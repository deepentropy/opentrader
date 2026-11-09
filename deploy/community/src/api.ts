/*
 * The community API: ticker communities and General, posts (ideas, analysis,
 * questions, post-mortems), replies, the readers' "useful" ratings, reports,
 * the moderation queue and the account. Reading needs no account; writing
 * needs a session (auth.ts) and an account that isn't banned. The pages'
 * views (home, ticker, search, profile) are in views.ts.
 */
import { Env } from "./env";
import { User } from "./auth";
import { SharedChart, deleteImages, parseChart, parseImage, saveImage } from "./charts";
import { requirePostingCheck } from "./check";
import { broadcast } from "./live";
import { notBannedIn } from "./members";
import { notify, notifyStatement } from "./notify";
import { IdeaRecord, emptyRecord, openingState, parseIdea, quotes, recordsOf, reference, rewardRisk, rMultiple, round2 } from "./ideas";
import { takeSnapshot } from "./snapshots";
import { cancelForDeletedAccount } from "./billing";
import { GITHUB_REPO, HttpError, LIMITS, NAME_RE, REPORT_REASONS, SUGGESTIONS, hotRank, json, newId, now, parseCommunityId, senderHash, sha256Hex, str } from "./util";

type Row = Record<string, any>;

export function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, "Sign in to do this.");
  return user;
}

/** A signed-in user allowed to write. */
export function writer(user: User | null): User {
  const u = requireUser(user);
  if (u.banned_until && u.banned_until > now()) {
    const until = u.banned_until > 4_000_000_000 ? "permanently" : `until ${new Date(u.banned_until * 1000).toISOString().slice(0, 10)}`;
    throw new HttpError(403, `Your account is banned ${until}. Reason: ${u.ban_reason || "not given"}.`);
  }
  return u;
}

export async function isMod(env: Env, user: User | null, communityId: string): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!(await env.DB.prepare("SELECT 1 FROM moderators WHERE community_id = ? AND user_id = ?").bind(communityId, user.id).first());
}

async function moderated(env: Env, user: User): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT community_id FROM moderators WHERE user_id = ?").bind(user.id).all<{ community_id: string }>();
  return results.map((r) => r.community_id);
}

function text(v: unknown, field: string, min: number, max: number): string {
  const s = str(v).trim();
  if (s.length < min) throw new HttpError(400, min > 1 ? `${field} needs at least ${min} characters.` : `${field} is empty.`);
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max} characters.`);
  return s;
}

// ── Communities ─────────────────────────────────────────────────────────

/** Where posts go: a US stock or ETF ticker, or General. */
export const GENERAL = "c:general";

function communityOut(row: Row, followed: boolean, mod: boolean) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    post_count: row.post_count,
    min_account_days: row.min_account_days,
    followed,
    is_mod: mod,
  };
}

/** The community row; a ticker community is a virtual one until its first post or follower. */
export async function findCommunity(env: Env, id: string): Promise<Row> {
  const parsed = parseCommunityId(id);
  if (!parsed) throw new HttpError(404, "No such community.");
  const cid = parsed.kind === "ticker" ? `t:${parsed.key}` : `c:${parsed.key}`;
  const row = await env.DB.prepare("SELECT * FROM communities WHERE id = ?").bind(cid).first<Row>();
  if (row) return row;
  if (parsed.kind === "theme") throw new HttpError(404, "No such community.");
  return { id: cid, kind: "ticker", title: `$${parsed.key}`, description: "", post_count: 0, min_account_days: 0, virtual: true };
}

/** Known checks are kept a month, unknown ones a day (a new listing). */
const KNOWN_TTL = 30 * 86_400;
const UNKNOWN_TTL = 86_400;

/** The market data lists this ticker among US stocks and ETFs. No gateway, or no answer: assumed known. */
async function tickerKnown(env: Env, ticker: string): Promise<boolean> {
  if (!env.GATEWAY_URL || !env.GATEWAY_TOKEN) return true;
  const cached = await env.DB.prepare("SELECT known, checked_at FROM ticker_checks WHERE ticker = ?").bind(ticker).first<{ known: number; checked_at: number }>();
  if (cached && now() - cached.checked_at < (cached.known ? KNOWN_TTL : UNKNOWN_TTL)) return !!cached.known;
  let known: boolean;
  try {
    known = !!(await reference(env, ticker));
  } catch {
    // Anything but an answer: the community is allowed (not kept).
    return true;
  }
  await env.DB.prepare("INSERT INTO ticker_checks (ticker, known, checked_at) VALUES (?, ?, ?) ON CONFLICT (ticker) DO UPDATE SET known = excluded.known, checked_at = excluded.checked_at")
    .bind(ticker, known ? 1 : 0, now())
    .run();
  return known;
}

export async function ensureCommunity(env: Env, id: string): Promise<Row> {
  const row = await findCommunity(env, id);
  if (row.virtual) {
    const ticker = row.id.slice(2);
    if (!(await tickerKnown(env, ticker))) throw new HttpError(404, `$${ticker} isn't a US stock or ETF.`);
    await env.DB.prepare("INSERT OR IGNORE INTO communities (id, kind, title, created_at) VALUES (?, 'ticker', ?, ?)").bind(row.id, row.title, now()).run();
    delete row.virtual;
  }
  return row;
}

/** GET /communities/:id */
export async function getCommunity(env: Env, user: User | null, id: string): Promise<Response> {
  const row = await findCommunity(env, id);
  const followed = !!user && !row.virtual && !!(await env.DB.prepare("SELECT 1 FROM follows WHERE user_id = ? AND community_id = ?").bind(user.id, row.id).first());
  return json({ community: communityOut(row, followed, await isMod(env, user, row.id)) });
}

/** POST / DELETE /communities/:id/follow — "my tickers". */
export async function follow(env: Env, user: User | null, id: string, on: boolean): Promise<Response> {
  const u = requireUser(user);
  if (on) {
    const row = await ensureCommunity(env, id);
    await env.DB.prepare("INSERT OR IGNORE INTO follows (user_id, community_id, created_at) VALUES (?, ?, ?)").bind(u.id, row.id, now()).run();
  } else {
    const row = await findCommunity(env, id);
    await env.DB.prepare("DELETE FROM follows WHERE user_id = ? AND community_id = ?").bind(u.id, row.id).run();
  }
  return json({ ok: true });
}

const MAX_TICKERS = 100;

/** PUT /me/tickers {tickers} — the app's watchlist becomes the member's tickers. */
export async function setTickers(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  const list = Array.isArray(body?.tickers) ? body.tickers : null;
  if (!list) throw new HttpError(400, "tickers is a list.");
  const ids = [...new Set<string>(list.map((t: unknown) => `t:${str(t).trim().toUpperCase()}`))].filter((id) => parseCommunityId(id)).slice(0, MAX_TICKERS);
  const kept: string[] = [];
  for (const id of ids) {
    try {
      kept.push((await ensureCommunity(env, id)).id);
    } catch {
      // Not a US stock or ETF (crypto, futures, indexes): not a community.
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM follows WHERE user_id = ? AND community_id LIKE 't:%'").bind(u.id),
    ...kept.map((id) => env.DB.prepare("INSERT OR IGNORE INTO follows (user_id, community_id, created_at) VALUES (?, ?, ?)").bind(u.id, id, now())),
  ]);
  return me(env, u);
}

// ── Posts ───────────────────────────────────────────────────────────────

export const POST_TYPES = ["idea", "analysis", "question", "postmortem"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_SELECT = `SELECT p.*, u.name AS author_name, u.role AS author_role, c.title AS community_title, c.kind AS community_kind,
    l.status AS linked_status, l.result_r AS linked_r, l.title AS linked_title
  FROM posts p
  JOIN communities c ON c.id = p.community_id
  LEFT JOIN users u ON u.id = p.author_id
  LEFT JOIN posts l ON l.id = p.linked_id`;

/** The idea part of a post: levels, where it stands, and its R now (open) or final. */
export function ideaOut(r: Row) {
  if (r.type !== "idea" || !r.direction) return null;
  const open = r.status === "open";
  return {
    direction: r.direction,
    entry: r.entry,
    stop: r.stop,
    target: r.target,
    expires: r.expires,
    entry_rule: r.entry_rule,
    /** The price when posted: the entry triggers when price crosses it from this side. */
    ref_price: r.ref_price,
    reward_risk: rewardRisk(r as any),
    status: r.status,
    triggered_at: r.triggered_at,
    trigger_price: r.trigger_price,
    resolved_at: r.resolved_at,
    exit_price: r.exit_price,
    last_price: r.last_price,
    result_r: r.result_r ?? (open && r.last_price ? round2(rMultiple(r.direction, r.entry, r.stop, r.last_price)) : null),
  };
}

export const SUGGESTION_STATUSES = ["review", "planned", "progress", "shipped", "declined"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** A suggestion's status, the administrators' note, its GitHub issue, and who asked on GitHub (imported ones). */
export function suggestionOut(r: Row) {
  if (!r.sg_status) return null;
  return {
    status: r.sg_status as SuggestionStatus,
    note: r.sg_note ?? null,
    updated_at: r.sg_updated_at ?? null,
    issue_number: r.issue_number ?? null,
    issue_url: r.issue_number ? `https://github.com/${GITHUB_REPO}/issues/${r.issue_number}` : null,
    external_author: r.external_author ?? null,
  };
}

export function postOut(r: Row, viewer: User | null, mod: boolean, withBody = true, record?: IdeaRecord) {
  const own = !!viewer && r.author_id === viewer.id;
  const hidden = !!r.removed && !own && !mod;
  const shown = !hidden && !r.deleted;
  let chart: SharedChart | null = null;
  if (shown && r.chart) chart = JSON.parse(r.chart);
  return {
    id: r.id,
    type: (r.type ?? "analysis") as PostType,
    community: { id: r.community_id, title: r.community_title, kind: r.community_kind },
    author: r.deleted ? null : r.author_name ?? null,
    author_record: r.deleted || !record ? null : { resolved: record.resolved, hit_pct: record.hit_pct, avg_r: record.avg_r, open: record.open },
    title: hidden ? "[Removed by moderators]" : r.title,
    body: withBody && shown ? r.body : "",
    excerpt: shown ? str(r.body).slice(0, 240) : "",
    useful_count: r.useful_count ?? 0,
    flag_count: r.flag_count ?? 0,
    comment_count: r.comment_count,
    created_at: r.created_at,
    edited_at: r.edited_at,
    locked: !!r.locked,
    deleted: !!r.deleted,
    removed: !!r.removed,
    removed_reason: r.removed && (own || mod) ? r.removed_reason : null,
    own,
    source_url: r.source_url ?? null,
    /** Posted by the automatic threads' account. */
    author_bot: r.author_role === "bot",
    idea: shown ? ideaOut(r) : null,
    suggestion: suggestionOut(r),
    answer_id: r.answer_id ?? null,
    linked: r.linked_id ? { id: r.linked_id, title: r.linked_title ?? null, status: r.linked_status ?? null, result_r: r.linked_r ?? null } : null,
    // The shared chart: its state in the post (lists: symbol and interval only), its picture as a path on this server.
    chart: withBody ? chart : chart ? { symbol: chart.symbol, interval: chart.interval, drawings: [] } : null,
    has_chart: shown && !!r.chart,
    image_url: shown && r.has_image ? `/images/${r.id}` : null,
  };
}

/** Post rows with their authors' records, as sent. */
export async function postsOut(env: Env, rows: Row[], user: User | null): Promise<ReturnType<typeof postOut>[]> {
  const records = await recordsOf(env, rows.map((r) => r.author_id));
  return rows.map((r) => postOut(r, user, false, false, r.author_id ? records.get(r.author_id) ?? emptyRecord() : undefined));
}

export function order(sort: string): string {
  return sort === "useful" ? "p.useful_count DESC, p.created_at DESC" : "p.created_at DESC";
}

async function listPosts(env: Env, user: User | null, where: string, binds: unknown[], url: URL) {
  const sort = url.searchParams.get("sort") ?? "new";
  const offset = Math.max(0, Math.min(10_000, Number(url.searchParams.get("offset")) || 0));
  const type = url.searchParams.get("type");
  const typed = type && (POST_TYPES as readonly string[]).includes(type);
  const { results } = await env.DB.prepare(
    `${POST_SELECT} WHERE ${where} AND p.removed = 0 AND p.deleted = 0 ${typed ? "AND p.type = ?" : ""} ORDER BY ${order(sort)} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, ...(typed ? [type] : []), LIMITS.pageSize + 1, offset)
    .all<Row>();
  const more = results.length > LIMITS.pageSize;
  return {
    posts: await postsOut(env, results.slice(0, LIMITS.pageSize), user),
    next_offset: more ? offset + LIMITS.pageSize : null,
  };
}

/** GET /communities/:id/posts?sort=new|useful&type=…&offset=… */
export async function communityPosts(env: Env, user: User | null, id: string, url: URL): Promise<Response> {
  const row = await findCommunity(env, id);
  if (row.virtual) return json({ posts: [], next_offset: null });
  return json(await listPosts(env, user, "p.community_id = ?", [row.id], url));
}

/** GET /feed?scope=following|all&sort=…&type=… — the app panel's lists. */
export async function feed(env: Env, user: User | null, url: URL): Promise<Response> {
  if (url.searchParams.get("scope") === "following") {
    const u = requireUser(user);
    return json(await listPosts(env, user, "p.community_id IN (SELECT community_id FROM follows WHERE user_id = ?) AND p.community_id <> ?", [u.id, SUGGESTIONS], url));
  }
  // Suggestions have their own page.
  return json(await listPosts(env, user, "p.community_id <> ?", [SUGGESTIONS], url));
}

/** Posts and comments a connection may send a day, whatever the account. */
const PER_CONNECTION = { posts: 30, comments: 300 } as const;

async function rateLimit(env: Env, u: User, table: "posts" | "comments", sender: string): Promise<void> {
  if (u.role === "admin") return;
  const fromHere = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sender_hash = ? AND created_at >= ?`).bind(sender, now() - 86_400).first<{ n: number }>();
  if ((fromHere?.n ?? 0) >= PER_CONNECTION[table]) throw new HttpError(429, `Too many ${table} from your connection today. Try again tomorrow.`);
  const young = now() - u.created_at < LIMITS.newAccountSeconds;
  const max = table === "posts" ? (young ? LIMITS.postsPerDayNew : LIMITS.postsPerDay) : young ? LIMITS.commentsPerDayNew : LIMITS.commentsPerDay;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE author_id = ? AND created_at >= ?`).bind(u.id, now() - 86_400).first<{ n: number }>();
  if ((row?.n ?? 0) >= max) {
    throw new HttpError(429, `You reached today's limit of ${max} ${table}${young ? " for new accounts" : ""}. Try again later.`);
  }
}

/** The text that identifies a post's content: title and text, lowercase, without spacing or punctuation. */
export function contentKey(title: string, body: string): string {
  return `${title}\n${body}`.toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, " ").trim();
}

/** Accounts posting the same text within this time: coordinated promotion, sent to the moderators. */
const SAME_TEXT_WINDOW = 86_400;
const SAME_TEXT_AUTHORS = 3;

/** The chart attached to a post or a reply: a snapshot sent from the app earlier, or one sent with it. */
async function attachment(env: Env, u: User, body: any): Promise<{ chart: SharedChart | null; image: { bytes: Uint8Array; type: string } | null }> {
  const snapshotId = str(body?.snapshot_id);
  if (snapshotId) {
    const s = await takeSnapshot(env, u, snapshotId);
    return { chart: s.chart, image: s.image };
  }
  return { chart: parseChart(body?.chart), image: parseImage(body?.image, body?.image_type) };
}

/** POST /communities/:id/posts {type, title, body, idea?, linked_id?, snapshot_id? | chart+image} */
export async function createPost(env: Env, user: User | null, request: Request, id: string, body: any): Promise<Response> {
  const u = writer(user);
  // Apps from before post types send none: an analysis; their theme communities are General now.
  const type = (str(body?.type) || "analysis") as PostType | "suggestion";
  // A suggestion goes to Suggestions, and only a suggestion does (suggestions.ts).
  const suggestion = type === "suggestion";
  if (suggestion !== (id === SUGGESTIONS)) throw new HttpError(400, "Suggestions go on the Suggestions page.");
  if (!suggestion && !(POST_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Pick what kind of post this is.");
  if (id.startsWith("c:") && !suggestion) id = GENERAL;
  const title = text(body?.title, "The title", LIMITS.titleMin, LIMITS.titleMax);
  const content = str(body?.body).trim();
  if (content.length > LIMITS.bodyMax) throw new HttpError(400, `The text is longer than ${LIMITS.bodyMax} characters.`);
  if (!id.startsWith("t:") && id !== GENERAL && !suggestion) throw new HttpError(400, "Post on a ticker, or in General.");
  const community = await ensureCommunity(env, id);
  await notBannedIn(env, u, community.id);
  requirePostingCheck(env, u);
  const ageDays = (now() - u.created_at) / 86_400;
  if (ageDays < community.min_account_days && !(await isMod(env, u, community.id))) {
    throw new HttpError(403, `Posting in ${community.title} needs an account at least ${community.min_account_days} days old.`);
  }
  const at = now();
  // An idea: its levels against the price now.
  let idea: Row = {};
  if (type === "idea") {
    if (!community.id.startsWith("t:")) throw new HttpError(400, "An idea is on a ticker.");
    const ticker = community.id.slice(2);
    const q = (await quotes(env, [ticker]).catch(() => new Map())).get(ticker);
    if (!q) throw new HttpError(503, `No price for $${ticker} right now, so the idea can't be tracked. Try again later.`);
    const levels = parseIdea(body?.idea, q.last, at);
    idea = { ...levels, ...openingState(levels, q.last, at), last_price: q.last };
  }
  let linked: string | null = null;
  if (type === "postmortem" && str(body?.linked_id)) {
    const l = await env.DB.prepare("SELECT id, author_id, type FROM posts WHERE id = ?").bind(str(body.linked_id)).first<Row>();
    if (!l || l.author_id !== u.id || l.type !== "idea") throw new HttpError(400, "A post-mortem links one of your own ideas.");
    linked = l.id;
  }
  const { chart, image } = await attachment(env, u, body);
  const sender = await senderHash(request);
  await rateLimit(env, u, "posts", sender);
  const contentHash = await sha256Hex(contentKey(title, content));
  const repeat = await env.DB.prepare("SELECT 1 FROM posts WHERE author_id = ? AND content_hash = ? AND created_at >= ? AND deleted = 0")
    .bind(u.id, contentHash, now() - 7 * 86_400)
    .first();
  if (repeat) throw new HttpError(409, suggestion ? "You already suggested this." : "You already posted this text. Post it once, on the ticker it fits best.");
  const postId = newId();
  if (image) await saveImage(env, postId, image);
  const cols: Row = {
    id: postId, community_id: community.id, author_id: u.id, title, body: content, score: 0, hot: hotRank(0, at), created_at: at,
    chart: chart ? JSON.stringify(chart) : null, has_image: image ? 1 : 0, sender_hash: sender, content_hash: contentHash,
    type, linked_id: linked, ...idea,
    // Its author is its first supporter.
    ...(suggestion ? { sg_status: "review", sg_updated_at: at, useful_count: 1 } : {}),
  };
  const keys = Object.keys(cols);
  const watchers = type === "idea"
    ? (await env.DB.prepare("SELECT user_id FROM watches WHERE author_id = ?").bind(u.id).all<{ user_id: string }>()).results
    : [];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO posts (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => cols[k])),
    env.DB.prepare("UPDATE communities SET post_count = post_count + 1 WHERE id = ?").bind(community.id),
    ...(suggestion ? [env.DB.prepare("INSERT INTO ratings (user_id, target_type, target_id, reason, created_at) VALUES (?, 'post', ?, 'support', ?)").bind(u.id, postId, at)] : []),
    // "Notify me of new ideas".
    ...watchers.map((w) => notifyStatement(env, w.user_id, { kind: "idea", postId, actor: u.name, text: title })!),
  ]);
  await flagSameText(env, contentHash);
  return getPost(env, user, postId, 201);
}

/** The same text from several accounts in a day: each copy goes to the moderation queue (a report with no reporter). */
async function flagSameText(env: Env, contentHash: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, community_id, author_id FROM posts WHERE content_hash = ? AND created_at >= ? AND removed = 0 AND deleted = 0",
  )
    .bind(contentHash, now() - SAME_TEXT_WINDOW)
    .all<{ id: string; community_id: string; author_id: string | null }>();
  const authors = new Set(results.map((r) => r.author_id));
  if (authors.size < SAME_TEXT_AUTHORS) return;
  const details = `The same text was posted by ${authors.size} accounts within 24 hours (possible coordinated promotion).`;
  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare(
        `INSERT INTO reports (id, target_type, target_id, community_id, reporter_id, reason, details, created_at)
         SELECT ?, 'post', ?, ?, NULL, 'spam', ?, ? WHERE NOT EXISTS
           (SELECT 1 FROM reports WHERE target_type = 'post' AND target_id = ? AND reporter_id IS NULL AND status = 'open')`,
      ).bind(newId(), r.id, r.community_id, details, now(), r.id),
    ),
  );
}

export async function postRow(env: Env, id: string): Promise<Row> {
  const row = await env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(id).first<Row>();
  if (!row) throw new HttpError(404, "This post doesn't exist.");
  return row;
}

function commentOut(r: Row, viewer: User | null, mod: boolean, postAuthor: string | null, record?: IdeaRecord) {
  const own = !!viewer && r.author_id === viewer.id;
  const hidden = !!r.removed && !own && !mod;
  const shown = !hidden && !r.deleted;
  return {
    id: r.id,
    parent_id: r.parent_id,
    author: r.deleted ? null : r.author_name ?? null,
    author_record: r.deleted || !record ? null : { resolved: record.resolved, hit_pct: record.hit_pct, avg_r: record.avg_r, open: record.open },
    /** Written by the post's author. */
    by_op: !r.deleted && !!postAuthor && r.author_id === postAuthor,
    kind: r.kind ?? null,
    body: shown ? r.body : "",
    useful_count: r.useful_count ?? 0,
    my_useful: !!r.my_useful,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted: !!r.deleted,
    removed: !!r.removed,
    removed_reason: r.removed && (own || mod) ? r.removed_reason : null,
    own,
    chart: shown && r.chart ? JSON.parse(r.chart) : null,
    image_url: shown && r.has_image ? `/images/c/${r.id}` : null,
  };
}

/** How many readers gave each reason, and the viewer's. */
async function postRatings(env: Env, postId: string, user: User | null) {
  const { results } = await env.DB.prepare("SELECT reason, COUNT(*) AS n FROM ratings WHERE target_type = 'post' AND target_id = ? GROUP BY reason").bind(postId).all<{ reason: string; n: number }>();
  const mine = user
    ? (await env.DB.prepare("SELECT reason FROM ratings WHERE user_id = ? AND target_type = 'post' AND target_id = ?").bind(user.id, postId).all<{ reason: string }>()).results.map((r) => r.reason)
    : [];
  return { reasons: Object.fromEntries(results.map((r) => [r.reason, r.n])), mine };
}

/** GET /posts/:id — the post, its replies (the client builds the tree), the viewer's ratings (a suggestion: whether the viewer supports it). */
export async function getPost(env: Env, user: User | null, id: string, status = 200): Promise<Response> {
  const row = await postRow(env, id);
  const mod = await isMod(env, user, row.community_id);
  const { results } = await env.DB.prepare(
    `SELECT c.*, u.name AS author_name, r.reason IS NOT NULL AS my_useful FROM comments c
       LEFT JOIN users u ON u.id = c.author_id
       LEFT JOIN ratings r ON r.user_id = ? AND r.target_type = 'comment' AND r.target_id = c.id AND r.reason = 'useful'
      WHERE c.post_id = ? ORDER BY c.created_at LIMIT ?`,
  )
    .bind(user?.id ?? "", id, LIMITS.commentsPerPost)
    .all<Row>();
  const records = await recordsOf(env, [row.author_id, ...results.map((c) => c.author_id)]);
  const rec = (a: string | null) => (a ? records.get(a) ?? emptyRecord() : undefined);
  return json(
    {
      post: postOut(row, user, mod, true, rec(row.author_id)),
      comments: results.map((c) => commentOut(c, user, mod, row.author_id, rec(c.author_id))),
      ratings: await postRatings(env, id, user),
      is_mod: mod,
      ...(row.sg_status ? { supported: !!user && !!(await env.DB.prepare("SELECT 1 FROM ratings WHERE user_id = ? AND target_type = 'post' AND target_id = ? AND reason = 'support'").bind(user.id, id).first()) } : {}),
    },
    status,
  );
}

/** PATCH /posts/:id {body} — the author edits the text (the title and an idea's levels stay). */
export async function editPost(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const row = await postRow(env, id);
  if (row.author_id !== u.id || row.deleted || row.removed) throw new HttpError(403, "You can't edit this post.");
  const content = str(body?.body).trim();
  if (content.length > LIMITS.bodyMax) throw new HttpError(400, `The text is longer than ${LIMITS.bodyMax} characters.`);
  await env.DB.prepare("UPDATE posts SET body = ?, edited_at = ? WHERE id = ?").bind(content, now(), id).run();
  return getPost(env, user, id);
}

/** DELETE /posts/:id — by its author: the text and name go, the comments stay. An idea stays in its author's record. */
export async function deletePost(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireUser(user);
  const row = await postRow(env, id);
  if (row.author_id !== u.id) throw new HttpError(403, "You can't delete this post.");
  if (row.type === "idea" && row.status && row.status !== "untriggered" && row.status !== "pending") {
    throw new HttpError(403, "A triggered idea stays in your record: edit its text, or add an update.");
  }
  if (!row.deleted) {
    if (row.has_image) await deleteImages(env, [id]);
    await env.DB.batch([
      env.DB.prepare("UPDATE posts SET deleted = 1, body = '', chart = NULL, has_image = 0 WHERE id = ?").bind(id),
      env.DB.prepare("UPDATE communities SET post_count = MAX(post_count - 1, 0) WHERE id = ?").bind(row.community_id),
    ]);
  }
  return json({ ok: true });
}

/** POST /posts/:id/answer {comment_id | null} — the asker marks the reply that answers the question. */
export async function markAnswer(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const row = await postRow(env, id);
  if (row.author_id !== u.id || row.type !== "question") throw new HttpError(403, "Only the person who asked marks the answer.");
  const commentId = str(body?.comment_id) || null;
  if (commentId) {
    const c = await env.DB.prepare("SELECT post_id, deleted, removed FROM comments WHERE id = ?").bind(commentId).first<Row>();
    if (!c || c.post_id !== id || c.deleted || c.removed) throw new HttpError(400, "This reply isn't in the question.");
  }
  await env.DB.prepare("UPDATE posts SET answer_id = ? WHERE id = ?").bind(commentId, id).run();
  return json({ answer_id: commentId });
}

// ── Comments ────────────────────────────────────────────────────────────

/** 'support': why a supporter needs a suggestion (suggestions.ts). */
export const REPLY_KINDS = ["data", "counterpoint", "question", "update", "support"] as const;

/** POST /posts/:id/comments {body, parent_id?, kind?, snapshot_id? | chart+image} */
export async function createComment(env: Env, user: User | null, request: Request, postId: string, body: any, ctx?: ExecutionContext): Promise<Response> {
  const u = writer(user);
  const post = await postRow(env, postId);
  if (post.deleted || post.removed) throw new HttpError(403, "This post no longer takes comments.");
  if (post.locked && !(await isMod(env, u, post.community_id))) throw new HttpError(403, "This post is locked: no new comments.");
  await notBannedIn(env, u, post.community_id);
  requirePostingCheck(env, u);
  const content = text(body?.body, "The comment", 1, LIMITS.commentMax);
  const kind = str(body?.kind) || null;
  if (kind && !(REPLY_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "Unknown kind of reply.");
  if (kind === "update" && post.author_id !== u.id) throw new HttpError(400, "Updates are by the post's author.");
  if (kind === "support" && !post.sg_status) throw new HttpError(400, "Unknown kind of reply.");
  const parentId = str(body?.parent_id) || null;
  let parentAuthor: string | null = null;
  if (parentId) {
    const parent = await env.DB.prepare("SELECT post_id, author_id FROM comments WHERE id = ?").bind(parentId).first<{ post_id: string; author_id: string | null }>();
    if (!parent || parent.post_id !== postId) throw new HttpError(400, "The comment you reply to isn't in this post.");
    parentAuthor = parent.author_id;
  }
  const { chart, image } = await attachment(env, u, body);
  const sender = await senderHash(request);
  await rateLimit(env, u, "comments", sender);
  const id = newId();
  if (image) await saveImage(env, id, image, "comments");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO comments (id, post_id, parent_id, author_id, body, score, created_at, sender_hash, kind, chart, has_image) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)").bind(
      id, postId, parentId, u.id, content, now(), sender, kind, chart ? JSON.stringify(chart) : null, image ? 1 : 0,
    ),
    env.DB.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?").bind(postId),
  ]);
  const row = await env.DB.prepare("SELECT c.*, ? AS author_name, 0 AS my_useful FROM comments c WHERE c.id = ?").bind(u.name, id).first<Row>();
  const record = (await recordsOf(env, [u.id])).get(u.id) ?? emptyRecord();
  // The person replied to hears of it; the post's readers see it come in.
  const to = parentId ? parentAuthor : post.author_id;
  if (to && to !== u.id) await notify(env, to, { kind: "reply", postId, commentId: id, actor: u.name, text: content.slice(0, 200) });
  const live = broadcast(env, postId, { type: "comment", comment: commentOut(row!, null, false, post.author_id, record) });
  if (ctx) ctx.waitUntil(live);
  else await live;
  return json({ comment: commentOut(row!, u, false, post.author_id, record) }, 201);
}

async function commentRow(env: Env, id: string): Promise<Row> {
  const row = await env.DB.prepare("SELECT c.*, p.community_id, p.author_id AS post_author FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?").bind(id).first<Row>();
  if (!row) throw new HttpError(404, "This comment doesn't exist.");
  return row;
}

/** PATCH /comments/:id {body} */
export async function editComment(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const row = await commentRow(env, id);
  if (row.author_id !== u.id || row.deleted || row.removed) throw new HttpError(403, "You can't edit this comment.");
  const content = text(body?.body, "The comment", 1, LIMITS.commentMax);
  await env.DB.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").bind(content, now(), id).run();
  return json({ comment: commentOut({ ...row, body: content, edited_at: now(), author_name: u.name }, u, false, row.post_author) });
}

/** DELETE /comments/:id — by its author; the replies stay. */
export async function deleteComment(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireUser(user);
  const row = await commentRow(env, id);
  if (row.author_id !== u.id) throw new HttpError(403, "You can't delete this comment.");
  if (row.has_image) await deleteImages(env, [id], "comments");
  await env.DB.prepare("UPDATE comments SET deleted = 1, body = '', chart = NULL, has_image = 0 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ── Ratings ─────────────────────────────────────────────────────────────

/** Why a post was useful; 'vague': it wasn't. */
export const REASONS = ["thesis", "data", "view", "risk", "vague"] as const;

/** POST /posts/:id/rate {reason, on} — a reason on or off; "vague" and the useful reasons exclude each other. */
export async function ratePost(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const reason = str(body?.reason);
  if (!(REASONS as readonly string[]).includes(reason)) throw new HttpError(400, "Unknown reason.");
  const post = await postRow(env, id);
  if (post.deleted || post.removed) throw new HttpError(403, "This post can't be rated.");
  if (post.sg_status) throw new HttpError(400, "Support the suggestion instead.");
  if (post.author_id === u.id) throw new HttpError(403, "Readers rate a post, not its author.");
  await notBannedIn(env, u, post.community_id);
  const on = body?.on !== false;
  const stmts: D1PreparedStatement[] = [];
  if (on) {
    stmts.push(
      reason === "vague"
        ? env.DB.prepare("DELETE FROM ratings WHERE user_id = ? AND target_type = 'post' AND target_id = ? AND reason <> 'vague'").bind(u.id, id)
        : env.DB.prepare("DELETE FROM ratings WHERE user_id = ? AND target_type = 'post' AND target_id = ? AND reason = 'vague'").bind(u.id, id),
      env.DB.prepare("INSERT OR IGNORE INTO ratings (user_id, target_type, target_id, reason, created_at) VALUES (?, 'post', ?, ?, ?)").bind(u.id, id, reason, now()),
    );
  } else {
    stmts.push(env.DB.prepare("DELETE FROM ratings WHERE user_id = ? AND target_type = 'post' AND target_id = ? AND reason = ?").bind(u.id, id, reason));
  }
  stmts.push(
    env.DB.prepare(
      `UPDATE posts SET
         useful_count = (SELECT COUNT(DISTINCT user_id) FROM ratings WHERE target_type = 'post' AND target_id = ?1 AND reason <> 'vague'),
         flag_count = (SELECT COUNT(*) FROM ratings WHERE target_type = 'post' AND target_id = ?1 AND reason = 'vague')
       WHERE id = ?1`,
    ).bind(id),
  );
  await env.DB.batch(stmts);
  const counts = await env.DB.prepare("SELECT useful_count, flag_count FROM posts WHERE id = ?").bind(id).first<Row>();
  return json({ useful_count: counts!.useful_count, flag_count: counts!.flag_count, ...(await postRatings(env, id, u)) });
}

/** POST /comments/:id/useful {on} */
export async function rateComment(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const row = await commentRow(env, id);
  if (row.deleted || row.removed) throw new HttpError(403, "This comment can't be rated.");
  if (row.author_id === u.id) throw new HttpError(403, "Readers rate a reply, not its author.");
  await notBannedIn(env, u, row.community_id);
  const on = body?.on !== false;
  await env.DB.batch([
    on
      ? env.DB.prepare("INSERT OR IGNORE INTO ratings (user_id, target_type, target_id, reason, created_at) VALUES (?, 'comment', ?, 'useful', ?)").bind(u.id, id, now())
      : env.DB.prepare("DELETE FROM ratings WHERE user_id = ? AND target_type = 'comment' AND target_id = ?").bind(u.id, id),
    env.DB.prepare("UPDATE comments SET useful_count = (SELECT COUNT(*) FROM ratings WHERE target_type = 'comment' AND target_id = ?1) WHERE id = ?1").bind(id),
  ]);
  const r = await env.DB.prepare("SELECT useful_count FROM comments WHERE id = ?").bind(id).first<{ useful_count: number }>();
  return json({ useful_count: r!.useful_count, my_useful: on });
}

// ── Reports and moderation ──────────────────────────────────────────────

async function targetCommunity(env: Env, type: string, id: string): Promise<string> {
  if (type === "post") {
    const r = await env.DB.prepare("SELECT community_id FROM posts WHERE id = ?").bind(id).first<{ community_id: string }>();
    if (r) return r.community_id;
  } else if (type === "comment") {
    const r = await env.DB.prepare("SELECT p.community_id FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?").bind(id).first<{ community_id: string }>();
    if (r) return r.community_id;
  }
  throw new HttpError(404, "Nothing to report there.");
}

/** POST /reports {target_type, target_id, reason, details} */
export async function report(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  const type = str(body?.target_type);
  const id = str(body?.target_id);
  const reason = str(body?.reason);
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw new HttpError(400, "Pick a reason.");
  const details = str(body?.details).trim().slice(0, LIMITS.reportDetailsMax);
  const community = await targetCommunity(env, type, id);
  await env.DB.prepare(
    `INSERT INTO reports (id, target_type, target_id, community_id, reporter_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason = excluded.reason, details = excluded.details, status = 'open'`,
  )
    .bind(newId(), type, id, community, u.id, reason, details, now())
    .run();
  return json({ ok: true }, 201);
}

async function modScope(env: Env, user: User | null): Promise<{ u: User; all: boolean; ids: string[] }> {
  const u = requireUser(user);
  if (u.role === "admin") return { u, all: true, ids: [] };
  const ids = await moderated(env, u);
  if (!ids.length) throw new HttpError(403, "You don't moderate any community.");
  return { u, all: false, ids };
}

/** GET /mod/queue — reported content not yet decided, oldest first. */
export async function modQueue(env: Env, user: User | null): Promise<Response> {
  const { all, ids } = await modScope(env, user);
  const scope = all ? "" : `AND community_id IN (${ids.map(() => "?").join(",")})`;
  const { results: groups } = await env.DB.prepare(
    `SELECT target_type, target_id, community_id, COUNT(*) AS reports, MIN(created_at) AS first_at
       FROM reports WHERE status = 'open' ${scope} GROUP BY target_type, target_id ORDER BY first_at LIMIT 100`,
  )
    .bind(...ids)
    .all<Row>();
  const items = await Promise.all(
    groups.map(async (g) => {
      const reasons = await env.DB.prepare("SELECT reason, details, created_at FROM reports WHERE status = 'open' AND target_type = ? AND target_id = ? ORDER BY created_at")
        .bind(g.target_type, g.target_id)
        .all<Row>();
      const content = g.target_type === "post"
        ? await env.DB.prepare("SELECT p.id, p.title, p.body, p.removed, p.locked, u.name AS author FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?").bind(g.target_id).first<Row>()
        : await env.DB.prepare("SELECT c.id, c.post_id, c.body, c.removed, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?").bind(g.target_id).first<Row>();
      return { ...g, content, reasons: reasons.results };
    }),
  );
  return json({ items });
}

/** GET /mod/log?community_id= — recent decisions. */
export async function modLog(env: Env, user: User | null, url: URL): Promise<Response> {
  const { all, ids } = await modScope(env, user);
  const community = url.searchParams.get("community_id");
  if (community && !all && !ids.includes(community)) throw new HttpError(403, "You don't moderate this community.");
  const where = community ? "WHERE m.community_id = ?" : all ? "" : `WHERE m.community_id IN (${ids.map(() => "?").join(",")})`;
  const binds = community ? [community] : all ? [] : ids;
  const { results } = await env.DB.prepare(
    `SELECT m.*, u.name AS moderator FROM mod_actions m LEFT JOIN users u ON u.id = m.moderator_id ${where} ORDER BY m.created_at DESC LIMIT 100`,
  )
    .bind(...binds)
    .all<Row>();
  return json({ actions: results });
}

/**
 * POST /mod/action {action, target_type, target_id, reason, days?}
 *   post/comment: remove, restore, dismiss (the reports); post: lock, unlock
 *   user (target_id: the name; administrators): ban (days, 0 = permanent), unban
 */
export async function modAction(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  const action = str(body?.action);
  const type = str(body?.target_type);
  const targetId = str(body?.target_id);
  const reason = str(body?.reason).trim().slice(0, LIMITS.reasonMax);
  const at = now();
  if ((action === "remove" || action === "ban") && !reason) throw new HttpError(400, "Give a reason: it is shown to the author.");

  if (type === "user") {
    if (u.role !== "admin") throw new HttpError(403, "Only administrators ban accounts.");
    const target = await env.DB.prepare("SELECT id FROM users WHERE name_key = ?").bind(targetId.toLowerCase()).first<{ id: string }>();
    if (!target) throw new HttpError(404, "No such user.");
    let stmt: D1PreparedStatement;
    if (action === "ban") {
      const days = Math.max(0, Number(body?.days) || 0);
      stmt = env.DB.prepare("UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?").bind(days ? at + days * 86_400 : 9_999_999_999, reason, target.id);
    } else if (action === "unban") {
      stmt = env.DB.prepare("UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?").bind(target.id);
    } else throw new HttpError(400, "Unknown action.");
    const days = Math.max(0, Number(body?.days) || 0);
    const notice = notifyStatement(env, target.id, {
      kind: "banned",
      text: action === "ban" ? `Your account is banned ${days ? `for ${days} day${days === 1 ? "" : "s"}` : "permanently"}. Reason: ${reason}` : "Your account's ban was lifted.",
    });
    await env.DB.batch([
      stmt,
      env.DB.prepare("INSERT INTO mod_actions (id, moderator_id, action, target_type, target_id, reason, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").bind(newId(), u.id, action, target.id, reason, at),
      ...(notice ? [notice] : []),
    ]);
    return json({ ok: true });
  }

  if (type !== "post" && type !== "comment") throw new HttpError(400, "Unknown target.");
  const community = await targetCommunity(env, type, targetId);
  if (!(await isMod(env, u, community))) throw new HttpError(403, "You don't moderate this community.");
  const table = type === "post" ? "posts" : "comments";
  const stmts: D1PreparedStatement[] = [];
  const settle = (status: string) =>
    env.DB.prepare("UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE status = 'open' AND target_type = ? AND target_id = ?").bind(status, u.id, at, type, targetId);
  switch (action) {
    case "remove": {
      stmts.push(env.DB.prepare(`UPDATE ${table} SET removed = 1, removed_reason = ? WHERE id = ?`).bind(reason, targetId), settle("actioned"));
      const authored = await env.DB.prepare(`SELECT author_id${type === "comment" ? ", post_id" : ""} FROM ${table} WHERE id = ?`).bind(targetId).first<Row>();
      const notice = notifyStatement(env, authored?.author_id, {
        kind: "removed",
        postId: type === "post" ? targetId : authored?.post_id,
        commentId: type === "comment" ? targetId : null,
        text: `Your ${type} was removed by the moderators. Reason: ${reason}`,
      });
      if (notice) stmts.push(notice);
      if (type === "post") stmts.push(env.DB.prepare("UPDATE communities SET post_count = MAX(post_count - 1, 0) WHERE id = ? AND (SELECT removed FROM posts WHERE id = ?) = 0").bind(community, targetId));
      break;
    }
    case "restore":
      if (type === "post") stmts.push(env.DB.prepare("UPDATE communities SET post_count = post_count + 1 WHERE id = ? AND (SELECT removed FROM posts WHERE id = ?) = 1").bind(community, targetId));
      stmts.push(env.DB.prepare(`UPDATE ${table} SET removed = 0, removed_reason = NULL WHERE id = ?`).bind(targetId), settle("actioned"));
      break;
    case "dismiss":
      stmts.push(settle("dismissed"));
      break;
    case "lock":
    case "unlock":
      if (type !== "post") throw new HttpError(400, "Only posts are locked.");
      stmts.push(env.DB.prepare("UPDATE posts SET locked = ? WHERE id = ?").bind(action === "lock" ? 1 : 0, targetId));
      break;
    default:
      throw new HttpError(400, "Unknown action.");
  }
  stmts.push(
    env.DB.prepare("INSERT INTO mod_actions (id, moderator_id, action, target_type, target_id, community_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      newId(), u.id, action, type, targetId, community, reason, at,
    ),
  );
  await env.DB.batch(stmts);
  return json({ ok: true });
}

/** POST /mod/moderators {community_id, name, add} — administrators appoint moderators. */
export async function setModerator(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  if (u.role !== "admin") throw new HttpError(403, "Only administrators appoint moderators.");
  const community = await ensureCommunity(env, str(body?.community_id));
  const target = await env.DB.prepare("SELECT id FROM users WHERE name_key = ?").bind(str(body?.name).toLowerCase()).first<{ id: string }>();
  if (!target) throw new HttpError(404, "No such user.");
  await env.DB.prepare(body?.add === false ? "DELETE FROM moderators WHERE community_id = ? AND user_id = ?" : "INSERT OR IGNORE INTO moderators (community_id, user_id) VALUES (?, ?)")
    .bind(community.id, target.id)
    .run();
  return json({ ok: true });
}

// ── Account ─────────────────────────────────────────────────────────────

/** GET /me */
export async function me(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const { results: follows } = await env.DB.prepare(
    "SELECT c.id, c.kind, c.title FROM follows f JOIN communities c ON c.id = f.community_id WHERE f.user_id = ? ORDER BY c.kind DESC, c.title",
  )
    .bind(u.id)
    .all<Row>();
  const bio = (await env.DB.prepare("SELECT bio FROM users WHERE id = ?").bind(u.id).first<{ bio: string }>())?.bio ?? "";
  return json({
    user: { name: u.name, role: u.role, created_at: u.created_at, banned_until: u.banned_until, ban_reason: u.ban_reason, post_checked: !!u.post_checked, bio },
    moderates: u.role === "admin" ? "all" : await moderated(env, u),
    follows,
  });
}

const BIO_MAX = 160;

/** PATCH /me {name?, bio?} */
export async function rename(env: Env, user: User | null, body: any): Promise<Response> {
  const u = writer(user);
  if (typeof body?.bio === "string") {
    await env.DB.prepare("UPDATE users SET bio = ? WHERE id = ?").bind(body.bio.trim().replace(/\s+/g, " ").slice(0, BIO_MAX), u.id).run();
  }
  if (typeof body?.name !== "string") return me(env, u);
  const name = body.name.trim();
  if (!NAME_RE.test(name)) throw new HttpError(400, "A name has 3 to 20 letters, digits, - or _.");
  const res = await env.DB.prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE name_key = ? AND id <> ?)")
    .bind(name, name.toLowerCase(), u.id, name.toLowerCase(), u.id)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "This name is taken.");
  return me(env, { ...u, name });
}

/** DELETE /me — the account, its sessions, ratings, snapshots and follows; its posts and comments are emptied. */
export async function deleteAccount(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  // A paid subscription ends first: the account is not charged again.
  await cancelForDeletedAccount(env, u.id);
  const { results: pictured } = await env.DB.prepare("SELECT id FROM posts WHERE author_id = ? AND has_image = 1").bind(u.id).all<{ id: string }>();
  await deleteImages(env, pictured.map((p) => p.id));
  const { results: replies } = await env.DB.prepare("SELECT id FROM comments WHERE author_id = ? AND has_image = 1").bind(u.id).all<{ id: string }>();
  await deleteImages(env, replies.map((c) => c.id), "comments");
  const { results: snaps } = await env.DB.prepare("SELECT id FROM snapshots WHERE user_id = ?").bind(u.id).all<{ id: string }>();
  await deleteImages(env, snaps.map((s) => s.id), "snapshots");
  await env.DB.batch([
    env.DB.prepare("UPDATE posts SET deleted = 1, title = '[deleted]', body = '', chart = NULL, has_image = 0 WHERE author_id = ?").bind(u.id),
    env.DB.prepare("UPDATE comments SET deleted = 1, body = '', chart = NULL, has_image = 0 WHERE author_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
  ]);
  return json({ ok: true });
}

// ── Contact point and appeals ───────────────────────────────────────────

export const CONTACT_KINDS = ["illegal", "appeal", "authority", "other"] as const;
const CONTACTS_PER_DAY = 5;

/** POST /contact {kind, email?, url?, body} — anyone, signed in or not. */
export async function contact(env: Env, user: User | null, request: Request, body: any): Promise<Response> {
  const kind = str(body?.kind);
  if (!(CONTACT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "Pick a subject.");
  const message = text(body?.body, "The message", 10, 5_000);
  const email = str(body?.email).trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "This e-mail address doesn't look right.");
  const url = str(body?.url).trim().slice(0, 500);
  const day = Math.floor(now() / 86_400);
  const sender = await sha256Hex(`${request.headers.get("CF-Connecting-IP") ?? "unknown"}:${day}`);
  const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_hash = ? AND created_at >= ?").bind(sender, now() - 86_400).first<{ n: number }>();
  if ((sent?.n ?? 0) >= CONTACTS_PER_DAY) throw new HttpError(429, "Too many messages today. Try again tomorrow.");
  await env.DB.prepare("INSERT INTO messages (id, kind, email, url, body, user_id, sender_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId(), kind, email || null, url, message, user?.id ?? null, sender, now())
    .run();
  return json({ ok: true }, 201);
}

function requireAdmin(user: User | null): User {
  const u = requireUser(user);
  if (u.role !== "admin") throw new HttpError(403, "Only administrators read the messages.");
  return u;
}

/** GET /mod/messages — open messages, oldest first (administrators). */
export async function messages(env: Env, user: User | null): Promise<Response> {
  requireAdmin(user);
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.kind, m.email, m.url, m.body, m.created_at, u.name AS user_name FROM messages m
       LEFT JOIN users u ON u.id = m.user_id WHERE m.status = 'open' ORDER BY m.created_at LIMIT 200`,
  ).all<Row>();
  return json({ messages: results });
}

/** POST /mod/messages/:id/done — handled: its e-mail address is erased. */
export async function messageDone(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireAdmin(user);
  await env.DB.prepare("UPDATE messages SET status = 'done', email = NULL, handled_by = ?, handled_at = ? WHERE id = ?").bind(u.id, now(), id).run();
  return json({ ok: true });
}

/** POST /appeals {target_type, target_id, details} — the author asks the moderators to look again at a removal. */
export async function appeal(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  const type = str(body?.target_type);
  const id = str(body?.target_id);
  if (type !== "post" && type !== "comment") throw new HttpError(400, "Unknown target.");
  const row = await env.DB.prepare(`SELECT author_id, removed FROM ${type === "post" ? "posts" : "comments"} WHERE id = ?`).bind(id).first<Row>();
  if (!row || row.author_id !== u.id) throw new HttpError(403, "You can only appeal the removal of your own content.");
  if (!row.removed) throw new HttpError(400, "This content isn't removed.");
  const details = text(body?.details, "The explanation", 10, LIMITS.reportDetailsMax);
  const community = await targetCommunity(env, type, id);
  await env.DB.prepare(
    `INSERT INTO reports (id, target_type, target_id, community_id, reporter_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, 'appeal', ?, ?)
     ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason = 'appeal', details = excluded.details, status = 'open', created_at = excluded.created_at`,
  )
    .bind(newId(), type, id, community, u.id, details, now())
    .run();
  return json({ ok: true }, 201);
}
