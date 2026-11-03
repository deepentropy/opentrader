/*
 * The bot check before a new account's first post or comment (#219). Writing
 * answers 428 with `check: true` until the account passed it once; the app
 * then opens /check?ticket=… in the browser (the check can't run in the
 * desktop app's own page) and posts again once the account is checked.
 */
import { Env } from "./env";
import { User, page, turnstilePage, turnstilePassed } from "./auth";
import { HttpError, json, newToken, now } from "./util";

const TICKET_TTL = 15 * 60;

/** Writing needs the check, unless done (or no check is set up). */
export function requirePostingCheck(env: Env, u: User): void {
  if (!env.TURNSTILE_SITE_KEY || u.post_checked || u.role === "admin") return;
  throw new HttpError(428, "Before your first post, confirm that you're not a robot.", { check: true });
}

/** POST /check/start — the address of the check page, for the signed-in account. */
export async function startCheck(env: Env, user: User | null): Promise<Response> {
  if (!user) throw new HttpError(401, "Sign in to do this.");
  const ticket = newToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM post_checks WHERE created_at < ?").bind(now() - TICKET_TTL),
    env.DB.prepare("INSERT INTO post_checks (ticket, user_id, created_at) VALUES (?, ?, ?)").bind(ticket, user.id, now()),
  ]);
  return json({ url: `${env.PUBLIC_URL}/check?ticket=${ticket}` });
}

/** GET /check?ticket= — the check page. */
export async function checkPage(env: Env, url: URL): Promise<Response> {
  const ticket = url.searchParams.get("ticket") ?? "";
  const row = await env.DB.prepare("SELECT user_id FROM post_checks WHERE ticket = ? AND created_at >= ?").bind(ticket, now() - TICKET_TTL).first();
  if (!row) return page("Check expired", "<p>This check has expired. Post again from OpenTrader to get a new one.</p>", 400);
  return turnstilePage(env, "/check/verify", { ticket }, "One quick check", "Confirm that you're not a robot, then go back to OpenTrader: your post goes out.");
}

/** POST /check/verify (form: ticket, cf-turnstile-response) */
export async function verifyCheck(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const ticket = String(form.get("ticket") ?? "");
  const row = await env.DB.prepare("SELECT user_id FROM post_checks WHERE ticket = ? AND created_at >= ?").bind(ticket, now() - TICKET_TTL).first<{ user_id: string }>();
  if (!row) return page("Check expired", "<p>This check has expired. Post again from OpenTrader to get a new one.</p>", 400);
  if (!(await turnstilePassed(env, request, form))) return page("Check failed", "<p>The check did not pass. Post again from OpenTrader to try once more.</p>", 403);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET post_checked = 1 WHERE id = ?").bind(row.user_id),
    env.DB.prepare("DELETE FROM post_checks WHERE ticket = ?").bind(ticket),
  ]);
  return page("Done", "<p>Thank you. You can close this tab: OpenTrader sends your post.</p>");
}
