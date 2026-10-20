/*
 * Market REST client — the gateway's market API (`gateway::MARKET`).
 *
 * Every call is a `GET <MARKET>/<path>?<query>` with the app token as a
 * Bearer header (`get_json` / `get_bytes`). Answers use the gateway's own
 * field names; a missing value is `null`, times are Unix ms. Errors come as
 * `{"code","error","ref"}` and are returned as `gateway::ApiError`, whose
 * message carries `ref` (it finds the cause in the gateway log). A
 * `RATE_LIMITED` answer is retried after its `Retry-After` when that is short.
 *
 * Bars are columnar (`{t[], o[], h[], l[], c[], v[], vw[], n[]}`) and
 * `truncated` says the range holds more bars than were returned (the 50 000
 * cap of one request, see `aggs`).
 */
use chrono::NaiveDate;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Mutex;

use crate::data::gateway::{self, ApiError, ErrorCode, MARKET, NO_TOKEN};

mod aggs;
mod cache;
mod catalog;
mod corporate_actions;
pub mod economics;
mod fundamentals;
mod market_snapshot;
mod news;
mod prior_close;
mod quotes;
mod reference;
mod search;
mod snapshot;

pub use aggs::{fetch_daily_aggs, fetch_minute_aggs, fetch_second_aggs, fetch_second_tail, probe_oldest_bar};
pub use cache::clear_market_data_cache;
pub use catalog::init as init_symbol_catalog;
pub(crate) use cache::rest_cache_root;
pub use corporate_actions::{
    dividend_events, fetch_splits_cached, split_events, DividendEvent, Split, SplitEvent,
};
#[cfg(test)]
pub(crate) use corporate_actions::set_splits_for_test;
pub use fundamentals::{fetch_fundamentals, Fundamentals};
pub use market_snapshot::{fetch_market_snapshot, shape_feed_snapshots, FeedSnapshot, MarketRow};
pub use news::{latest_news, NewsItem};
pub use quotes::fetch_snapshots;
pub use reference::{
    fetch_icon, fetch_reference_tickers, fetch_ticker_info, listing_date, set_icon_proxy_base, ticker_changes, RefTicker, TickerInfo,
};
pub use search::{search_tickers, SymbolSearchResult};
pub use snapshot::{fetch_ticker_snapshot, Snapshot};

/// Process-wide memo keyed by `K`, each value stamped with the day it was
/// resolved for (callers rebuild it when the day changes).
pub(crate) type DayMemo<K, V> = OnceLock<Mutex<HashMap<K, (NaiveDate, Arc<V>)>>>;

/// One shared, connection-pooled HTTP client for every gateway call. `reqwest::
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

/// Longest `Retry-After` waited out on a `RATE_LIMITED` answer; a longer one
/// is returned as the error.
const RATE_LIMIT_MAX_WAIT: Duration = Duration::from_secs(20);
/// Retries of one request after `RATE_LIMITED`.
const RATE_LIMIT_RETRIES: usize = 2;

/// `GET <MARKET>/<path>?<query>` with the app token; the body of a success
/// answer. `what` names the request in error messages.
async fn get_raw(what: &'static str, path: &str, query: &[(&str, String)]) -> Result<reqwest::Response, ApiError> {
    let token = gateway::token().ok_or_else(|| ApiError::transport(what, NO_TOKEN))?;
    let url = format!("{MARKET}/{path}");
    let mut attempt = 0;
    loop {
        let resp = http()
            .get(&url)
            .query(query)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ApiError::transport(what, format!("request failed: {}", e.without_url())))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let body = resp.bytes().await.unwrap_or_default();
        let err = ApiError::from_answer(what, status, retry_after, &body);
        if err.code == ErrorCode::RateLimited && attempt < RATE_LIMIT_RETRIES {
            let wait = err.retry_after.unwrap_or(Duration::from_secs(1));
            if wait <= RATE_LIMIT_MAX_WAIT {
                eprintln!("[market_rest] {what}: rate limited, retrying in {} s", wait.as_secs());
                tokio::time::sleep(wait).await;
                attempt += 1;
                continue;
            }
        }
        return Err(err);
    }
}

/// A JSON answer of the market API.
pub(crate) async fn get_json<T: DeserializeOwned>(what: &'static str, path: &str, query: &[(&str, String)]) -> Result<T, ApiError> {
    let resp = get_raw(what, path, query).await?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ApiError::transport(what, format!("read failed: {}", e.without_url())))?;
    serde_json::from_slice(&bytes).map_err(|e| ApiError::transport(what, format!("unreadable answer: {e}")))
}

/// A binary answer (an image) with its content type.
pub(crate) async fn get_bytes(what: &'static str, path: &str) -> Result<(Vec<u8>, String), ApiError> {
    let resp = get_raw(what, path, &[]).await?;
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ApiError::transport(what, format!("read failed: {}", e.without_url())))?;
    Ok((bytes.to_vec(), content_type))
}

/// A ticker as a path segment. Tickers are letters, digits, `.` and `-`,
/// which pass as they are; anything else is percent-encoded.
pub(crate) fn seg(ticker: &str) -> String {
    const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'.').remove(b'-');
    percent_encoding::utf8_percent_encode(ticker, SEGMENT).to_string()
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
