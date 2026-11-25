/*
 * The bot API: OpenTrader-bot's own posts and replies (a labelled account, never
 * passed off as a member), for announcements such as a suggestion that shipped.
 * Called by a script of ours (scripts/bot.mjs) with the key BOT_TOKEN, never by
 * a page. The bot follows the members' rules: limits, locked posts, repeated
 * texts; it changes or deletes only what it wrote.
 */
import { Env } from "./env";
import { User } from "./auth";
import { BOT } from "./bot";
import { createComment, createPost, deleteComment, deletePost, editComment, editPost } from "./api";
import { HttpError, SUGGESTIONS, sha256Hex, timingSafeEqual } from "./util";

/** The bot's account, for a request that carries its key. */
export async function botUser(env: Env, request: Request): Promise<User> {
  if (!env.BOT_TOKEN || env.BOT_TOKEN.length < 32) throw new HttpError(404, "Not available.");
  const given = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!timingSafeEqual(await sha256Hex(given), await sha256Hex(env.BOT_TOKEN))) throw new HttpError(401, "Wrong key.");
  const row = await env.DB.prepare("SELECT id, name, role, created_at, banned_until, ban_reason FROM users WHERE id = ?").bind(BOT).first<User>();
  if (!row) throw new HttpError(503, "The bot has no account.");
  return { ...row, post_checked: 1 } as User;
}

/** POST /bot/posts/:id/comments {body, parent_id?} */
export async function comment(env: Env, request: Request, postId: string, body: any, ctx: ExecutionContext): Promise<Response> {
  const bot = await botUser(env, request);
  return createComment(env, bot, request, postId, { body: body?.body, parent_id: body?.parent_id }, ctx);
}

/** POST /bot/communities/:id/posts {title, body} — a thread on a ticker or in General. */
export async function post(env: Env, request: Request, community: string, body: any): Promise<Response> {
  const bot = await botUser(env, request);
  if (community === SUGGESTIONS) throw new HttpError(400, "The bot suggests nothing.");
  return createPost(env, bot, request, community, { title: body?.title, body: body?.body, type: "analysis" });
}

/** PATCH, DELETE /bot/comments/:id and /bot/posts/:id — what the bot wrote. */
export async function change(env: Env, request: Request, kind: string, id: string, body: any): Promise<Response> {
  const bot = await botUser(env, request);
  if (request.method === "DELETE") return kind === "comments" ? deleteComment(env, bot, id) : deletePost(env, bot, id);
  return kind === "comments" ? editComment(env, bot, id, { body: body?.body }) : editPost(env, bot, id, { body: body?.body });
}
