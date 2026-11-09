/*
 * Ideas: a trade posted with locked levels, settled against price.
 *
 *   - The entry triggers when price crosses it from the side it was on when
 *     the idea was posted: on a daily close through it ('close') or on a
 *     trade through it ('touch'). An entry at the price triggers at once.
 *   - Once open, a daily bar reaching the stop settles it at −1R (worse on a
 *     gap through the stop), one reaching the target at the target's R. A bar
 *     reaching both counts as stopped.
 *   - On its last day it settles at that day's close (expired), or, never
 *     triggered, ends without a result (untriggered: not in the record).
 *
 * The pure rules are unit-tested (test/ideas.test.ts); `settleIdeas` and
 * `refreshPrices` run from the Worker's cron (index.ts) on the market data.
 */
import type { Direction, EntryRule, IdeaStatus, Quote, RecordTotals, TickerReference } from "../../../src/community-shared/contract";
import { Env } from "./env";
import { HttpError, now } from "./util";

export const SETTLED: IdeaStatus[] = ["target", "stopped", "expired"];

export type IdeaLevels = { direction: Direction; entry: number; stop: number; target: number; expires: string; entry_rule: EntryRule };

export type IdeaState = IdeaLevels & {
  ref_price: number;
  created_at: number;
  status: IdeaStatus;
  triggered_at: number | null;
  trigger_price: number | null;
  resolved_at: number | null;
  exit_price: number | null;
  result_r: number | null;
  checked_day: string | null;
};

/** A daily bar: its session (YYYY-MM-DD, New York) and prices. */
export type DayBar = { day: string; o: number; h: number; l: number; c: number };

/** An entry this close to the price (fraction) is taken at once. */
const AT_PRICE = 0.002;
/** Levels further than this from the price (fraction) are refused. */
const MAX_DISTANCE = 0.6;
const MAX_DAYS = 366;

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });

/** New York date (YYYY-MM-DD) and hour of a UNIX time. */
export function nyTime(at: number): { day: string; hour: number } {
  const parts = Object.fromEntries(NY.formatToParts(new Date(at * 1000)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The bar's session date: daily bars start at midnight New York. */
export function barDay(t: number): string {
  return nyTime(Math.floor(t / 1000) + 12 * 3600).day;
}

/** The R multiple of a price for these levels. */
export function rMultiple(direction: Direction, entry: number, stop: number, price: number): number {
  const risk = Math.abs(entry - stop);
  if (!risk) return 0;
  return ((direction === "long" ? price - entry : entry - price) / risk);
}

export const round2 = (v: number) => Math.round(v * 100) / 100;

export function rewardRisk(l: Pick<IdeaLevels, "entry" | "stop" | "target">): number {
  return round2(Math.abs(l.target - l.entry) / Math.abs(l.entry - l.stop));
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);

/** The levels of a new idea, checked against the price now; throws a 400 with what is wrong. */
export function parseIdea(input: any, price: number, at = now()): IdeaLevels {
  const direction = input?.direction;
  if (direction !== "long" && direction !== "short") throw new HttpError(400, "Pick long or short.");
  const entry = num(input?.entry), stop = num(input?.stop), target = num(input?.target);
  if (![entry, stop, target].every((v) => Number.isFinite(v) && v > 0)) throw new HttpError(400, "Entry, stop and target are prices above zero.");
  if (direction === "long" && !(stop < entry && entry < target)) throw new HttpError(400, "A long idea has its stop below the entry and its target above.");
  if (direction === "short" && !(target < entry && entry < stop)) throw new HttpError(400, "A short idea has its stop above the entry and its target below.");
  for (const v of [entry, stop, target]) {
    if (Math.abs(v - price) / price > MAX_DISTANCE) throw new HttpError(400, `Levels must be within ${MAX_DISTANCE * 100}% of the price now (${price}).`);
  }
  const expires = typeof input?.expires === "string" ? input.expires : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new HttpError(400, "Give the date the idea expires.");
  const today = nyTime(at).day;
  const days = (Date.parse(expires) - Date.parse(today)) / 86_400_000;
  if (!(days >= 1)) throw new HttpError(400, "The idea expires after today.");
  if (days > MAX_DAYS) throw new HttpError(400, "An idea expires within a year.");
  const entry_rule: EntryRule = input?.entry_rule === "touch" ? "touch" : "close";
  return { direction, entry, stop, target, expires, entry_rule };
}

/** A new idea's first state: open at once when the entry is at the price. */
export function openingState(l: IdeaLevels, price: number, at: number): Pick<IdeaState, "status" | "triggered_at" | "trigger_price" | "ref_price"> {
  const atPrice = Math.abs(price - l.entry) / l.entry <= AT_PRICE;
  return { status: atPrice ? "open" : "pending", triggered_at: atPrice ? at : null, trigger_price: atPrice ? price : null, ref_price: price };
}

/** 16:00 New York of a session, as a UNIX time (EST/EDT read from the date). */
export function sessionClose(day: string): number {
  const noonUtc = Date.parse(`${day}T12:00:00Z`) / 1000;
  const nyNoon = nyTime(noonUtc).hour; // 7 (EST) or 8 (EDT)
  return noonUtc + (16 - nyNoon) * 3600;
}

/**
 * The idea after these sessions' bars (oldest first, past `checked_day` only).
 * Bars before the idea could act are skipped: the posting day counts for a
 * 'close' entry posted before the close; a trade-through entry and the levels
 * after a trigger start the next session (the bar's order within the day is
 * unknown).
 */
export function stepIdea(s: IdeaState, bars: DayBar[], lastDay: string = nyTime(now()).day): IdeaState {
  let st = { ...s };
  const posted = nyTime(s.created_at);
  for (const b of bars) {
    if (st.status !== "pending" && st.status !== "open") break;
    if (st.checked_day && b.day <= st.checked_day) continue;
    if (b.day < posted.day) continue;
    const postingDay = b.day === posted.day;
    if (postingDay && (st.entry_rule === "touch" || posted.hour >= 16 || st.status === "open")) {
      st.checked_day = b.day;
      continue;
    }
    if (st.status === "pending") {
      const fromBelow = st.ref_price < st.entry;
      const hit = st.entry_rule === "close" ? (fromBelow ? b.c >= st.entry : b.c <= st.entry) : fromBelow ? b.h >= st.entry : b.l <= st.entry;
      if (hit) {
        st.status = "open";
        st.triggered_at = sessionClose(b.day);
        st.trigger_price = st.entry_rule === "close" ? b.c : st.entry;
      } else if (b.day >= st.expires) {
        st = { ...st, status: "untriggered", resolved_at: sessionClose(b.day), result_r: null, exit_price: null };
      }
      st.checked_day = b.day;
      continue;
    }
    // Open.
    const long = st.direction === "long";
    const stopHit = long ? b.l <= st.stop : b.h >= st.stop;
    const targetHit = long ? b.h >= st.target : b.l <= st.target;
    if (stopHit) {
      const gap = long ? b.o < st.stop : b.o > st.stop;
      const exit = gap ? b.o : st.stop;
      st = { ...st, status: "stopped", exit_price: exit, result_r: round2(rMultiple(st.direction, st.entry, st.stop, exit)), resolved_at: sessionClose(b.day) };
    } else if (targetHit) {
      st = { ...st, status: "target", exit_price: st.target, result_r: round2(rMultiple(st.direction, st.entry, st.stop, st.target)), resolved_at: sessionClose(b.day) };
    } else if (b.day >= st.expires) {
      st = { ...st, status: "expired", exit_price: b.c, result_r: round2(rMultiple(st.direction, st.entry, st.stop, b.c)), resolved_at: sessionClose(b.day) };
    }
    st.checked_day = b.day;
  }
  // No session since the last day (a halted or delisted symbol): ends a week after it.
  if ((st.status === "pending" || st.status === "open") && Date.parse(lastDay) - Date.parse(st.expires) > 7 * 86_400_000) {
    const exit = st.status === "open" ? (bars.length ? bars[bars.length - 1].c : null) : null;
    st = {
      ...st,
      status: st.status === "open" ? "expired" : "untriggered",
      exit_price: exit,
      result_r: exit == null ? null : round2(rMultiple(st.direction, st.entry, st.stop, exit)),
      resolved_at: sessionClose(st.expires),
    };
  }
  return st;
}

// ── Records ─────────────────────────────────────────────────────────────

export function emptyRecord(): RecordTotals {
  return { resolved: 0, hits: 0, hit_pct: null, avg_r: null, total_r: 0, open: 0 };
}

/** SQL columns of a record over posts `p` (grouped by the caller). */
export const RECORD_COLUMNS = `
  SUM(p.status IN ('target','stopped','expired')) AS resolved,
  SUM(p.status = 'target') AS hits,
  SUM(CASE WHEN p.status IN ('target','stopped','expired') THEN p.result_r ELSE 0 END) AS total_r,
  SUM(p.status IN ('pending','open')) AS open`;

export function recordOf(row: { resolved?: number | null; hits?: number | null; total_r?: number | null; open?: number | null } | null | undefined): RecordTotals {
  const resolved = row?.resolved ?? 0;
  const hits = row?.hits ?? 0;
  const total = round2(row?.total_r ?? 0);
  return {
    resolved,
    hits,
    hit_pct: resolved ? Math.round((hits / resolved) * 100) : null,
    avg_r: resolved ? round2(total / resolved) : null,
    total_r: total,
    open: row?.open ?? 0,
  };
}

/** The records of these authors (user ids), over their ideas not deleted or removed. */
export async function recordsOf(env: Env, authorIds: (string | null)[]): Promise<Map<string, RecordTotals>> {
  const ids = [...new Set(authorIds.filter((x): x is string => !!x))];
  const out = new Map<string, RecordTotals>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT p.author_id, ${RECORD_COLUMNS} FROM posts p
        WHERE p.type = 'idea' AND p.deleted = 0 AND p.removed = 0 AND p.author_id IN (${chunk.map(() => "?").join(",")}) GROUP BY p.author_id`,
    )
      .bind(...chunk)
      .all<any>();
    for (const r of results) out.set(r.author_id, recordOf(r));
  }
  return out;
}

/** "34 ideas · 62% hit", "3 ideas", "no ideas yet". */
export function recordLine(r: RecordTotals | undefined): string {
  if (!r || (!r.resolved && !r.open)) return "no ideas yet";
  if (!r.resolved) return `${r.open} open idea${r.open === 1 ? "" : "s"}`;
  return `${r.resolved} idea${r.resolved === 1 ? "" : "s"} · ${r.hit_pct}% hit`;
}

// ── Market data ─────────────────────────────────────────────────────────

async function gateway<T>(env: Env, path: string): Promise<T | null> {
  if (!env.GATEWAY_URL || !env.GATEWAY_TOKEN) return null;
  const res = await fetch(`${env.GATEWAY_URL}${path}`, { headers: { authorization: `Bearer ${env.GATEWAY_TOKEN}`, "user-agent": "OpenTrader-Community" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

type SnapTicker = { ticker: string; todaysChange?: number; todaysChangePerc?: number; day?: { c?: number }; min?: { c?: number }; lastTrade?: { p?: number }; prevDay?: { c?: number } };

function quoteOf(t: SnapTicker): Quote | null {
  const last = t.lastTrade?.p || t.min?.c || t.day?.c || t.prevDay?.c;
  if (!last) return null;
  return { last, change: t.todaysChange ?? null, change_pct: t.todaysChangePerc ?? null };
}

/** Delayed quotes of these tickers (none without the market data). */
export async function quotes(env: Env, tickers: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const list = [...new Set(tickers)].sort();
  for (let i = 0; i < list.length; i += 100) {
    const r = await gateway<{ tickers?: SnapTicker[] }>(env, `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${list.slice(i, i + 100).map(encodeURIComponent).join(",")}`);
    for (const t of r?.tickers ?? []) {
      const q = quoteOf(t);
      if (q) out.set(t.ticker, q);
    }
  }
  return out;
}

const EXCHANGES: Record<string, string> = { XNAS: "Nasdaq", XNYS: "NYSE", ARCX: "NYSE Arca", XASE: "NYSE American", BATS: "Cboe BZX", IEXG: "IEX" };

/** The company behind a US stock or ETF ticker; null when the market data doesn't list it there. */
export async function reference(env: Env, ticker: string): Promise<TickerReference | null> {
  const r = await gateway<{ results?: { name?: string; market?: string; locale?: string; primary_exchange?: string; sic_description?: string; type?: string } }>(
    env,
    `/v3/reference/tickers/${encodeURIComponent(ticker)}`,
  );
  const x = r?.results;
  if (!x || x.market !== "stocks" || x.locale !== "us") return null;
  const sector = (x.sic_description ?? "").toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
  return { name: x.name ?? ticker, exchange: EXCHANGES[x.primary_exchange ?? ""] ?? x.primary_exchange ?? "", sector: x.type === "ETF" ? "ETF" : sector, type: x.type ?? "" };
}

type AggBar = { t: number; o: number; h: number; l: number; c: number; v?: number };

/** Daily bars of a ticker between two dates (YYYY-MM-DD), split-adjusted. */
export async function dailyBars(env: Env, ticker: string, from: string, to: string): Promise<(DayBar & { t: number; v: number })[]> {
  const r = await gateway<{ results?: AggBar[] }>(env, `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000`);
  return (r?.results ?? []).map((b) => ({ t: b.t, day: barDay(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }));
}

type Split = { execution_date: string; split_from: number; split_to: number };

/** Splits of a ticker after a date: the bars are adjusted for them, so the levels are too. */
async function splitsAfter(env: Env, ticker: string, day: string): Promise<Split[]> {
  const r = await gateway<{ results?: Split[] }>(env, `/v3/reference/splits?ticker=${encodeURIComponent(ticker)}&execution_date.gt=${day}&order=asc&limit=50`);
  return (r?.results ?? []).filter((s) => s.split_from > 0 && s.split_to > 0);
}

type IdeaRow = IdeaState & { id: string; community_id: string; split_day: string | null; last_price: number | null };

const PRICE_COLUMNS = ["entry", "stop", "target", "ref_price", "trigger_price", "exit_price", "last_price"] as const;

/** Settles the ideas still pending or open against the daily bars since they were last read. */
export async function settleIdeas(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM posts WHERE type = 'idea' AND status IN ('pending','open') AND deleted = 0 AND removed = 0 AND community_id LIKE 't:%'",
  ).all<IdeaRow>();
  const byTicker = new Map<string, IdeaRow[]>();
  for (const r of results) {
    const t = r.community_id.slice(2);
    byTicker.set(t, [...(byTicker.get(t) ?? []), r]);
  }
  const today = nyTime(now()).day;
  let changed = 0;
  for (const [ticker, ideas] of byTicker) {
    const from = ideas.map((i) => i.checked_day ?? nyTime(i.created_at).day).sort()[0];
    let bars: DayBar[];
    let splits: Split[];
    try {
      bars = await dailyBars(env, ticker, from, today);
      splits = await splitsAfter(env, ticker, ideas.map((i) => i.split_day ?? nyTime(i.created_at).day).sort()[0]);
    } catch (e) {
      console.error(`[ideas] ${ticker}:`, e);
      continue;
    }
    // Only complete sessions: today's bar once the close is past.
    const done = bars.filter((b) => b.day < today || now() >= sessionClose(b.day) + 30 * 60);
    for (const idea of ideas) {
      const st = { ...idea };
      // A split after posting: the adjusted bars are on the new scale, so are the levels from now on.
      for (const s of splits) {
        if (s.execution_date <= (st.split_day ?? nyTime(st.created_at).day)) continue;
        const k = s.split_from / s.split_to;
        for (const c of PRICE_COLUMNS) if (st[c] != null) (st as any)[c] = Math.round((st[c] as number) * k * 10_000) / 10_000;
        st.split_day = s.execution_date;
      }
      const next = stepIdea(st, done, today);
      const keys = ["status", "triggered_at", "trigger_price", "resolved_at", "exit_price", "result_r", "checked_day", "split_day", ...PRICE_COLUMNS] as const;
      if (keys.every((k) => (next as any)[k] === (idea as any)[k])) continue;
      await env.DB.prepare(
        `UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      )
        .bind(...keys.map((k) => (next as any)[k] ?? null), idea.id)
        .run();
      changed++;
    }
  }
  return changed;
}

/** The last price of the tickers with ideas pending or open (the "now" of an idea). */
export async function refreshPrices(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT substr(community_id, 3) AS ticker FROM posts WHERE type = 'idea' AND status IN ('pending','open') AND deleted = 0 AND removed = 0 AND community_id LIKE 't:%'",
  ).all<{ ticker: string }>();
  if (!results.length) return 0;
  const q = await quotes(env, results.map((r) => r.ticker));
  const stmts = [...q].map(([t, v]) =>
    env.DB.prepare("UPDATE posts SET last_price = ? WHERE community_id = ? AND type = 'idea' AND status IN ('pending','open')").bind(v.last, `t:${t}`),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}
