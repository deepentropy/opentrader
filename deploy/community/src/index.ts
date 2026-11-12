/*
 * OpenTrader Community: posts per ticker ($AAPL, US stocks and ETFs) and in
 * General, ideas settled against price, members' feature suggestions
 * (suggestions.ts), served from one Worker and one D1 database, with its
 * website (./site, see pages.ts) at the same address.
 * The desktop app and the web version call it directly (CORS below).
 * See migrations/ for the data, auth.ts for sign-in, api.ts for the rest.
 */
import { Env } from "./env";
import * as auth from "./auth";
import * as api from "./api";
import { isFile, notFound, page } from "./pages";
import { serveImage } from "./charts";
import * as check from "./check";
import * as live from "./live";
import * as members from "./members";
import * as notices from "./notify";
import * as bot from "./bot";
import * as ideas from "./ideas";
import * as snapshots from "./snapshots";
import * as views from "./views";
import * as billing from "./billing";
import * as suggestions from "./suggestions";

export { PostRoom } from "./live";
import { HttpError, json } from "./util";

/** Page origins of the desktop app's webview (Windows; macOS and Linux). */
const DESKTOP_ORIGINS = ["http://tauri.localhost", "tauri://localhost"];
const MAX_BODY = 64 * 1024;
/** A new post, a reply or a snapshot may carry a chart's picture. */
const MAX_POST_BODY = 2_500_000;
const PICTURED = /^\/(communities\/[^/]+\/posts|posts\/[a-z0-9]+\/comments|me\/snapshots)$/;

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = [...DESKTOP_ORIGINS, ...env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())];
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function readBody(request: Request, path: string): Promise<any> {
  if (request.method === "GET" || request.method === "DELETE") return null;
  const text = await request.text();
  if (text.length > (PICTURED.test(path) ? MAX_POST_BODY : MAX_BODY)) throw new HttpError(413, "Too long.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request is not valid JSON.");
  }
}

/** Bursts from one connection: sign-ins, and writes (posts, comments, ratings, reports). */
async function burstLimit(env: Env, request: Request, path: string): Promise<void> {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limiter = path === "/auth/start" || path === "/auth/token" || path === "/auth/verify" || path === "/check/verify" ? env.AUTH_LIMITER : request.method === "GET" ? undefined : env.WRITE_LIMITER;
  if (limiter && !(await limiter.limit({ key })).success) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
}

type Handler = (ctx: { env: Env; request: Request; url: URL; params: string[]; body: any; user: auth.User | null; ctx: ExecutionContext }) => Promise<Response>;

const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/auth\/providers$/, async ({ env }) => json({ providers: auth.enabledProviders(env) })],
  ["GET", /^\/auth\/start$/, ({ env, url }) => auth.start(env, url)],
  ["POST", /^\/auth\/verify$/, ({ env, request }) => auth.verify(env, request)],
  ["GET", /^\/auth\/callback\/(github|google|discord)$/, ({ env, request, url, params }) => auth.callback(env, request, url, params[0])],
  ["GET", /^\/auth\/dev$/, ({ env, request, url }) => auth.devLogin(env, request, url)],
  ["POST", /^\/auth\/token$/, ({ env, body }) => auth.token(env, body)],
  ["POST", /^\/auth\/logout$/, async ({ env, user }) => (user ? auth.logout(env, user) : json({ ok: true }))],
  ["POST", /^\/auth\/pass$/, ({ env, user }) => billing.issuePass(env, user)],

  // Paid tier (#252).
  ["GET", /^\/me\/plan$/, ({ env, user }) => billing.myPlan(env, user)],
  ["POST", /^\/billing\/checkout$/, ({ env, user }) => billing.checkout(env, user)],
  ["POST", /^\/billing\/portal$/, ({ env, user }) => billing.portal(env, user)],
  ["POST", /^\/billing\/webhook$/, ({ env, request }) => billing.webhook(env, request)],
  ["GET", /^\/billing\/(done|cancelled)$/, async ({ params }) => billing.returnPage(params[0] === "done")],

  ["GET", /^\/me$/, ({ env, user }) => api.me(env, user)],
  ["GET", /^\/me\/unread$/, ({ env, user }) => notices.unread(env, user)],
  ["GET", /^\/me\/notifications$/, ({ env, user }) => notices.list(env, user)],
  ["POST", /^\/me\/notifications\/read$/, ({ env, user }) => notices.markRead(env, user)],
  ["POST", /^\/check\/start$/, ({ env, user }) => check.startCheck(env, user)],
  ["GET", /^\/check$/, ({ env, url }) => check.checkPage(env, url)],
  ["POST", /^\/check\/verify$/, ({ env, request }) => check.verifyCheck(env, request)],
  ["POST", /^\/mod\/bot$/, ({ env, user, body }) => bot.runJob(env, user, body)],
  ["POST", /^\/mod\/community-ban$/, ({ env, user, body }) => members.communityBan(env, user, body)],
  ["PATCH", /^\/me$/, ({ env, user, body }) => api.rename(env, user, body)],
  ["DELETE", /^\/me$/, ({ env, user }) => api.deleteAccount(env, user)],
  ["PUT", /^\/me\/tickers$/, ({ env, user, body }) => api.setTickers(env, user, body)],
  ["GET", /^\/me\/snapshots$/, ({ env, user }) => snapshots.listSnapshots(env, user)],
  ["POST", /^\/me\/snapshots$/, ({ env, user, body }) => snapshots.addSnapshot(env, user, body)],
  ["GET", /^\/me\/snapshots\/([a-z0-9]+)\/image$/, ({ env, user, params }) => snapshots.snapshotImage(env, user, params[0])],
  ["DELETE", /^\/me\/snapshots\/([a-z0-9]+)$/, ({ env, user, params }) => snapshots.deleteSnapshot(env, user, params[0])],

  ["GET", /^\/home$/, ({ env, user, url }) => views.home(env, user, url)],
  ["GET", /^\/search$/, ({ env, user, url }) => views.search(env, user, url)],
  ["GET", /^\/tickers$/, ({ env, user }) => views.tickersIndex(env, user)],
  ["GET", /^\/tickers\/popular$/, ({ env }) => members.popularTickers(env)],
  ["GET", /^\/tickers\/([^/]+)$/, ({ env, user, params }) => views.tickerPage(env, user, params[0])],
  ["GET", /^\/tickers\/([^/]+)\/bars$/, ({ env, params }) => views.tickerBars(env, params[0])],
  ["GET", /^\/users\/([^/]+)$/, ({ env, user, params }) => views.profile(env, user, params[0])],
  ["GET", /^\/users\/([^/]+)\/posts$/, ({ env, user, params, url }) => views.userPosts(env, user, params[0], url)],
  ["GET", /^\/users\/([^/]+)\/replies$/, ({ env, params, url }) => views.userReplies(env, params[0], url)],
  ["POST", /^\/users\/([^/]+)\/watch$/, ({ env, user, params }) => views.watch(env, user, params[0], true)],
  ["DELETE", /^\/users\/([^/]+)\/watch$/, ({ env, user, params }) => views.watch(env, user, params[0], false)],

  ["GET", /^\/suggestions$/, ({ env, user, url }) => suggestions.list(env, user, url)],
  ["POST", /^\/suggestions$/, ({ env, user, request, body }) => suggestions.create(env, user, request, body)],
  ["GET", /^\/suggestions\/([a-z0-9]+)$/, ({ env, user, params }) => suggestions.get(env, user, params[0])],
  ["POST", /^\/suggestions\/([a-z0-9]+)\/support$/, ({ env, user, request, params, body, ctx }) => suggestions.support(env, user, request, params[0], body, ctx)],
  ["POST", /^\/mod\/suggestions\/import$/, ({ env, user, body }) => suggestions.importIssue(env, user, body)],
  ["POST", /^\/mod\/suggestions\/([a-z0-9]+)$/, ({ env, user, params, body }) => suggestions.update(env, user, params[0], body)],
  ["POST", /^\/mod\/suggestions\/([a-z0-9]+)\/promote$/, ({ env, user, params }) => suggestions.promote(env, user, params[0])],

  ["GET", /^\/communities\/([^/]+)$/, ({ env, user, params }) => api.getCommunity(env, user, params[0])],
  ["GET", /^\/communities\/([^/]+)\/moderators$/, ({ env, params }) => members.moderators(env, params[0])],
  ["GET", /^\/communities\/([^/]+)\/log$/, ({ env, params }) => members.publicLog(env, params[0])],
  ["GET", /^\/communities\/([^/]+)\/bans$/, ({ env, user, params }) => members.bans(env, user, params[0])],
  ["POST", /^\/communities\/([^/]+)\/follow$/, ({ env, user, params }) => api.follow(env, user, params[0], true)],
  ["DELETE", /^\/communities\/([^/]+)\/follow$/, ({ env, user, params }) => api.follow(env, user, params[0], false)],
  ["GET", /^\/communities\/([^/]+)\/posts$/, ({ env, user, params, url }) => api.communityPosts(env, user, params[0], url)],
  ["POST", /^\/communities\/([^/]+)\/posts$/, ({ env, user, request, params, body }) => api.createPost(env, user, request, params[0], body)],
  ["GET", /^\/feed$/, ({ env, user, url }) => api.feed(env, user, url)],

  ["GET", /^\/images\/([a-z0-9]+)$/, ({ env, params }) => serveImage(env, params[0])],
  ["GET", /^\/images\/c\/([a-z0-9]+)$/, ({ env, params }) => serveImage(env, params[0], "comments")],
  ["GET", /^\/posts\/([a-z0-9]+)$/, ({ env, user, params }) => api.getPost(env, user, params[0])],
  ["PATCH", /^\/posts\/([a-z0-9]+)$/, ({ env, user, params, body }) => api.editPost(env, user, params[0], body)],
  ["DELETE", /^\/posts\/([a-z0-9]+)$/, ({ env, user, params }) => api.deletePost(env, user, params[0])],
  ["POST", /^\/posts\/([a-z0-9]+)\/rate$/, ({ env, user, params, body }) => api.ratePost(env, user, params[0], body)],
  ["POST", /^\/posts\/([a-z0-9]+)\/answer$/, ({ env, user, params, body }) => api.markAnswer(env, user, params[0], body)],
  ["POST", /^\/posts\/([a-z0-9]+)\/comments$/, ({ env, user, request, params, body, ctx }) => api.createComment(env, user, request, params[0], body, ctx)],
  ["GET", /^\/posts\/([a-z0-9]+)\/live$/, ({ env, request, params }) => live.joinRoom(env, request, params[0])],
  ["PATCH", /^\/comments\/([a-z0-9]+)$/, ({ env, user, params, body }) => api.editComment(env, user, params[0], body)],
  ["DELETE", /^\/comments\/([a-z0-9]+)$/, ({ env, user, params }) => api.deleteComment(env, user, params[0])],
  // Apps from before the ratings: votes are gone.
  ["POST", /^\/(posts|comments)\/[a-z0-9]+\/vote$/, async () => json({ error: "Votes were replaced by \"useful\" ratings. Update OpenTrader to rate posts." }, 410)],
  ["POST", /^\/comments\/([a-z0-9]+)\/useful$/, ({ env, user, params, body }) => api.rateComment(env, user, params[0], body)],

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    // Plain HTTP to the public address: HTTPS (a local run serves HTTP).
    if (url.protocol === "http:" && env.PUBLIC_URL.startsWith("https:")) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    let res: Response;
    try {
      // The website's pages (an address the API also uses, such as /search or /contact, is a page for a browser).
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
      // The website's files (the sign-in page answers without its .html too); any other address is no page of it.
      if (!handler && (request.method === "GET" || request.method === "HEAD") && env.ASSETS) {
        const file = await env.ASSETS.fetch(request);
        return file.status === 404 && !isFile(url.pathname) ? notFound(env, url) : file;
      }
      if (!handler) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed." : "Not found.");
      // The payment provider's deliveries come in bursts from a few addresses.
      const raw = path === "/billing/webhook";
      if (!raw) await burstLimit(env, request, path);
      // The bot check's form and the webhook's signed body are read by their handlers.
      const body = raw || path === "/auth/verify" || path === "/check/verify" ? null : await readBody(request, path);
      const user = await auth.currentUser(env, request);
      res = await handler({ env, request, url, params, body, user, ctx });
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message, ...e.extra }, e.status);
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

  /**
   * Every half hour on weekdays (wrangler.jsonc), by UTC time: the bot's threads
   * at 13:00 and 16:00, idea prices from 14:00 to 21:30, the ideas settled at
   * 22:30 on the day's bars, subscriptions read back from the payment provider at 23:00,
   * suggestions whose GitHub issue closed each hour.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const t = new Date(controller.scheduledTime);
    const hm = t.getUTCHours() * 100 + t.getUTCMinutes();
    const run = (name: string, job: () => Promise<unknown>) => ctx.waitUntil(job().catch((e) => console.error(`[${name}]`, e)));
    if (hm === 1300 || hm === 1600) run("bot", () => bot.scheduled(env, hm));
    if (hm >= 1400 && hm <= 2130) run("prices", () => ideas.refreshPrices(env));
    if (hm === 2230) run("ideas", () => ideas.settleIdeas(env));
    if (hm === 2300) run("billing", () => billing.reconcile(env));
    if (t.getUTCMinutes() === 0) run("suggestions", () => suggestions.syncIssues(env));
  },
};
