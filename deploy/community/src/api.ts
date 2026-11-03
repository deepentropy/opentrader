/*
 * The community API: communities, posts, threaded comments, votes, reports,
 * the moderation queue and the account. Reading needs no account; writing
 * needs a session (auth.ts) and an account that isn't banned.
 */
import { Env } from "./env";
import { User } from "./auth";
import { deleteImages, parseChart, parseImage, saveImage } from "./charts";
import { HttpError, LIMITS, NAME_RE, REPORT_REASONS, hotRank, json, newId, now, parseCommunityId, sha256Hex, str, topSince } from "./util";

type Row = Record<string, any>;

function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, "Sign in to do this.");
  return user;
}

/** A signed-in user allowed to write. */
function writer(user: User | null): User {
  const u = requireUser(user);
  if (u.banned_until && u.banned_until > now()) {
    const until = u.banned_until > 4_000_000_000 ? "permanently" : `until ${new Date(u.banned_until * 1000).toISOString().slice(0, 10)}`;
    throw new HttpError(403, `Your account is banned ${until}. Reason: ${u.ban_reason || "not given"}.`);
  }
  return u;
}

async function isMod(env: Env, user: User | null, communityId: string): Promise<boolean> {
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
async function findCommunity(env: Env, id: string): Promise<Row> {
  const parsed = parseCommunityId(id);
  if (!parsed) throw new HttpError(404, "No such community.");
  const cid = parsed.kind === "ticker" ? `t:${parsed.key}` : `c:${parsed.key}`;
  const row = await env.DB.prepare("SELECT * FROM communities WHERE id = ?").bind(cid).first<Row>();
  if (row) return row;
  if (parsed.kind === "theme") throw new HttpError(404, "No such community.");
  return { id: cid, kind: "ticker", title: `$${parsed.key}`, description: "", post_count: 0, min_account_days: 0, virtual: true };
}

async function ensureCommunity(env: Env, id: string): Promise<Row> {
  const row = await findCommunity(env, id);
  if (row.virtual) {
    await env.DB.prepare("INSERT OR IGNORE INTO communities (id, kind, title, created_at) VALUES (?, 'ticker', ?, ?)").bind(row.id, row.title, now()).run();
    delete row.virtual;
  }
  return row;
}

/** GET /communities — the theme communities. */
export async function listThemes(env: Env, user: User | null): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, f.user_id IS NOT NULL AS followed FROM communities c
       LEFT JOIN follows f ON f.community_id = c.id AND f.user_id = ?
      WHERE c.kind = 'theme' ORDER BY c.sort_order, c.title`,
  )
    .bind(user?.id ?? "")
    .all<Row>();
  const mods = user ? new Set(user.role === "admin" ? results.map((r) => r.id) : await moderated(env, user)) : new Set<string>();
  return json({ communities: results.map((r) => communityOut(r, !!r.followed, mods.has(r.id))) });
}

/** GET /communities/:id */
export async function getCommunity(env: Env, user: User | null, id: string): Promise<Response> {
  const row = await findCommunity(env, id);
  const followed = !!user && !row.virtual && !!(await env.DB.prepare("SELECT 1 FROM follows WHERE user_id = ? AND community_id = ?").bind(user.id, row.id).first());
  return json({ community: communityOut(row, followed, await isMod(env, user, row.id)) });
}

/** POST / DELETE /communities/:id/follow */
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

// ── Posts ───────────────────────────────────────────────────────────────

const POST_SELECT = `SELECT p.*, u.name AS author_name, c.title AS community_title, c.kind AS community_kind, v.value AS my_vote
  FROM posts p
  JOIN communities c ON c.id = p.community_id
  LEFT JOIN users u ON u.id = p.author_id
  LEFT JOIN votes v ON v.user_id = ? AND v.target_type = 'post' AND v.target_id = p.id`;

function postOut(r: Row, viewer: User | null, mod: boolean, withBody = true) {
  const own = !!viewer && r.author_id === viewer.id;
  const hidden = !!r.removed && !own && !mod;
  return {
    id: r.id,
    community: { id: r.community_id, title: r.community_title, kind: r.community_kind },
    author: r.deleted ? null : r.author_name ?? null,
    title: hidden ? "[Removed by moderators]" : r.title,
    body: withBody && !hidden && !r.deleted ? r.body : "",
    excerpt: hidden || r.deleted ? "" : str(r.body).slice(0, 200),
    score: r.score,
    comment_count: r.comment_count,
    created_at: r.created_at,
    edited_at: r.edited_at,
    locked: !!r.locked,
    deleted: !!r.deleted,
    removed: !!r.removed,
    removed_reason: r.removed && (own || mod) ? r.removed_reason : null,
    my_vote: r.my_vote ?? 0,
    own,
    source_url: r.source_url ?? null,
    // The shared chart: its state in the post itself, its picture as a path on this server.
    chart: withBody && !hidden && !r.deleted && r.chart ? JSON.parse(r.chart) : null,
    has_chart: !hidden && !r.deleted && !!r.chart,
    image_url: !hidden && !r.deleted && r.has_image ? `/images/${r.id}` : null,
  };
}

function order(sort: string): string {
  switch (sort) {
    case "new": return "p.created_at DESC";
    case "top": return "p.score DESC, p.created_at DESC";
    default: return "p.hot DESC";
  }
}

function pageParams(url: URL) {
  const sort = url.searchParams.get("sort") ?? "hot";
  const offset = Math.max(0, Math.min(10_000, Number(url.searchParams.get("offset")) || 0));
  const since = sort === "top" ? topSince(url.searchParams.get("t") ?? "all", now()) : 0;
  return { sort, offset, since };
}

async function listPosts(env: Env, user: User | null, where: string, binds: unknown[], url: URL) {
  const { sort, offset, since } = pageParams(url);
  const { results } = await env.DB.prepare(
    `${POST_SELECT} WHERE ${where} AND p.removed = 0 AND p.deleted = 0 AND p.created_at >= ? ORDER BY ${order(sort)} LIMIT ? OFFSET ?`,
  )
    .bind(user?.id ?? "", ...binds, since, LIMITS.pageSize + 1, offset)
    .all<Row>();
  const more = results.length > LIMITS.pageSize;
  return {
    posts: results.slice(0, LIMITS.pageSize).map((r) => postOut(r, user, false, false)),
    next_offset: more ? offset + LIMITS.pageSize : null,
  };
}

/** GET /communities/:id/posts?sort=hot|new|top&t=…&offset=… */
export async function communityPosts(env: Env, user: User | null, id: string, url: URL): Promise<Response> {
  const row = await findCommunity(env, id);
  if (row.virtual) return json({ posts: [], next_offset: null });
  return json(await listPosts(env, user, "p.community_id = ?", [row.id], url));
}

/** GET /feed?scope=following|all&sort=… */
export async function feed(env: Env, user: User | null, url: URL): Promise<Response> {
  if (url.searchParams.get("scope") === "following") {
    const u = requireUser(user);
    return json(await listPosts(env, user, "p.community_id IN (SELECT community_id FROM follows WHERE user_id = ?)", [u.id], url));
  }
  return json(await listPosts(env, user, "1 = 1", [], url));
}

async function rateLimit(env: Env, u: User, table: "posts" | "comments"): Promise<void> {
  if (u.role === "admin") return;
  const young = now() - u.created_at < LIMITS.newAccountSeconds;
  const max = table === "posts" ? (young ? LIMITS.postsPerDayNew : LIMITS.postsPerDay) : young ? LIMITS.commentsPerDayNew : LIMITS.commentsPerDay;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE author_id = ? AND created_at >= ?`).bind(u.id, now() - 86_400).first<{ n: number }>();
  if ((row?.n ?? 0) >= max) {
    throw new HttpError(429, `You reached today's limit of ${max} ${table}${young ? " for new accounts" : ""}. Try again later.`);
  }
}

/** POST /communities/:id/posts {title, body} */
export async function createPost(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const title = text(body?.title, "The title", LIMITS.titleMin, LIMITS.titleMax);
  const content = str(body?.body).trim();
  if (content.length > LIMITS.bodyMax) throw new HttpError(400, `The text is longer than ${LIMITS.bodyMax} characters.`);
  const community = await ensureCommunity(env, id);
  const ageDays = (now() - u.created_at) / 86_400;
  if (ageDays < community.min_account_days && !(await isMod(env, u, community.id))) {
    throw new HttpError(403, `Posting in ${community.title} needs an account at least ${community.min_account_days} days old.`);
  }
  const chart = parseChart(body?.chart);
  const image = parseImage(body?.image, body?.image_type);
  await rateLimit(env, u, "posts");
  const postId = newId();
  const at = now();
  if (image) await saveImage(env, postId, image);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO posts (id, community_id, author_id, title, body, score, hot, created_at, chart, has_image) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)").bind(
      postId, community.id, u.id, title, content, hotRank(1, at), at, chart ? JSON.stringify(chart) : null, image ? 1 : 0,
    ),
    // Authors vote for their own post.
    env.DB.prepare("INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?, 'post', ?, 1)").bind(u.id, postId),
    env.DB.prepare("UPDATE communities SET post_count = post_count + 1 WHERE id = ?").bind(community.id),
  ]);
  return getPost(env, user, postId, 201);
}

async function postRow(env: Env, user: User | null, id: string): Promise<Row> {
  const row = await env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(user?.id ?? "", id).first<Row>();
  if (!row) throw new HttpError(404, "This post doesn't exist.");
  return row;
}

function commentOut(r: Row, viewer: User | null, mod: boolean) {
  const own = !!viewer && r.author_id === viewer.id;
  const hidden = !!r.removed && !own && !mod;
  return {
    id: r.id,
    parent_id: r.parent_id,
    author: r.deleted ? null : r.author_name ?? null,
    body: hidden || r.deleted ? "" : r.body,
    score: r.score,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted: !!r.deleted,
    removed: !!r.removed,
    removed_reason: r.removed && (own || mod) ? r.removed_reason : null,
    my_vote: r.my_vote ?? 0,
    own,
  };
}

/** GET /posts/:id — the post and all its comments (the client builds the tree). */
export async function getPost(env: Env, user: User | null, id: string, status = 200): Promise<Response> {
  const row = await postRow(env, user, id);
  const mod = await isMod(env, user, row.community_id);
  const { results } = await env.DB.prepare(
    `SELECT c.*, u.name AS author_name, v.value AS my_vote FROM comments c
       LEFT JOIN users u ON u.id = c.author_id
       LEFT JOIN votes v ON v.user_id = ? AND v.target_type = 'comment' AND v.target_id = c.id
      WHERE c.post_id = ? ORDER BY c.created_at LIMIT ?`,
  )
    .bind(user?.id ?? "", id, LIMITS.commentsPerPost)
    .all<Row>();
  return json({ post: postOut(row, user, mod), comments: results.map((c) => commentOut(c, user, mod)), is_mod: mod }, status);
}

/** PATCH /posts/:id {body} — the author edits the text (the title stays). */
export async function editPost(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = writer(user);
  const row = await postRow(env, u, id);
  if (row.author_id !== u.id || row.deleted || row.removed) throw new HttpError(403, "You can't edit this post.");
  const content = str(body?.body).trim();
  if (content.length > LIMITS.bodyMax) throw new HttpError(400, `The text is longer than ${LIMITS.bodyMax} characters.`);
  await env.DB.prepare("UPDATE posts SET body = ?, edited_at = ? WHERE id = ?").bind(content, now(), id).run();
  return getPost(env, user, id);
}

/** DELETE /posts/:id — by its author: the text and name go, the comments stay. */
export async function deletePost(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireUser(user);
  const row = await postRow(env, u, id);
  if (row.author_id !== u.id) throw new HttpError(403, "You can't delete this post.");
  if (!row.deleted) {
    if (row.has_image) await deleteImages(env, [id]);
    await env.DB.batch([
      env.DB.prepare("UPDATE posts SET deleted = 1, body = '', chart = NULL, has_image = 0 WHERE id = ?").bind(id),
      env.DB.prepare("UPDATE communities SET post_count = MAX(post_count - 1, 0) WHERE id = ?").bind(row.community_id),
    ]);
  }
  return json({ ok: true });
}

// ── Comments ────────────────────────────────────────────────────────────

/** POST /posts/:id/comments {body, parent_id?} */
export async function createComment(env: Env, user: User | null, postId: string, body: any): Promise<Response> {
  const u = writer(user);
  const post = await postRow(env, u, postId);
  if (post.deleted || post.removed) throw new HttpError(403, "This post no longer takes comments.");
  if (post.locked && !(await isMod(env, u, post.community_id))) throw new HttpError(403, "This post is locked: no new comments.");
  const content = text(body?.body, "The comment", 1, LIMITS.commentMax);
  const parentId = str(body?.parent_id) || null;
  if (parentId) {
    const parent = await env.DB.prepare("SELECT post_id FROM comments WHERE id = ?").bind(parentId).first<{ post_id: string }>();
    if (!parent || parent.post_id !== postId) throw new HttpError(400, "The comment you reply to isn't in this post.");
  }
  await rateLimit(env, u, "comments");
  const id = newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO comments (id, post_id, parent_id, author_id, body, score, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(id, postId, parentId, u.id, content, now()),
    env.DB.prepare("INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?, 'comment', ?, 1)").bind(u.id, id),
    env.DB.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?").bind(postId),
  ]);
  const row = await env.DB.prepare("SELECT c.*, ? AS author_name, 1 AS my_vote FROM comments c WHERE c.id = ?").bind(u.name, id).first<Row>();
  return json({ comment: commentOut(row!, u, false) }, 201);
}

async function commentRow(env: Env, id: string): Promise<Row> {
  const row = await env.DB.prepare("SELECT c.*, p.community_id FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?").bind(id).first<Row>();
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
  return json({ comment: commentOut({ ...row, body: content, edited_at: now(), author_name: u.name, my_vote: 0 }, u, false) });
}

/** DELETE /comments/:id — by its author; the replies stay. */
export async function deleteComment(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireUser(user);
  const row = await commentRow(env, id);
  if (row.author_id !== u.id) throw new HttpError(403, "You can't delete this comment.");
  await env.DB.prepare("UPDATE comments SET deleted = 1, body = '' WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ── Votes ───────────────────────────────────────────────────────────────

/** POST /posts/:id/vote, /comments/:id/vote {value: 1 | 0 | -1} */
export async function vote(env: Env, user: User | null, type: "post" | "comment", id: string, body: any): Promise<Response> {
  const u = writer(user);
  const value = Number(body?.value);
  if (![1, 0, -1].includes(value)) throw new HttpError(400, "value must be 1, 0 or -1");
  const table = type === "post" ? "posts" : "comments";
  const target = await env.DB.prepare(`SELECT id, created_at, deleted, removed FROM ${table} WHERE id = ?`).bind(id).first<Row>();
  if (!target) throw new HttpError(404, `This ${type} doesn't exist.`);
  if (target.deleted || target.removed) throw new HttpError(403, `This ${type} can't be voted on.`);
  const old = (await env.DB.prepare("SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?").bind(u.id, type, id).first<{ value: number }>())?.value ?? 0;
  const delta = value - old;
  if (delta !== 0) {
    const write = value === 0
      ? env.DB.prepare("DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?").bind(u.id, type, id)
      : env.DB.prepare("INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value").bind(u.id, type, id, value);
    await env.DB.batch([write, env.DB.prepare(`UPDATE ${table} SET score = score + ? WHERE id = ?`).bind(delta, id)]);
  }
  const score = (await env.DB.prepare(`SELECT score FROM ${table} WHERE id = ?`).bind(id).first<{ score: number }>())!.score;
  if (type === "post" && delta !== 0) await env.DB.prepare("UPDATE posts SET hot = ? WHERE id = ?").bind(hotRank(score, target.created_at), id).run();
  return json({ score, my_vote: value });
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
    await env.DB.batch([
      stmt,
      env.DB.prepare("INSERT INTO mod_actions (id, moderator_id, action, target_type, target_id, reason, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)").bind(newId(), u.id, action, target.id, reason, at),
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
    case "remove":
      stmts.push(env.DB.prepare(`UPDATE ${table} SET removed = 1, removed_reason = ? WHERE id = ?`).bind(reason, targetId), settle("actioned"));
      if (type === "post") stmts.push(env.DB.prepare("UPDATE communities SET post_count = MAX(post_count - 1, 0) WHERE id = ? AND (SELECT removed FROM posts WHERE id = ?) = 0").bind(community, targetId));
      break;
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
  return json({
    user: { name: u.name, role: u.role, created_at: u.created_at, banned_until: u.banned_until, ban_reason: u.ban_reason },
    moderates: u.role === "admin" ? "all" : await moderated(env, u),
    follows,
  });
}

/** PATCH /me {name} */
export async function rename(env: Env, user: User | null, body: any): Promise<Response> {
  const u = writer(user);
  const name = str(body?.name).trim();
  if (!NAME_RE.test(name)) throw new HttpError(400, "A name has 3 to 20 letters, digits, - or _.");
  const res = await env.DB.prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE name_key = ? AND id <> ?)")
    .bind(name, name.toLowerCase(), u.id, name.toLowerCase(), u.id)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "This name is taken.");
  return me(env, { ...u, name });
}

/** DELETE /me — the account, its sessions, votes and follows; its posts and comments are emptied. */
export async function deleteAccount(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const { results: pictured } = await env.DB.prepare("SELECT id FROM posts WHERE author_id = ? AND has_image = 1").bind(u.id).all<{ id: string }>();
  await deleteImages(env, pictured.map((p) => p.id));
  await env.DB.batch([
    env.DB.prepare("UPDATE posts SET deleted = 1, title = '[deleted]', body = '', chart = NULL, has_image = 0 WHERE author_id = ?").bind(u.id),
    env.DB.prepare("UPDATE comments SET deleted = 1, body = '' WHERE author_id = ?").bind(u.id),
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
