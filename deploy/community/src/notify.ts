/*
 * Notifications (#208): a reply to your post or comment, a moderation
 * decision about your content or account, a new idea from a trader you
 * asked to hear from ('proposal': past answers to community proposals). The app asks for the unread count now and then and lists them.
 */
import { Env } from "./env";
import { User } from "./auth";
import { HttpError, json, newId, now } from "./util";

export type NoticeKind = "reply" | "removed" | "banned" | "proposal" | "idea";

const KEEP = 90 * 86_400;

/** A notification for `userId` (none for one's own actions). */
export function notifyStatement(
  env: Env,
  userId: string | null | undefined,
  n: { kind: NoticeKind; postId?: string | null; commentId?: string | null; actor?: string | null; text?: string },
): D1PreparedStatement | null {
  if (!userId) return null;
  return env.DB.prepare("INSERT INTO notifications (id, user_id, kind, post_id, comment_id, actor, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
    newId(), userId, n.kind, n.postId ?? null, n.commentId ?? null, n.actor ?? null, (n.text ?? "").slice(0, 300), now(),
  );
}

export async function notify(env: Env, userId: string | null | undefined, n: Parameters<typeof notifyStatement>[2]): Promise<void> {
  const stmt = notifyStatement(env, userId, n);
  if (stmt) await stmt.run();
}

function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, "Sign in to do this.");
  return user;
}

/** GET /me/unread — how many are unread (cheap: the app asks every minute). */
export async function unread(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(u.id).first<{ n: number }>();
  return json({ unread: r?.n ?? 0 });
}

/** GET /me/notifications — the latest 50, newest first. */
export async function list(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.kind, n.post_id, n.comment_id, n.actor, n.text, n.created_at, n.read_at, p.title AS post_title
       FROM notifications n LEFT JOIN posts p ON p.id = n.post_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC, n.rowid DESC LIMIT 50`,
  )
    .bind(u.id)
    .all();
  return json({ notifications: results });
}

/** POST /me/notifications/read — all read; old ones go. */
export async function markRead(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  await env.DB.batch([
    env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now(), u.id),
    env.DB.prepare("DELETE FROM notifications WHERE user_id = ? AND created_at < ?").bind(u.id, now() - KEEP),
  ]);
  return json({ ok: true });
}
