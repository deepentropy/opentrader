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
use crate::data::provider::{entitlements, DataProvider, Provider, SymbolChange};
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

/// What the provider knows of the company now behind a symbol, as times
/// (midnight UTC seconds of the dates): where its bars start in an archive
/// that holds every company that ever used the symbol.
#[derive(Debug, Default, PartialEq)]
struct Listing {
    /// Start of the current listing, from the reference data.
    listed_sec: Option<f64>,
    /// Dates the company took this very symbol.
    held_since: Vec<f64>,
    /// Date the company moved to this symbol from another one: its older
    /// bars are under that other symbol.
    taken_sec: Option<f64>,
    /// That other symbol.
    taken_from: Option<String>,
}

impl Listing {
    /// From the listing date and the company's symbol history (newest
    /// first). The history's dates are not listing dates (a lone entry can
    /// be years after the first bar), so one is a start only when the
    /// company came from another symbol.
    fn new(ticker: &str, listed: Option<NaiveDate>, changes: &[SymbolChange]) -> Self {
        let midnight = |d: NaiveDate| d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp() as f64);
        let held_since: Vec<f64> = changes.iter().filter(|c| c.ticker == ticker).filter_map(|c| midnight(c.date)).collect();
        // Oldest entry with this symbol, when an entry with another symbol precedes it.
        let taken = changes.iter().rposition(|c| c.ticker == ticker).filter(|&i| i + 1 < changes.len());
        Self {
            listed_sec: listed.and_then(midnight),
            held_since,
            taken_sec: taken.and_then(|i| midnight(changes[i].date)),
            taken_from: taken.map(|i| changes[i + 1].ticker.clone()),
        }
    }
}

/// Days before a symbol change in which the earlier symbol must have traded
/// for the change to count as the start of the company's bars.
const TAKEN_PROOF_SECS: f64 = 45.0 * 86_400.0;

/// The listing facts of `sym` from the provider. A move from another symbol
/// is kept only when that symbol's own archive has bars just before the date:
/// the history can name an earlier spelling of the same symbol on a date the
/// company already traded under the current one (its bars are then here, and
/// cutting them would lose real history).
async fn listing_of<P: DataProvider + ?Sized>(provider: &P, sym: &SymbolRef) -> Listing {
    let (listed, changes) = tokio::join!(provider.listing_date(sym), provider.symbol_changes(sym));
    let mut listing = Listing::new(&sym.ticker, listed, &changes.unwrap_or_default());
    if let (Some(taken), Some(from)) = (listing.taken_sec, listing.taken_from.clone()) {
        let earlier = SymbolRef { exchange: sym.exchange.clone(), ticker: from };
        let proven = provider
            .daily_archive(&earlier, false)
            .await
            .is_ok_and(|bars| bars.iter().any(|b| b.time < taken && b.time >= taken - TAKEN_PROOF_SECS));
        if !proven {
            listing.taken_sec = None;
        }
    }
    listing
}

/// `bars` with the archived sessions older than its first bar in front.
/// Archived bars are kept from `from_sec` on, strictly before the first bar of
/// `bars` (inside its window the live source wins), and back to where the
/// current company starts:
///   - the date it took the symbol from another one (`taken_sec`); the live
///     bars before that date are another company's too and are dropped;
///   - the start of its listing (`listed_sec`), unless that date is later
///     than the first live bar (the live source itself has older bars, so
///     it is no start of this series);
///   - the first hole longer than [`ARCHIVE_MAX_HOLE_SECS`], unless the
///     company already held the symbol before the hole (`held_since`: a
///     company delisted and listed again under its symbol).
/// Both inputs oldest first.
fn prepend_archive(mut bars: Vec<Candle>, archive: Vec<Candle>, from_sec: f64, listing: &Listing) -> Vec<Candle> {
    if let Some(taken) = listing.taken_sec {
        // Never down to nothing: a date after every bar is not a start.
        if bars.last().is_some_and(|b| b.time >= taken) {
            bars.retain(|b| b.time >= taken);
        }
    }
    let Some(first) = bars.first().map(|b| b.time) else {
        return bars;
    };
    let mut from_sec = from_sec;
    if let Some(listed) = listing.listed_sec.filter(|l| *l <= first) {
        from_sec = from_sec.max(listed);
    }
    if let Some(taken) = listing.taken_sec {
        from_sec = from_sec.max(taken);
    }
    let mut next = first;
    let mut older: Vec<Candle> = Vec::new();
    for bar in archive.into_iter().rev() {
        if bar.time >= first {
            continue;
        }
        let hole = next - bar.time > ARCHIVE_MAX_HOLE_SECS;
        if bar.time < from_sec || (hole && !listing.held_since.iter().any(|held| *held <= bar.time)) {
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
    let (bars, archive, listing) = tokio::join!(
        provider.daily_aggs(&sym, from, to, adjusted),
        provider.daily_archive(&sym, adjusted),
        listing_of(provider.inner().as_ref(), &sym),
    );
    let bars = bars.map_err(|e| e.to_string())?;
    if bars.is_empty() {
        return Err(format!("no daily data for {sym} in last {days} days"));
    }
    // A failed archive read leaves the chart on the recent series, as without
    // an archive, and is not memoised so the next load reads it again.
    let (bars, complete) = match archive {
        Ok(archive) => {
            let from_sec = wanted_from.and_hms_opt(0, 0, 0).map_or(0.0, |dt| dt.and_utc().timestamp() as f64);
            (prepend_archive(bars, archive, from_sec, &listing), true)
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
    let (bars, listing) =
        tokio::join!(provider.daily_aggs(&sym, from, end, adjusted), listing_of(provider.inner().as_ref(), &sym));
    let bars = bars.map_err(|e| e.to_string())?;
    // Same start as the initial load: bars from before the company took the
    // symbol are another company's.
    let start = listing.taken_sec.unwrap_or(f64::MIN);
    Ok(bars.into_iter().filter(|b| b.time < before_sec && b.time >= start).collect())
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
        let joined = prepend_archive(vec![bar(1003), bar(1004)], (1000..=1004).map(bar).collect(), 0.0, &Listing::default());
        assert_eq!(days(&joined), vec![1000, 1001, 1002, 1003, 1004]);
    }

    /// A reused symbol: the bars of the earlier listing sit behind a hole of
    /// several years, in the archive or between the archive and the live bars.
    #[test]
    fn archive_stops_at_a_long_hole() {
        let archive: Vec<Candle> = [100, 101, 102, 2000, 2001].into_iter().map(bar).collect();
        assert_eq!(days(&prepend_archive(vec![bar(2002)], archive.clone(), 0.0, &Listing::default())), vec![2000, 2001, 2002]);
        assert_eq!(days(&prepend_archive(vec![bar(5000)], archive, 0.0, &Listing::default())), vec![5000]);
    }

    /// Bars before the requested start are left out; no archive or no live
    /// bars changes nothing.
    #[test]
    fn archive_respects_the_requested_start() {
        let archive: Vec<Candle> = (1000..=1002).map(bar).collect();
        let from = (1001 * 86_400) as f64;
        assert_eq!(days(&prepend_archive(vec![bar(1003)], archive.clone(), from, &Listing::default())), vec![1001, 1002, 1003]);
        assert_eq!(days(&prepend_archive(vec![bar(1003)], Vec::new(), 0.0, &Listing::default())), vec![1003]);
        assert!(prepend_archive(Vec::new(), archive, 0.0, &Listing::default()).is_empty());
    }

    /// A symbol used again without a long hole: the bars before the current
    /// listing's start are the earlier company's. A listing date after the
    /// first live bar is no start of this series and changes nothing.
    #[test]
    fn archive_starts_at_the_listing_date() {
        let archive: Vec<Candle> = (1000..=1005).map(bar).collect();
        let listed = |d: i64| Listing { listed_sec: Some((d * 86_400) as f64), ..Listing::default() };
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listed(1003))), vec![1003, 1004, 1005, 1006]);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listed(900))).len(), 7);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive, 0.0, &listed(1010))).len(), 7);
    }

    fn date(day: i64) -> NaiveDate {
        chrono::DateTime::from_timestamp(day * 86_400, 0).unwrap().date_naive()
    }

    fn change(day: i64, ticker: &str) -> SymbolChange {
        SymbolChange { date: date(day), ticker: ticker.into() }
    }

    /// A company delisted for more than a year and listed again under its
    /// symbol: it held the symbol before the hole, so the hole is no cut. A
    /// hole before the company took the symbol still is.
    #[test]
    fn archive_keeps_a_relisted_company_across_the_hole() {
        let archive: Vec<Candle> = [100, 101, 1000, 1001, 2000, 2001].into_iter().map(bar).collect();
        // TLF shape: the symbol since day 900, another symbol in between.
        let listing = Listing::new("TLF", None, &[change(1500, "TLFA"), change(900, "TLF")]);
        assert_eq!(listing.taken_sec, None);
        assert_eq!(days(&prepend_archive(vec![bar(2002)], archive.clone(), 0.0, &listing)), vec![1000, 1001, 2000, 2001, 2002]);
        // GHC shape: the only entry is the end of the hole.
        let listing = Listing::new("GHC", None, &[change(2000, "GHC")]);
        assert_eq!(days(&prepend_archive(vec![bar(2002)], archive, 0.0, &listing)), vec![2000, 2001, 2002]);
    }

    /// A company that moved to the symbol from another one: the bars before
    /// that date are another company's, with or without a hole. A lone
    /// entry is no start (its date can be years after the first bar).
    #[test]
    fn archive_starts_where_the_company_took_the_symbol() {
        let archive: Vec<Candle> = (1000..=1005).map(bar).collect();
        // WEX shape: WXS, then WEX on day 1003.
        let listing = Listing::new("WEX", Some(date(950)), &[change(1003, "WEX"), change(990, "WXS")]);
        assert_eq!((listing.taken_sec, listing.taken_from.as_deref()), (Some((1003 * 86_400) as f64), Some("WXS")));
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listing)), vec![1003, 1004, 1005, 1006]);
        // META shape: the symbol taken inside the live window; the live bars
        // before that date go too.
        let live: Vec<Candle> = (1006..=1009).map(bar).collect();
        let listing = Listing::new("META", None, &[change(1008, "META"), change(900, "FB")]);
        assert_eq!(days(&prepend_archive(live, archive.clone(), 0.0, &listing)), vec![1008, 1009]);
        // GSL shape: one entry, later than the first bar.
        let listing = Listing::new("GSL", None, &[change(1004, "GSL")]);
        assert_eq!(listing.taken_sec, None);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listing)).len(), 7);
        // Back to a symbol it held before: the first time counts.
        let listing = Listing::new("ABC", None, &[change(1004, "ABC"), change(1002, "XYZ"), change(900, "ABC")]);
        assert_eq!(listing.taken_sec, None);
        // Entries under other symbols only (GOOGL has `GOOG`): nothing known.
        assert_eq!(Listing::new("GOOGL", None, &[change(1004, "GOOG")]), Listing::default());
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive, 0.0, &Listing::default())).len(), 7);
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

        let joined = prepend_archive(live.clone(), archive, 0.0, &Listing::default());
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

    /// Where the daily series of each ticker of `OT_TICKERS` (comma list,
    /// source spelling) starts, with the listing date alone and with the
    /// symbol history (network). Prints the tickers whose start differs. Run with:
    ///   OT_TICKERS=TLF,WEX,GHC cargo test --lib archive_start_live -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the gateway; run explicitly"]
    async fn archive_start_live() {
        use crate::data::{daily_archive, massive_rest, ticker_case};
        use futures_util::stream::{self, StreamExt};
        let tickers: Vec<String> =
            std::env::var("OT_TICKERS").unwrap_or_else(|_| "TLF,WEX,GHC,META,GSL,AAPL".into()).split(',').map(str::to_string).collect();
        let to = crate::data::trading_calendar::ny_today();
        let from = clamp_to_floor(BarFamily::Day, to - Duration::days(30 * 366), to).await.unwrap().0;
        let day = |sec: f64| chrono::DateTime::from_timestamp(sec as i64, 0).unwrap().date_naive();
        let rows: Vec<String> = stream::iter(tickers)
            .map(|t| async move {
                let live = massive_rest::fetch_daily_aggs(&t, from, to, true).await.unwrap_or_default();
                let archive = daily_archive::daily_bars(&t, true).await.unwrap_or_default();
                if live.is_empty() || archive.is_empty() {
                    return format!("{t},,,,no live bars or no archive");
                }
                let sym = SymbolRef::parse(&ticker_case::to_app(&t));
                let listed = MassiveProvider.listing_date(&sym).await;
                let Some(changes) = MassiveProvider.symbol_changes(&sym).await else {
                    return format!("{t},,,,symbol history not read");
                };
                let listing = listing_of(&MassiveProvider, &sym).await;
                let before = prepend_archive(live.clone(), archive.clone(), 0.0, &Listing::new(&sym.ticker, listed, &[]));
                let after = prepend_archive(live.clone(), archive, 0.0, &listing);
                let dropped = if listing.taken_from.is_some() && listing.taken_sec.is_none() { " (move not proven, ignored)" } else { "" };
                let history = changes.iter().map(|c| format!("{} {}", c.ticker, c.date)).collect::<Vec<_>>().join(" < ") + dropped;
                format!("{t},{},{},{},{history}", day(before[0].time), day(after[0].time), day(live[0].time))
            })
            .buffered(8)
            .collect()
            .await;
        let mut changed = 0;
        for r in &rows {
            let f: Vec<&str> = r.splitn(5, ',').collect();
            if f[1] != f[2] {
                changed += 1;
                eprintln!("CHANGED {r}");
            }
        }
        eprintln!("{} tickers, start changed for {changed}", rows.len());
        if let Ok(out) = std::env::var("OT_OUT") {
            std::fs::write(out, format!("ticker,start_listing_date_only,start_with_symbol_history,first_live_bar,symbol_history
{}
", rows.join("
"))).unwrap();
        }
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
