/*
 * Communities run by members (#209): administrators appoint moderators;
 * moderators ban members from their ticker; each community's moderation log
 * is public.
 */
import { Env } from "./env";
import { User } from "./auth";
import { findCommunity, isMod, requireUser } from "./api";
import { notifyStatement } from "./notify";
import { HttpError, json, newId, now, str } from "./util";

type Row = Record<string, any>;

/** Account age to propose a community (days). */
const PROPOSE_MIN_DAYS = 7;

/** GET /communities/:id/moderators — public. */
export async function moderators(env: Env, id: string): Promise<Response> {
  const c = await findCommunity(env, id);
  const { results } = await env.DB.prepare("SELECT u.name FROM moderators m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? ORDER BY u.name").bind(c.id).all<{ name: string }>();
  return json({ moderators: results.map((r) => r.name) });
}

/** GET /communities/:id/log — the community's moderation decisions, public (no moderator or member names). */
export async function publicLog(env: Env, id: string): Promise<Response> {
  const c = await findCommunity(env, id);
  const { results } = await env.DB.prepare(
    `SELECT m.action, m.target_type, m.target_id, m.reason, m.created_at,
            CASE m.target_type WHEN 'post' THEN p.title WHEN 'comment' THEN cp.title END AS post_title,
            CASE m.target_type WHEN 'post' THEN m.target_id WHEN 'comment' THEN cm.post_id END AS post_id
       FROM mod_actions m
       LEFT JOIN posts p ON m.target_type = 'post' AND p.id = m.target_id
       LEFT JOIN comments cm ON m.target_type = 'comment' AND cm.id = m.target_id
       LEFT JOIN posts cp ON cp.id = cm.post_id
      WHERE m.community_id = ? AND m.action <> 'dismiss' ORDER BY m.created_at DESC LIMIT 100`,
  )
    .bind(c.id)
    .all<Row>();
  return json({
    actions: results.map((r) => ({
      action: r.action,
      target_type: r.target_type,
      reason: r.reason,
      created_at: r.created_at,
      post_id: r.post_id ?? null,
      post_title: r.post_title ?? null,
    })),
  });
}

/** The member may not write in this community (banned from it). */
export async function notBannedIn(env: Env, u: User, communityId: string): Promise<void> {
  const ban = await env.DB.prepare("SELECT until, reason FROM community_bans WHERE community_id = ? AND user_id = ? AND until > ?")
    .bind(communityId, u.id, now())
    .first<{ until: number; reason: string }>();
  if (!ban) return;
  const until = ban.until > 4_000_000_000 ? "permanently" : `until ${new Date(ban.until * 1000).toISOString().slice(0, 10)}`;
  throw new HttpError(403, `You are banned from this community ${until}. Reason: ${ban.reason}.`);
}

/** GET /communities/:id/bans — its moderators. */
export async function bans(env: Env, user: User | null, id: string): Promise<Response> {
  const c = await findCommunity(env, id);
  if (!(await isMod(env, user, c.id))) throw new HttpError(403, "You don't moderate this community.");
  const { results } = await env.DB.prepare(
    "SELECT u.name, b.until, b.reason, b.created_at FROM community_bans b JOIN users u ON u.id = b.user_id WHERE b.community_id = ? AND b.until > ? ORDER BY b.created_at DESC",
  )
    .bind(c.id, now())
    .all<Row>();
  return json({ bans: results });
}

/** POST /mod/community-ban {community_id, name, ban, days (0 = permanent), reason} — the community's moderators. */
export async function communityBan(env: Env, user: User | null, body: any): Promise<Response> {
  const u = requireUser(user);
  const c = await findCommunity(env, str(body?.community_id));
  if (c.virtual || !(await isMod(env, u, c.id))) throw new HttpError(403, "You don't moderate this community.");
  const target = await env.DB.prepare("SELECT id, role FROM users WHERE name_key = ?").bind(str(body?.name).toLowerCase()).first<{ id: string; role: string }>();
  if (!target) throw new HttpError(404, "No such member.");
  if (target.id === u.id || target.role === "admin") throw new HttpError(400, "This member can't be banned.");
  const ban = body?.ban !== false;
  const reason = str(body?.reason).trim().slice(0, 500);
  if (ban && !reason) throw new HttpError(400, "Give a reason: it is shown to the member.");
  const days = Math.max(0, Number(body?.days) || 0);
  const at = now();
  const until = days ? at + days * 86_400 : 9_999_999_999;
  const stmts: D1PreparedStatement[] = [
    ban
      ? env.DB.prepare(
          "INSERT INTO community_bans (community_id, user_id, until, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (community_id, user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at",
        ).bind(c.id, target.id, until, reason, u.id, at)
      : env.DB.prepare("DELETE FROM community_bans WHERE community_id = ? AND user_id = ?").bind(c.id, target.id),
    env.DB.prepare("INSERT INTO mod_actions (id, moderator_id, action, target_type, target_id, community_id, reason, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)").bind(
      newId(), u.id, ban ? "ban" : "unban", target.id, c.id, reason, at,
    ),
  ];
  const notice = notifyStatement(env, target.id, {
    kind: "banned",
    actor: c.title,
    text: ban ? `You are banned from ${c.title} ${days ? `for ${days} day${days === 1 ? "" : "s"}` : "permanently"}. Reason: ${reason}` : `Your ban from ${c.title} was lifted.`,
  });
  if (notice) stmts.push(notice);
  await env.DB.batch(stmts);
  return json({ ok: true });
}

/** GET /tickers/popular — the ticker communities with the most posts (the website's front page). */
export async function popularTickers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, title, post_count FROM communities WHERE kind = 'ticker' AND post_count > 0 ORDER BY post_count DESC, title LIMIT 12").all<Row>();
  return json({ tickers: results }, 200, { "cache-control": "public, max-age=300" });
}
