/*
 * History commands — daily / minute / second candles for `symbol`. All bar data
 * is fetched through the injected `DataProvider` (the provider-agnostic seam);
 * the generic parts — trading-calendar date math, the daily memo, and the
 * scroll-back `before_sec` → range conversion — stay here, independent of vendor.
 * For the Massive provider a cold load is a single HTTP request and warm loads
 * read its per-session disk cache.
 */
use crate::data::provider::capabilities::BarFamily;
use crate::data::provider::{entitlements, Provider};
use crate::data::massive_rest::DayMemo;
use crate::data::trading_calendar;
use crate::data::types::Candle;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::State;
use tokio::sync::Mutex;

/// Process-memory cache of assembled daily series. The Tauri backend process
/// outlives a front-end reload (Ctrl+R), so a ticker loaded once this session
/// re-displays instantly instead of re-reading ~1254 per-day cache files from
/// disk. Keyed by (ticker, days, adjusted); rebuilt once per UTC day so new
/// closed bars and today's bar are picked up — today's still-forming bar is
/// corrected live by the poller, so a slightly stale snapshot here is harmless.
static DAILY_MEM: DayMemo<(String, u32, bool), Vec<Candle>> = OnceLock::new();

/// Clamp `[from, to]` to the key's oldest available bar for `family` (probed
/// entitlement). `None` when the whole window is older than that floor, so
/// nothing is fetched. Asking for days before the floor returns no bars, and
/// the REST cache would then store them as empty no-trade days.
async fn clamp_to_floor(
    family: BarFamily,
    from: NaiveDate,
    to: NaiveDate,
) -> Option<(NaiveDate, NaiveDate)> {
    let floor = entitlements::history_floor(family).await;
    let from = floor.map_or(from, |f| from.max(f));
    (from <= to).then_some((from, to))
}

#[tauri::command]
#[specta::specta]
pub async fn get_daily_history(
    provider: State<'_, Provider>,
    symbol: String,
    days: u32,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    let sym = symbol.to_uppercase();
    let to = Utc::now().date_naive();

    // Instant path: same (ticker, days, adjusted) already assembled today.
    let mem = DAILY_MEM.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((as_of, series)) = mem.lock().await.get(&(sym.clone(), days, adjusted)) {
        if *as_of == to {
            return Ok((**series).clone());
        }
    }

    let dates = trading_calendar::last_trading_days(days.max(1) as usize);
    let from = *dates.first().unwrap_or(&to);
    let Some((from, to)) = clamp_to_floor(BarFamily::Day, from, to).await else {
        return Err(format!("no daily data for {sym} in last {days} days"));
    };

    // One REST call returns the whole daily series (split-adjusted when
    // `adjusted`); closed sessions are then served from the per-day disk cache
    // on later loads.
    let bars = provider
        .daily_aggs(&sym, from, to, adjusted)
        .await
        .map_err(|e| e.to_string())?;
    if bars.is_empty() {
        return Err(format!("no daily data for {sym} in last {days} days"));
    }
    mem.lock()
        .await
        .insert((sym, days, adjusted), (to, Arc::new(bars.clone())));
    Ok(bars)
}

/// Fetch minute candles for `symbol` over the last `days` trading days,
/// optionally aggregating to a coarser `interval_min` bucket
/// (5, 15, 30, 60, 120, 240). `interval_min <= 1` returns raw 1-minute candles.
/// Massive buckets server-side, so one REST call returns this ticker's bars
/// split-adjusted; closed sessions are served from the per-session disk cache.
#[tauri::command]
#[specta::specta]
pub async fn get_minute_history(
    provider: State<'_, Provider>,
    symbol: String,
    days: u32,
    interval_min: u32,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    let dates = trading_calendar::last_trading_days(days.max(1) as usize);
    let sym = symbol.to_uppercase();
    let to = Utc::now().date_naive();
    let from = *dates.first().unwrap_or(&to);
    let Some((from, to)) = clamp_to_floor(BarFamily::Minute, from, to).await else {
        return Err(format!("no minute data for {sym} in last {days} days"));
    };

    let bars = provider
        .minute_aggs(&sym, interval_min.max(1), from, to, adjusted)
        .await
        .map_err(|e| e.to_string())?;
    if bars.is_empty() {
        return Err(format!("no minute data for {sym} in last {days} days"));
    }
    Ok(bars)
}

/// Fetch second-granularity bars for `symbol` over the trailing `days`
/// calendar days, bucketed to `mult`-second candles via Massive's REST
/// aggregates endpoint. Used for the sub-minute interval rows (1S / 5S /
/// 10S / …) where no per-ticker flat file exists.
#[tauri::command]
#[specta::specta]
pub async fn get_second_history(
    provider: State<'_, Provider>,
    symbol: String,
    mult: u32,
    days: u32,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    let to = Utc::now().date_naive();
    // Pad the lookback by a day so a `days = 1` request still spans the
    // most recent full session even before today's bars exist.
    let from = to - Duration::days((days.max(1) as i64) + 1);
    let Some((from, to)) = clamp_to_floor(BarFamily::Second, from, to).await else {
        return Ok(Vec::new());
    };
    provider
        .second_aggs(&symbol.to_uppercase(), mult, from, to, adjusted)
        .await
        .map_err(|e| e.to_string())
}

/// Live-tail refresh for the seconds frames: `mult`-second bars strictly newer
/// than `since_sec` (UNIX seconds). The 30s refresh loop calls this instead of
/// refetching the whole 1-3 day window; the caller merges the overlap through
/// its live-bar path and falls back to a full refetch when the tail doesn't
/// overlap the loaded series.
#[tauri::command]
#[specta::specta]
pub async fn get_second_history_tail(
    provider: State<'_, Provider>,
    symbol: String,
    mult: u32,
    since_sec: f64,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    provider
        .second_tail(&symbol.to_uppercase(), mult, since_sec, adjusted)
        .await
        .map_err(|e| e.to_string())
}

/// The `[from, to]` calendar window a scroll-back page should fetch, given the
/// oldest loaded bar's date (`to`) and how many sessions back to reach.
///
/// `span_days` counts TRADING days, not calendar days. The naive `to - span_days`
/// (calendar) is wrong at every weekend/holiday boundary: the oldest loaded bar
/// usually sits at a session OPEN, so the only same-day bars older than it are
/// premarket — which the caller's RTH filter then drops. The page therefore has
/// to reach the PRIOR session to return anything, and for the sub-minute frames
/// (`span_days` = 1 for 1S/5S, 2 for 10S/15S) a calendar-day window can't span a
/// weekend, so it comes back empty and the renderer latches "history exhausted".
/// Walking the trading calendar guarantees at least one prior session is in the
/// window. `+1` because `trading_days_before` includes `to` itself.
fn aggregates_before_window(to: NaiveDate, span_days: u32) -> (NaiveDate, NaiveDate) {
    let span = span_days.max(1) as usize;
    let from = *trading_calendar::trading_days_before(to, span + 1)
        .first()
        .unwrap_or(&to);
    (from, to)
}

/// Scroll-back pager for the REST-sourced frames (seconds + minutes): one older
/// window of `mult`-`timespan` bars strictly before `before_sec` (the time, in
/// seconds, of the chart's oldest loaded bar). `span_days` sizes the window (in
/// TRADING days — see {@link aggregates_before_window}); `fetch_*_aggs` already
/// sort desc + cap at 50k base units, so the page ends at `before_sec` and the
/// caller pages further back by passing the new oldest time. Returns `[]` when no
/// older bars exist (the renderer reads that as exhausted).
#[tauri::command]
#[specta::specta]
pub async fn get_aggregates_before(
    provider: State<'_, Provider>,
    symbol: String,
    timespan: String,
    mult: u32,
    // Seconds since epoch. `f64` (not i64) because specta forbids exporting
    // 64-bit ints to TypeScript, and it matches `Candle.time`'s type anyway.
    before_sec: f64,
    span_days: u32,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    let sym = symbol.to_uppercase();
    let to = DateTime::from_timestamp(before_sec as i64 - 1, 0)
        .ok_or_else(|| format!("invalid before_sec: {before_sec}"))?
        .date_naive();
    let (from, to) = aggregates_before_window(to, span_days);
    let family = match timespan.as_str() {
        "second" => BarFamily::Second,
        _ => BarFamily::Minute,
    };
    // Older than the key's history floor: exhausted, no request.
    let Some((from, to)) = clamp_to_floor(family, from, to).await else {
        return Ok(Vec::new());
    };

    let bars = match timespan.as_str() {
        "second" => provider.second_aggs(&sym, mult, from, to, adjusted).await,
        "minute" => provider.minute_aggs(&sym, mult, from, to, adjusted).await,
        other => return Err(format!("unsupported timespan for aggregates-before: {other}")),
    }
    .map_err(|e| e.to_string())?;

    // The day-rounded `to` can echo the boundary bar; keep strictly-older bars.
    Ok(bars.into_iter().filter(|b| b.time < before_sec).collect())
}

/// Scroll-back pager for the daily family (1D/1W/1M): older daily candles
/// strictly before `before_sec`, from the same REST daily source as the initial
/// load (so 1W/1M re-aggregate against a single consistent source). The frontend
/// keeps the underlying daily bars and re-aggregates. Returns `[]` when exhausted
/// (e.g. past the key's history floor, see `clamp_to_floor`).
#[tauri::command]
#[specta::specta]
pub async fn get_daily_history_before(
    provider: State<'_, Provider>,
    symbol: String,
    // Seconds since epoch as `f64` — see `get_aggregates_before`.
    before_sec: f64,
    span_days: u32,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    let sym = symbol.to_uppercase();
    let end = DateTime::from_timestamp(before_sec as i64 - 1, 0)
        .ok_or_else(|| format!("invalid before_sec: {before_sec}"))?
        .date_naive();
    let dates = trading_calendar::trading_days_before(end, span_days.max(1) as usize);
    let Some(&from) = dates.first() else {
        return Ok(Vec::new());
    };
    // Older than the key's history floor: exhausted, no request.
    let Some((from, end)) = clamp_to_floor(BarFamily::Day, from, end).await else {
        return Ok(Vec::new());
    };

    // Unlike the initial load, a scroll-back page never errors the UI: an empty
    // result (no older data, or past the plan's history floor) is reported as
    // Ok([]) so the renderer latches "history exhausted" and stops paging.
    let bars = provider
        .daily_aggs(&sym, from, end, adjusted)
        .await
        .map_err(|e| e.to_string())?;
    Ok(bars.into_iter().filter(|b| b.time < before_sec).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::provider::{HistoryProvider, MassiveProvider};

    /// Regression for the sub-minute scroll-back stall: a 1S page (span_days = 1)
    /// whose oldest bar sits on a Monday open must still reach back to the prior
    /// Friday session, not stop one calendar day back inside the empty weekend.
    #[test]
    fn before_window_jumps_the_weekend() {
        // 2025-05-12 is a Monday; the prior session is Friday 2025-05-09.
        let mon = NaiveDate::from_ymd_opt(2025, 5, 12).unwrap();
        let fri = NaiveDate::from_ymd_opt(2025, 5, 9).unwrap();
        // span_days = 1 (1S/5S) — the calendar-day window [Sun, Mon] returned an
        // empty older page; the trading-day window must include Friday.
        assert_eq!(aggregates_before_window(mon, 1), (fri, mon));
        // span_days = 2 (10S/15S) reaches one more session back (Thursday the 8th).
        let thu = NaiveDate::from_ymd_opt(2025, 5, 8).unwrap();
        assert_eq!(aggregates_before_window(mon, 2), (thu, mon));
    }

    /// Mid-week the window is just the prior `span_days` sessions — no surprises.
    #[test]
    fn before_window_midweek() {
        // 2025-05-14 Wed → span 1 reaches Tuesday the 13th.
        let wed = NaiveDate::from_ymd_opt(2025, 5, 14).unwrap();
        let tue = NaiveDate::from_ymd_opt(2025, 5, 13).unwrap();
        assert_eq!(aggregates_before_window(wed, 1), (tue, wed));
    }

    /// Exercises the real daily-load path against the on-disk cache (no network
    /// for the cached recent window). Prints cold vs warm timing so we can see
    /// the per-session REST cache actually take effect, and asserts the series
    /// is non-empty and ends at a recent (2026) bar. Calls the provider directly
    /// (the command needs injected `State`, unavailable in a unit test); this
    /// still exercises the per-session REST disk cache for the cold/warm split.
    /// Run with:
    ///   cargo test --lib daily_load_smoke -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the real REST aggregate cache; run explicitly"]
    async fn daily_load_smoke() {
        // Through the gateway; build.rs compiles the token in from ../.env.
        assert!(
            crate::data::gateway::token().is_some(),
            "{}",
            crate::data::gateway::NO_TOKEN
        );

        let provider = MassiveProvider;
        let to = Utc::now().date_naive();
        let from = *trading_calendar::last_trading_days(252).first().unwrap_or(&to);

        for sym in ["AMD", "NVDA", "TSLA"] {
            let t0 = std::time::Instant::now();
            let bars = provider
                .daily_aggs(sym, from, to, true)
                .await
                .unwrap_or_else(|e| panic!("{sym} daily load failed: {e}"));
            let cold_ms = t0.elapsed().as_millis();
            assert!(!bars.is_empty(), "{sym} returned ZERO bars");
            let last = bars.last().unwrap();

            let t1 = std::time::Instant::now();
            let warm = provider.daily_aggs(sym, from, to, true).await.unwrap();
            let warm_ms = t1.elapsed().as_millis();

            eprintln!(
                "{sym}: {} bars | cold {cold_ms}ms -> warm {warm_ms}ms | last t={} close={}",
                bars.len(), last.time as i64, last.close,
            );
            assert_eq!(bars.len(), warm.len(), "{sym} cold/warm length mismatch");
            // unix seconds for 2026-01-01 = 1_767_225_600 — guards against a stale window.
            assert!((last.time as i64) >= 1_767_225_600, "{sym} newest bar is stale");
        }
    }
}
