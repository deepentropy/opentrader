/*
 * The automatic threads, posted by "OpenTrader-bot" (a labelled account,
 * never passed off as a member) as Analysis posts. Facts and an open
 * question, no opinions. They show on ticker pages and in search, not in the
 * home feed:
 *
 *   - every trading day, a daily thread for each active ticker (posts,
 *     followers and open ideas of the last week), the previous one locked;
 *   - every Monday, a weekly thread in General, the previous one locked;
 *   - every trading day after the open, a thread for each of the day's
 *     biggest moves among US stocks (from the market data; no figure in it).
 *
 * Run by the Worker's cron triggers (wrangler.jsonc), or by an administrator
 * (POST /mod/bot {job}).
 */
import { Env } from "./env";
import { User } from "./auth";
import { utcDate } from "../../../src/community-shared/dates";
import { HttpError, hotRank, json, newId, now } from "./util";

/** UTC days since 1970. */
const today = (at = now()) => Math.floor(at / 86_400);

export const BOT = "bot";
const DAY = 86_400;
/** Active ticker communities that get a daily thread, at most. */
const DAILY_MAX = 15;
const DAILY_MIN_SCORE = 3;
/** Movers: at most this many each way, past this change, with this volume and price. */
const MOVERS_EACH_WAY = 3;
const MOVER_MIN_CHANGE = 15;
const MOVER_MIN_VOLUME = 1_000_000;
const MOVER_MIN_PRICE = 0.5;

/** Posts a bot thread once per key; locks the previous thread of the same kind in that community. */
async function post(
  env: Env,
  kind: string,
  communityId: string,
  period: string,
  title: string,
  body: string,
  lockPrevious: boolean,
  /** The thread's date (a past trading day for the backfill); now by default. */
  at = now(),
): Promise<string | null> {
  const key = `${communityId}:${period}`;
  if (await env.DB.prepare("SELECT 1 FROM bot_threads WHERE kind = ? AND key = ?").bind(kind, key).first()) return null;
  const id = newId();
  const stmts: D1PreparedStatement[] = [];
  if (lockPrevious) {
    stmts.push(
      env.DB.prepare("UPDATE posts SET locked = 1 WHERE id IN (SELECT post_id FROM bot_threads WHERE kind = ? AND community_id = ?)").bind(kind, communityId),
    );
  }
  if (communityId.startsWith("t:")) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO communities (id, kind, title, created_at) VALUES (?, 'ticker', ?, ?)").bind(communityId, `$${communityId.slice(2)}`, at));
  }
  stmts.push(
    env.DB.prepare("INSERT INTO posts (id, community_id, author_id, title, body, score, hot, created_at, type) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'analysis')").bind(
      id, communityId, BOT, title, body, hotRank(0, at), at,
    ),
    env.DB.prepare("UPDATE communities SET post_count = post_count + 1 WHERE id = ?").bind(communityId),
    env.DB.prepare("INSERT INTO bot_threads (kind, key, community_id, post_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(kind, key, communityId, id, at),
  );
  await env.DB.batch(stmts);
  return id;
}

/** The ticker communities active over the last week: posts, followers, ideas posted. */
export async function activeTickers(env: Env): Promise<string[]> {
  const since = now() - 7 * DAY;
  const { results } = await env.DB.prepare(
    `SELECT id, score FROM (
       SELECT c.id,
              (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.created_at >= ? AND p.author_id IS NOT ? AND p.removed = 0 AND p.deleted = 0)
            + (SELECT COUNT(*) FROM follows f WHERE f.community_id = c.id)
            + (SELECT COUNT(*) FROM posts i WHERE i.community_id = c.id AND i.type = 'idea' AND i.created_at >= ?) AS score
         FROM communities c WHERE c.kind = 'ticker')
      WHERE score >= ? ORDER BY score DESC LIMIT ?`,
  )
    .bind(since, BOT, since, DAILY_MIN_SCORE, DAILY_MAX)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function dailyThreads(env: Env): Promise<string[]> {
  const at = now();
  const made: string[] = [];
  for (const id of await activeTickers(env)) {
    const t = `$${id.slice(2)}`;
    const p = await post(
      env,
      "daily",
      id,
      String(today(at)),
      `${t} daily thread, ${utcDate(at)}`,
      `Today's thread for ${t}: plans, levels, charts and news for the session.\n\n_Posted automatically every trading day. Yesterday's thread is locked._`,
      true,
    );
    if (p) made.push(p);
  }
  return made;
}

/** Monday's date of the week holding `at`. */
const weekOf = (at: number) => {
  const d = new Date(at * 1000);
  const back = (d.getUTCDay() + 6) % 7;
  return Math.floor(at / DAY) * DAY - back * DAY;
};

export async function weeklyThreads(env: Env): Promise<string[]> {
  const monday = weekOf(now());
  const { results } = await env.DB.prepare("SELECT id, title FROM communities WHERE kind = 'theme' ORDER BY sort_order").all<{ id: string; title: string }>();
  const made: string[] = [];
  for (const c of results) {
    const p = await post(
      env,
      "weekly",
      c.id,
      String(monday),
      `${c.title} weekly thread, week of ${utcDate(monday)}`,
      `This week's open thread for ${c.title}: questions, trades and ideas that don't need a post of their own.\n\n_Posted automatically every Monday. Last week's thread is locked._`,
      true,
    );
    if (p) made.push(p);
  }
  return made;
}

export type Snap = { ticker: string; changePct: number | null; day: { c: number | null; v: number | null } | null };

/** The day's biggest moves: common stocks (1 to 5 letters, not the warrants, rights and units: a fifth letter W, R
 *  or U) traded enough, past the change, the largest each way. */
export function pickMoves(tickers: Snap[]): Snap[] {
  const eligible = tickers.filter(
    (s) =>
      /^[A-Z]{1,5}$/.test(s.ticker) &&
      !/^[A-Z]{4}[WRU]$/.test(s.ticker) &&
      s.changePct != null &&
      Number.isFinite(s.changePct) &&
      (s.day?.v ?? 0) >= MOVER_MIN_VOLUME &&
      (s.day?.c ?? 0) >= MOVER_MIN_PRICE,
  );
  const up = eligible.filter((s) => s.changePct! >= MOVER_MIN_CHANGE).sort((a, b) => b.changePct! - a.changePct!).slice(0, MOVERS_EACH_WAY);
  const down = eligible.filter((s) => s.changePct! <= -MOVER_MIN_CHANGE).sort((a, b) => a.changePct! - b.changePct!).slice(0, MOVERS_EACH_WAY);
  return [...up, ...down];
}

/** The day's biggest moves among US common stocks (none on a closed market). */
export async function biggestMoves(env: Env): Promise<string[]> {
  if (!env.GATEWAY_URL || !env.GATEWAY_TOKEN) return [];
  const res = await fetch(`${env.GATEWAY_URL}/market/v1/snapshot`, {
    headers: { authorization: `Bearer ${env.GATEWAY_TOKEN}`, "user-agent": "OpenTrader-Community" },
  });
  if (!res.ok) throw new Error(`market snapshot answered ${res.status}`);
  const { tickers } = (await res.json()) as { tickers: Snap[] };
  const made: string[] = [];
  for (const s of pickMoves(tickers)) {
    const t = `$${s.ticker}`;
    const p = await post(
      env,
      "mover",
      `t:${s.ticker}`,
      String(today()),
      `${t}: one of today's biggest moves`,
      `${t} is among today's biggest moves in US stocks. What's behind it? Share the news, your levels and charts.\n\n_Posted automatically for the day's biggest moves._`,
      false,
    );
    if (p) made.push(p);
  }
  return made;
}

type DayBar = { T: string; c: number; v: number };

/** The whole market's daily bars of a date (YYYY-MM-DD); empty on a day without a session. */
async function dailyBars(env: Env, date: string): Promise<DayBar[]> {
  const res = await fetch(`${env.GATEWAY_URL}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`, {
    headers: { authorization: `Bearer ${env.GATEWAY_TOKEN}`, "user-agent": "OpenTrader-Community" },
  });
  if (!res.ok) throw new Error(`daily bars of ${date} answered ${res.status}`);
  return ((await res.json()) as { results?: DayBar[] }).results ?? [];
}

const isoDate = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);

/**
 * The biggest moves of past trading days (the last `days` sessions before today), each compared with the session
 * before; the same rules as the daily job. Each thread is dated to its session (after the close) and says it was
 * added later. Days already done are skipped.
 */
export async function backfillMoves(env: Env, days: number): Promise<string[]> {
  if (!env.GATEWAY_URL || !env.GATEWAY_TOKEN) return [];
  const made: string[] = [];
  const added = utcDate(now());
  // Sessions newest first, each with the session before it.
  const sessions: { day: number; bars: DayBar[] }[] = [];
  for (let d = today() - 1; sessions.length < days + 1 && d > today() - (days + 1) * 2 - 10; d--) {
    const wd = new Date(d * DAY * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const bars = await dailyBars(env, isoDate(d));
    if (bars.length) sessions.push({ day: d, bars });
  }
  for (let i = 0; i + 1 < sessions.length && i < days; i++) {
    const { day, bars } = sessions[i];
    const prev = new Map(sessions[i + 1].bars.map((b) => [b.T, b.c]));
    const snaps: Snap[] = bars.map((b) => {
      const p = prev.get(b.T);
      return { ticker: b.T, changePct: p ? ((b.c - p) / p) * 100 : null, day: { c: b.c, v: b.v } };
    });
    const date = utcDate(day * DAY);
    for (const s of pickMoves(snaps)) {
      const t = `$${s.ticker}`;
      const p = await post(
        env,
        "mover",
        `t:${s.ticker}`,
        String(day),
        `${t}: one of the biggest moves of ${date}`,
        `${t} was among the biggest moves in US stocks on ${date}. What was behind it? Share the news, your levels and charts.

_Added on ${added} from that session's market data._`,
        false,
        // After that session's close.
        day * DAY + 21 * 3600,
      );
      if (p) made.push(p);
    }
  }
  return made;
}

/** From the cron (index.ts): 13:00 UTC on trading days (daily threads; Mondays, weekly ones too), 16:00 UTC (moves). */
export async function scheduled(env: Env, hm: number): Promise<void> {
  if (hm === 1300) {
    await dailyThreads(env);
    if (new Date().getUTCDay() === 1) await weeklyThreads(env);
  } else if (hm === 1600) {
    await biggestMoves(env);
  }
}

/** POST /mod/bot {job: "daily" | "weekly" | "movers" | "backfill", days?} — an administrator runs a job now. */
export async function runJob(env: Env, user: User | null, body: any): Promise<Response> {
  if (!user || user.role !== "admin") throw new HttpError(403, "Only administrators run the bot.");
  const job = String(body?.job ?? "");
  const days = Math.min(30, Math.max(1, Number(body?.days) || 10));
  const made =
    job === "daily" ? await dailyThreads(env)
    : job === "weekly" ? await weeklyThreads(env)
    : job === "movers" ? await biggestMoves(env)
    : job === "backfill" ? await backfillMoves(env, days)
    : null;
  if (!made) throw new HttpError(400, "Unknown job.");
  return json({ posts: made });
}
