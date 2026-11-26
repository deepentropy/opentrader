/*
 * Sign-in with an existing account (GitHub, Google, Discord): no passwords,
 * no e-mail addresses stored, only the provider's user id and a name. Or with
 * an e-mail address: a one-time code sent to it (no password either); the
 * address is the account's identity and is kept, for account and billing
 * messages only.
 *
 *   1. The app picks a random `state` and a PKCE verifier, and opens
 *      /auth/start?provider&state&challenge&redirect in the browser.
 *   2. The provider sends the browser back to /auth/callback/<provider>; the
 *      user is found or created and a one-time code is attached to the login.
 *   3. The browser goes on to `redirect`: the desktop app's loopback address
 *      (http://127.0.0.1:<port>/community-auth, RFC 8252) or the web version's
 *      page. It carries the code; only the app holding the verifier can trade
 *      it for a session at POST /auth/token.
 *
 * Before the provider, the browser passes a bot check (Cloudflare Turnstile,
 * when TURNSTILE_SITE_KEY is set). A connection makes at most
 * SIGNUPS_PER_DAY new accounts a day.
 *
 * DEV_LOGIN=1 (local runs only) adds a "dev" provider that asks for a name.
 */
import { Env } from "./env";
import { HttpError, NAME_RE, escapeHtml, json, nameFromProfile, newId, newToken, now, pkceMatches, senderHash, sha256Hex, str, timingSafeEqual } from "./util";

const LOGIN_TTL = 15 * 60;
/** New accounts a connection may make a day. */
const SIGNUPS_PER_DAY = 3;
const SESSION_TTL = 90 * 86_400;
/** A session used with less than this left is extended. */
const SESSION_RENEW = 60 * 86_400;

type Profile = { id: string; name: string };

type Provider = {
  authorize: string;
  token: string;
  scope: string;
  clientId: (env: Env) => string | undefined;
  clientSecret: (env: Env) => string | undefined;
  profile: (accessToken: string) => Promise<Profile>;
};

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(502, `sign-in provider answered ${res.status}`);
  return res.json();
}

const PROVIDERS: Record<string, Provider> = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "",
    clientId: (e) => e.GITHUB_CLIENT_ID,
    clientSecret: (e) => e.GITHUB_CLIENT_SECRET,
    profile: async (t) => {
      const u = await fetchJson("https://api.github.com/user", { headers: { authorization: `Bearer ${t}`, "user-agent": "OpenTrader-Community", accept: "application/vnd.github+json" } });
      return { id: String(u.id), name: str(u.login) };
    },
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid profile",
    clientId: (e) => e.GOOGLE_CLIENT_ID,
    clientSecret: (e) => e.GOOGLE_CLIENT_SECRET,
    profile: async (t) => {
      const u = await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t}` } });
      return { id: String(u.sub), name: str(u.given_name) || str(u.name) };
    },
  },
  discord: {
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    scope: "identify",
    clientId: (e) => e.DISCORD_CLIENT_ID,
    clientSecret: (e) => e.DISCORD_CLIENT_SECRET,
    profile: async (t) => {
      const u = await fetchJson("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${t}` } });
      return { id: String(u.id), name: str(u.username) };
    },
  },
};

export function enabledProviders(env: Env): string[] {
  const list = Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].clientId(env) && PROVIDERS[p].clientSecret(env));
  if (mailOn(env)) list.push("email");
  if (env.DEV_LOGIN === "1") list.push("dev");
  return list;
}

/** Where a login may end: the desktop app's loopback listener, or a listed web page. */
export function redirectAllowed(env: Env, redirect: string): boolean {
  let u: URL;
  try {
    u = new URL(redirect);
  } catch {
    return false;
  }
  if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port !== "" && u.pathname === "/community-auth" && !u.search) return true;
  const listed = (env.WEB_REDIRECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return listed.includes(u.origin + u.pathname) && !u.search;
}

const STATE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function page(title: string, body: string, status = 200, head = ""): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>
<style>body{font:15px system-ui,sans-serif;background:#131722;color:#d1d4dc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
main{max-width:420px;padding:32px;background:#1e222d;border-radius:8px}h1{font-size:20px;margin:0 0 12px}input{font:inherit;padding:8px;width:100%;box-sizing:border-box;margin:8px 0 12px;background:#131722;color:inherit;border:1px solid #434651;border-radius:4px}
button{font:inherit;padding:8px 16px;background:#2962ff;color:#fff;border:0;border-radius:4px;cursor:pointer}
.link{background:none;color:#2962ff;padding:0}.error{color:#f7525f}.muted{color:#787b86;font-size:13px}form+form{margin-top:16px}</style>${head}</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Sign-in pages carry the login's state: never kept, framed by another site or sent on as referrer.
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

function finish(redirect: string, params: Record<string, string>): Response {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
}

/** GET /auth/start */
export async function start(env: Env, url: URL): Promise<Response> {
  const provider = url.searchParams.get("provider") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("challenge") ?? "";
  const redirect = url.searchParams.get("redirect") ?? "";
  if (!enabledProviders(env).includes(provider)) return page("Sign-in unavailable", "<p>This sign-in method isn't available.</p>", 400);
  if (!STATE_RE.test(state) || !CHALLENGE_RE.test(challenge) || !redirectAllowed(env, redirect)) {
    return page("Sign-in failed", "<p>The sign-in request is not valid. Start again from OpenTrader.</p>", 400);
  }
  const at = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM logins WHERE created_at < ?").bind(at - LOGIN_TTL),
    // The same page loaded again (a refresh): the same sign-in goes on.
    env.DB.prepare("INSERT INTO logins (state, provider, challenge, redirect, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (state) DO NOTHING").bind(
      state, provider, challenge, redirect, at,
    ),
  ]);
  const login = await env.DB.prepare("SELECT provider, challenge, redirect, code FROM logins WHERE state = ?").bind(state).first<Record<string, string | null>>();
  if (!login || login.provider !== provider || login.challenge !== challenge || login.redirect !== redirect || login.code) {
    return page("Sign-in failed", "<p>This sign-in was already used. Start again from OpenTrader.</p>", 400);
  }
  if (env.TURNSTILE_SITE_KEY) return botCheck(env, state);
  return toProvider(env, provider, state);
}

/** A Turnstile check page that posts `hidden` to `action` once passed. */
export function turnstilePage(env: Env, action: string, hidden: Record<string, string>, title: string, text: string): Response {
  const fields = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join("");
  return page(
    title,
    `<p>${escapeHtml(text)}</p>
<form id="f" method="post" action="${escapeHtml(action)}">${fields}
<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY ?? "")}" data-callback="passed" data-theme="dark"></div></form>
<script>function passed(){document.getElementById("f").submit()}</script>`,
    200,
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
  );
}

/** The Turnstile answer a check page posted is valid. */
export async function turnstilePassed(env: Env, request: Request, form: FormData): Promise<boolean> {
  const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET ?? "",
      response: String(form.get("cf-turnstile-response") ?? ""),
      remoteip: request.headers.get("CF-Connecting-IP") ?? "",
    }),
  }).then((r) => r.json() as Promise<{ success?: boolean }>, () => ({ success: false }));
  return !!check.success;
}

/** The bot check page of a sign-in. */
function botCheck(env: Env, state: string): Response {
  return turnstilePage(env, "/auth/verify", { state }, "Signing in…", "A quick check that you're not a robot, then the sign-in continues.");
}

/** POST /auth/verify (form: state, cf-turnstile-response) */
export async function verify(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const login = await pendingLogin(env, state);
  if (!login) return page("Sign-in failed", "<p>This sign-in has expired. Start again from OpenTrader.</p>", 400);
  if (!(await turnstilePassed(env, request, form))) return page("Sign-in failed", "<p>The check did not pass. Start again from OpenTrader.</p>", 403);
  await env.DB.prepare("UPDATE logins SET verified = 1 WHERE state = ?").bind(state).run();
  // 303: the browser follows with a GET.
  const next = await toProvider(env, login.provider, state);
  return new Response(next.body, { status: next.status === 302 ? 303 : next.status, headers: next.headers });
}

/** On to the provider (the test sign-in: its name form). */
async function toProvider(env: Env, provider: string, state: string): Promise<Response> {
  if (provider === "dev") {
    return page(
      "Test sign-in",
      `<p>Local test server: pick any name. Names in DEV_ADMINS are administrators.</p>
<form method="get" action="/auth/dev"><input type="hidden" name="state" value="${escapeHtml(state)}"><input name="name" placeholder="Name" autofocus required pattern="[A-Za-z0-9_\\-]{3,20}"><button>Sign in</button></form>`,
    );
  }
  if (provider === "email") return mailForm(state);
  const p = PROVIDERS[provider];
  const auth = new URL(p.authorize);
  auth.searchParams.set("client_id", p.clientId(env)!);
  auth.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/auth/callback/${provider}`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("state", state);
  if (p.scope) auth.searchParams.set("scope", p.scope);
  if (provider === "google") auth.searchParams.set("prompt", "select_account");
  return Response.redirect(auth.toString(), 302);
}

async function pendingLogin(env: Env, state: string): Promise<{ provider: string; redirect: string; verified: number } | null> {
  return env.DB.prepare("SELECT provider, redirect, verified FROM logins WHERE state = ? AND code IS NULL AND created_at >= ?")
    .bind(state, now() - LOGIN_TTL)
    .first();
}

/** GET /auth/callback/:provider */
export async function callback(env: Env, request: Request, url: URL, provider: string): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const login = await pendingLogin(env, state);
  if (!login || login.provider !== provider || (env.TURNSTILE_SITE_KEY && !login.verified)) {
    return page("Sign-in failed", "<p>This sign-in has expired. Start again from OpenTrader.</p>", 400);
  }
  const error = url.searchParams.get("error");
  if (error) return finish(login.redirect, { state, error });
  const p = PROVIDERS[provider];
  const tokenRes = await fetchJson(p.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: p.clientId(env)!,
      client_secret: p.clientSecret(env)!,
      code: url.searchParams.get("code") ?? "",
      grant_type: "authorization_code",
      redirect_uri: `${env.PUBLIC_URL}/auth/callback/${provider}`,
    }),
  });
  const accessToken = str(tokenRes.access_token);
  if (!accessToken) return finish(login.redirect, { state, error: "token" });
  const profile = await p.profile(accessToken);
  return complete(env, request, state, login.redirect, provider, profile);
}

// ── E-mail sign-in ──────────────────────────────────────────────────────
//
// The address gets a 6-digit code tied to the sign-in that asked for it (its
// state, itself tied to the app's PKCE verifier): a code read by someone else
// opens nothing on its own. Guessing is bounded: MAIL_TRIES per code,
// MAIL_PER_LOGIN codes per sign-in, MAIL_PER_HOUR / MAIL_PER_DAY codes per
// address, so at most MAIL_PER_DAY * MAIL_TRIES guesses in a million a day.
// Each sign-in passes the bot check first (the method is offered only with it).

/** A code works this long after it was sent. */
const MAIL_CODE_TTL = 10 * 60;
const MAIL_TRIES = 5;
const MAIL_PER_LOGIN = 3;
/** Seconds before the same sign-in may ask for another code. */
const MAIL_RESEND_AFTER = 60;
const MAIL_PER_HOUR = 5;
const MAIL_PER_DAY = 10;
/** Codes one connection may have sent in an hour, to any addresses. */
const MAIL_PER_SENDER_HOUR = 10;

/** E-mail sign-in is offered: a sender, and the bot check (or a local run). */
function mailOn(env: Env): boolean {
  return !!env.EMAIL && !!env.EMAIL_FROM && (!!env.TURNSTILE_SITE_KEY || env.DEV_LOGIN === "1");
}

// The HTML form's own rule for an address (one dot at least in the domain), ASCII only.
const MAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The address in lower case, or null when it is not one. */
export function normalizeMail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && MAIL_RE.test(s) ? s : null;
}

/** Six digits, uniform. */
export function mailCode(): string {
  const n = new Uint32Array(1);
  // 4,294,000,000 is the last multiple of a million under 2^32: the values above it would favour low codes.
  do crypto.getRandomValues(n);
  while (n[0] >= 4_294_000_000);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

const mailCodeHash = (state: string, code: string) => sha256Hex(`mail:${state}:${code}`);

type MailLogin = { redirect: string; mail: string | null; mail_code_hash: string | null; mail_code_at: number | null; mail_tries: number; mail_sent: number; mail_ok: number };

/** The e-mail sign-in of `state`, still open and past the bot check. */
async function mailLogin(env: Env, state: string): Promise<MailLogin | null> {
  if (!mailOn(env) || !STATE_RE.test(state)) return null;
  const login = await env.DB.prepare(
    "SELECT redirect, verified, mail, mail_code_hash, mail_code_at, mail_tries, mail_sent, mail_ok FROM logins WHERE state = ? AND provider = 'email' AND code IS NULL AND created_at >= ?",
  )
    .bind(state, now() - LOGIN_TTL)
    .first<MailLogin & { verified: number }>();
  if (!login || (env.TURNSTILE_SITE_KEY && !login.verified)) return null;
  return login;
}

const expired = () => page("Sign-in failed", "<p>This sign-in has expired. Start again from OpenTrader.</p>", 400);
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
const error = (text: string | undefined) => (text ? `<p class="error" role="alert">${escapeHtml(text)}</p>` : "");

function mailForm(state: string, problem?: string, value = "", status = 200): Response {
  return page(
    "Sign in with e-mail",
    `<p>Enter your e-mail address: we send you a code to sign in. No password.</p>${error(problem)}
<form method="post" action="/auth/email">${hidden("state", state)}
<input type="email" name="email" value="${escapeHtml(value)}" placeholder="you@example.com" autocomplete="email" maxlength="254" required autofocus>
<button>Send the code</button></form>
<p class="muted">We use your address only to send sign-in codes and messages about your account and billing. Never marketing, never shared.</p>`,
    status,
  );
}

function codeForm(state: string, mail: string, problem?: string, status = 200): Response {
  return page(
    "Check your e-mail",
    `<p>We sent a 6-digit code to <b>${escapeHtml(mail)}</b>. It works for ${MAIL_CODE_TTL / 60} minutes.</p>${error(problem)}
<form method="post" action="/auth/email/code">${hidden("state", state)}
<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="123456" required autofocus>
<button>Sign in</button></form>
${newCodeForm(state, mail)}`,
    status,
  );
}

/** Another code to the same address, or another address. */
function newCodeForm(state: string, mail: string): string {
  return `<form method="post" action="/auth/email">${hidden("state", state)}${hidden("email", mail)}
<p class="muted">No e-mail? Look in your spam folder, or <button class="link">send a new code</button>. <a href="/auth/email?state=${encodeURIComponent(state)}" style="color:#2962ff">Use another address</a>.</p></form>`;
}

function nameForm(state: string, problem?: string, value = "", status = 200): Response {
  return page(
    "Choose your user name",
    `<p>It is shown with what you post. 3 to 20 letters, digits, _ or -.</p>${error(problem)}
<form method="post" action="/auth/email/name">${hidden("state", state)}
<input name="name" value="${escapeHtml(value)}" autocomplete="username" pattern="[A-Za-z0-9_\\-]{3,20}" maxlength="20" required autofocus>
<button>Create my account</button></form>`,
    status,
  );
}

/** GET /auth/email?state: the address form again (another address). */
export async function mailStart(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const login = await mailLogin(env, state);
  return login ? mailForm(state, undefined, login.mail ?? "") : expired();
}

/** POST /auth/email (form: state, email): sends a code. */
export async function mailSend(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const login = await mailLogin(env, state);
  if (!login) return expired();
  const typed = String(form.get("email") ?? "").slice(0, 300);
  const mail = normalizeMail(typed);
  if (!mail) return mailForm(state, "Enter a valid e-mail address.", typed, 400);
  if (login.mail_sent >= MAIL_PER_LOGIN) return page("Too many codes", "<p>This sign-in sent all the codes it may. Start again from OpenTrader.</p>", 429);
  const at = now();
  const wait = login.mail_code_at ? login.mail_code_at + MAIL_RESEND_AFTER - at : 0;
  if (wait > 0) return mailForm(state, `Wait ${wait} seconds before asking for another code.`, mail, 429);

  const address = await sha256Hex(`mail:${mail}`);
  const sender = await senderHash(request);
  await env.DB.prepare("DELETE FROM mail_sends WHERE created_at < ?").bind(at - 86_400).run();
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM mail_sends WHERE address_hash = ?1 AND created_at >= ?3) AS hour,
       (SELECT COUNT(*) FROM mail_sends WHERE address_hash = ?1) AS day,
       (SELECT COUNT(*) FROM mail_sends WHERE sender_hash = ?2 AND created_at >= ?3) AS sender`,
  )
    .bind(address, sender, at - 3600)
    .first<{ hour: number; day: number; sender: number }>();
  if (!counts || counts.hour >= MAIL_PER_HOUR || counts.day >= MAIL_PER_DAY) {
    return page("Too many codes", "<p>This address received too many codes. Try again later, or sign in another way.</p>", 429);
  }
  if (counts.sender >= MAIL_PER_SENDER_HOUR) return page("Too many codes", "<p>Your connection asked for too many codes. Try again in an hour.</p>", 429);

  const code = mailCode();
  // Taken in one statement: two forms sent at once cannot both pass the limits of the sign-in.
  const took = await env.DB.prepare(
    `UPDATE logins SET mail = ?, mail_code_hash = ?, mail_code_at = ?, mail_tries = 0, mail_sent = mail_sent + 1, mail_ok = 0
       WHERE state = ? AND code IS NULL AND mail_sent < ? AND (mail_code_at IS NULL OR mail_code_at <= ?)`,
  )
    .bind(mail, await mailCodeHash(state, code), at, state, MAIL_PER_LOGIN, at - MAIL_RESEND_AFTER)
    .run();
  if (!took.meta.changes) return mailForm(state, "A code was just sent. Wait a minute before asking for another one.", mail, 429);
  // Counted before the sending: a failed one counts too.
  await env.DB.prepare("INSERT INTO mail_sends (address_hash, sender_hash, created_at) VALUES (?, ?, ?)").bind(address, sender, at).run();
  try {
    await env.EMAIL!.send({
      to: mail,
      from: { email: env.EMAIL_FROM!, name: "OpenTrader" },
      subject: "Your OpenTrader sign-in code",
      text: mailText(code),
      html: mailHtml(code),
    });
  } catch (e) {
    console.error("[mail]", (e as { code?: string }).code ?? e);
    await env.DB.prepare("UPDATE logins SET mail_code_hash = NULL WHERE state = ?").bind(state).run();
    return mailForm(state, "The code could not be sent to this address. Check it and try again in a minute.", mail, 502);
  }
  return codeForm(state, mail);
}

function mailText(code: string): string {
  return `Your OpenTrader sign-in code is:

${code}

It works for ${MAIL_CODE_TTL / 60} minutes, for the sign-in you just started. Never give it to anyone: OpenTrader never asks for it.

If you did not ask for it, ignore this e-mail: nobody can sign in without the code.`;
}

function mailHtml(code: string): string {
  return `<div style="font:15px system-ui,sans-serif;color:#131722;max-width:480px">
<p>Your OpenTrader sign-in code is:</p>
<p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:16px 0">${code}</p>
<p>It works for ${MAIL_CODE_TTL / 60} minutes, for the sign-in you just started. Never give it to anyone: OpenTrader never asks for it.</p>
<p style="color:#787b86;font-size:13px">If you did not ask for it, ignore this e-mail: nobody can sign in without the code.</p></div>`;
}

/** POST /auth/email/code (form: state, code) */
export async function mailCheck(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const login = await mailLogin(env, state);
  if (!login || !login.mail) return expired();
  const mail = login.mail;
  const again = (text: string) =>
    page("Sign-in code", `${error(text)}${newCodeForm(state, mail)}`, 400);
  if (!login.mail_code_hash || !login.mail_code_at || now() - login.mail_code_at > MAIL_CODE_TTL) return again("This code no longer works. Ask for a new one.");
  const code = String(form.get("code") ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return codeForm(state, mail, "Enter the 6 digits of the code.", 400);
  // The try is counted before the comparison: guesses sent at once cannot pass the limit.
  const tried = await env.DB.prepare(
    "UPDATE logins SET mail_tries = mail_tries + 1 WHERE state = ? AND code IS NULL AND mail_code_hash IS NOT NULL AND mail_tries < ? RETURNING mail_tries, mail_code_hash",
  )
    .bind(state, MAIL_TRIES)
    .first<{ mail_tries: number; mail_code_hash: string }>();
  if (!tried) return again("Too many wrong codes. Ask for a new one.");
  if (!timingSafeEqual(await mailCodeHash(state, code), tried.mail_code_hash)) {
    const left = MAIL_TRIES - tried.mail_tries;
    if (left > 0) return codeForm(state, mail, left === 1 ? "Wrong code. 1 try left." : `Wrong code. ${left} tries left.`, 400);
    await env.DB.prepare("UPDATE logins SET mail_code_hash = NULL WHERE state = ?").bind(state).run();
    return again("Too many wrong codes. Ask for a new one.");
  }
  // Right: the code is spent.
  const spent = await env.DB.prepare("UPDATE logins SET mail_code_hash = NULL, mail_ok = 1 WHERE state = ? AND mail_code_hash = ?").bind(state, tried.mail_code_hash).run();
  if (!spent.meta.changes) return again("This code no longer works. Ask for a new one.");
  const known = await env.DB.prepare("SELECT 1 FROM users WHERE provider = 'email' AND provider_id = ?").bind(mail).first();
  if (known) return complete(env, request, state, login.redirect, "email", { id: mail, name: "" });
  return nameForm(state);
}

/** POST /auth/email/name (form: state, name): a new account's user name. */
export async function mailName(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const login = await mailLogin(env, state);
  if (!login || !login.mail || !login.mail_ok) return expired();
  const name = String(form.get("name") ?? "").trim().slice(0, 40);
  if (!NAME_RE.test(name)) return nameForm(state, "3 to 20 characters: letters, digits, _ or -.", name, 400);
  const taken = await env.DB.prepare("SELECT 1 FROM users WHERE name_key = ?").bind(name.toLowerCase()).first();
  if (taken) return nameForm(state, "This name is taken. Pick another one.", name, 409);
  return complete(env, request, state, login.redirect, "email", { id: login.mail, name });
}

/** GET /auth/dev (DEV_LOGIN only) */
export async function devLogin(env: Env, request: Request, url: URL): Promise<Response> {
  if (env.DEV_LOGIN !== "1") throw new HttpError(404, "not found");
  const state = url.searchParams.get("state") ?? "";
  const login = await pendingLogin(env, state);
  if (!login || login.provider !== "dev" || (env.TURNSTILE_SITE_KEY && !login.verified)) return page("Sign-in failed", "<p>This sign-in has expired.</p>", 400);
  const name = nameFromProfile(url.searchParams.get("name") ?? "");
  return complete(env, request, state, login.redirect, "dev", { id: name.toLowerCase(), name });
}

async function complete(env: Env, request: Request, state: string, redirect: string, provider: string, profile: Profile): Promise<Response> {
  const userId = await upsertUser(env, provider, profile, await senderHash(request));
  if (!userId) {
    return page("Too many new accounts", `<p>Your connection made ${SIGNUPS_PER_DAY} new accounts today. Try again tomorrow, or sign in with an account you already have.</p>`, 429);
  }
  const code = newToken();
  await env.DB.prepare("UPDATE logins SET code = ?, user_id = ? WHERE state = ?").bind(code, userId, state).run();
  return finish(redirect, { state, code });
}

function isAdmin(env: Env, provider: string, providerId: string): boolean {
  const list = provider === "dev" ? env.DEV_ADMINS : env.ADMINS;
  return (list ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(`${provider}:${providerId}`.toLowerCase());
}

/** The account's id; null when the connection made too many accounts today. */
async function upsertUser(env: Env, provider: string, profile: Profile, sender: string): Promise<string | null> {
  const admin = isAdmin(env, provider, profile.id);
  const found = await env.DB.prepare("SELECT id, role FROM users WHERE provider = ? AND provider_id = ?").bind(provider, profile.id).first<{ id: string; role: string }>();
  if (found) {
    if (admin && found.role !== "admin") await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(found.id).run();
    return found.id;
  }
  const made = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE signup_hash = ? AND created_at >= ?").bind(sender, now() - 86_400).first<{ n: number }>();
  if ((made?.n ?? 0) >= SIGNUPS_PER_DAY && !admin) return null;
  const base = nameFromProfile(profile.name || `${provider}_user`);
  const id = newId(12);
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? base : `${base.slice(0, 15)}${Math.floor(Math.random() * 10_000)}`;
    const ok = await env.DB.prepare(
      "INSERT INTO users (id, name, name_key, provider, provider_id, role, created_at, signup_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name_key) DO NOTHING",
    )
      .bind(id, name, name.toLowerCase(), provider, profile.id, admin ? "admin" : "user", now(), sender)
      .run();
    if (ok.meta.changes) return id;
  }
  throw new HttpError(500, "could not pick a user name");
}

/** POST /auth/token {code, verifier} → {token} */
export async function token(env: Env, body: any): Promise<Response> {
  const code = str(body?.code);
  const verifier = str(body?.verifier);
  if (!code || !verifier) throw new HttpError(400, "code and verifier are required");
  const login = await env.DB.prepare("SELECT state, challenge, user_id FROM logins WHERE code = ? AND created_at >= ?")
    .bind(code, now() - LOGIN_TTL)
    .first<{ state: string; challenge: string; user_id: string }>();
  if (!login) throw new HttpError(400, "this sign-in has expired");
  // One try: a wrong verifier ends the login.
  await env.DB.prepare("DELETE FROM logins WHERE state = ?").bind(login.state).run();
  if (!(await pkceMatches(verifier, login.challenge))) throw new HttpError(400, "this sign-in does not belong to this app");
  const tok = newToken();
  const at = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(tok), login.user_id, at, at + SESSION_TTL)
    .run();
  return json({ token: tok });
}

export type User = {
  id: string;
  name: string;
  role: string;
  created_at: number;
  banned_until: number | null;
  ban_reason: string | null;
  /** Passed the bot check before posting (#219). */
  post_checked: number;
  token_hash: string;
  /** The address of an e-mail account (account and billing messages); null for the other sign-ins. */
  email?: string | null;
};

/** The signed-in user (Authorization: Bearer <token>), or null. */
export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(header);
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.created_at, u.banned_until, u.ban_reason, u.post_checked, s.expires_at, s.token_hash,
            CASE WHEN u.provider = 'email' THEN u.provider_id END AS email
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<User & { expires_at: number }>();
  if (!row) return null;
  const at = now();
  if (row.expires_at < at) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  if (row.expires_at - at < SESSION_RENEW) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(at + SESSION_TTL, hash).run();
  }
  return row;
}

/** POST /auth/logout */
export async function logout(env: Env, user: User): Promise<Response> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.token_hash).run();
  return json({ ok: true });
}
