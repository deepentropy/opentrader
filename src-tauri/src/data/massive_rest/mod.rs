/*
 * Massive REST aggregates — Feature 8b (sub-minute / second bars).
 *
 * Why REST and not S3 flat files (the project's usual rule): the only
 * flat file with sub-minute granularity is `trades_v1`, which is the
 * whole US market's individual trades for a day — multiple GB per file.
 * The REST aggregates endpoint returns ONLY the requested ticker's bars
 * (a few hundred KB for a day of 1-second bars), so it's the sane source
 * for seconds. Daily + minute history stay on the S3 flat-file path.
 *
 * Endpoint:
 *   GET /v2/aggs/ticker/{ticker}/range/{mult}/second/{from}/{to}
 *       ?adjusted=true&sort=asc&limit=50000&apiKey=...
 *
 * `limit=50000` comfortably covers one regular session of 1-second bars
 * (~23,400). If a request truncates we log it; the caller keeps small
 * date ranges so this shouldn't happen for the favorited intervals.
 */
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

mod aggs;
mod cache;
mod corporate_actions;
mod market_snapshot;
mod news;
mod prior_close;
mod quotes;
mod reference;
mod search;
mod snapshot;

pub use aggs::{fetch_daily_aggs, fetch_minute_aggs, fetch_second_aggs, fetch_second_tail, probe_oldest_bar};
pub use cache::clear_market_data_cache;
pub(crate) use cache::rest_cache_root;
pub use corporate_actions::{
    dividend_events, executed_splits, fetch_splits_cached, paid_dividends, split_events, DividendEvent, Split, SplitEvent,
};
#[cfg(test)]
pub(crate) use corporate_actions::set_splits_for_test;
pub use market_snapshot::{fetch_market_snapshot, shape_feed_snapshots, FeedSnapshot, MarketRow};
pub use news::{latest_news, NewsItem};
pub use quotes::fetch_snapshots;
pub use reference::{fetch_icon, fetch_reference_tickers, fetch_ticker_info, listing_date, ticker_changes, RefTicker, TickerInfo};
pub use search::{search_tickers, SymbolSearchResult};
pub use snapshot::{fetch_ticker_snapshot, Snapshot};

/// Process-wide memo keyed by `K`, each value stamped with the day it was
/// resolved for (callers rebuild it when the day changes).
pub(crate) type DayMemo<K, V> = OnceLock<Mutex<HashMap<K, (NaiveDate, Arc<V>)>>>;

/// One shared, connection-pooled HTTP client for every Massive call. `reqwest::
/// get` builds a fresh client — and therefore a fresh TCP+TLS handshake — on
/// every request, which was the bulk of each load's latency (~300ms warm,
/// ~2.3s on the first call). A single keep-alive client reuses the warm
/// connection (and multiplexes over HTTP/2), so repeat requests skip the
/// handshake entirely.
pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .build()
            .expect("build shared reqwest client")
    })
}

/// A single OHLCV candle — the shape returned to the chart for every
/// resolution (daily, minute, second).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Candle {
    /// UTC seconds (lightweight-charts `UTCTimestamp`). Stored as `f64` so
    /// specta-typescript doesn't reject the export (i64 is forbidden to
    /// avoid BigInt precision loss); f64 holds exact integers up to 2^53.
    pub time: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[cfg(test)]
mod tests;
