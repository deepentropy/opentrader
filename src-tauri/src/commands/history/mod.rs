/*
 * History commands — daily / minute / second candles for `symbol`. All bar data
 * is fetched through the injected `DataProvider` (the provider-agnostic seam);
 * the generic parts — trading-calendar date math, the daily memo, and the
 * scroll-back `before_sec` → range conversion — stay here, independent of vendor.
 * Windows are counted in the symbol's own trading calendar and exchange dates
 * (`SessionCalendar`, from the provider's symbol session).
 * For the Massive provider a cold load is a single HTTP request and warm loads
 * read its per-session disk cache.
 */
use crate::data::provider::capabilities::BarFamily;
use crate::data::provider::{entitlements, Provider};
use crate::data::massive_rest::DayMemo;
use crate::data::symbol::SymbolRef;
use crate::data::calendar::SessionCalendar;
use crate::data::types::Candle;
use chrono::{Duration, NaiveDate};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::State;
use tokio::sync::Mutex;

mod adjustments;
mod archive_join;
mod listing;
mod span;
mod symbol_chain;

use adjustments::with_dividends;
use archive_join::joined_daily;
use span::Span;
use symbol_chain::chained_aggs;

/// Process-memory cache of assembled daily series. The Tauri backend process
/// outlives a front-end reload (Ctrl+R), so a ticker loaded once this session
/// re-displays instantly instead of re-reading ~1254 per-day cache files from
/// disk. Keyed by (full symbol, days); rebuilt once per UTC day so new
/// closed bars and today's bar are picked up — today's still-forming bar is
/// corrected live by the poller, so a slightly stale snapshot here is harmless.
/// The series is split-adjusted; the dividend adjustment is applied on a copy.
static DAILY_MEM: DayMemo<(String, u32), Vec<Candle>> = OnceLock::new();

/// Daily sessions the dividend factors are computed from: the window of the
/// daily chart, so the series is the memoised one.
const DIVIDEND_BASIS_DAYS: u32 = 7560;

/// Settings > Service > "Clear cache": the market-data disk cache and the
/// in-memory series and memos.
#[tauri::command]
#[specta::specta]
pub async fn clear_cache() -> Result<(), String> {
    if let Some(m) = DAILY_MEM.get() {
        m.lock().await.clear();
    }
    crate::data::daily_archive::clear_memo().await;
    crate::data::massive_rest::clear_market_data_cache().await
}

/// The symbol's trading calendar (its session: weekdays, holidays, zone).
async fn calendar_of(provider: &Provider, sym: &SymbolRef) -> Result<SessionCalendar, String> {
    let session = provider.symbol_session(sym).await.map_err(|e| e.to_string())?;
    Ok(SessionCalendar::new(&session))
}

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

/// Midnight UTC of a date, as seconds.
fn midnight(d: NaiveDate) -> Option<f64> {
    d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp() as f64)
}

/// The UTC date of a time in seconds (the date itself for [`midnight`]).
fn day_of(sec: f64) -> Option<NaiveDate> {
    chrono::DateTime::from_timestamp(sec as i64, 0).map(|dt| dt.date_naive())
}

/// The split-adjusted daily series of `sym` over its last `days` sessions
/// (see [`joined_daily`]), memoised for the day.
async fn daily_series(provider: &Provider, cal: &SessionCalendar, sym: &SymbolRef, days: u32) -> Result<Arc<Vec<Candle>>, String> {
    let to = cal.window_end();

    // Instant path: same (ticker, days) already assembled today.
    let mem = DAILY_MEM.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((as_of, series)) = mem.lock().await.get(&(sym.full(), days)) {
        if *as_of == to {
            return Ok(series.clone());
        }
    }

    let dates = cal.last_trading_days(days.max(1) as usize);
    let wanted_from = *dates.first().unwrap_or(&to);
    let Some((from, to)) = clamp_to_floor(BarFamily::Day, wanted_from, to).await else {
        return Err(format!("no daily data for {sym} in last {days} days"));
    };

    let (bars, complete) = joined_daily(provider, cal, sym, wanted_from, from, to, true).await?;
    if bars.is_empty() {
        return Err(format!("no daily data for {sym} in last {days} days"));
    }
    let bars = Arc::new(bars);
    if complete {
        mem.lock().await.insert((sym.full(), days), (to, bars.clone()));
    }
    Ok(bars)
}

/// Daily candles of `symbol` over its last `days` sessions. Prices are always
/// split-adjusted; `adjusted` adjusts them for dividends too (here and in
/// every history command below).
#[tauri::command]
#[specta::specta]
pub async fn get_daily_history(
    provider: State<'_, Provider>,
    symbol: String,
    days: u32,
    adjusted: bool,
) -> Result<Vec<Candle>, String> {
    let sym = SymbolRef::parse(&symbol);
    let cal = calendar_of(&provider, &sym).await?;
    let bars = daily_series(&provider, &cal, &sym, days).await?;
    with_dividends(&provider, &cal, &sym, (*bars).clone(), adjusted).await
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
    let sym = SymbolRef::parse(&symbol);
    let cal = calendar_of(&provider, &sym).await?;
    let dates = cal.last_trading_days(days.max(1) as usize);
    let to = cal.window_end();
    let from = *dates.first().unwrap_or(&to);
    let Some((from, to)) = clamp_to_floor(BarFamily::Minute, from, to).await else {
        return Err(format!("no minute data for {sym} in last {days} days"));
    };

    let bars = chained_aggs(&provider, &cal, &sym, Span::Minute(interval_min.max(1)), from, to, true, true)
        .await
        .map_err(|e| e.to_string())?;
    if bars.is_empty() {
        return Err(format!("no minute data for {sym} in last {days} days"));
    }
    with_dividends(&provider, &cal, &sym, bars, adjusted).await
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
    let sym = SymbolRef::parse(&symbol);
    let cal = calendar_of(&provider, &sym).await?;
    let to = cal.window_end();
    // Pad the lookback by a day so a `days = 1` request still spans the
    // most recent full session even before today's bars exist.
    let from = to - Duration::days((days.max(1) as i64) + 1);
    let Some((from, to)) = clamp_to_floor(BarFamily::Second, from, to).await else {
        return Ok(Vec::new());
    };
    let bars = chained_aggs(&provider, &cal, &sym, Span::Second(mult), from, to, true, true)
        .await
        .map_err(|e| e.to_string())?;
    with_dividends(&provider, &cal, &sym, bars, adjusted).await
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
    let sym = SymbolRef::parse(&symbol);
    let bars = provider.second_tail(&sym, mult, since_sec, true).await.map_err(|e| e.to_string())?;
    if !adjusted || bars.is_empty() {
        return Ok(bars);
    }
    let cal = calendar_of(&provider, &sym).await?;
    with_dividends(&provider, &cal, &sym, bars, true).await
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
fn aggregates_before_window(cal: &SessionCalendar, to: NaiveDate, span_days: u32) -> (NaiveDate, NaiveDate) {
    let span = span_days.max(1) as usize;
    let from = *cal.trading_days_before(to, span + 1)
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
    let sym = SymbolRef::parse(&symbol);
    let cal = calendar_of(&provider, &sym).await?;
    // The exchange date of the oldest loaded bar.
    let to = cal
        .date_of(before_sec as i64 - 1)
        .ok_or_else(|| format!("invalid before_sec: {before_sec}"))?;
    let (from, to) = aggregates_before_window(&cal, to, span_days);
    let family = match timespan.as_str() {
        "second" => BarFamily::Second,
        _ => BarFamily::Minute,
    };
    // Older than the key's history floor: exhausted, no request.
    let Some((from, to)) = clamp_to_floor(family, from, to).await else {
        return Ok(Vec::new());
    };

    let span = match timespan.as_str() {
        "second" => Span::Second(mult),
        "minute" => Span::MinuteChunked(mult),
        other => return Err(format!("unsupported timespan for aggregates-before: {other}")),
    };
    let bars = chained_aggs(&provider, &cal, &sym, span, from, to, true, false).await.map_err(|e| e.to_string())?;

    // The day-rounded `to` can echo the boundary bar; keep strictly-older bars.
    let bars = bars.into_iter().filter(|b| b.time < before_sec).collect();
    with_dividends(&provider, &cal, &sym, bars, adjusted).await
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
    let sym = SymbolRef::parse(&symbol);
    let cal = calendar_of(&provider, &sym).await?;
    let end = cal
        .date_of(before_sec as i64 - 1)
        .ok_or_else(|| format!("invalid before_sec: {before_sec}"))?;
    let dates = cal.trading_days_before(end, span_days.max(1) as usize);
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
    // Same series as the initial load: the days before the company took the
    // symbol are read under its earlier symbol.
    let bars = chained_aggs(&provider, &cal, &sym, Span::Day, from, end, true, false).await.map_err(|e| e.to_string())?;
    let bars = bars.into_iter().filter(|b| b.time < before_sec).collect();
    with_dividends(&provider, &cal, &sym, bars, adjusted).await
}

#[cfg(test)]
mod tests;
