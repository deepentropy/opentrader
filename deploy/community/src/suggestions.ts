/*
 * Suggestions: members ask for features on the website, without a GitHub
 * account. A suggestion is a post of type 'suggestion' in the Suggestions
 * community (replies, reports, moderation as for any post); members support
 * it ("I need this too", optionally saying why in a reply of kind 'support').
 *
 * Administrators set its status (under review, planned, in progress, shipped,
 * declined) with a note, promote it to a GitHub issue of the project, or bring
 * an existing issue in. A linked issue that closes moves the suggestion to
 * shipped (completed) or declined (not planned); its author and supporters
 * hear of each new status.
 */
import { Env } from "./env";
import { User } from "./auth";
import { SUGGESTION_STATUSES, type SuggestionStatus, type SuggestionsView } from "../../../src/community-shared/contract";
import { POST_SELECT, createComment, createPost, getPost, postRow, postsOut, requireUser, writer } from "./api";
import { notBannedIn } from "./members";
import { notifyStatement } from "./notify";
import { GITHUB_REPO, HttpError, LIMITS, SUGGESTIONS, hotRank, json, newId, now, str } from "./util";

/** A database row: the columns its query selects (the answers sent are typed by the API contract). */
type Row = Record<string, any>;

const STATUS_LABEL: Record<SuggestionStatus, string> = { review: "Under review", planned: "Planned", progress: "In progress", shipped: "Shipped", declined: "Declined" };
/** Still to do: what "Open" lists, and what the issue sync watches. */
const OPEN: SuggestionStatus[] = ["review", "planned", "progress"];
const WHY_MAX = 2_000;

function requireAdmin(user: User | null): User {
  const u = requireUser(user);
  if (u.role !== "admin") throw new HttpError(403, "Only administrators do this.");
  return u;
}

async function suggestionRow(env: Env, id: string): Promise<Row> {
  const row = await postRow(env, id);
  if (!row.sg_status) throw new HttpError(404, "This isn't a suggestion.");
  return row;
}

/** GET /suggestions?status=open|all|<status>&sort=top|new&q=&offset= — the list, the counts per status, what the viewer supports. */
export async function list(env: Env, user: User | null, url: URL): Promise<Response> {
  const status = url.searchParams.get("status") ?? "open";
  const sort = url.searchParams.get("sort") === "new" ? "new" : "top";
  const offset = Math.max(0, Math.min(10_000, Number(url.searchParams.get("offset")) || 0));
  const terms = str(url.searchParams.get("q")).trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[%_\\]/g, "").slice(0, 40)).filter(Boolean).slice(0, 8);
  const where = ["p.community_id = ?", "p.removed = 0", "p.deleted = 0"];
  const binds: unknown[] = [SUGGESTIONS];
  for (const t of terms) {
    where.push("(p.title LIKE ? OR p.body LIKE ?)");
    binds.push(`%${t}%`, `%${t}%`);
  }
  const { results: byStatus } = await env.DB.prepare(`SELECT p.sg_status AS k, COUNT(*) AS n FROM posts p WHERE ${where.join(" AND ")} GROUP BY p.sg_status`)
    .bind(...binds)
    .all<{ k: SuggestionStatus; n: number }>();
  const statuses = status === "all" ? [...SUGGESTION_STATUSES] : status === "open" ? OPEN : (SUGGESTION_STATUSES as readonly string[]).includes(status) ? [status] : OPEN;
  where.push(`p.sg_status IN (${statuses.map(() => "?").join(",")})`);
  const { results } = await env.DB.prepare(
    `${POST_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${sort === "new" ? "p.created_at DESC" : "p.useful_count DESC, p.created_at DESC"} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, ...statuses, LIMITS.pageSize + 1, offset)
    .all<Row>();
  const page = results.slice(0, LIMITS.pageSize);
  const supported = user && page.length
    ? (
        await env.DB.prepare(`SELECT target_id FROM ratings WHERE user_id = ? AND target_type = 'post' AND reason = 'support' AND target_id IN (${page.map(() => "?").join(",")})`)
          .bind(user.id, ...page.map((r) => r.id))
          .all<{ target_id: string }>()
      ).results.map((r) => r.target_id)
    : [];
  const counts: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.k, r.n]));
  return json<SuggestionsView>({
    suggestions: await postsOut(env, page, user),
    supported,
    counts: { ...counts, open: OPEN.reduce((a, s) => a + (counts[s] ?? 0), 0), all: byStatus.reduce((a, r) => a + r.n, 0) },
    next_offset: results.length > LIMITS.pageSize ? offset + LIMITS.pageSize : null,
  });
}

/** POST /suggestions {title, body} */
export function create(env: Env, user: User | null, request: Request, body: any): Promise<Response> {
  return createPost(env, user, request, SUGGESTIONS, { title: body?.title, body: body?.body, type: "suggestion" });
}

/** GET /suggestions/:id — the post with its replies, and whether the viewer supports it. */
export async function get(env: Env, user: User | null, id: string, status = 200): Promise<Response> {
  await suggestionRow(env, id);
  return getPost(env, user, id, status);
}

/** POST /suggestions/:id/support {on, why?} — support on or off; "why" is posted as a reply. */
export async function support(env: Env, user: User | null, request: Request, id: string, body: any, ctx?: ExecutionContext): Promise<Response> {
  const u = writer(user);
  const row = await suggestionRow(env, id);
  if (row.deleted || row.removed) throw new HttpError(403, "This suggestion can't be supported.");
  if (row.sg_status === "shipped") throw new HttpError(400, "This suggestion shipped already.");
  await notBannedIn(env, u, SUGGESTIONS);
  const on = body?.on !== false;
  const why = str(body?.why).trim();
  if (why.length > WHY_MAX) throw new HttpError(400, `The reason is longer than ${WHY_MAX} characters.`);
  await env.DB.batch([
    on
      ? env.DB.prepare("INSERT OR IGNORE INTO ratings (user_id, target_type, target_id, reason, created_at) VALUES (?, 'post', ?, 'support', ?)").bind(u.id, id, now())
      : env.DB.prepare("DELETE FROM ratings WHERE user_id = ? AND target_type = 'post' AND target_id = ? AND reason = 'support'").bind(u.id, id),
    env.DB.prepare("UPDATE posts SET useful_count = (SELECT COUNT(*) FROM ratings WHERE target_type = 'post' AND target_id = ?1 AND reason = 'support') WHERE id = ?1").bind(id),
  ]);
  let comment: unknown = null;
  if (on && why) comment = (await (await createComment(env, u, request, id, { body: why, kind: "support" }, ctx)).json<Row>()).comment;
  const r = await env.DB.prepare("SELECT useful_count FROM posts WHERE id = ?").bind(id).first<{ useful_count: number }>();
  return json({ supporters: r?.useful_count ?? 0, supported: on, comment });
}

/** The author and the supporters hear of a new status. */
async function statusNotices(env: Env, row: Row, status: SuggestionStatus, note: string | null, actor: string | null): Promise<D1PreparedStatement[]> {
  const { results } = await env.DB.prepare("SELECT user_id FROM ratings WHERE target_type = 'post' AND target_id = ? AND reason = 'support'").bind(row.id).all<{ user_id: string }>();
  const to = new Set([row.author_id, ...results.map((r) => r.user_id)].filter(Boolean) as string[]);
  const text = `${STATUS_LABEL[status]}: ${row.title}${note ? ` — ${note}` : ""}`;
  return [...to].map((id) => notifyStatement(env, id, { kind: "status", postId: row.id, actor, text })!);
}

function parseIssue(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(String(v).replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "An issue number is a whole number, like 266.");
  return n;
}

async function linkedElsewhere(env: Env, issue: number, id: string | null): Promise<void> {
  const other = await env.DB.prepare("SELECT id FROM posts WHERE issue_number = ? AND id IS NOT ?").bind(issue, id).first<{ id: string }>();
  if (other) throw new HttpError(409, `Issue #${issue} is already linked to another suggestion.`, { post_id: other.id });
}

/** POST /mod/suggestions/:id {status?, note?, issue_number?} — administrators. */
export async function update(env: Env, user: User | null, id: string, body: any): Promise<Response> {
  const u = requireAdmin(user);
  const row = await suggestionRow(env, id);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const status = body?.status === undefined ? row.sg_status : str(body.status);
  if (!(SUGGESTION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "Unknown status.");
  const note = body?.note === undefined ? row.sg_note : str(body.note).trim().slice(0, LIMITS.reasonMax) || null;
  const changed = status !== row.sg_status;
  if (changed || note !== row.sg_note) {
    sets.push("sg_status = ?", "sg_note = ?", "sg_updated_at = ?");
    binds.push(status, note, now());
  }
  if (body?.issue_number !== undefined) {
    const issue = parseIssue(body.issue_number);
    if (issue) await linkedElsewhere(env, issue, id);
    sets.push("issue_number = ?");
    binds.push(issue);
  }
  if (sets.length) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id),
      ...(changed ? await statusNotices(env, row, status, note, u.name) : []),
    ]);
  }
  return get(env, user, id);
}

// ── GitHub ──────────────────────────────────────────────────────────────

async function github(env: Env, path: string, init: { method?: string; body?: unknown } = {}): Promise<Row> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "OpenTrader-Community",
    "x-github-api-version": "2022-11-28",
  };
  if (env.GITHUB_ISSUES_TOKEN) headers.authorization = `Bearer ${env.GITHUB_ISSUES_TOKEN}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`https://api.github.com${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (res.status === 404) throw new HttpError(404, "GitHub has no such issue.");
  if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status}. Try again later.`);
  return res.json<Row>();
}

/** The status a GitHub issue's state stands for: open → planned, closed → shipped or declined. */
export function statusOfIssue(issue: Row): SuggestionStatus {
  if (issue.state !== "closed") return "planned";
  return issue.state_reason === "completed" || !issue.state_reason ? "shipped" : "declined";
}

/** The issue's text: the suggestion, then where it came from and how many support it. */
function issueBody(env: Env, row: Row): string {
  const n = row.useful_count ?? 0;
  return `${str(row.body).trim()}\n\n---\nSuggested on the OpenTrader Community: ${env.PUBLIC_URL}/p/${row.id} (${n} supporter${n === 1 ? "" : "s"}).`;
}

/**
 * POST /mod/suggestions/:id/promote — opens the project's GitHub issue and links it (planned).
 * Without a token: 501 with the prefilled new-issue page, to open and link by hand.
 */
export async function promote(env: Env, user: User | null, id: string): Promise<Response> {
  const u = requireAdmin(user);
  const row = await suggestionRow(env, id);
  if (row.issue_number) throw new HttpError(409, `Already linked to issue #${row.issue_number}.`);
  if (!env.GITHUB_ISSUES_TOKEN) {
    const q = new URLSearchParams({ title: row.title, body: issueBody(env, row) });
    throw new HttpError(501, "No GitHub token is set: open the issue on GitHub, then link its number.", { new_issue_url: `https://github.com/${GITHUB_REPO}/issues/new?${q}` });
  }
  const issue = await github(env, `/repos/${GITHUB_REPO}/issues`, { method: "POST", body: { title: row.title, body: issueBody(env, row) } });
  const status: SuggestionStatus = row.sg_status === "review" ? "planned" : row.sg_status;
  await env.DB.batch([
    env.DB.prepare("UPDATE posts SET issue_number = ?, sg_status = ?, sg_updated_at = ? WHERE id = ?").bind(issue.number, status, now(), id),
    ...(status !== row.sg_status ? await statusNotices(env, row, status, row.sg_note, u.name) : []),
  ]);
  return get(env, user, id);
}

/** An issue's text without a first heading that repeats its title (it would show twice). */
export function withoutTitleHeading(text: string, title: string): string {
  const m = /^#{1,6}\s+(.+)\n*/.exec(text);
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return m && key(m[1]) === key(title) ? text.slice(m[0].length).trim() : text;
}

/** POST /mod/suggestions/import {issue, status?} — a GitHub issue of the project becomes a suggestion, credited to its author there. */
export async function importIssue(env: Env, user: User | null, body: any): Promise<Response> {
  requireAdmin(user);
  const number = parseIssue(body?.issue);
  if (!number) throw new HttpError(400, "Give the issue's number.");
  await linkedElsewhere(env, number, null);
  const issue = await github(env, `/repos/${GITHUB_REPO}/issues/${number}`);
  if (issue.pull_request) throw new HttpError(400, `#${number} is a pull request, not an issue.`);
  const status = body?.status ? str(body.status) : statusOfIssue(issue);
  if (!(SUGGESTION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "Unknown status.");
  const title = str(issue.title).trim().slice(0, LIMITS.titleMax);
  const text = withoutTitleHeading(str(issue.body).replace(/\r\n/g, "\n").trim(), title).slice(0, LIMITS.bodyMax);
  const created = Math.floor(Date.parse(issue.created_at) / 1000) || now();
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO posts (id, community_id, author_id, title, body, score, hot, created_at, type, sg_status, sg_updated_at, issue_number, external_author)
       VALUES (?, ?, NULL, ?, ?, 0, ?, ?, 'suggestion', ?, ?, ?, ?)`,
    ).bind(id, SUGGESTIONS, title, text, hotRank(0, created), created, status, now(), number, str(issue.user?.login) || null),
    env.DB.prepare("UPDATE communities SET post_count = post_count + 1 WHERE id = ?").bind(SUGGESTIONS),
  ]);
  return get(env, user, id, 201);
}

/** Linked issues of open suggestions closed on GitHub: shipped or declined (the cron, hourly). */
export async function syncIssues(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, author_id, sg_status, sg_note, issue_number FROM posts WHERE issue_number IS NOT NULL AND sg_status IN (${OPEN.map(() => "?").join(",")}) AND deleted = 0 AND removed = 0`,
  )
    .bind(...OPEN)
    .all<Row>();
  for (const row of results) {
    let issue: Row;
    try {
      issue = await github(env, `/repos/${GITHUB_REPO}/issues/${row.issue_number}`);
    } catch (e) {
      console.error("[suggestions] issue", row.issue_number, e);
      continue;
    }
    if (issue.state !== "closed") continue;
    const status = statusOfIssue(issue);
    await env.DB.batch([
      env.DB.prepare("UPDATE posts SET sg_status = ?, sg_updated_at = ? WHERE id = ?").bind(status, now(), row.id),
      ...(await statusNotices(env, row, status, row.sg_note, null)),
    ]);
  }
}
