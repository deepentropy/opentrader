/*
 * OpenTrader Community: discussion communities per ticker ($AAPL) and per
 * theme (c/penny-stocks), served from one Worker and one D1 database, with
 * its website (./site, see pages.ts) at the same address.
 * The desktop app and the web version call it directly (CORS below).
 * See migrations/ for the data, auth.ts for sign-in, api.ts for the rest.
 */
import { Env } from "./env";
import * as auth from "./auth";
import * as api from "./api";
import { page } from "./pages";
import { HttpError, json } from "./util";

/** Page origins of the desktop app's webview (Windows; macOS and Linux). */
const DESKTOP_ORIGINS = ["http://tauri.localhost", "tauri://localhost"];
const MAX_BODY = 64 * 1024;

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = [...DESKTOP_ORIGINS, ...env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())];
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function readBody(request: Request): Promise<any> {
  if (request.method === "GET" || request.method === "DELETE") return null;
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Too long.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request is not valid JSON.");
  }
}

type Handler = (ctx: { env: Env; request: Request; url: URL; params: string[]; body: any; user: auth.User | null }) => Promise<Response>;

const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/auth\/providers$/, async ({ env }) => json({ providers: auth.enabledProviders(env) })],
  ["GET", /^\/auth\/start$/, ({ env, url }) => auth.start(env, url)],
  ["GET", /^\/auth\/callback\/(github|google|discord)$/, ({ env, url, params }) => auth.callback(env, url, params[0])],
  ["GET", /^\/auth\/dev$/, ({ env, url }) => auth.devLogin(env, url)],
  ["POST", /^\/auth\/token$/, ({ env, body }) => auth.token(env, body)],
  ["POST", /^\/auth\/logout$/, async ({ env, user }) => (user ? auth.logout(env, user) : json({ ok: true }))],

  ["GET", /^\/me$/, ({ env, user }) => api.me(env, user)],
  ["PATCH", /^\/me$/, ({ env, user, body }) => api.rename(env, user, body)],
  ["DELETE", /^\/me$/, ({ env, user }) => api.deleteAccount(env, user)],

  ["GET", /^\/communities$/, ({ env, user }) => api.listThemes(env, user)],
  ["GET", /^\/communities\/([^/]+)$/, ({ env, user, params }) => api.getCommunity(env, user, params[0])],
  ["POST", /^\/communities\/([^/]+)\/follow$/, ({ env, user, params }) => api.follow(env, user, params[0], true)],
  ["DELETE", /^\/communities\/([^/]+)\/follow$/, ({ env, user, params }) => api.follow(env, user, params[0], false)],
  ["GET", /^\/communities\/([^/]+)\/posts$/, ({ env, user, params, url }) => api.communityPosts(env, user, params[0], url)],
  ["POST", /^\/communities\/([^/]+)\/posts$/, ({ env, user, params, body }) => api.createPost(env, user, params[0], body)],
  ["GET", /^\/feed$/, ({ env, user, url }) => api.feed(env, user, url)],

  ["GET", /^\/posts\/([a-z0-9]+)$/, ({ env, user, params }) => api.getPost(env, user, params[0])],
  ["PATCH", /^\/posts\/([a-z0-9]+)$/, ({ env, user, params, body }) => api.editPost(env, user, params[0], body)],
  ["DELETE", /^\/posts\/([a-z0-9]+)$/, ({ env, user, params }) => api.deletePost(env, user, params[0])],
  ["POST", /^\/posts\/([a-z0-9]+)\/vote$/, ({ env, user, params, body }) => api.vote(env, user, "post", params[0], body)],
  ["POST", /^\/posts\/([a-z0-9]+)\/comments$/, ({ env, user, params, body }) => api.createComment(env, user, params[0], body)],
  ["PATCH", /^\/comments\/([a-z0-9]+)$/, ({ env, user, params, body }) => api.editComment(env, user, params[0], body)],
  ["DELETE", /^\/comments\/([a-z0-9]+)$/, ({ env, user, params }) => api.deleteComment(env, user, params[0])],
  ["POST", /^\/comments\/([a-z0-9]+)\/vote$/, ({ env, user, params, body }) => api.vote(env, user, "comment", params[0], body)],

  ["POST", /^\/reports$/, ({ env, user, body }) => api.report(env, user, body)],
  ["POST", /^\/appeals$/, ({ env, user, body }) => api.appeal(env, user, body)],
  ["POST", /^\/contact$/, ({ env, user, request, body }) => api.contact(env, user, request, body)],
  ["GET", /^\/mod\/messages$/, ({ env, user }) => api.messages(env, user)],
  ["POST", /^\/mod\/messages\/([a-z0-9]+)\/done$/, ({ env, user, params }) => api.messageDone(env, user, params[0])],
  ["GET", /^\/mod\/queue$/, ({ env, user }) => api.modQueue(env, user)],
  ["GET", /^\/mod\/log$/, ({ env, user, url }) => api.modLog(env, user, url)],
  ["POST", /^\/mod\/action$/, ({ env, user, body }) => api.modAction(env, user, body)],
  ["POST", /^\/mod\/moderators$/, ({ env, user, body }) => api.setModerator(env, user, body)],
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    let res: Response;
    try {
      const html = await page(env, request, url);
      if (html) return html;
      const path = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
      let handler: Handler | null = null;
      let params: string[] = [];
      let pathMatched = false;
      for (const [method, re, h] of ROUTES) {
        const m = re.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (method === request.method) {
          handler = h;
          params = m.slice(1);
          break;
        }
      }
      // The website's files and pages (an address the API also uses, /contact, is a page for a browser).
      if (!handler && request.method === "GET" && env.ASSETS) return env.ASSETS.fetch(request);
      if (!handler) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed." : "Not found.");
      const body = await readBody(request);
      const user = await auth.currentUser(env, request);
      res = await handler({ env, request, url, params, body, user });
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else {
        console.error(e);
        res = json({ error: "Something went wrong. Try again." }, 500);
      }
    }
    if (!Object.keys(headers).length) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
    return out;
  },
};
