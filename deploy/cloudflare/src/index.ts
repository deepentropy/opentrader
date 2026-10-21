/*
 * The web version on Cloudflare. The built frontend (dist-web) is served as
 * static assets; `/api/*` goes to one container running the OpenTrader server
 * (src-tauri/crates/server), shared by every visitor: its live subscriptions
 * and screener table are in its memory. A cron ping keeps it running between
 * visits, so the first visitor does not wait for a start.
 *
 * `/ingest/*` relays the usage statistics of the web version and the desktop
 * app (src/data/analytics.ts) to the analytics service, adding the city,
 * region and country Cloudflare reports. The user's IP address is passed on
 * only in events marked `ip_consent` (the user agreed); otherwise it never
 * reaches the service.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  SERVER: DurableObjectNamespace<OpenTraderServer>;
  ASSETS: Fetcher;
  /** Gateway token (secret). */
  OPENTRADER_GATEWAY_TOKEN: string;
  /** Origins of the public site (comma-separated): the only pages allowed to call the API. */
  PUBLIC_ORIGIN: string;
}

/**
 * The one instance: every visitor must reach the same server. The container
 * reads its environment when it starts: after changing the secret, bump the
 * name so a fresh container starts (the old one sleeps once unpinged).
 */
const INSTANCE = "main-2";

export class OpenTraderServer extends Container<Env> {
  defaultPort = 8080;
  // Above the cron period: with the pings it never sleeps.
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Page origins are checked in the Worker (see `fetch`), so a new address
    // needs no container restart.
    this.envVars = { OPENTRADER_GATEWAY_TOKEN: env.OPENTRADER_GATEWAY_TOKEN };
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
    // A custom property (the project discards `$ip`); only with consent.
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
      return relayAnalytics(request, url);
    }
    if (url.pathname.startsWith("/api/")) {
      if (foreignOrigin(request, env)) return new Response("origin not allowed", { status: 403 });
      return getContainer(env.SERVER, INSTANCE).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getContainer(env.SERVER, INSTANCE).fetch(new Request("http://container/api/health"));
  },
};
