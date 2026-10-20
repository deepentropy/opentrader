/*
 * The web version on Cloudflare. The built frontend (dist-web) is served as
 * static assets; `/api/*` goes to one container running the OpenTrader server
 * (src-tauri/crates/server), shared by every visitor: its live subscriptions
 * and screener table are in its memory. A cron ping keeps it running between
 * visits, so the first visitor does not wait for a start.
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
