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
  /** Origin of the public site, the only page origin the server accepts. */
  PUBLIC_ORIGIN: string;
}

/** The one instance: every visitor must reach the same server. */
const INSTANCE = "main";

export class OpenTraderServer extends Container<Env> {
  defaultPort = 8080;
  // Above the cron period: with the pings it never sleeps.
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      OPENTRADER_GATEWAY_TOKEN: env.OPENTRADER_GATEWAY_TOKEN,
      OPENTRADER_ALLOWED_ORIGINS: env.PUBLIC_ORIGIN,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return getContainer(env.SERVER, INSTANCE).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getContainer(env.SERVER, INSTANCE).fetch(new Request("http://container/api/health"));
  },
};
