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

/// Process-memory cache of assembled daily series. The Tauri backend process
/// outlives a front-end reload (Ctrl+R), so a ticker loaded once this session
/// re-displays instantly instead of re-reading ~1254 per-day cache files from
/// disk. Keyed by (full symbol, days, adjusted); rebuilt once per UTC day so new
/// closed bars and today's bar are picked up — today's still-forming bar is
/// corrected live by the poller, so a slightly stale snapshot here is harmless.
static DAILY_MEM: DayMemo<(String, u32, bool), Vec<Candle>> = OnceLock::new();

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

/// Longest stretch without a bar inside one listing. A ticker symbol can be
/// used again by another company years later (one archive file holds both), so
/// archived bars beyond a longer hole are another listing and are left out.
const ARCHIVE_MAX_HOLE_SECS: f64 = 366.0 * 86_400.0;

/// `bars` with the archived sessions older than its first bar in front.
/// Archived bars are kept from `from_sec` on, strictly before the first bar of
/// `bars` (inside its window the live source wins), and only back to the first
/// hole longer than [`ARCHIVE_MAX_HOLE_SECS`] or to the start of the current
/// listing (`listed_sec`), whichever comes first. A listing date later than
/// the first live bar is not a start of this series (the live source itself
/// has older bars) and is ignored. Both inputs oldest first.
fn prepend_archive(bars: Vec<Candle>, archive: Vec<Candle>, from_sec: f64, listed_sec: Option<f64>) -> Vec<Candle> {
    let Some(first) = bars.first().map(|b| b.time) else {
        return bars;
    };
    let from_sec = match listed_sec {
        Some(listed) if listed <= first => from_sec.max(listed),
        _ => from_sec,
    };
    let mut next = first;
    let mut older: Vec<Candle> = Vec::new();
    for bar in archive.into_iter().rev() {
        if bar.time >= first {
            continue;
        }
        if bar.time < from_sec || next - bar.time > ARCHIVE_MAX_HOLE_SECS {
            break;
        }
        next = bar.time;
        older.push(bar);
    }
    older.reverse();
    older.extend(bars);
    older
}

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
    let to = cal.window_end();

    // Instant path: same (ticker, days, adjusted) already assembled today.
    let mem = DAILY_MEM.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((as_of, series)) = mem.lock().await.get(&(sym.full(), days, adjusted)) {
        if *as_of == to {
            return Ok((**series).clone());
        }
    }

    let dates = cal.last_trading_days(days.max(1) as usize);
    let wanted_from = *dates.first().unwrap_or(&to);
    let Some((from, to)) = clamp_to_floor(BarFamily::Day, wanted_from, to).await else {
        return Err(format!("no daily data for {sym} in last {days} days"));
    };

    // One REST call returns the whole daily series (split-adjusted when
    // `adjusted`); closed sessions are then served from the per-day disk cache
    // on later loads. The sessions older than that series come from the daily
    // archive, read at the same time.
    let (bars, archive, listed) = tokio::join!(
        provider.daily_aggs(&sym, from, to, adjusted),
        provider.daily_archive(&sym, adjusted),
        provider.listing_date(&sym),
    );
    let bars = bars.map_err(|e| e.to_string())?;
    if bars.is_empty() {
        return Err(format!("no daily data for {sym} in last {days} days"));
    }
    // A failed archive read leaves the chart on the recent series, as without
    // an archive, and is not memoised so the next load reads it again.
    let (bars, complete) = match archive {
        Ok(archive) => {
            let midnight = |d: NaiveDate| d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp() as f64);
            let from_sec = midnight(wanted_from).unwrap_or(0.0);
            (prepend_archive(bars, archive, from_sec, listed.and_then(midnight)), true)
        }
        Err(e) => {
            eprintln!("[history] {sym}: daily archive not loaded: {e:#}");
            (bars, false)
        }
    };
    if complete {
        mem.lock()
            .await
            .insert((sym.full(), days, adjusted), (to, Arc::new(bars.clone())));
    }
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
    let sym = SymbolRef::parse(&symbol);
    let cal = calendar_of(&provider, &sym).await?;
    let dates = cal.last_trading_days(days.max(1) as usize);
    let to = cal.window_end();
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
    let sym = SymbolRef::parse(&symbol);
    let to = calendar_of(&provider, &sym).await?.window_end();
    // Pad the lookback by a day so a `days = 1` request still spans the
    // most recent full session even before today's bars exist.
    let from = to - Duration::days((days.max(1) as i64) + 1);
    let Some((from, to)) = clamp_to_floor(BarFamily::Second, from, to).await else {
        return Ok(Vec::new());
    };
    provider
        .second_aggs(&sym, mult, from, to, adjusted)
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
        .second_tail(&SymbolRef::parse(&symbol), mult, since_sec, adjusted)
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
fn aggregates_before_window(cal: &SessionCalendar, to: NaiveDate, span_days: u32) -> (NaiveDate, NaiveDate) {
    let span = span_days.max(1) as usize;
    let from = *cal.trading_days_before(to, span + 1)
        .first()
        .unwrap_or(&to);
    (from, to)
}

/// Trading days per minute-family request. Massive reads at most 50 000 base
/// minutes per request and drops the OLDEST ones beyond that; 50 full extended
/// sessions (16 h = 960 minutes each) stay under it, so a chunk is never cut.
const MINUTE_CHUNK_DAYS: usize = 50;
/// Chunk requests in flight at once.
const CHUNK_CONCURRENCY: usize = 6;

/// Minute bars over `[from, to]`, split into [`MINUTE_CHUNK_DAYS`] windows
/// fetched concurrently, so a long window (a time-sync or go-to target months
/// back) comes back complete in about one request's time instead of cut at
/// 50 000 minutes. Chunks are calendar-contiguous; bars come back oldest-first.
async fn minute_aggs_chunked(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    mult: u32,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> anyhow::Result<Vec<Candle>> {
    use futures_util::stream::{self, StreamExt, TryStreamExt};
    let days = cal.trading_days_in_range(from, to);
    if days.len() <= MINUTE_CHUNK_DAYS {
        return provider.minute_aggs(sym, mult, from, to, adjusted).await;
    }
    let mut windows = Vec::new();
    let mut start = from;
    for chunk in days.chunks(MINUTE_CHUNK_DAYS) {
        let last = *chunk.last().unwrap_or(&to);
        let end = if last >= to || chunk.len() < MINUTE_CHUNK_DAYS { to } else { last };
        windows.push((start, end));
        start = end + Duration::days(1);
    }
    let pages: Vec<Vec<Candle>> = stream::iter(windows)
        .map(|(a, b)| provider.minute_aggs(sym, mult, a, b, adjusted))
        .buffered(CHUNK_CONCURRENCY)
        .try_collect()
        .await?;
    Ok(pages.into_iter().flatten().collect())
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

    let bars = match timespan.as_str() {
        "second" => provider.second_aggs(&sym, mult, from, to, adjusted).await,
        "minute" => minute_aggs_chunked(&provider, &cal, &sym, mult, from, to, adjusted).await,
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
    let bars = provider
        .daily_aggs(&sym, from, end, adjusted)
        .await
        .map_err(|e| e.to_string())?;
    Ok(bars.into_iter().filter(|b| b.time < before_sec).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::provider::{HistoryProvider, MassiveProvider, ReferenceProvider};

    /// The US equities calendar the current provider reports.
    fn us() -> SessionCalendar {
        let session = tauri::async_runtime::block_on(MassiveProvider.symbol_session(&SymbolRef::parse("NASDAQ:AAPL"))).unwrap();
        SessionCalendar::new(&session)
    }

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
        assert_eq!(aggregates_before_window(&us(), mon, 1), (fri, mon));
        // span_days = 2 (10S/15S) reaches one more session back (Thursday the 8th).
        let thu = NaiveDate::from_ymd_opt(2025, 5, 8).unwrap();
        assert_eq!(aggregates_before_window(&us(), mon, 2), (thu, mon));
    }

    fn bar(day: i64) -> Candle {
        Candle { time: (day * 86_400) as f64, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1.0 }
    }

    fn days(bars: &[Candle]) -> Vec<i64> {
        bars.iter().map(|b| b.time as i64 / 86_400).collect()
    }

    /// Archived sessions go in front of the first live bar; the ones the live
    /// series already covers are dropped.
    #[test]
    fn archive_is_joined_before_the_first_live_bar() {
        let joined = prepend_archive(vec![bar(1003), bar(1004)], (1000..=1004).map(bar).collect(), 0.0, None);
        assert_eq!(days(&joined), vec![1000, 1001, 1002, 1003, 1004]);
    }

    /// A reused symbol: the bars of the earlier listing sit behind a hole of
    /// several years, in the archive or between the archive and the live bars.
    #[test]
    fn archive_stops_at_a_long_hole() {
        let archive: Vec<Candle> = [100, 101, 102, 2000, 2001].into_iter().map(bar).collect();
        assert_eq!(days(&prepend_archive(vec![bar(2002)], archive.clone(), 0.0, None)), vec![2000, 2001, 2002]);
        assert_eq!(days(&prepend_archive(vec![bar(5000)], archive, 0.0, None)), vec![5000]);
    }

    /// Bars before the requested start are left out; no archive or no live
    /// bars changes nothing.
    #[test]
    fn archive_respects_the_requested_start() {
        let archive: Vec<Candle> = (1000..=1002).map(bar).collect();
        let from = (1001 * 86_400) as f64;
        assert_eq!(days(&prepend_archive(vec![bar(1003)], archive.clone(), from, None)), vec![1001, 1002, 1003]);
        assert_eq!(days(&prepend_archive(vec![bar(1003)], Vec::new(), 0.0, None)), vec![1003]);
        assert!(prepend_archive(Vec::new(), archive, 0.0, None).is_empty());
    }

    /// A symbol used again without a long hole: the bars before the current
    /// listing's start are the earlier company's. A listing date after the
    /// first live bar is no start of this series and changes nothing.
    #[test]
    fn archive_starts_at_the_listing_date() {
        let archive: Vec<Candle> = (1000..=1005).map(bar).collect();
        let day = |d: i64| Some((d * 86_400) as f64);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, day(1003))), vec![1003, 1004, 1005, 1006]);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, day(900))).len(), 7);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive, 0.0, day(1010))).len(), 7);
    }

    /// Mid-week the window is just the prior `span_days` sessions — no surprises.
    #[test]
    fn before_window_midweek() {
        // 2025-05-14 Wed → span 1 reaches Tuesday the 13th.
        let wed = NaiveDate::from_ymd_opt(2025, 5, 14).unwrap();
        let tue = NaiveDate::from_ymd_opt(2025, 5, 13).unwrap();
        assert_eq!(aggregates_before_window(&us(), wed, 1), (tue, wed));
    }

    /// The real join on AAPL (network): the series starts on 10/09/2003, the
    /// archived bars sit on the scale of the adjusted live bars where the two
    /// overlap, and no split date or the join leaves a step. A ticker without
    /// an archive yields no archived bars. Run with:
    ///   cargo test --lib daily_archive_join_live -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the gateway; run explicitly"]
    async fn daily_archive_join_live() {
        let provider = MassiveProvider;
        let sym = SymbolRef::parse("NASDAQ:AAPL");
        let cal = SessionCalendar::new(&provider.symbol_session(&sym).await.unwrap());
        let to = cal.window_end();
        let from = clamp_to_floor(BarFamily::Day, *cal.last_trading_days(7560).first().unwrap(), to)
            .await
            .unwrap()
            .0;
        let live = provider.daily_aggs(&sym, from, to, true).await.unwrap();
        let t0 = std::time::Instant::now();
        let archive = provider.daily_archive(&sym, true).await.unwrap();
        let cold_ms = t0.elapsed().as_millis();
        let t1 = std::time::Instant::now();
        provider.daily_archive(&sym, true).await.unwrap();
        eprintln!("archive: {} bars, first read {cold_ms} ms, memo {} us", archive.len(), t1.elapsed().as_micros());

        // Overlap: archived bars of sessions the live series also has.
        let by_time: HashMap<i64, &Candle> = live.iter().map(|b| (b.time as i64, b)).collect();
        let (mut common, mut worst, mut off) = (0, 0.0_f64, 0);
        for a in &archive {
            if let Some(l) = by_time.get(&(a.time as i64)) {
                common += 1;
                let diff = (a.close / l.close - 1.0).abs();
                worst = worst.max(diff);
                if diff > 0.005 {
                    off += 1;
                }
            }
        }
        eprintln!("overlap: {common} sessions, closes off by more than 0.5%: {off}, worst {:.4}%", worst * 100.0);
        assert!(common > 1000 && off == 0);

        let joined = prepend_archive(live.clone(), archive, 0.0, None);
        let first = joined.first().unwrap();
        eprintln!(
            "joined: {} bars ({} live from {:?}), first {:?} close {:.4} volume {:.0}",
            joined.len(), live.len(), cal.date_of(live[0].time as i64), cal.date_of(first.time as i64), first.close, first.volume,
        );
        assert_eq!(cal.date_of(first.time as i64), NaiveDate::from_ymd_opt(2003, 9, 10));
        assert!(joined.windows(2).all(|w| w[0].time < w[1].time), "times not strictly ascending");
        // Largest close-to-close move: a missed split would show as 50% or more.
        let (mut big, mut at) = (0.0_f64, 0.0);
        for w in joined.windows(2) {
            let m = (w[1].close / w[0].close - 1.0).abs();
            if m > big {
                (big, at) = (m, w[1].time);
            }
        }
        eprintln!("largest daily close move: {:.2}% on {:?}", big * 100.0, cal.date_of(at as i64));
        assert!(big < 0.35);
        for (y, m, d) in [(2005, 2, 28), (2014, 6, 9), (2020, 8, 31)] {
            let day = NaiveDate::from_ymd_opt(y, m, d);
            let i = joined.iter().position(|b| cal.date_of(b.time as i64) == day).unwrap();
            eprintln!("split {day:?}: close before {:.4}, on the day {:.4}", joined[i - 1].close, joined[i].close);
        }
        let join = joined.iter().position(|b| b.time == live[0].time).unwrap();
        eprintln!("join: {:.4} -> {:.4}", joined[join - 1].close, joined[join].close);

        let raw = provider.daily_archive(&sym, false).await.unwrap();
        assert_eq!((raw[0].close, raw[0].volume), (22.18, 3_957_751.0));
        let none = provider.daily_archive(&SymbolRef::parse("ZZZZQQ"), true).await.unwrap();
        assert!(none.is_empty());
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
        let cal = us();
        let to = cal.window_end();
        let from = *cal.last_trading_days(252).first().unwrap_or(&to);

        for sym in ["AMD", "NVDA", "TSLA"] {
            let t0 = std::time::Instant::now();
            let bars = provider
                .daily_aggs(&SymbolRef::parse(sym), from, to, true)
                .await
                .unwrap_or_else(|e| panic!("{sym} daily load failed: {e}"));
            let cold_ms = t0.elapsed().as_millis();
            assert!(!bars.is_empty(), "{sym} returned ZERO bars");
            let last = bars.last().unwrap();

            let t1 = std::time::Instant::now();
            let warm = provider.daily_aggs(&SymbolRef::parse(sym), from, to, true).await.unwrap();
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
