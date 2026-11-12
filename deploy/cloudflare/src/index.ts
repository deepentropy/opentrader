/*
 * The web version on Cloudflare. The built frontend (dist-web) is served as
 * static assets; `/api/*` goes to one container running the OpenTrader server
 * (src-tauri/crates/server), shared by every visitor: its live subscriptions
 * and screener table are in its memory. It runs while visitors are connected
 * and stops once idle (`sleepAfter`); the next visitor starts it again, in
 * about a second.
 *
 * `/ingest/*` relays the usage statistics of the web version and the desktop
 * app (src/data/analytics.ts) to the analytics service, adding the city,
 * region and country Cloudflare reports. The user's IP address is passed on
 * in events marked `ip_consent` (all, except users who declined it on the
 * former consent card); otherwise it never reaches the service.
 *
 * The networks of `BLOCKED_ASNS` (cloud networks the gateway refuses, where
 * copies of the app run unattended) get no API: the server fetches its data
 * from the gateway, which would not see them. Their events are dropped.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  SERVER: DurableObjectNamespace<OpenTraderServer>;
  ASSETS: Fetcher;
  /** Gateway token (secret). */
  OPENTRADER_GATEWAY_TOKEN: string;
  /** Origins of the public site (comma-separated): the only pages allowed to call the API. */
  PUBLIC_ORIGIN: string;
  /** Networks (AS numbers, comma-separated) refused the API, whose usage statistics are
   *  dropped: the cloud networks the gateway refuses, where copies of the app run unattended. */
  BLOCKED_ASNS?: string;
}

/**
 * The one instance: every visitor must reach the same server. The container
 * reads its environment when it starts: after changing the secret, bump the
 * name so a fresh container starts (the old one stops once idle).
 */
const INSTANCE = "main-3";

export class OpenTraderServer extends Container<Env> {
  defaultPort = 8080;
  // Stopped this long after the last request, a visitor's open WebSocket
  // counting as one (a hidden tab closes it after 10 minutes).
  sleepAfter = "15m";
  /** SIGTERM went out at the previous expiry (the server exits on it): still running, it is killed. */
  private stopSent = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Page origins are checked in the Worker (see `fetch`), so a new address
    // needs no container restart.
    this.envVars = { OPENTRADER_GATEWAY_TOKEN: env.OPENTRADER_GATEWAY_TOKEN };
  }

  override onStart(): void {
    this.stopSent = false;
  }

  // An image whose server ignored SIGTERM ran (and was billed) for good.
  override async onActivityExpired(): Promise<void> {
    if (!this.ctx.container?.running) return;
    if (this.stopSent) return this.destroy();
    this.stopSent = true;
    await this.stop();
  }
}

const ANALYTICS_HOST = "https://us.i.posthog.com";

/** Page origins of the desktop app's webview (Windows; macOS and Linux). */
const DESKTOP_ORIGINS = ["http://tauri.localhost", "tauri://localhost"];

/** CORS headers for the desktop app, which sends from its own origin. */
function ingestCors(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !DESKTOP_ORIGINS.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" };
}

/** Relay a usage-statistics request, with the user's location (and their IP
 *  only when they agreed). */
async function relayAnalytics(request: Request, url: URL): Promise<Response> {
  const cors = ingestCors(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });
  const cf = request.cf ?? {};
  const location = {
    country: (cf.country as string | undefined) ?? null,
    region: (cf.region as string | undefined) ?? null,
    city: (cf.city as string | undefined) ?? null,
  };
  const ip = request.headers.get("CF-Connecting-IP");
  let body: { batch?: { properties?: Record<string, unknown> }[] };
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400, headers: cors });
  }
  for (const e of body.batch ?? []) {
    const props: Record<string, unknown> = { ...e.properties, ...location };
    // The service would locate Cloudflare's address, not the user's: the location above stands instead.
    props.$geoip_disable = true;
    // A custom property (the project discards `$ip`); not for users who declined it.
    if (props.ip_consent === true && ip) props.ip = ip;
    else delete props.ip;
    e.properties = props;
  }
  const res = await fetch(ANALYTICS_HOST + url.pathname.slice("/ingest".length), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(res.body, { status: res.status, headers: { ...cors, "content-type": res.headers.get("content-type") ?? "application/json" } });
}

/** True when the request comes from one of the networks of `BLOCKED_ASNS`. */
function blockedNetwork(request: Request, env: Env): boolean {
  const asn = (request.cf as { asn?: number } | undefined)?.asn;
  if (!asn) return false;
  return (env.BLOCKED_ASNS ?? "").split(",").some((a) => a.trim() !== "" && Number(a) === asn);
}

/** A page of another site calling the API (browsers send `Origin` on
 *  WebSocket and cross-origin requests). */
function foreignOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return !env.PUBLIC_ORIGIN.split(",").map((o) => o.trim()).includes(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ingest/")) {
      const origin = request.headers.get("Origin");
      if (foreignOrigin(request, env) && !(origin && DESKTOP_ORIGINS.includes(origin))) {
        return new Response("origin not allowed", { status: 403 });
      }
      // Copies of the app run on refused cloud networks: their events would count as users.
      // Answered as accepted, so they are not sent again.
      if (blockedNetwork(request, env)) return new Response(null, { status: 204, headers: ingestCors(request) });
      return relayAnalytics(request, url);
    }
    if (url.pathname.startsWith("/api/")) {
      if (foreignOrigin(request, env)) return new Response("origin not allowed", { status: 403 });
      // The zone firewall refuses them on the public address; this also covers the workers.dev one.
      if (blockedNetwork(request, env)) return new Response("network not allowed", { status: 403 });
      return getContainer(env.SERVER, INSTANCE).fetch(request);
    }
    // Not one of the app's files: no page here (search engines drop the address).
    return new Response(NOT_FOUND, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" } });
  },
};

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · OpenTrader online demo</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:grid;place-content:center;gap:12px;text-align:center;background:#0f0f0f;color:#d9dbe0;font:16px system-ui,sans-serif}a{color:#82a4ff}</style>
</head><body><h1>Page not found</h1><p>This page doesn't exist. <a href="/">Open the demo</a> or visit <a href="https://opentrader.markets/">opentrader.markets</a>.</p></body></html>`;
