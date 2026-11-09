/*
 * The website's pages, each in one answer: the home feed since the last
 * visit, a ticker's page, the tickers, search, and a trader's profile.
 *
 * The home feed holds members' posts only (the bot's threads are on ticker
 * pages and in search) and ends: "You're caught up". Suggestions are on
 * their own page (suggestions.ts), not in the feed or search.
 */
import { Env } from "./env";
import { User } from "./auth";
import { POST_SELECT, POST_TYPES, findCommunity, ideaOut, order, postsOut, requireUser } from "./api";
import { RECORD_COLUMNS, dailyBars, nyTime, quotes, recordOf, recordsOf, reference, round2, type IdeaRecord } from "./ideas";
import { HttpError, SUGGESTIONS, json, now, parseCommunityId, str } from "./util";

type Row = Record<string, any>;

const DAY = 86_400;
/** A new visit after this much quiet; the feed starts at the previous one. */
const VISIT_GAP = 30 * 60;
const HOME_MAX = 100;
const BOT = "bot";

const recordOut = (r: IdeaRecord | undefined) => (r ? { resolved: r.resolved, hit_pct: r.hit_pct, avg_r: r.avg_r, open: r.open } : null);

/** Where the home feed starts: the member's previous visit (a week for visitors, a month at most). */
async function visitStart(env: Env, user: User | null, at: number): Promise<{ since: number; visitor: boolean }> {
  if (!user) return { since: at - 7 * DAY, visitor: true };
  const v = await env.DB.prepare("SELECT seen_at, prev_seen_at FROM users WHERE id = ?").bind(user.id).first<{ seen_at: number | null; prev_seen_at: number | null }>();
  let prev = v?.prev_seen_at ?? at - 7 * DAY;
  if (!v?.seen_at) prev = at - 7 * DAY;
  else if (at - v.seen_at > VISIT_GAP) prev = v.seen_at;
  await env.DB.prepare("UPDATE users SET seen_at = ?, prev_seen_at = ? WHERE id = ?").bind(at, prev, user.id).run();
  return { since: Math.max(prev, at - 30 * DAY), visitor: false };
}

/** GET /home?sort=useful|new&type=… */
export async function home(env: Env, user: User | null, url: URL): Promise<Response> {
  const at = now();
  const { since, visitor } = await visitStart(env, user, at);
  const type = url.searchParams.get("type");
  const typed = !!type && (POST_TYPES as readonly string[]).includes(type);
  const base = `p.created_at >= ? AND p.removed = 0 AND p.deleted = 0 AND p.author_id IS NOT ? AND p.community_id <> '${SUGGESTIONS}'`;
  const { results } = await env.DB.prepare(`${POST_SELECT} WHERE ${base} ${typed ? "AND p.type = ?" : ""} ORDER BY ${order(url.searchParams.get("sort") ?? "useful")} LIMIT ?`)
    .bind(since, BOT, ...(typed ? [type] : []), HOME_MAX)
    .all<Row>();
  const { results: byType } = await env.DB.prepare(`SELECT p.type, COUNT(*) AS n FROM posts p WHERE ${base} GROUP BY p.type`).bind(since, BOT).all<{ type: string; n: number }>();
  const counts = Object.fromEntries(byType.map((r) => [r.type, r.n]));
  const resolved = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE type = 'idea' AND status IN ('target','stopped','expired') AND resolved_at >= ? AND deleted = 0 AND removed = 0")
    .bind(since)
    .first<{ n: number }>();
  const tickers = user
    ? (
        await env.DB.prepare(
          `SELECT c.id, c.title, (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND ${base}) AS fresh
             FROM follows f JOIN communities c ON c.id = f.community_id WHERE f.user_id = ? AND c.kind = 'ticker' ORDER BY fresh DESC, c.title LIMIT 12`,
        )
          .bind(since, BOT, user.id)
          .all<Row>()
      ).results
    : [];
  const record30 = await env.DB.prepare(`SELECT ${RECORD_COLUMNS} FROM posts p WHERE p.type = 'idea' AND p.resolved_at >= ? AND p.deleted = 0 AND p.removed = 0`).bind(at - 30 * DAY).first<Row>();
  const weekEnd = nyTime(at + 7 * DAY).day;
  const { results: resolving } = await env.DB.prepare(
    `SELECT p.id, p.community_id, p.direction, p.entry, p.stop, p.target, p.expires, p.last_price, p.status, u.name AS author
       FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.type = 'idea' AND p.status IN ('pending','open') AND p.expires <= ? AND p.deleted = 0 AND p.removed = 0 ORDER BY p.expires LIMIT 5`,
  )
    .bind(weekEnd)
    .all<Row>();
  const { results: questions } = await env.DB.prepare(
    `SELECT p.id, p.title, p.created_at, p.comment_count FROM posts p
      WHERE p.type = 'question' AND p.answer_id IS NULL AND p.created_at >= ? AND p.removed = 0 AND p.deleted = 0 AND p.author_id IS NOT ? ORDER BY p.created_at DESC LIMIT 3`,
  )
    .bind(at - 14 * DAY, BOT)
    .all<Row>();
  return json({
    since,
    visitor,
    posts: await postsOut(env, results, user),
    counts: { all: byType.reduce((a, r) => a + r.n, 0), ...counts },
    resolved: resolved?.n ?? 0,
    my_tickers: tickers.map((t) => ({ id: t.id, title: t.title, fresh: t.fresh })),
    record30: recordOf(record30),
    resolving: resolving.map((r) => ({
      id: r.id, ticker: r.community_id.slice(2), direction: r.direction, author: r.author, status: r.status,
      entry: r.entry, stop: r.stop, target: r.target, expires: r.expires, last_price: r.last_price,
    })),
    open_questions: questions,
  });
}

/** The ticker of a `t:` address, or 404. */
function tickerOf(id: string): string {
  const p = parseCommunityId(`t:${id}`);
  if (!p) throw new HttpError(404, "No such ticker.");
  return p.key;
}

/** GET /tickers/:T — the ticker's page: company, price, open ideas, positioning, record, answered questions. */
export async function tickerPage(env: Env, user: User | null, raw: string): Promise<Response> {
  const ticker = tickerOf(raw);
  const c = await findCommunity(env, `t:${ticker}`);
  const id = c.id;
  const [ref, q] = await Promise.all([reference(env, ticker).catch(() => null), quotes(env, [ticker]).then((m) => m.get(ticker) ?? null).catch(() => null)]);
  const followed = !!user && !c.virtual && !!(await env.DB.prepare("SELECT 1 FROM follows WHERE user_id = ? AND community_id = ?").bind(user.id, id).first());
  const { results: open } = await env.DB.prepare(
    `SELECT p.*, u.name AS author_name FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.community_id = ? AND p.type = 'idea' AND p.status IN ('pending','open') AND p.deleted = 0 AND p.removed = 0`,
  )
    .bind(id)
    .all<Row>();
  const records = await recordsOf(env, open.map((o) => o.author_id));
  const rec = (a: string | null) => (a ? records.get(a) : undefined);
  const ideas = open
    .map((o) => ({ id: o.id, title: o.title, author: o.author_name, author_record: recordOut(rec(o.author_id)), created_at: o.created_at, idea: ideaOut({ ...o, last_price: q?.last ?? o.last_price }) }))
    .sort((a, b) => (b.author_record?.resolved ?? 0) - (a.author_record?.resolved ?? 0) || (b.author_record?.hit_pct ?? 0) - (a.author_record?.hit_pct ?? 0));
  // Each side weighted by its authors' hit rate (a new author counts as an even record).
  const weight = (a: string | null) => {
    const r = rec(a);
    return ((r?.hits ?? 0) + 1) / ((r?.resolved ?? 0) + 2);
  };
  const w = { long: 0, short: 0 };
  for (const o of open) w[o.direction as "long" | "short"] += weight(o.author_id);
  const since90 = now() - 90 * DAY;
  const r90 = await env.DB.prepare(`SELECT ${RECORD_COLUMNS} FROM posts p WHERE p.community_id = ? AND p.type = 'idea' AND p.resolved_at >= ? AND p.deleted = 0 AND p.removed = 0`).bind(id, since90).first<Row>();
  const { results: recent } = await env.DB.prepare(
    `SELECT p.id, p.direction, p.status, p.result_r, p.resolved_at, u.name AS author FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.community_id = ? AND p.type = 'idea' AND p.status IN ('target','stopped','expired') AND p.resolved_at >= ? AND p.deleted = 0 AND p.removed = 0
      ORDER BY p.resolved_at DESC LIMIT 4`,
  )
    .bind(id, since90)
    .all<Row>();
  const { results: answered } = await env.DB.prepare(
    `SELECT p.id, p.title, a.useful_count, ua.name AS answer_by FROM posts p
       JOIN comments a ON a.id = p.answer_id LEFT JOIN users ua ON ua.id = a.author_id
      WHERE p.community_id = ? AND p.type = 'question' AND p.removed = 0 AND p.deleted = 0 ORDER BY p.useful_count DESC, p.created_at DESC LIMIT 3`,
  )
    .bind(id)
    .all<Row>();
  return json({
    community: { id, title: c.title, post_count: c.post_count ?? 0, followed },
    ticker,
    reference: ref,
    quote: q,
    open_ideas: ideas,
    positioning: { long: open.filter((o) => o.direction === "long").length, short: open.filter((o) => o.direction === "short").length, weighted_long_pct: w.long + w.short ? Math.round((w.long / (w.long + w.short)) * 100) : null },
    resolved90: { ...recordOf(r90), recent },
    answered,
  });
}

/** GET /tickers/:T/bars — about 9 months of daily bars for the ticker page's chart. */
export async function tickerBars(env: Env, raw: string): Promise<Response> {
  const ticker = tickerOf(raw);
  const to = nyTime(now()).day;
  const from = nyTime(now() - 270 * DAY).day;
  const bars = await dailyBars(env, ticker, from, to).catch(() => []);
  return json({ bars: bars.map((b) => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c })) }, 200, { "cache-control": "public, max-age=900" });
}

/** GET /tickers — the member's tickers and the most discussed of the last month. */
export async function tickersIndex(env: Env, user: User | null): Promise<Response> {
  const since = now() - 30 * DAY;
  const stats = `(SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.created_at >= ? AND p.removed = 0 AND p.deleted = 0) AS posts30,
                 (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.type = 'idea' AND p.status IN ('pending','open') AND p.removed = 0 AND p.deleted = 0) AS open_ideas`;
  const mine = user
    ? (await env.DB.prepare(`SELECT c.id, c.title, ${stats} FROM follows f JOIN communities c ON c.id = f.community_id WHERE f.user_id = ? AND c.kind = 'ticker' ORDER BY c.title`).bind(since, user.id).all<Row>()).results
    : [];
  const { results: active } = await env.DB.prepare(
    `SELECT * FROM (SELECT c.id, c.title, ${stats} FROM communities c WHERE c.kind = 'ticker') WHERE posts30 > 0 OR open_ideas > 0 ORDER BY posts30 DESC, open_ideas DESC LIMIT 40`,
  )
    .bind(since)
    .all<Row>();
  return json({ mine, active }, 200, user ? {} : { "cache-control": "public, max-age=300" });
}

// ── Search ──────────────────────────────────────────────────────────────

const TYPE_WORDS: Record<string, string> = { idea: "idea", ideas: "idea", analysis: "analysis", question: "question", questions: "question", "post-mortem": "postmortem", postmortem: "postmortem", "post-mortems": "postmortem" };
const OUTCOMES = ["target", "stopped", "expired", "open"] as const;
const OUTCOME_WORDS: Record<string, string> = { target: "target", hit: "target", stopped: "stopped", stop: "stopped", expired: "expired", open: "open" };

/** A query in words: `$NVDA`, `type:post-mortem`, `outcome:stopped`, `by:name`, and text. */
export function parseQuery(q: string): { terms: string[]; ticker: string | null; types: string[]; outcomes: string[]; author: string | null } {
  const out = { terms: [] as string[], ticker: null as string | null, types: [] as string[], outcomes: [] as string[], author: null as string | null };
  for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
    const w = raw.toLowerCase();
    const m = /^(type|outcome|by|ticker):(.+)$/.exec(w);
    if (raw.startsWith("$") && raw.length > 1) out.ticker = raw.slice(1).toUpperCase();
    else if (raw.startsWith("@") && raw.length > 1) out.author = raw.slice(1);
    else if (m && m[1] === "type" && TYPE_WORDS[m[2]]) out.types.push(TYPE_WORDS[m[2]]);
    else if (m && m[1] === "outcome" && OUTCOME_WORDS[m[2]]) out.outcomes.push(OUTCOME_WORDS[m[2]]);
    else if (m && m[1] === "by") out.author = raw.slice(3);
    else if (m && m[1] === "ticker") out.ticker = m[2].toUpperCase();
    else out.terms.push(raw.replace(/[%_\\]/g, "").slice(0, 40));
  }
  out.terms = out.terms.filter(Boolean).slice(0, 8);
  return out;
}

/** The text around the first term found (the page marks the terms). */
export function snippet(body: string, terms: string[], len = 240): string {
  const plain = body.replace(/[#*_~`>|[\]()]/g, " ").replace(/\s+/g, " ").trim();
  const lower = plain.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  const s = plain.slice(start, start + len);
  return (start > 0 ? "…" : "") + s + (start + len < plain.length ? "…" : "");
}

const POSTED: Record<string, number> = { week: 7 * DAY, "90d": 90 * DAY };

/** GET /search?q=&type=a,b&outcome=a,b&posted=week|90d|any&min_useful=&offset= */
export async function search(env: Env, user: User | null, url: URL): Promise<Response> {
  const q = parseQuery(url.searchParams.get("q") ?? "");
  const list = (k: string) => (url.searchParams.get(k) ?? "").split(",").filter(Boolean);
  const types = [...new Set([...q.types, ...list("type").filter((t) => (POST_TYPES as readonly string[]).includes(t))])];
  const outcomes = [...new Set([...q.outcomes, ...list("outcome").filter((o) => (OUTCOMES as readonly string[]).includes(o))])];
  const posted = url.searchParams.get("posted") ?? "any";
  const minUseful = Math.max(0, Number(url.searchParams.get("min_useful")) || 0);
  const offset = Math.max(0, Math.min(5_000, Number(url.searchParams.get("offset")) || 0));

  // The query's own conditions; the facets add theirs.
  const where: string[] = ["p.removed = 0", "p.deleted = 0", `p.community_id <> '${SUGGESTIONS}'`];
  const binds: unknown[] = [];
  for (const t of q.terms) {
    where.push("(p.title LIKE ? OR p.body LIKE ?)");
    binds.push(`%${t}%`, `%${t}%`);
  }
  if (q.ticker) {
    where.push("p.community_id = ?");
    binds.push(q.ticker === "GENERAL" ? "c:general" : `t:${q.ticker}`);
  }
  if (q.author) {
    where.push("u.name_key = ?");
    binds.push(q.author.toLowerCase());
  }
  if (minUseful) {
    where.push("p.useful_count >= ?");
    binds.push(minUseful);
  }
  const at = now();
  const postedCond = POSTED[posted] ? "p.created_at >= ?" : "1 = 1";
  const postedBind = POSTED[posted] ? [at - POSTED[posted]] : [];
  const typeCond = types.length ? `p.type IN (${types.map(() => "?").join(",")})` : "1 = 1";
  const outcomeCond = outcomes.length
    ? `(p.type <> 'idea' OR ${outcomes.map((o) => (o === "open" ? "p.status IN ('pending','open')" : "p.status = ?")).join(" OR ")})`
    : "1 = 1";
  const outcomeBind = outcomes.filter((o) => o !== "open");
  const from = "FROM posts p LEFT JOIN users u ON u.id = p.author_id";
  const base = where.join(" AND ");

  const { results: typeFacet } = await env.DB.prepare(`SELECT p.type AS k, COUNT(*) AS n ${from} WHERE ${base} AND ${postedCond} AND ${outcomeCond} GROUP BY p.type`)
    .bind(...binds, ...postedBind, ...outcomeBind)
    .all<{ k: string; n: number }>();
  const { results: outcomeFacet } = await env.DB.prepare(
    `SELECT CASE WHEN p.status IN ('pending','open') THEN 'open' ELSE p.status END AS k, COUNT(*) AS n ${from}
      WHERE ${base} AND ${postedCond} AND p.type = 'idea' GROUP BY k`,
  )
    .bind(...binds, ...postedBind)
    .all<{ k: string; n: number }>();
  const postedFacet = await env.DB.prepare(
    `SELECT SUM(p.created_at >= ?) AS week, SUM(p.created_at >= ?) AS d90, COUNT(*) AS any ${from} WHERE ${base} AND ${typeCond} AND ${outcomeCond}`,
  )
    .bind(at - POSTED.week, at - POSTED["90d"], ...binds, ...types, ...outcomeBind)
    .first<Row>();

  const cond = `${base} AND ${postedCond} AND ${typeCond} AND ${outcomeCond}`;
  const condBinds = [...binds, ...postedBind, ...types, ...outcomeBind];
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${cond}`).bind(...condBinds).first<{ n: number }>();
  const { results } = await env.DB.prepare(
    `${POST_SELECT} WHERE ${cond}
      ORDER BY (p.type = 'question' AND p.answer_id IS NOT NULL) DESC, p.useful_count DESC, p.created_at DESC LIMIT 26 OFFSET ?`,
  )
    .bind(...condBinds, offset)
    .all<Row>();
  const posts = await postsOut(env, results.slice(0, 25), user);
  return json({
    query: q,
    total: total?.n ?? 0,
    facets: {
      type: Object.fromEntries(typeFacet.map((r) => [r.k, r.n])),
      outcome: Object.fromEntries(outcomeFacet.filter((r) => r.k !== "untriggered").map((r) => [r.k, r.n])),
      posted: { week: postedFacet?.week ?? 0, "90d": postedFacet?.d90 ?? 0, any: postedFacet?.any ?? 0 },
    },
    results: posts.map((p, i) => ({ ...p, snippet: snippet(results[i].body ?? "", q.terms) })),
    next_offset: results.length > 25 ? offset + 25 : null,
  });
}

// ── Profiles ────────────────────────────────────────────────────────────

const REASON_LABELS = ["thesis", "risk", "data", "view"];

async function userByName(env: Env, name: string): Promise<Row> {
  const u = await env.DB.prepare("SELECT id, name, bio, role, created_at FROM users WHERE name_key = ?").bind(str(name).toLowerCase()).first<Row>();
  if (!u) throw new HttpError(404, "No such member.");
  return u;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** GET /users/:name — the profile: the record and everything behind it. */
export async function profile(env: Env, user: User | null, name: string): Promise<Response> {
  const u = await userByName(env, name);
  const live = "p.author_id = ? AND p.deleted = 0 AND p.removed = 0";
  const rec = await env.DB.prepare(`SELECT ${RECORD_COLUMNS} FROM posts p WHERE ${live} AND p.type = 'idea'`).bind(u.id).first<Row>();
  const { results: settled } = await env.DB.prepare(
    `SELECT p.id, p.status, p.result_r, p.resolved_at, p.triggered_at, p.direction FROM posts p
      WHERE ${live} AND p.type = 'idea' AND p.status IN ('target','stopped','expired') ORDER BY p.resolved_at`,
  )
    .bind(u.id)
    .all<Row>();
  let acc = 0;
  const curve = settled.map((s) => ({ at: s.resolved_at, r: round2((acc += s.result_r ?? 0)), result: s.result_r }));
  const hold = median(settled.filter((s) => s.triggered_at).map((s) => (s.resolved_at - s.triggered_at) / DAY));
  const { results: typeCounts } = await env.DB.prepare(`SELECT p.type, COUNT(*) AS n FROM posts p WHERE ${live} GROUP BY p.type`).bind(u.id).all<{ type: string; n: number }>();
  const replies = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND deleted = 0 AND removed = 0").bind(u.id).first<{ n: number }>();
  const { results: reasons } = await env.DB.prepare(
    `SELECT r.reason, COUNT(*) AS n FROM ratings r JOIN posts p ON p.id = r.target_id AND r.target_type = 'post' WHERE ${live} AND r.reason <> 'vague' GROUP BY r.reason`,
  )
    .bind(u.id)
    .all<{ reason: string; n: number }>();
  const { results: dirs } = await env.DB.prepare(`SELECT p.direction, ${RECORD_COLUMNS} FROM posts p WHERE ${live} AND p.type = 'idea' GROUP BY p.direction`).bind(u.id).all<Row>();
  const { results: tickers } = await env.DB.prepare(
    `SELECT p.community_id AS id, COUNT(*) AS n FROM posts p WHERE ${live} AND p.community_id LIKE 't:%' GROUP BY p.community_id ORDER BY n DESC LIMIT 5`,
  )
    .bind(u.id)
    .all<Row>();
  const watching = !!user && !!(await env.DB.prepare("SELECT 1 FROM watches WHERE user_id = ? AND author_id = ?").bind(user.id, u.id).first());
  const outcomes = { target: 0, stopped: 0, expired: 0 } as Record<string, number>;
  for (const s of settled) outcomes[s.status]++;
  return json({
    user: { name: u.name, bio: u.bio, created_at: u.created_at, bot: u.role === "bot" },
    record: recordOf(rec),
    median_hold_days: hold == null ? null : Math.round(hold),
    first_resolved_at: settled[0]?.resolved_at ?? null,
    curve,
    outcomes,
    counts: { ...Object.fromEntries(typeCounts.map((t) => [t.type, t.n])), replies: replies?.n ?? 0 },
    reasons: REASON_LABELS.map((r) => ({ reason: r, n: reasons.find((x) => x.reason === r)?.n ?? 0 })).sort((a, b) => b.n - a.n),
    by_direction: dirs.filter((d) => d.direction).map((d) => ({ direction: d.direction, ...recordOf(d) })),
    tickers: tickers.map((t) => ({ ticker: t.id.slice(2), n: t.n })),
    watching,
    own: !!user && user.id === u.id,
  });
}

/** GET /users/:name/posts?type=&offset= — the profile's tabs (all ideas, winners and losers). */
export async function userPosts(env: Env, user: User | null, name: string, url: URL): Promise<Response> {
  const u = await userByName(env, name);
  const type = url.searchParams.get("type") ?? "idea";
  if (!(POST_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Unknown type.");
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 8));
  const { results } = await env.DB.prepare(`${POST_SELECT} WHERE p.author_id = ? AND p.type = ? AND p.deleted = 0 AND p.removed = 0 ORDER BY p.created_at DESC LIMIT ? OFFSET ?`)
    .bind(u.id, type, limit + 1, offset)
    .all<Row>();
  return json({ posts: await postsOut(env, results.slice(0, limit), user), next_offset: results.length > limit ? offset + limit : null });
}

/** GET /users/:name/replies?offset= */
export async function userReplies(env: Env, name: string, url: URL): Promise<Response> {
  const u = await userByName(env, name);
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.post_id, c.body, c.kind, c.useful_count, c.created_at, p.title AS post_title, p.community_id FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE c.author_id = ? AND c.deleted = 0 AND c.removed = 0 AND p.removed = 0 ORDER BY c.created_at DESC LIMIT 26 OFFSET ?`,
  )
    .bind(u.id, offset)
    .all<Row>();
  return json({ replies: results.slice(0, 25).map((r) => ({ ...r, body: str(r.body).slice(0, 240) })), next_offset: results.length > 25 ? offset + 25 : null });
}

/** POST / DELETE /users/:name/watch — "Notify me of new ideas". */
export async function watch(env: Env, user: User | null, name: string, on: boolean): Promise<Response> {
  const me = requireUser(user);
  const u = await userByName(env, name);
  if (u.id === me.id) throw new HttpError(400, "That's you.");
  await (on
    ? env.DB.prepare("INSERT OR IGNORE INTO watches (user_id, author_id, created_at) VALUES (?, ?, ?)").bind(me.id, u.id, now())
    : env.DB.prepare("DELETE FROM watches WHERE user_id = ? AND author_id = ?").bind(me.id, u.id)
  ).run();
  return json({ watching: on });
}
