/*
 * gateway — the one door to Massive (formerly Polygon) data.
 *
 * Every Massive call (REST and WebSocket) goes through the OpenTrader gateway
 * (`deepentropy/gateway`, a Cloudflare Worker). The gateway holds the Massive
 * key and shares ONE upstream WebSocket between all running apps, so users
 * need no key of their own and several apps can stream at the same time
 * (Massive allows one stream connection per key). The protocol is Massive's,
 * with the app token in place of the Massive key; see `gateway/doc/README.md`.
 *
 * The token is compiled in from `OPENTRADER_GATEWAY_TOKEN` (`build.rs` takes it
 * from the environment, else from the repo-root `.env`). It is never committed.
 * A build without it has no market data.
 */

/// REST base: `https://<gw>/<Massive path>?...&apiKey=<token>`. No trailing
/// slash: the gateway rewrites Massive hosts in REST bodies (`next_url`,
/// branding `icon_url`) to exactly this origin.
pub const BASE: &str = "https://opentrader-gateway.cloudflare-breeder165.workers.dev";

/// The one stream URL. The gateway picks the delayed or real-time upstream.
pub const WS_URL: &str = "wss://opentrader-gateway.cloudflare-breeder165.workers.dev/stocks";

/// The screener's live feed: one full-market table, then its changes every
/// 10 s, polled once by the gateway for every app (`?apiKey=<token>`).
pub const SCREENER_LIVE_URL: &str = "wss://opentrader-gateway.cloudflare-breeder165.workers.dev/screener/v1/live";

/// Shown when the build has no token. Surfaces in the UI as the reason a chart
/// failed to load.
pub const NO_TOKEN: &str =
    "No gateway token in this build — rebuild with OPENTRADER_GATEWAY_TOKEN set";

/// The app token, or `None` when the build was made without one.
pub fn token() -> Option<&'static str> {
    option_env!("OPENTRADER_GATEWAY_TOKEN")
        .map(str::trim)
        .filter(|t| !t.is_empty())
}
