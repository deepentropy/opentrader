//! Bars: the ranged request, the per-resolution fetchers, the entitlement
//! probe and the cached ranged fetch (closed sessions from disk, the live
//! tail from the network).
use super::cache::{persist_closed_days, read_day_cache, remove_legacy_cache_once};
use super::corporate_actions::split_epoch;
use super::{get_json, seg, Candle};
use crate::data::trading_calendar;
use anyhow::Result;
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, Utc};
use serde::Deserialize;
use std::collections::HashMap;

/// Most bars one request returns (the gateway's `limit` cap).
const MAX_BARS: u32 = 50_000;

/// A `bars/<T>` answer: columnar, one entry per bar in every array.
#[derive(Deserialize)]
struct BarsAnswer {
    /// The data is delayed (the plan's 15 minutes).
    #[serde(default)]
    delayed: bool,
    /// The range holds more bars than were returned: with `order=desc` the
    /// oldest part was cut. The cap applies to the base units read
    /// (minutes), not to the bars returned, so a coarse range is cut too
    /// (measured 29/09/2026: 30-minute AAPL 05/01-15/05/2026 came back cut
    /// at 2175 bars).
    #[serde(default)]
    truncated: bool,
    /// Bar start, Unix **milliseconds**.
    #[serde(default)]
    t: Vec<Option<i64>>,
    #[serde(default)]
    o: Vec<Option<f64>>,
    #[serde(default)]
    h: Vec<Option<f64>>,
    #[serde(default)]
    l: Vec<Option<f64>>,
    #[serde(default)]
    c: Vec<Option<f64>>,
    #[serde(default)]
    v: Vec<Option<f64>>,
}

impl BarsAnswer {
    /// The bars as candles, in the answer's order. A bar without its time or
    /// a price is dropped (nothing to draw); a missing volume reads 0.
    fn candles(&self) -> Vec<Candle> {
        let at = |col: &[Option<f64>], i: usize| col.get(i).copied().flatten();
        self.t
            .iter()
            .enumerate()
            .filter_map(|(i, t)| {
                Some(Candle {
                    time: ((*t)? / 1000) as f64,
                    open: at(&self.o, i)?,
                    high: at(&self.h, i)?,
                    low: at(&self.l, i)?,
                    close: at(&self.c, i)?,
                    volume: at(&self.v, i).unwrap_or(0.0),
                })
            })
            .collect()
    }
}

/// The `tf` of a bar request: `mult` and the unit letter of `timespan`.
fn timeframe(mult: u32, timespan: &str) -> String {
    let unit = match timespan {
        "second" => "s",
        "minute" => "m",
        "hour" => "h",
        "week" => "w",
        _ => "d",
    };
    format!("{}{unit}", mult.max(1))
}

/// Fetch bars for `ticker` from `from`..`to` (inclusive, `YYYY-MM-DD` or
/// unix-ms strings). `mult` is the bucket-width multiplier and `timespan` the
/// unit ("second", "minute", "day"). One HTTP call; the gateway buckets
/// server-side and returns only this ticker's bars. The returned bool is
/// `true` when the answer was `truncated` (oldest bars cut) — the cache uses
/// it to decide how far back it may safely sentinel no-trade days.
async fn fetch_aggs(
    ticker: &str,
    mult: u32,
    timespan: &str,
    from: &str,
    to: &str,
    adjusted: bool,
) -> Result<(Vec<Candle>, bool)> {
    // The cap counts *base* units (minutes, not the multiplied bars), so a
    // wide range exceeds it. Ask newest first and reverse below: `desc`
    // keeps the most recent base units (the series always ends at "now");
    // `asc` would keep the oldest and leave the chart frozen months in the
    // past. Trade-off: very coarse intraday over a long span loses the
    // *oldest* history, never the current price.
    let tf = timeframe(mult, timespan);
    let answer: BarsAnswer = get_json(
        "bars",
        &format!("bars/{}", seg(ticker)),
        &[
            ("tf", tf.clone()),
            ("from", from.to_string()),
            ("to", to.to_string()),
            ("adjusted", adjusted.to_string()),
            ("order", "desc".into()),
            ("limit", MAX_BARS.to_string()),
        ],
    )
    .await?;
    if answer.truncated {
        eprintln!("[market_rest] {ticker} {tf} bars truncated — older history cut (most-recent bars kept)");
    }
    // Newest first (order=desc); the chart wants oldest first.
    let mut out = answer.candles();
    out.reverse();
    Ok((out, answer.truncated))
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
/// bucket width in minutes (1, 5, 15, 30, 60, 120, 240…) — the gateway buckets
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

/// Entitlement probe: the oldest `timespan` bar the plan can read for
/// `ticker`, and whether the data is `delayed`. One request (`order=asc&
/// limit=1` over 30 years up to today), ~0.4 s. Use a ticker listed before any
/// plan's history floor, so the first bar marks the plan floor and not the
/// listing date. A range wholly outside the plan answers `NOT_ENTITLED`.
pub async fn probe_oldest_bar(ticker: &str, timespan: &str) -> Result<(Option<NaiveDate>, bool)> {
    let to = Utc::now().date_naive();
    let from = to - ChronoDuration::days(30 * 366);
    let answer: BarsAnswer = get_json(
        "entitlement probe",
        &format!("bars/{}", seg(ticker)),
        &[
            ("tf", timeframe(1, timespan)),
            ("from", from.to_string()),
            ("to", to.to_string()),
            ("adjusted", "true".into()),
            ("order", "asc".into()),
            ("limit", "1".into()),
        ],
    )
    .await?;
    let oldest = answer
        .candles()
        .first()
        .and_then(|b| DateTime::from_timestamp(b.time as i64, 0))
        .map(|dt| dt.date_naive());
    Ok((oldest, answer.delayed))
}

/// Ranged aggregate fetch with per-closed-session disk caching. `from`/`to` are
/// inclusive calendar dates. Returns oldest-first bars across the range.
///
/// Cold path (any closed day missing): one ranged call — as fast as the
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
