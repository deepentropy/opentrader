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
use crate::data::gateway::{self, BASE, NO_TOKEN};
use crate::data::trading_calendar;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, NaiveDate, Utc, Weekday};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

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

#[derive(Deserialize)]
struct AggResponse {
    results: Option<Vec<AggBar>>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    error: Option<String>,
    /// Entitlement 403s (status NOT_AUTHORIZED) explain themselves here, not
    /// in `error` — seen 26/07/2026 when a transient NOT_AUTHORIZED hid its
    /// reason because only `error`/`status` were surfaced.
    #[serde(default)]
    message: Option<String>,
    /// Base units read (minutes for a 5-minute range). The 50k `limit` applies
    /// to this count, not to `resultsCount` (the multiplied bars returned).
    #[serde(default, rename = "queryCount")]
    query_count: Option<u64>,
    /// Present when the range holds more than `limit` base units: the older
    /// part was cut (sort=desc). Measured 29/09/2026: 30-minute AAPL
    /// 05/01-15/05/2026 returned resultsCount 2175, queryCount 50000, next_url.
    #[serde(default)]
    next_url: Option<String>,
}

#[derive(Deserialize)]
struct AggBar {
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    #[serde(default)]
    v: f64,
    /// Bar start, UNIX **milliseconds**.
    t: i64,
}

/// Fetch aggregate bars for `ticker` from `from`..`to` (inclusive,
/// `YYYY-MM-DD` or unix-ms strings). `mult` is the bucket-width multiplier
/// and `timespan` is Massive's unit ("second", "minute", "hour", "day").
/// One HTTP call; Massive does the bucketing server-side and returns only
/// this ticker's bars. The returned bool is `true` when the response hit the
/// 50k base-unit cap (oldest bars truncated) — the cache uses it to decide how
/// far back it may safely sentinel no-trade days.
async fn fetch_aggs(
    ticker: &str,
    mult: u32,
    timespan: &str,
    from: &str,
    to: &str,
    adjusted: bool,
) -> Result<(Vec<Candle>, bool)> {
    let token = gateway::token().context(NO_TOKEN)?;
    let mult = mult.max(1);
    // `limit` caps the number of *base* aggregates Massive reads (e.g. minutes,
    // not the multiplied bars), so a wide range exceeds it. We must therefore
    // sort DESC and reverse below: `desc` keeps the most-recent base units (so
    // the series always ends at "now"); `asc` would keep the oldest and leave
    // the chart frozen months in the past. Trade-off: very coarse intraday over
    // a long span loses the *oldest* history, never the current price.
    let url = format!(
        "{BASE}/v2/aggs/ticker/{ticker}/range/{mult}/{timespan}/{from}/{to}\
         ?adjusted={adjusted}&sort=desc&limit=50000&apiKey={token}"
    );

    let resp = http().get(&url).send().await.context("massive aggs request failed")?;
    let http_status = resp.status();
    let body: AggResponse = resp
        .json()
        .await
        .context("massive aggs: parse response json")?;

    if !http_status.is_success() {
        return Err(anyhow!(
            "massive aggs {http_status}: {}",
            body.error
                .or(body.message)
                .unwrap_or_else(|| body.status.clone())
        ));
    }

    let bars = body.results.unwrap_or_default();
    let truncated = body.next_url.is_some() || body.query_count.is_some_and(|n| n >= 50_000);
    if truncated {
        eprintln!(
            "[massive_rest] {ticker} {mult}{timespan} aggs hit the 50k base-unit cap — \
             older history truncated (most-recent bars kept)"
        );
    }

    // Massive returned newest-first (sort=desc); the chart wants oldest-first.
    let mut out: Vec<Candle> = bars
        .into_iter()
        .map(|b| Candle {
            time: (b.t / 1000) as f64,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
        })
        .collect();
    out.reverse();
    Ok((out, truncated))
}

/// Fetch second-granularity aggregate bars over `[from, to]` (inclusive calendar
/// dates), served from the per-session disk cache where possible. `mult` is the
/// bucket width in seconds (1, 5, 10, 15, 30, 45…).
pub async fn fetch_second_aggs(
    ticker: &str,
    mult: u32,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> Result<Vec<Candle>> {
    fetch_aggs_cached(ticker, mult, "second", from, to, true, adjusted).await
}

/// Live-tail fetch: `mult`-second bars strictly newer than `since_sec` (UNIX
/// seconds), straight from the ranged endpoint using millisecond bounds. No
/// disk cache — this only ever covers today's mutable tail (the seconds chart
/// refresh loop), so caching would be wasted writes.
pub async fn fetch_second_tail(
    ticker: &str,
    mult: u32,
    since_sec: f64,
    adjusted: bool,
) -> Result<Vec<Candle>> {
    let from_ms = ((since_sec.max(0.0)) as i64) * 1000;
    let to_ms = Utc::now().timestamp_millis();
    fetch_aggs(
        ticker,
        mult,
        "second",
        &from_ms.to_string(),
        &to_ms.to_string(),
        adjusted,
    )
    .await
    .map(|(bars, _)| bars)
}

/// Fetch minute-granularity aggregate bars over `[from, to]` (inclusive calendar
/// dates), served from the per-session disk cache where possible. `mult` is the
/// bucket width in minutes (1, 5, 15, 30, 60, 120, 240…) — Massive buckets
/// server-side, so a cold fetch is one small request instead of downloading
/// whole-market minute flat files over S3.
pub async fn fetch_minute_aggs(
    ticker: &str,
    mult: u32,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> Result<Vec<Candle>> {
    fetch_aggs_cached(ticker, mult, "minute", from, to, true, adjusted).await
}

/// Fetch daily candles over `[from, to]` (inclusive calendar dates), served from
/// the per-session disk cache where possible. One cold REST call returns the
/// whole ticker's daily series (split-adjusted when `adjusted`) — versus the old
/// S3 path's one whole-market flat-file download per trading day.
///
/// `with_live_tail = false`: a warm load returns only closed sessions (through
/// yesterday) and skips the extra ~290ms request for today's still-forming bar —
/// the chart's live poller fills today's daily bar anyway. A cold load still
/// includes today (it comes free in the single ranged fetch).
pub async fn fetch_daily_aggs(
    ticker: &str,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> Result<Vec<Candle>> {
    fetch_aggs_cached(ticker, 1, "day", from, to, false, adjusted).await
}

/// Entitlement probe: the oldest `timespan` bar the key can read for `ticker`,
/// plus the response's `status` word ("DELAYED" on the delayed plans, seen
/// 27/09/2026). One request (`sort=asc&limit=1` over 30 years), ~0.4 s. Use a
/// ticker listed before any plan's history floor, so the first bar marks the
/// plan floor and not the listing date.
pub async fn probe_oldest_bar(ticker: &str, timespan: &str) -> Result<(Option<NaiveDate>, String)> {
    let token = gateway::token().context(NO_TOKEN)?;
    let to = Utc::now().date_naive();
    let from = to - ChronoDuration::days(30 * 366);
    let url = format!(
        "{BASE}/v2/aggs/ticker/{ticker}/range/1/{timespan}/{from}/{to}\
         ?adjusted=true&sort=asc&limit=1&apiKey={token}"
    );
    let resp = http().get(&url).send().await.context("massive probe request failed")?;
    let http_status = resp.status();
    let body: AggResponse = resp.json().await.context("massive probe: parse response json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive probe {http_status}: {}",
            body.error.or(body.message).unwrap_or_else(|| body.status.clone())
        ));
    }
    let oldest = body
        .results
        .unwrap_or_default()
        .first()
        .and_then(|b| DateTime::from_timestamp(b.t / 1000, 0))
        .map(|dt| dt.date_naive());
    Ok((oldest, body.status))
}

// ── REST-aggregate disk cache (closed sessions only) ─────────────────────
//
// The REST aggregate path (minute fast path + second bars + scroll-back) was
// the one market-data route with no caching: every intraday/second symbol or
// interval switch re-hit Massive. We now persist *closed* sessions per
// (ticker, timespan, mult, date) under `<cache_dir>/opentrader/rest_aggs/…`
// and only ever re-fetch the live tail.
//
// Glitch-safety rests on one rule: a session strictly before today's (UTC) date
// is immutable, so it is cached indefinitely; today's session is mutable
// (forming bars, late/corrected prints) and is ALWAYS fetched fresh, never
// persisted. The cached (days < today) and live (days >= today) segments are
// stitched on a half-open day boundary, so no bar is duplicated or dropped.
//
// Split-adjustment is handled by folding the ticker's latest executed-split
// date into the cache namespace (see `split_epoch`): `adjusted=true` rescales
// ALL historical bars when a split executes, so a fresh split changes the epoch
// and transparently invalidates every prior cached session.
//
// A ticker's pre-split epoch directory is reclaimed by `prune_stale_epochs` the
// next time its splits are resolved (once per ticker per day).
//
// No-trade sessions (sparse/illiquid tickers, halts) are persisted as empty
// sentinel files so they count as cache hits rather than forcing a full-range
// refetch every load (see `persist_closed_days`).
//
// Known limitation (fast-follow — see the feasibility assessment):
//  • Truncation: a cold range exceeding Massive's 50k base-unit cap drops its
//    oldest days (sort=desc keeps the most recent), which therefore never cache
//    — and their no-trade days can't be sentineled (can't prove they're empty
//    rather than dropped), so a truncated range stays on the cold path.

/// Cache root folder. `rest_aggs` (before 29/09/2026) detected truncation
/// from `resultsCount`, so the days cut from a truncated multi-minute range
/// were cached as empty no-trade days and the cut oldest day as a full day:
/// scroll-back and time sync stopped there ("history exhausted"). It also
/// keyed days by UTC date (see `bar_date`); `rest_aggs_v2` (dev builds of
/// 29-30/09/2026) still did. The new root drops those files; the old roots
/// are deleted once per run.
const REST_CACHE_DIR: &str = "rest_aggs_v3";
const LEGACY_REST_CACHE_DIRS: &[&str] = &["rest_aggs", "rest_aggs_v2"];

fn rest_cache_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("opentrader")
}

/// Market-data folders under the cache root that "Clear cache" deletes: the
/// REST aggregate cache, its legacy roots and the older per-day caches. The
/// root itself is never deleted (on Windows it is also the install folder).
const CLEARABLE_CACHE_DIRS: &[&str] = &[REST_CACHE_DIR, "rest_aggs", "rest_aggs_v2", "day_aggs", "day_ticker", "minute_aggs"];

/// Settings > Service > "Clear cache": delete the market-data disk cache and
/// forget the in-memory splits, dividends and prior-close memos. Bars are
/// fetched again on the next load.
pub async fn clear_market_data_cache() -> Result<(), String> {
    let root = rest_cache_root();
    for dir in CLEARABLE_CACHE_DIRS {
        let path = root.join(dir);
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(&path).await.map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    if let Some(m) = SPLITS.get() {
        m.lock().await.clear();
    }
    if let Some(m) = DIVIDENDS.get() {
        m.lock().await.clear();
    }
    if let Some(m) = PRIOR_CLOSES.get() {
        *m.lock().await = None;
    }
    Ok(())
}

/// Delete the legacy cache roots in the background, once per process.
fn remove_legacy_cache_once() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        tokio::spawn(async {
            for dir in LEGACY_REST_CACHE_DIRS {
                let _ = tokio::fs::remove_dir_all(rest_cache_root().join(dir)).await;
            }
        });
    });
}

fn rest_cache_path(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    date: NaiveDate,
) -> PathBuf {
    rest_cache_root()
        .join(REST_CACHE_DIR)
        .join(ticker.to_uppercase())
        .join(epoch)
        .join(format!("{timespan}{mult}"))
        .join(format!("{}.json", date.format("%Y-%m-%d")))
}

async fn read_day_cache(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    date: NaiveDate,
) -> Option<Vec<Candle>> {
    let path = rest_cache_path(ticker, epoch, timespan, mult, date);
    let bytes = tokio::fs::read(&path).await.ok()?;
    serde_json::from_slice::<Vec<Candle>>(&bytes).ok()
}

async fn write_day_cache(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    date: NaiveDate,
    bars: &[Candle],
) {
    let path = rest_cache_path(ticker, epoch, timespan, mult, date);
    if let Ok(json) = serde_json::to_vec(bars) {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&path, &json).await;
    }
}

/// Session (New York) date of a bar (its bucket start is unix seconds): the
/// cache key of a day. The UTC date split a winter session (its 19:00-20:00
/// post-market is 00:00-01:00 UTC next day), so a range ending on day D wrote a
/// "D+1" file holding only those bars, which could replace D+1's full file.
fn bar_date(bar: &Candle) -> Option<NaiveDate> {
    trading_calendar::ny_date(bar.time as i64)
}

/// Persist each *closed* day's slice of an oldest-first ranged response. Bars
/// are sorted ascending, so same-date bars are contiguous; days dated today or
/// later are skipped (the live tail is never cached).
#[allow(clippy::too_many_arguments)]
async fn persist_closed_days(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    bars: &[Candle],
    from: NaiveDate,
    to: NaiveDate,
    truncated: bool,
    today: NaiveDate,
) {
    // Write each closed day that has bars. A truncated response cuts its
    // oldest returned day part way (only the newest minutes of it came back),
    // so that day is not written: caching it would serve the partial day as
    // complete.
    let partial = if truncated { bars.first().and_then(bar_date) } else { None };
    let mut i = 0;
    while i < bars.len() {
        let Some(d) = bar_date(&bars[i]) else {
            i += 1;
            continue;
        };
        let mut j = i + 1;
        while j < bars.len() && bar_date(&bars[j]) == Some(d) {
            j += 1;
        }
        if d < today && Some(d) != partial {
            write_day_cache(ticker, epoch, timespan, mult, d, &bars[i..j]).await;
        }
        i = j;
    }

    // Sentinel the genuinely no-trade closed days so they read as cache hits
    // instead of forcing a full-range refetch every load.
    for d in empty_sentinel_days(bars, from, to, truncated, today) {
        write_day_cache(ticker, epoch, timespan, mult, d, &[]).await;
    }
}

/// Closed trading days in `[from, to]` that returned no bars and can be safely
/// cached as empty sentinels. The floor is the lowest date provably inside the
/// response: `from` when the response wasn't truncated, else the oldest returned
/// bar — truncation drops the OLDEST days (Massive sorts desc), so earlier
/// no-bar days are ambiguous (dropped vs no-trade) and are left unpersisted. An
/// empty response anchors nothing, so it yields no sentinels. Pure (no I/O).
fn empty_sentinel_days(
    bars: &[Candle],
    from: NaiveDate,
    to: NaiveDate,
    truncated: bool,
    today: NaiveDate,
) -> Vec<NaiveDate> {
    let present: HashSet<NaiveDate> = bars.iter().filter_map(bar_date).collect();
    let Some(oldest) = present.iter().min().copied() else {
        return Vec::new();
    };
    let floor = if truncated { oldest } else { from };
    trading_calendar::trading_days_in_range(floor, to)
        .into_iter()
        .filter(|&d| d < today && !present.contains(&d))
        .collect()
}

// ── Splits (REST cache invalidation) ─────────────────────────────────────
//
// The REST aggregate path requests `adjusted=true`, so Massive already returns
// split-adjusted prices — no on-read adjustment is needed. The one thing splits
// still drive is cache invalidation: `adjusted=true` rescales ALL historical
// bars when a split executes, so the latest executed-split date is folded into
// the cache namespace (`epoch_of`) and a fresh split transparently invalidates
// every prior cached session.

#[derive(Deserialize)]
struct SplitsResponse {
    #[serde(default)]
    results: Vec<SplitRow>,
}

#[derive(Deserialize)]
struct SplitRow {
    #[serde(default)]
    execution_date: Option<String>,
    #[serde(default)]
    split_from: Option<f64>,
    #[serde(default)]
    split_to: Option<f64>,
}

/// One already-executed stock split. `execution_date` doubles as the cache epoch
/// (`epoch_of`); `from`/`to` give the ratio for the event marker label ("4:1").
#[derive(Clone)]
pub struct Split {
    pub execution_date: NaiveDate,
    pub from: f64,
    pub to: f64,
}

// ── Chart event markers (Events tab: Dividends / Splits) ────────────────────
/// Midnight-UTC UNIX seconds for a calendar date — the x-anchor for a marker.
fn date_to_unix(d: NaiveDate) -> f64 {
    d.and_hms_opt(0, 0, 0)
        .map(|dt| dt.and_utc().timestamp() as f64)
        .unwrap_or(0.0)
}

/// A split marker: execution date (UNIX seconds) + the ratio (to:from).
#[derive(Serialize, specta::Type)]
pub struct SplitEvent {
    pub date: f64,
    pub from: f64,
    pub to: f64,
}

/// A dividend marker: ex-dividend date (UNIX seconds) + cash amount per share.
#[derive(Clone, Serialize, specta::Type)]
pub struct DividendEvent {
    pub date: f64,
    pub amount: f64,
}

/// Every already-executed split for `ticker`, newest-first. `None` on any lookup
/// failure (the caller then bypasses the REST cache rather than risk stale bars).
async fn fetch_splits(ticker: &str, today: NaiveDate) -> Option<Vec<Split>> {
    let token = gateway::token()?;
    let url = format!(
        "{BASE}/v3/reference/splits?ticker={ticker}\
         &execution_date.lte={today}&order=desc&sort=execution_date&limit=1000&apiKey={token}"
    );
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: SplitsResponse = resp.json().await.ok()?;
    Some(
        body.results
            .into_iter()
            .filter_map(|r| {
                let date = NaiveDate::parse_from_str(r.execution_date.as_deref()?, "%Y-%m-%d").ok()?;
                Some(Split { execution_date: date, from: r.split_from.unwrap_or(1.0), to: r.split_to.unwrap_or(1.0) })
            })
            .collect(),
    )
}

/// Per-ticker, per-day memo of the splits list. One small REST call resolved at
/// most once per ticker per calendar day; a transient failure simply retries on
/// the next fetch. Shared by the REST cache epoch and the S3 adjustment.
static SPLITS: DayMemo<String, Vec<Split>> = OnceLock::new();

/// Memoised already-executed splits for `ticker` (newest-first), or `None` on a
/// lookup failure.
pub async fn fetch_splits_cached(ticker: &str) -> Option<Arc<Vec<Split>>> {
    let ticker = ticker.to_uppercase();
    let memo = SPLITS.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    {
        let guard = memo.lock().await;
        if let Some((as_of, splits)) = guard.get(&ticker) {
            if *as_of == today {
                return Some(splits.clone());
            }
        }
    }
    // Resolve without holding the lock (don't serialize unrelated tickers). A
    // concurrent duplicate lookup for the same ticker is harmless/idempotent.
    let splits = Arc::new(fetch_splits(&ticker, today).await?);
    // A fresh resolution is the once-per-ticker-per-day moment to reclaim any
    // stale epoch directories left behind by a past split. Fire-and-forget so
    // the cleanup never delays the data path.
    {
        let (t, epoch) = (ticker.clone(), epoch_of(&splits));
        tokio::spawn(async move { prune_stale_epochs(&t, &epoch).await });
    }
    memo.lock().await.insert(ticker, (today, splits.clone()));
    Some(splits)
}

/// Split markers for the chart (newest-first). Reuses the per-day splits memo.
pub async fn split_events(ticker: &str) -> Vec<SplitEvent> {
    match fetch_splits_cached(ticker).await {
        Some(splits) => splits
            .iter()
            .map(|s| SplitEvent { date: date_to_unix(s.execution_date), from: s.from, to: s.to })
            .collect(),
        None => Vec::new(),
    }
}

#[derive(Deserialize)]
struct DividendsResponse {
    #[serde(default)]
    results: Vec<DividendRow>,
}

#[derive(Deserialize)]
struct DividendRow {
    #[serde(default)]
    ex_dividend_date: Option<String>,
    #[serde(default)]
    cash_amount: Option<f64>,
}

/// Per-ticker, per-day memo of dividend markers (mirrors the splits memo). One
/// small REST call resolved at most once per ticker per calendar day.
static DIVIDENDS: DayMemo<String, Vec<DividendEvent>> = OnceLock::new();

/// Ex-dividend markers for `ticker` (newest-first); empty on any lookup failure.
pub async fn dividend_events(ticker: &str) -> Vec<DividendEvent> {
    let ticker = ticker.to_uppercase();
    let memo = DIVIDENDS.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    {
        let guard = memo.lock().await;
        if let Some((as_of, evs)) = guard.get(&ticker) {
            if *as_of == today {
                return (**evs).clone();
            }
        }
    }
    let evs = Arc::new(fetch_dividends(&ticker, today).await.unwrap_or_default());
    memo.lock().await.insert(ticker, (today, evs.clone()));
    (*evs).clone()
}

async fn fetch_dividends(ticker: &str, today: NaiveDate) -> Option<Vec<DividendEvent>> {
    let token = gateway::token()?;
    let url = format!(
        "{BASE}/v3/reference/dividends?ticker={ticker}\
         &ex_dividend_date.lte={today}&order=desc&sort=ex_dividend_date&limit=1000&apiKey={token}"
    );
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: DividendsResponse = resp.json().await.ok()?;
    Some(
        body.results
            .into_iter()
            .filter_map(|r| {
                let date = NaiveDate::parse_from_str(r.ex_dividend_date.as_deref()?, "%Y-%m-%d").ok()?;
                Some(DividendEvent { date: date_to_unix(date), amount: r.cash_amount.unwrap_or(0.0) })
            })
            .collect(),
    )
}

/// The cache epoch implied by a splits list (newest-first): the latest executed
/// split date, or `"none"` when the ticker has never split.
fn epoch_of(splits: &[Split]) -> String {
    splits
        .first()
        .map(|s| s.execution_date.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "none".to_string())
}

/// Remove stale split-epoch cache directories for a ticker, keeping only
/// `current_epoch`. After a split the prior epoch's sessions are never read
/// again (the namespace moved on), so this reclaims that bounded disk. A missing
/// directory or any per-entry failure is ignored — cleanup is best-effort.
async fn prune_stale_epochs(ticker: &str, current_epoch: &str) {
    let dir = rest_cache_root().join(REST_CACHE_DIR).join(ticker.to_uppercase());
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) != Some(current_epoch) {
            let _ = tokio::fs::remove_dir_all(&path).await;
        }
    }
}

/// Cache namespace for a ticker's current split-adjustment state — the latest
/// executed split date, or `"none"`. Folding this into the REST cache path means
/// a fresh split changes the namespace and invalidates prior cached sessions.
/// `None` (lookup failed) → the caller bypasses the cache to avoid stale bars.
async fn split_epoch(ticker: &str) -> Option<String> {
    let splits = fetch_splits_cached(ticker).await?;
    Some(epoch_of(&splits))
}

/// Ranged aggregate fetch with per-closed-session disk caching. `from`/`to` are
/// inclusive calendar dates. Returns oldest-first bars across the range.
///
/// Cold path (any closed day missing): one ranged Massive call — as fast as the
/// uncached path — whose closed portion is then split onto disk. Warm path (every
/// closed day cached): closed days are read from disk and only the live tail
/// (today, when the range reaches it) is fetched.
async fn fetch_aggs_cached(
    ticker: &str,
    mult: u32,
    timespan: &str,
    from: NaiveDate,
    to: NaiveDate,
    with_live_tail: bool,
    adjusted: bool,
) -> Result<Vec<Candle>> {
    let mult = mult.max(1);
    let ticker = ticker.to_uppercase();
    let today = trading_calendar::ny_today();
    remove_legacy_cache_once();
    // Adjusted and raw bars are different series — namespace them apart so a
    // toggle never reads the other basis's cached sessions.
    let timespan_ns = if adjusted {
        timespan.to_string()
    } else {
        format!("{timespan}-raw")
    };
    let timespan_ns = timespan_ns.as_str();

    // Resolve the split epoch first; a failed lookup bypasses the cache entirely
    // so we never serve bars under the wrong adjustment basis.
    let Some(epoch) = split_epoch(&ticker).await else {
        return fetch_aggs(&ticker, mult, timespan, &from.to_string(), &to.to_string(), adjusted)
            .await
            .map(|(bars, _)| bars);
    };

    let days = trading_calendar::trading_days_in_range(from, to);
    let closed: Vec<NaiveDate> = days.into_iter().filter(|&d| d < today).collect();

    // Read every closed (< today) trading day from cache. A long daily range is
    // ~1254 tiny files; reading them sequentially was the bulk of a warm load,
    // so fan the reads out (per-day files are independent) and reassemble in
    // date order afterwards.
    let mut set = tokio::task::JoinSet::new();
    for d in closed.iter().copied() {
        let (t, e, ts) = (ticker.clone(), epoch.clone(), timespan_ns.to_string());
        set.spawn(async move { (d, read_day_cache(&t, &e, &ts, mult, d).await) });
    }
    let mut by_day: HashMap<NaiveDate, Option<Vec<Candle>>> = HashMap::new();
    while let Some(joined) = set.join_next().await {
        if let Ok((d, bars)) = joined {
            by_day.insert(d, bars);
        }
    }
    let mut cached: Vec<Candle> = Vec::new();
    let mut missing_closed = false;
    for d in &closed {
        match by_day.remove(d) {
            Some(Some(bars)) => cached.extend(bars),
            _ => missing_closed = true,
        }
    }
    if missing_closed {
        let (all, truncated) =
            fetch_aggs(&ticker, mult, timespan, &from.to_string(), &to.to_string(), adjusted)
                .await?;
        // Populate the per-day disk cache in the background: the bars are already
        // in hand, so blocking the chart on ~1254 sequential file writes
        // (~600-900ms) just to warm a cache for *next* time is wasted latency.
        let (t, e, ts, to_persist) =
            (ticker.clone(), epoch.clone(), timespan_ns.to_string(), all.clone());
        tokio::spawn(async move {
            persist_closed_days(&t, &e, &ts, mult, &to_persist, from, to, truncated, today).await;
        });
        return Ok(all);
    }

    // Warm path: serve closed days from disk; fetch only the live tail. `cached`
    // is all dated < today and `live` all >= today, so concatenation stays
    // oldest-first with no overlap. Callers that have a live feed for today
    // (the daily family) skip this extra request and let the poller fill today.
    if with_live_tail && to >= today {
        let (live, _) =
            fetch_aggs(&ticker, mult, timespan, &today.to_string(), &to.to_string(), adjusted)
                .await?;
        cached.extend(live);
    }
    Ok(cached)
}

// ── Reference info (/v3/reference/tickers) ───────────────────────────────

/// Company reference info for the WatchlistDetail panel. All optional —
/// the frontend renders an em-dash for any missing field.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TickerInfo {
    pub ticker: String,
    pub name: Option<String>,
    pub exchange: Option<String>,
    pub industry: Option<String>,
    pub sector: Option<String>,
    pub currency: Option<String>,
    pub description: Option<String>,
    pub homepage_url: Option<String>,
    pub total_employees: Option<f64>,
    pub market_cap: Option<f64>,
    pub figi: Option<String>,
    /// Massive branding icon (square), wrapped in the `ticker-icon` custom
    /// scheme so the webview can use it as an <img src> without ever seeing the
    /// gateway token — the backend re-attaches the token when it serves the bytes.
    pub icon_url: Option<String>,
}

#[derive(Deserialize)]
struct RefResponse {
    results: Option<RefResult>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct RefResult {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    primary_exchange: Option<String>,
    #[serde(default)]
    sic_description: Option<String>,
    #[serde(default)]
    currency_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage_url: Option<String>,
    #[serde(default)]
    total_employees: Option<f64>,
    #[serde(default)]
    market_cap: Option<f64>,
    #[serde(default)]
    composite_figi: Option<String>,
    #[serde(default)]
    branding: Option<RefBranding>,
}

#[derive(Deserialize)]
struct RefBranding {
    #[serde(default)]
    icon_url: Option<String>,
}

/// One news headline for the chart's "Latest news" lollipop: publisher,
/// publish time (UNIX ms) and title.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub id: String,
    pub title: String,
    pub publisher: String,
    pub published: f64,
    pub url: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize)]
struct NewsResponse {
    #[serde(default)]
    results: Vec<NewsRow>,
}

#[derive(Deserialize)]
struct NewsRow {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    publisher: Option<NewsPublisher>,
    #[serde(default)]
    published_utc: Option<String>,
    #[serde(default)]
    article_url: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct NewsPublisher {
    #[serde(default)]
    name: Option<String>,
}

/// Newest `limit` headlines tagged with `ticker` (newest first). Empty on any
/// lookup failure: the lollipop is decorative.
pub async fn latest_news(ticker: &str, limit: u32) -> Vec<NewsItem> {
    fetch_latest_news(ticker, limit).await.unwrap_or_default()
}

async fn fetch_latest_news(ticker: &str, limit: u32) -> Option<Vec<NewsItem>> {
    let token = gateway::token()?;
    let url = format!(
        "{BASE}/v2/reference/news?ticker={ticker}&order=desc&sort=published_utc&limit={limit}&apiKey={token}"
    );
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: NewsResponse = resp.json().await.ok()?;
    Some(
        body.results
            .into_iter()
            .filter_map(|r| {
                let published = DateTime::parse_from_rfc3339(r.published_utc.as_deref()?).ok()?;
                Some(NewsItem {
                    id: r.id?,
                    title: r.title?,
                    publisher: r.publisher.and_then(|p| p.name).unwrap_or_default(),
                    published: published.timestamp_millis() as f64,
                    url: r.article_url,
                    description: r.description,
                })
            })
            .collect(),
    )
}

pub async fn fetch_ticker_info(ticker: &str) -> Result<TickerInfo> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!(
        "{BASE}/v3/reference/tickers/{ticker}?apiKey={token}"
    );
    let resp = http().get(&url).send().await.context("massive reference request")?;
    let http_status = resp.status();
    let body: RefResponse = resp.json().await.context("massive reference: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive reference {http_status}: {}",
            body.error.unwrap_or_default()
        ));
    }
    let r = body
        .results
        .ok_or_else(|| anyhow!("massive reference: no results for {ticker}"))?;
    Ok(TickerInfo {
        ticker: ticker.to_string(),
        name: r.name,
        exchange: r.primary_exchange,
        // Massive has no clean sector field; sic_description is the closest
        // (an industry classification). Leave sector empty rather than guess.
        industry: r.sic_description,
        sector: None,
        currency: r.currency_name.map(|c| c.to_uppercase()),
        description: r.description,
        homepage_url: r.homepage_url,
        total_employees: r.total_employees,
        market_cap: r.market_cap,
        figi: r.composite_figi,
        icon_url: r
            .branding
            .and_then(|b| b.icon_url)
            .map(|u| icon_proxy_url(&u)),
    })
}

/// Wrap a bare branding URL (gateway host) in the `ticker-icon` custom scheme so
/// the gateway token never reaches the webview DOM. The scheme handler (see
/// `fetch_icon`) decodes the path, re-attaches the token, and streams the image back.
///
/// Windows/Android serve custom schemes over `http://<scheme>.localhost`; every
/// other platform uses the real `<scheme>://` form. We build whichever matches
/// the host this backend runs on, so the frontend can use the value verbatim.
fn icon_proxy_url(bare_url: &str) -> String {
    let encoded = utf8_percent_encode(bare_url, NON_ALPHANUMERIC).to_string();
    if cfg!(windows) {
        format!("http://ticker-icon.localhost/{encoded}")
    } else {
        format!("ticker-icon://localhost/{encoded}")
    }
}

/// Serve a Massive branding icon for the `ticker-icon` scheme handler. `encoded`
/// is the percent-encoded bare URL taken from the request path; we decode it,
/// attach the gateway token server-side, and return the raw bytes plus the
/// upstream content-type. Restricted to the gateway host (the gateway rewrites
/// Massive's branding URLs to it) so the handler can't be coerced into an open
/// proxy that attaches the token to an arbitrary origin.
pub async fn fetch_icon(encoded: &str) -> Result<(Vec<u8>, String)> {
    let bare = percent_decode_str(encoded)
        .decode_utf8()
        .context("ticker-icon: path is not valid percent-encoded UTF-8")?;
    // With the trailing slash, so a look-alike host (`<gw>.evil.com`) fails.
    if !bare.starts_with(&format!("{BASE}/")) {
        return Err(anyhow!("ticker-icon: refusing non-gateway URL {bare}"));
    }
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!("{bare}?apiKey={token}");
    let resp = http().get(&url).send().await.context("ticker-icon: request")?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp.bytes().await.context("ticker-icon: read body")?;
    if !status.is_success() {
        return Err(anyhow!("ticker-icon: massive {status}"));
    }
    Ok((bytes.to_vec(), content_type))
}

// ── Symbol search (/v3/reference/tickers?search=…) ───────────────────────

/// One typeahead result from Massive's reference-tickers search. The frontend
/// (`liveResultsToRows`) turns these into the symbol-search dialog rows.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub ticker: String,
    pub name: Option<String>,
    /// "stocks" | "crypto" | "fx" | "indices" | "otc"
    pub market: Option<String>,
    /// "us" | "global"
    pub locale: Option<String>,
    pub primary_exchange: Option<String>,
    /// Massive security type ("CS", "ETF", "ADRC", …).
    pub r#type: Option<String>,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<SearchRow>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct SearchRow {
    ticker: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    market: Option<String>,
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    primary_exchange: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// Typeahead over Massive's reference universe. Matches on the **ticker only**
/// (a prefix range), never the company name: `search=` fuzzy-matches both and
/// can't disable the name side, so it pulls in noise like "Maui Land & Pineapple"
/// for a query of "apple". A `[gte, lte]` ticker range gives a pure prefix match:
/// the upper bound is the query padded with 'Z's — 'Z' sorts at/above every char
/// Massive allows in a ticker (A–Z, 0–9, '.', ':', '-' all sort ≤ 'Z'), so the
/// range captures exactly the tickers starting with the prefix. ('~' would sort
/// higher but Massive rejects it as an invalid ticker character.) An optional
/// `type_filter` constrains to a security type.
pub async fn search_tickers(
    query: &str,
    type_filter: Option<&str>,
) -> Result<Vec<SymbolSearchResult>> {
    let token = gateway::token().context(NO_TOKEN)?;
    // Massive sorts the prefix range alphabetically, so a low cap truncates good
    // matches before the frontend can re-rank them (e.g. "MU" has 43 tickers —
    // MUR/MUX sort past position 20). Request Massive's max; the cap only adds
    // rows when a prefix genuinely has many (narrow prefixes still return few),
    // and `liveResultsToRows` ranks then slices to a display-sized list.
    let limit = "1000";
    // Tickers are uppercase; uppercase the query so the range matches. The 'Z'
    // padding length comfortably exceeds any real ticker's tail.
    let prefix = query.trim().to_uppercase();
    let prefix_end = format!("{prefix}ZZZZZZ");
    let mut params: Vec<(&str, &str)> = vec![
        ("ticker.gte", prefix.as_str()),
        ("ticker.lte", prefix_end.as_str()),
        ("active", "true"),
        ("limit", limit),
        ("apiKey", token),
    ];
    // Massive constrains the result set server-side when a type is given.
    let type_filter = type_filter.filter(|t| !t.is_empty());
    if let Some(t) = type_filter {
        params.push(("type", t));
    }
    let resp = http()
        .get(format!("{BASE}/v3/reference/tickers"))
        .query(&params)
        .send()
        .await
        .context("massive search request")?;
    let http_status = resp.status();
    let body: SearchResponse = resp.json().await.context("massive search: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive search {http_status}: {}",
            body.error.unwrap_or_default()
        ));
    }
    Ok(body
        .results
        .into_iter()
        .map(|r| SymbolSearchResult {
            ticker: r.ticker,
            name: r.name,
            market: r.market,
            locale: r.locale,
            primary_exchange: r.primary_exchange,
            r#type: r.kind,
        })
        .collect())
}

// ── Snapshot (/v2/snapshot) ──────────────────────────────────────────────

/// Live(ish) snapshot for the detail header. `source` is "live" when the
/// current session has volume, else "prev" (we fall back to the prior
/// day's bar so the range/last don't read as zero when the market's shut).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub ticker: String,
    pub last: f64,
    pub change: f64,
    pub change_percent: f64,
    pub day_high: f64,
    pub day_low: f64,
    pub day_volume: f64,
    /// Pre/post-market move vs the regular close — the "Ext" column. `None`
    /// when there's no extended-hours trade (e.g. mid-session).
    pub ext_change_percent: Option<f64>,
    pub source: String,
    pub updated_ns: f64,
}

// One per-ticker entry from either the single (`{ "ticker": … }`) or the bulk
// (`{ "tickers": [ … ] }`) snapshot endpoint — same shape, so one struct and
// one shaping function serve both.
#[derive(Deserialize)]
struct SnapEntry {
    #[serde(default)]
    ticker: String,
    #[serde(default, rename = "todaysChange")]
    todays_change: f64,
    #[serde(default, rename = "todaysChangePerc")]
    todays_change_perc: f64,
    #[serde(default)]
    updated: f64,
    #[serde(default)]
    day: Option<SnapBar>,
    #[serde(default, rename = "prevDay")]
    prev_day: Option<SnapBar>,
    #[serde(default)]
    min: Option<MinBar>,
}

#[derive(Deserialize)]
struct SnapResponse {
    ticker: Option<SnapEntry>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Default)]
struct SnapBar {
    #[serde(default)]
    o: f64,
    #[serde(default)]
    h: f64,
    #[serde(default)]
    l: f64,
    #[serde(default)]
    c: f64,
    #[serde(default)]
    v: f64,
}

/// The values the right rail shows for one ticker, distilled from a snapshot.
struct Shaped {
    last: f64,
    change: f64,
    change_percent: f64,
    ext_change_percent: Option<f64>,
    day_high: f64,
    day_low: f64,
    day_volume: f64,
    source: &'static str,
}

/// Normalise one snapshot entry exactly as the reference mock's
/// `shapeSnapshotTicker` does — this is the logic that makes pre-market read
/// correctly:
///   • `last` is the **regular-session** close (today's once it has traded,
///     else the prior session's) — NOT the latest pre/post-market trade.
///   • The day change is close-vs-prior-close: Massive's `todaysChange*` while
///     the session is live; for a closed/not-yet-open session, the completed
///     session's close vs the session-*before* it (`prior_close`), falling back
///     to the session's own open→close when no baseline is available.
///   • `ext_change_percent` is the pre/post-market move: the latest trade
///     (`min.c`, which includes extended hours) vs that regular close, shown
///     in the "Ext" column.
fn shape_snapshot(t: &SnapEntry, prior_close: Option<f64>) -> Option<Shaped> {
    let prev = t.prev_day.as_ref();
    // Today's regular session, but only once it has actually traded.
    let live = t.day.as_ref().filter(|d| d.c > 0.0);
    let src = live.or(prev)?;

    let (change, change_percent) = if live.is_some() {
        // Regular hours — Massive's todaysChange* is already close-vs-prev-close.
        (t.todays_change, t.todays_change_perc)
    } else if let Some(pc) = prior_close.filter(|p| *p > 0.0) {
        // Closed / pre-open — completed session's close vs the prior session's.
        (src.c - pc, (src.c - pc) / pc * 100.0)
    } else {
        // No baseline recoverable — the session's own open→close.
        let pct = if src.o > 0.0 { (src.c - src.o) / src.o * 100.0 } else { 0.0 };
        (src.c - src.o, pct)
    };

    // Extended-hours move: latest trade (incl. pre/post) vs the regular close.
    let ext_change_percent = {
        let min_close = t.min.as_ref().map(|m| m.c).unwrap_or(0.0);
        let ext_base = src.c;
        (min_close > 0.0 && ext_base > 0.0).then(|| (min_close - ext_base) / ext_base * 100.0)
    };

    Some(Shaped {
        last: src.c,
        change,
        change_percent,
        ext_change_percent,
        day_high: src.h,
        day_low: src.l,
        day_volume: src.v,
        source: if live.is_some() { "live" } else { "prev" },
    })
}

/// True when this entry's regular session hasn't traded yet (so the day %
/// change must be measured against the prior-session baseline, not `prevDay`).
fn is_closed(t: &SnapEntry) -> bool {
    t.day.as_ref().map(|d| d.c > 0.0) != Some(true)
}

// ── Prior-session close (grouped daily) ──────────────────────────────────
//
// A *closed* session's daily % change is (close − prior-session close) /
// prior-session close, but the snapshot only carries the single most-recent
// `prevDay`. Rather than one daily-aggs call per ticker, pull the whole market
// for one date in a single grouped call and reuse it across every ticker.

#[derive(Deserialize)]
struct GroupedResponse {
    #[serde(default)]
    results: Vec<GroupedRow>,
}

#[derive(Deserialize)]
struct GroupedRow {
    #[serde(rename = "T")]
    t: String,
    #[serde(default)]
    c: f64,
}

/// All US-stock closes for one calendar date → `{ ticker: close }`, or `None`
/// when the date had no session (weekend / holiday / not-yet-published).
async fn fetch_grouped_closes(date: NaiveDate, token: &str) -> Option<HashMap<String, f64>> {
    let url = format!(
        "{BASE}/v2/aggs/grouped/locale/us/market/stocks/{date}\
         ?adjusted=true&apiKey={token}"
    );
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: GroupedResponse = resp.json().await.ok()?;
    if body.results.is_empty() {
        return None;
    }
    Some(body.results.into_iter().map(|r| (r.t, r.c)).collect())
}

/// Process-wide memo of the baseline close map, keyed by the day it was resolved
/// for. The `tokio::Mutex` held across the awaits also coalesces concurrent
/// callers onto a single resolution.
#[allow(clippy::type_complexity)]
static PRIOR_CLOSES: OnceLock<Mutex<Option<(NaiveDate, Arc<HashMap<String, f64>>)>>> =
    OnceLock::new();

/// Closes of the session *before* the most recent completed one — the baseline
/// for a closed/pre-open session's daily % change. Walks back from yesterday
/// (skipping weekends) until two sessions return data; the second is the
/// baseline. Resolved at most once per calendar day.
async fn prior_session_closes(token: &str) -> Arc<HashMap<String, f64>> {
    let memo = PRIOR_CLOSES.get_or_init(|| Mutex::new(None));
    let today = Utc::now().date_naive();
    let mut guard = memo.lock().await;
    if let Some((as_of, closes)) = guard.as_ref() {
        if *as_of == today {
            return closes.clone();
        }
    }
    let mut found: Vec<HashMap<String, f64>> = Vec::new();
    let mut cursor = today - ChronoDuration::days(1);
    let mut steps = 0;
    while steps < 8 && found.len() < 2 {
        if !matches!(cursor.weekday(), Weekday::Sat | Weekday::Sun) {
            if let Some(c) = fetch_grouped_closes(cursor, token).await {
                found.push(c);
            }
        }
        cursor -= ChronoDuration::days(1);
        steps += 1;
    }
    // found[0] = most recent completed session, found[1] = the baseline.
    let closes = Arc::new(found.into_iter().nth(1).unwrap_or_default());
    if !closes.is_empty() {
        *guard = Some((today, closes.clone()));
    }
    closes
}

pub async fn fetch_ticker_snapshot(ticker: &str) -> Result<Snapshot> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!(
        "{BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}?apiKey={token}"
    );
    let resp = http().get(&url).send().await.context("massive snapshot request")?;
    let http_status = resp.status();
    let body: SnapResponse = resp.json().await.context("massive snapshot: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive snapshot {http_status}: {}",
            body.error.unwrap_or_default()
        ));
    }
    let t = body
        .ticker
        .ok_or_else(|| anyhow!("massive snapshot: no ticker for {ticker}"))?;
    let prior_close = if is_closed(&t) {
        prior_session_closes(token)
            .await
            .get(&ticker.to_uppercase())
            .copied()
    } else {
        None
    };
    let s = shape_snapshot(&t, prior_close)
        .ok_or_else(|| anyhow!("massive snapshot: neither day nor prevDay for {ticker}"))?;
    Ok(Snapshot {
        ticker: ticker.to_string(),
        last: s.last,
        change: s.change,
        change_percent: s.change_percent,
        day_high: s.day_high,
        day_low: s.day_low,
        day_volume: s.day_volume,
        ext_change_percent: s.ext_change_percent,
        source: s.source.to_string(),
        updated_ns: t.updated,
    })
}

// ── Bulk snapshot (/v2/snapshot … ?tickers=) ─────────────────────────────
//
// One HTTP call returns the delayed snapshot for many tickers at once —
// the REST-polling substitute for the WebSocket live feed (the Stocks
// Starter plan has no WebSocket entitlement; see massive_poll.rs).

/// A single ticker's latest delayed values, distilled for the poller.
pub struct LiveTick {
    pub ticker: String,
    /// Regular-session close (today's once traded, else the prior session's) —
    /// the watchlist's "Last", also pre-market.
    pub last: f64,
    /// Absolute regular-session change (close vs prior close).
    pub change: f64,
    /// Percent regular-session change (close vs prior close).
    pub change_percent: f64,
    /// Pre/post-market move vs the regular close — the "Ext" column. `None`
    /// mid-session / when there's no extended-hours trade.
    pub ext_change_percent: Option<f64>,
    /// Regular-session volume (today's once traded, else the prior session's).
    pub volume: f64,
    /// "live" when today's regular session has traded, else "prev".
    pub source: String,
    /// Most recent minute bar, when the snapshot carries one — fed to the
    /// chart as a `ChartAggregate`. `None` outside market hours.
    pub minute: Option<Candle>,
    /// Today's full-session daily bar (`day` in the snapshot), once today has
    /// traded. Rides along on the `ChartAggregate` so the daily-family chart
    /// bar updates exactly (a warm daily history load skips today's forming
    /// bar). `time` is the snapshot's update stamp in UNIX seconds — the
    /// frontend re-buckets it to the daily-bar convention.
    pub day: Option<Candle>,
}

#[derive(Deserialize)]
struct MultiSnapResponse {
    #[serde(default)]
    tickers: Vec<SnapEntry>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Default)]
struct MinBar {
    #[serde(default)]
    o: f64,
    #[serde(default)]
    h: f64,
    #[serde(default)]
    l: f64,
    #[serde(default)]
    c: f64,
    #[serde(default)]
    v: f64,
    /// Minute start, UNIX **milliseconds**.
    #[serde(default)]
    t: i64,
}

/// Fetch delayed snapshots for many tickers in a single request. Tickers
/// are uppercased and comma-joined. Returns one `LiveTick` per ticker the
/// API knows about (unknown / halted tickers are simply omitted).
pub async fn fetch_snapshots(tickers: &[String]) -> Result<Vec<LiveTick>> {
    if tickers.is_empty() {
        return Ok(Vec::new());
    }
    let token = gateway::token().context(NO_TOKEN)?;
    let joined = tickers
        .iter()
        .map(|t| t.to_uppercase())
        .collect::<Vec<_>>()
        .join(",");
    let url = format!(
        "{BASE}/v2/snapshot/locale/us/markets/stocks/tickers\
         ?tickers={joined}&apiKey={token}"
    );
    let resp = http().get(&url).send()
        .await
        .context("massive bulk snapshot request")?;
    let http_status = resp.status();
    let body: MultiSnapResponse = resp
        .json()
        .await
        .context("massive bulk snapshot: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive bulk snapshot {http_status}: {}",
            body.error.unwrap_or_else(|| body.status.clone())
        ));
    }

    // Any not-yet-open session needs the prior-session close baseline; resolve
    // the whole-market map once (memoised) and share it across those tickers.
    let prior = if body.tickers.iter().any(is_closed) {
        Some(prior_session_closes(token).await)
    } else {
        None
    };

    Ok(body
        .tickers
        .iter()
        .filter_map(|t| {
            let prior_close = if is_closed(t) {
                prior
                    .as_ref()
                    .and_then(|m| m.get(&t.ticker.to_uppercase()).copied())
            } else {
                None
            };
            let s = shape_snapshot(t, prior_close)?;
            // `min.t == 0` means the snapshot carried no minute bar (market
            // closed) — leave the chart untouched rather than emit a 1970 bar.
            let minute = t.min.as_ref().filter(|m| m.t > 0).map(|m| Candle {
                time: (m.t / 1000) as f64,
                open: m.o,
                high: m.h,
                low: m.l,
                close: m.c,
                volume: m.v,
            });
            // Today's session bar, only once it has traded (`c > 0`); a closed
            // or pre-open snapshot leaves the chart's daily bar untouched.
            let day = t.day.as_ref().filter(|d| d.c > 0.0).map(|d| Candle {
                time: (t.updated / 1e9).floor(),
                open: d.o,
                high: d.h,
                low: d.l,
                close: d.c,
                volume: d.v,
            });
            Some(LiveTick {
                ticker: t.ticker.clone(),
                last: s.last,
                change: s.change,
                change_percent: s.change_percent,
                ext_change_percent: s.ext_change_percent,
                volume: s.day_volume,
                source: s.source.to_string(),
                minute,
                day,
            })
        })
        .collect())
}

// ── Full-market snapshot (/v2/snapshot, no ticker list) ──────────────────
//
// The screener's live table: every US ticker in one call (13,256 tickers,
// 5.3 MB JSON, ~1.35 MB gzip, 1.2-2.1 s through the gateway, measured
// 29/09/2026). Shaped with the same rules as the watchlist (`shape_snapshot`)
// so both surfaces show the same last / change.

/// One ticker of the full-market snapshot, shaped for the screener.
pub struct MarketRow {
    pub ticker: String,
    /// Regular-session close (today's once traded, else the prior session's).
    pub last: f64,
    pub change: f64,
    pub change_percent: f64,
    /// The shown session's open / high / low / volume.
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub volume: f64,
    /// Close of the session before the shown one (the change baseline);
    /// `None` when no baseline is known.
    pub prev_close: Option<f64>,
    /// True when the shown session is today's (it has traded), false when the
    /// row shows the previous completed session (pre-open, closed day).
    pub live: bool,
    /// Snapshot update stamp, UNIX milliseconds.
    pub updated_ms: f64,
}

/// Fetch and shape the whole-market delayed snapshot.
pub async fn fetch_market_snapshot() -> Result<Vec<MarketRow>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!("{BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey={token}");
    let resp = http().get(&url).send().await.context("massive market snapshot request")?;
    let http_status = resp.status();
    let body: MultiSnapResponse = resp.json().await.context("massive market snapshot: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive market snapshot {http_status}: {}",
            body.error.unwrap_or_else(|| body.status.clone())
        ));
    }
    let prior = if body.tickers.iter().any(is_closed) {
        Some(prior_session_closes(token).await)
    } else {
        None
    };
    Ok(body
        .tickers
        .iter()
        .filter_map(|t| {
            let closed = is_closed(t);
            let prior_close = if closed {
                prior.as_ref().and_then(|m| m.get(&t.ticker.to_uppercase()).copied())
            } else {
                None
            };
            let s = shape_snapshot(t, prior_close)?;
            let src = if closed { t.prev_day.as_ref() } else { t.day.as_ref() }?;
            let prev_close = if closed {
                prior_close
            } else {
                t.prev_day.as_ref().map(|p| p.c).filter(|c| *c > 0.0)
            };
            // The reference app's `change` is close vs previous close. Massive's
            // todaysChange follows the latest trade, post-market included
            // (29/09/2026: 16 of 73 symbols off after the close).
            let (change, change_percent) = match prev_close {
                Some(pc) => (s.last - pc, (s.last / pc - 1.0) * 100.0),
                None => (s.change, s.change_percent),
            };
            Some(MarketRow {
                ticker: t.ticker.clone(),
                last: s.last,
                change,
                change_percent,
                open: src.o,
                high: src.h,
                low: src.l,
                volume: src.v,
                prev_close,
                live: !closed,
                updated_ms: t.updated / 1e6,
            })
        })
        .collect())
}

// ── Reference ticker list (/v3/reference/tickers) ────────────────────────

/// One active US stock-market ticker from the reference list.
#[derive(Deserialize, Serialize, Clone)]
pub struct RefTicker {
    pub ticker: String,
    #[serde(default)]
    pub name: String,
    /// Massive type code: CS, PFD, ADRC, ETF, ETN, FUND, WARRANT, RIGHT, UNIT…
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub primary_exchange: String,
    #[serde(default)]
    pub currency_name: String,
}

#[derive(Deserialize)]
struct RefListResponse {
    #[serde(default)]
    results: Vec<RefTicker>,
    #[serde(default)]
    next_url: Option<String>,
}

/// Every active ticker of the US stocks market (~13 pages of 1000). `next_url`
/// comes back pointing at the gateway without the token, so it is re-added.
pub async fn fetch_reference_tickers() -> Result<Vec<RefTicker>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let mut url = format!(
        "{BASE}/v3/reference/tickers?market=stocks&active=true&limit=1000&apiKey={token}"
    );
    let mut out = Vec::new();
    for _page in 0..40 {
        let resp = http().get(&url).send().await.context("massive reference tickers request")?;
        let http_status = resp.status();
        if !http_status.is_success() {
            return Err(anyhow!("massive reference tickers {http_status}"));
        }
        let body: RefListResponse =
            resp.json().await.context("massive reference tickers: parse json")?;
        out.extend(body.results.into_iter().map(|mut r| {
            r.currency_name = r.currency_name.to_uppercase();
            r
        }));
        match body.next_url {
            Some(next) if !next.is_empty() => url = format!("{next}&apiKey={token}"),
            _ => return Ok(out),
        }
    }
    Err(anyhow!("massive reference tickers: too many pages"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(time: i64, close: f64, volume: f64) -> Candle {
        Candle { time: time as f64, open: close, high: close, low: close, close, volume }
    }

    /// Candle dated `y-m-d` at 14:30 UTC (≈ US market open, so `bar_date` reads
    /// the intended calendar day unambiguously).
    fn cd(y: i32, m: u32, d: u32) -> Candle {
        let t = NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(14, 30, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        c(t, 10.0, 100.0)
    }

    fn nd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn sentinels_interior_no_trade_days_when_not_truncated() {
        // 2024-12-23 Mon … 27 Fri (25th Christmas closed → trading days 23,24,26,27).
        // Bars only on 23 and 27; 24 and 26 are genuine no-trade days.
        let bars = vec![cd(2024, 12, 23), cd(2024, 12, 27)];
        let got = empty_sentinel_days(&bars, nd(2024, 12, 23), nd(2024, 12, 27), false, nd(2025, 1, 2));
        assert_eq!(got, vec![nd(2024, 12, 24), nd(2024, 12, 26)]);
    }

    #[test]
    fn truncated_does_not_sentinel_before_oldest_bar() {
        // Truncated: floor = oldest returned (24th). 23rd is ambiguous (could be
        // dropped) → not sentineled; the interior 26th is.
        let bars = vec![cd(2024, 12, 24), cd(2024, 12, 27)];
        let got = empty_sentinel_days(&bars, nd(2024, 12, 23), nd(2024, 12, 27), true, nd(2025, 1, 2));
        assert_eq!(got, vec![nd(2024, 12, 26)]);
    }

    #[test]
    fn empty_response_yields_no_sentinels() {
        assert!(empty_sentinel_days(&[], nd(2024, 12, 23), nd(2024, 12, 27), false, nd(2025, 1, 2)).is_empty());
    }

    #[test]
    fn today_and_later_are_never_sentineled() {
        // Range reaches today (26th). 24th is a closed no-trade day → sentineled;
        // 26th (== today, the mutable live tail) must not be.
        let bars = vec![cd(2024, 12, 23)];
        let got = empty_sentinel_days(&bars, nd(2024, 12, 23), nd(2024, 12, 26), false, nd(2024, 12, 26));
        assert_eq!(got, vec![nd(2024, 12, 24)]);
    }

    #[test]
    fn epoch_is_newest_split_or_none() {
        assert_eq!(epoch_of(&[]), "none");
        // fetch_splits returns newest-first, so the first entry is the epoch.
        let splits = vec![
            Split { execution_date: NaiveDate::from_ymd_opt(2022, 1, 3).unwrap(), from: 1.0, to: 1.0 },
            Split { execution_date: NaiveDate::from_ymd_opt(2018, 6, 1).unwrap(), from: 1.0, to: 1.0 },
        ];
        assert_eq!(epoch_of(&splits), "2022-01-03");
    }
}
