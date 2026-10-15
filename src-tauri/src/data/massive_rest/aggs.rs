//! Aggregate bars: the ranged request, the per-resolution fetchers, the
//! entitlement probe and the cached ranged fetch (closed sessions from disk,
//! the live tail from the network).
use super::cache::{persist_closed_days, read_day_cache, remove_legacy_cache_once};
use super::corporate_actions::split_epoch;
use super::{http, Candle};
use crate::data::gateway::{self, BASE, NO_TOKEN};
use crate::data::trading_calendar;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, Utc};
use serde::Deserialize;
use std::collections::HashMap;

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
    // The source's spelling (case-sensitive, see `ticker_case`).
    let ticker = ticker.to_string();
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
