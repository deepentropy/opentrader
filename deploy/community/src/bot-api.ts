/*
 * The posting API: the project's replies and posts from a script of ours
 * (scripts/bot.mjs) with the key BOT_TOKEN, never from a page. They are written
 * as OpenTrader-bot (a labelled account, never passed off as a member), or as
 * one of the accounts API_AUTHORS lists (`as`: its name), the project's own.
 * The members' rules apply: limits, locked posts, repeated texts; an account
 * changes or deletes only what it wrote.
 */
import { Env } from "./env";
import { User } from "./auth";
import { BOT } from "./bot";
import { createComment, createPost, deleteComment, deletePost, editComment, editPost } from "./api";
import { HttpError, SUGGESTIONS, sha256Hex, timingSafeEqual } from "./util";

/** The account a request that carries the key writes as: the bot, or `as` when API_AUTHORS lists it. */
export async function botUser(env: Env, request: Request, as?: unknown): Promise<User> {
  if (!env.BOT_TOKEN || env.BOT_TOKEN.length < 32) throw new HttpError(404, "Not available.");
  const given = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!timingSafeEqual(await sha256Hex(given), await sha256Hex(env.BOT_TOKEN))) throw new HttpError(401, "Wrong key.");
  const name = typeof as === "string" && as.trim() ? as.trim() : null;
  const row = name
    ? await env.DB.prepare("SELECT id, name, role, created_at, banned_until, ban_reason FROM users WHERE name_key = ?").bind(name.toLowerCase()).first<User>()
    : await env.DB.prepare("SELECT id, name, role, created_at, banned_until, ban_reason FROM users WHERE id = ?").bind(BOT).first<User>();
  const allowed = (env.API_AUTHORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (name && (!row || !allowed.includes(row.id))) throw new HttpError(403, `The key doesn't write as ${name}.`);
  if (!row) throw new HttpError(503, "The bot has no account.");
  return { ...row, post_checked: 1 } as User;
}

/** POST /bot/posts/:id/comments {body, parent_id?} */
export async function comment(env: Env, request: Request, postId: string, body: any, ctx: ExecutionContext): Promise<Response> {
  const bot = await botUser(env, request, body?.as);
  return createComment(env, bot, request, postId, { body: body?.body, parent_id: body?.parent_id }, ctx);
}

/** POST /bot/communities/:id/posts {title, body} — a thread on a ticker or in General. */
export async function post(env: Env, request: Request, community: string, body: any): Promise<Response> {
  const bot = await botUser(env, request, body?.as);
  if (community === SUGGESTIONS) throw new HttpError(400, "The bot suggests nothing.");
  return createPost(env, bot, request, community, { title: body?.title, body: body?.body, type: "analysis" });
}

/** PATCH, DELETE /bot/comments/:id and /bot/posts/:id — what the bot wrote. */
export async function change(env: Env, request: Request, kind: string, id: string, body: any): Promise<Response> {
  const bot = await botUser(env, request, body?.as ?? new URL(request.url).searchParams.get("as"));
  if (request.method === "DELETE") return kind === "comments" ? deleteComment(env, bot, id) : deletePost(env, bot, id);
  return kind === "comments" ? editComment(env, bot, id, { body: body?.body }) : editPost(env, bot, id, { body: body?.body });
}
