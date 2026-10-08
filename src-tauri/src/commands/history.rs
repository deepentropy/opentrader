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
use crate::data::types::{Candle, SplitEvent};
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
    /// The symbols it traded under before that date, newest first.
    earlier: Vec<Segment>,
    /// The other symbols it traded under after it first held this one, before
    /// it came back to it, newest first: this symbol has no bar there.
    between: Vec<Segment>,
}

/// Another symbol of a company and the stretch of that symbol's bars that
/// is the company's (the symbol can be used by others before and after).
#[derive(Debug, Clone, PartialEq)]
struct Segment {
    ticker: String,
    /// Start of the stretch, `f64::MIN` when not known.
    start_sec: f64,
    /// Date the company left the symbol (not part of the stretch),
    /// `f64::MAX` when not known.
    end_sec: f64,
}

/// Midnight UTC of a date, as seconds.
fn midnight(d: NaiveDate) -> Option<f64> {
    d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp() as f64)
}

/// The UTC date of a time in seconds (the date itself for [`midnight`]).
fn day_of(sec: f64) -> Option<NaiveDate> {
    chrono::DateTime::from_timestamp(sec as i64, 0).map(|dt| dt.date_naive())
}

impl Listing {
    /// From the listing date and the company's symbol history (newest
    /// first). The history's dates are not listing dates (a lone entry can
    /// be years after the first bar), so one is a start only when the
    /// company came from another symbol.
    fn new(ticker: &str, listed: Option<NaiveDate>, changes: &[SymbolChange]) -> Self {
        let held_since: Vec<f64> = changes.iter().filter(|c| c.ticker == ticker).filter_map(|c| midnight(c.date)).collect();
        // Oldest entry with this symbol, when an entry with another symbol precedes it.
        let taken = changes.iter().rposition(|c| c.ticker == ticker).filter(|&i| i + 1 < changes.len());
        // Each older entry: that symbol, from its date to the next entry's.
        let earlier = taken.map_or_else(Vec::new, |i| {
            (i + 1..changes.len())
                .filter_map(|j| {
                    Some(Segment {
                        ticker: changes[j].ticker.clone(),
                        start_sec: midnight(changes[j].date)?,
                        end_sec: midnight(changes[j - 1].date)?,
                    })
                })
                .collect()
        });
        // Each entry with another symbol that is newer than the oldest one
        // with this symbol. The history has no entry for a return to a
        // symbol, so the newest stretch has no end date.
        let between = changes.iter().rposition(|c| c.ticker == ticker).map_or_else(Vec::new, |i| {
            (0..i)
                .filter(|&j| changes[j].ticker != ticker)
                .filter_map(|j| {
                    Some(Segment {
                        ticker: changes[j].ticker.clone(),
                        start_sec: midnight(changes[j].date)?,
                        end_sec: if j > 0 { midnight(changes[j - 1].date)? } else { f64::MAX },
                    })
                })
                .collect()
        });
        Self {
            listed_sec: listed.and_then(midnight),
            held_since,
            taken_sec: taken.and_then(|i| midnight(changes[i].date)),
            earlier,
            between,
        }
    }
}

/// Days before a symbol change in which the earlier symbol must have traded
/// for the change to count as the start of the company's bars.
const TAKEN_PROOF_SECS: f64 = 45.0 * 86_400.0;

/// Where the stretch of bars that ends before `end_sec` starts: the oldest
/// bar reached going back without a hole longer than
/// [`ARCHIVE_MAX_HOLE_SECS`] (`end_sec` when no bar precedes it). `bars`
/// oldest first.
fn stretch_start(bars: &[Candle], end_sec: f64) -> f64 {
    let mut start = end_sec;
    for bar in bars.iter().rev().filter(|b| b.time < end_sec) {
        if start - bar.time > ARCHIVE_MAX_HOLE_SECS {
            break;
        }
        start = bar.time;
    }
    start
}

/// The listing facts of `sym` from the provider. A move from another symbol
/// is kept only when that symbol's own archive has bars just before the date:
/// the history can name an earlier spelling of the same symbol on a date the
/// company already traded under the current one (its bars are then here, and
/// cutting them would lose real history). The chain of earlier symbols stops
/// at the first move that is not proven; the oldest symbol kept starts where
/// its bars do (the date of its entry is not a listing date). The symbols
/// used in between are checked one by one (see [`proven_between`]).
async fn listing_of<P: DataProvider + ?Sized>(provider: &P, sym: &SymbolRef) -> Listing {
    let (listed, changes) = tokio::join!(provider.listing_date(sym), provider.symbol_changes(sym));
    let mut listing = Listing::new(&sym.ticker, listed, &changes.unwrap_or_default());
    let (mut proven, mut oldest_start) = (0, f64::MIN);
    for segment in &listing.earlier {
        let earlier = SymbolRef { exchange: sym.exchange.clone(), ticker: segment.ticker.clone() };
        let Ok(bars) = provider.daily_archive(&earlier, false).await else {
            break;
        };
        if !bars.iter().any(|b| b.time < segment.end_sec && b.time >= segment.end_sec - TAKEN_PROOF_SECS) {
            break;
        }
        proven += 1;
        oldest_start = stretch_start(&bars, segment.end_sec);
    }
    listing.earlier.truncate(proven);
    match listing.earlier.last_mut() {
        Some(oldest) => oldest.start_sec = oldest_start,
        None => listing.taken_sec = None,
    }
    listing.between = proven_between(provider, sym, std::mem::take(&mut listing.between)).await;
    listing
}

/// First and last time of the bars inside `[start_sec, end_sec)`.
fn times_inside(bars: &[Candle], start_sec: f64, end_sec: f64) -> Option<(f64, f64)> {
    let mut inside = bars.iter().filter(|b| b.time >= start_sec && b.time < end_sec).map(|b| b.time);
    let first = inside.next()?;
    Some((first, inside.next_back().unwrap_or(first)))
}

/// The stretches of `candidates` (symbols the company used in between) that
/// are proven by the bars. A stretch without an end date ends at the next
/// daily bar of `sym` itself. It is kept when the other symbol has daily bars
/// inside it that meet the bars of `sym` on one side at least: they start
/// within [`TAKEN_PROOF_SECS`] of its last bar before the stretch, or end
/// within that time of its next bar (the company can go without a bar under
/// any symbol at the start of the stretch).
async fn proven_between<P: DataProvider + ?Sized>(provider: &P, sym: &SymbolRef, candidates: Vec<Segment>) -> Vec<Segment> {
    if candidates.is_empty() {
        return candidates;
    }
    let Ok(own) = provider.daily_archive(sym, false).await else {
        return Vec::new();
    };
    // Last date of the recent bars, in the symbol's own calendar (read on
    // the first stretch that needs it).
    let mut window_end: Option<Option<NaiveDate>> = None;
    let mut proven = Vec::new();
    for mut segment in candidates {
        let Some(start) = day_of(segment.start_sec) else {
            continue;
        };
        if segment.end_sec == f64::MAX {
            // The archive is some days behind: a return it does not hold yet
            // is in the recent bars.
            let mut next = own.iter().find(|b| b.time >= segment.start_sec).map(|b| b.time);
            if next.is_none() {
                if window_end.is_none() {
                    window_end = Some(provider.symbol_session(sym).await.ok().map(|s| SessionCalendar::new(&s).window_end()));
                }
                let Some(today) = window_end.flatten() else {
                    continue;
                };
                if let Some((a, b)) = clamp_to_floor(BarFamily::Day, start, today).await {
                    next = provider.daily_aggs(sym, a, b, false).await.ok().and_then(|bars| bars.first().map(|b| b.time));
                }
            }
            let Some(end_sec) = next.and_then(day_of).and_then(midnight) else {
                continue;
            };
            segment.end_sec = end_sec;
        }
        let Some(end) = day_of(segment.end_sec).filter(|end| *end > start) else {
            continue;
        };
        let other = SymbolRef { exchange: sym.exchange.clone(), ticker: segment.ticker.clone() };
        let archived = provider.daily_archive(&other, false).await.unwrap_or_default();
        let mut span = times_inside(&archived, segment.start_sec, segment.end_sec);
        if span.is_none() {
            // No archive for that symbol: its recent bars.
            if let Some((a, b)) = clamp_to_floor(BarFamily::Day, start, end - Duration::days(1)).await {
                let recent = provider.daily_aggs(&other, a, b, false).await.unwrap_or_default();
                span = times_inside(&recent, segment.start_sec, segment.end_sec);
            }
        }
        let Some((first, last)) = span else {
            continue;
        };
        let before = own.iter().rev().find(|b| b.time < segment.start_sec).map(|b| b.time);
        if last >= segment.end_sec - TAKEN_PROOF_SECS || before.is_some_and(|p| first - p <= TAKEN_PROOF_SECS) {
            proven.push(segment);
        }
    }
    proven
}

/// A bar family and its bucket width, for a ranged fetch.
#[derive(Clone, Copy)]
enum Span {
    Day,
    Minute(u32),
    /// Minutes over a window that can exceed one request (see
    /// [`minute_aggs_chunked`]).
    MinuteChunked(u32),
    Second(u32),
}

impl Span {
    fn family(self) -> BarFamily {
        match self {
            Span::Day => BarFamily::Day,
            Span::Minute(_) | Span::MinuteChunked(_) => BarFamily::Minute,
            Span::Second(_) => BarFamily::Second,
        }
    }
}

/// `span` bars of the symbol `sym` itself over `[from, to]`.
async fn span_aggs(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    span: Span,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> anyhow::Result<Vec<Candle>> {
    match span {
        Span::Day => provider.daily_aggs(sym, from, to, adjusted).await,
        Span::Minute(mult) => provider.minute_aggs(sym, mult, from, to, adjusted).await,
        Span::MinuteChunked(mult) => minute_aggs_chunked(provider, cal, sym, mult, from, to, adjusted).await,
        Span::Second(mult) => provider.second_aggs(sym, mult, from, to, adjusted).await,
    }
}

/// Unadjusted `bars` put on the split-adjusted scale: prices times
/// `from / to` of every split executed after the bar's session, volume
/// divided by it.
fn scale_by_splits(bars: &mut [Candle], splits: &[SplitEvent], cal: &SessionCalendar) {
    if splits.is_empty() {
        return;
    }
    for bar in bars {
        let session = cal.date_of(bar.time as i64).and_then(midnight).unwrap_or(bar.time);
        let factor: f64 =
            splits.iter().filter(|s| s.date > session && s.from > 0.0 && s.to > 0.0).map(|s| s.from / s.to).product();
        bar.open *= factor;
        bar.high *= factor;
        bar.low *= factor;
        bar.close *= factor;
        bar.volume /= factor;
    }
}

/// The company's bars over `[from, to]` under its other symbols (`segments`,
/// newest first), oldest first: each symbol is read inside its own stretch
/// only. With `with_archive` (daily bars) the sessions older than the
/// recent source come from that symbol's archive. The bars are read
/// unadjusted and, when `adjusted`, scaled by the splits of `sym`: the
/// current symbol's list is the company's (an earlier symbol's list can be a
/// later user's).
#[allow(clippy::too_many_arguments)]
async fn earlier_bars(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    segments: &[Segment],
    span: Span,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
    with_archive: bool,
) -> anyhow::Result<Vec<Candle>> {
    let mut parts: Vec<Vec<Candle>> = Vec::new();
    for segment in segments {
        let Some(end) = day_of(segment.end_sec) else {
            continue;
        };
        let a = day_of(segment.start_sec).map_or(from, |start| start.max(from));
        let b = to.min(end - Duration::days(1));
        if a > b {
            continue;
        }
        let earlier = SymbolRef { exchange: sym.exchange.clone(), ticker: segment.ticker.clone() };
        let recent = match clamp_to_floor(span.family(), a, b).await {
            Some((a, b)) => span_aggs(provider, cal, &earlier, span, a, b, false).await,
            None => Ok(Vec::new()),
        };
        // The archive reaches the recent sessions too, so with it a failed
        // recent read (a stretch older than the key's history) costs nothing.
        let mut bars = match recent {
            Err(e) if with_archive => {
                eprintln!("[history] {earlier}: recent bars not loaded, archive only: {e:#}");
                Vec::new()
            }
            other => other?,
        };
        if with_archive {
            let first = bars.first().map_or(f64::MAX, |b| b.time);
            let mut older: Vec<Candle> =
                provider.daily_archive(&earlier, false).await?.into_iter().filter(|c| c.time < first).collect();
            older.extend(bars);
            bars = older;
        }
        bars.retain(|c| cal.date_of(c.time as i64).is_some_and(|d| d >= a && d <= b));
        parts.push(bars);
    }
    let mut out: Vec<Candle> = parts.into_iter().rev().flatten().collect();
    if adjusted && !out.is_empty() {
        let splits = provider
            .executed_splits(sym)
            .await
            .ok_or_else(|| anyhow::anyhow!("no split list for {sym}"))?;
        scale_by_splits(&mut out, &splits, cal);
    }
    Ok(out)
}

/// `span` bars of the company behind `sym` over `[from, to]`: the days
/// before it took the symbol are read under its earlier symbols, and the days
/// it used another symbol in between under that one, so a window across a
/// symbol change is one series. `eager` reads the symbol's own bars
/// while the symbol history is looked up (a window that ends now always
/// needs them); otherwise the history comes first and a window entirely
/// before the change costs no request under the current symbol.
#[allow(clippy::too_many_arguments)]
async fn chained_aggs(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    span: Span,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
    eager: bool,
) -> anyhow::Result<Vec<Candle>> {
    let (listing, own) = if eager {
        let (listing, bars) =
            tokio::join!(listing_of(provider.as_ref(), sym), span_aggs(provider, cal, sym, span, from, to, adjusted));
        (listing, Some(bars?))
    } else {
        (listing_of(provider.as_ref(), sym).await, None)
    };
    let bars = match listing.taken_sec.and_then(day_of).filter(|taken| *taken > from) {
        None => match own {
            Some(bars) => bars,
            None => span_aggs(provider, cal, sym, span, from, to, adjusted).await?,
        },
        Some(taken) => {
            let mut bars = earlier_bars(provider, cal, sym, &listing.earlier, span, from, to, adjusted, false).await?;
            match own {
                Some(own) => bars.extend(own.into_iter().filter(|c| cal.date_of(c.time as i64).is_some_and(|d| d >= taken))),
                None if to >= taken => bars.extend(span_aggs(provider, cal, sym, span, taken, to, adjusted).await?),
                None => {}
            }
            bars
        }
    };
    if listing.between.is_empty() {
        return Ok(bars);
    }
    let between = earlier_bars(provider, cal, sym, &listing.between, span, from, to, adjusted, false).await?;
    Ok(merge_between(bars, between))
}

/// `bars` with `between` (the company's bars under a symbol it used in
/// between) at their times (in front of it when the window starts there).
/// Where both have a bar, the one of `bars` stays. Both oldest first.
fn merge_between(mut bars: Vec<Candle>, mut between: Vec<Candle>) -> Vec<Candle> {
    let own: std::collections::HashSet<i64> = bars.iter().map(|b| b.time as i64).collect();
    between.retain(|b| !own.contains(&(b.time as i64)));
    if between.is_empty() {
        return bars;
    }
    bars.extend(between);
    bars.sort_by(|a, b| a.time.total_cmp(&b.time));
    bars
}

/// `bars` with `older` (the company's bars under its earlier symbols) in
/// front, as far as they end before its first bar. Both oldest first.
fn prepend_older(bars: Vec<Candle>, mut older: Vec<Candle>) -> Vec<Candle> {
    if let Some(first) = bars.first().map(|b| b.time) {
        older.retain(|b| b.time < first);
    }
    older.extend(bars);
    older
}

/// `bars` with the archived sessions older than its first bar in front.
/// Archived bars are kept from `from_sec` on, strictly before the first bar of
/// `bars` (inside its window the live source wins), and back to where the
/// current company starts:
///   - the date it took the symbol from another one (`taken_sec`); the live
///     bars before that date are another company's too and are dropped (its
///     own are under the earlier symbol, see [`earlier_bars`]);
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

/// The daily series of the company behind `sym` from `wanted_from` on: the
/// recent source over `[from, to]`, the archive before it, the bars of its
/// earlier symbols in front, and the bars of a symbol it used in between in
/// the hole they left. The flag is false when a part older than
/// the recent series could not be read (the series is then not memoised).
/// Empty when the recent source has no bar.
async fn joined_daily(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    wanted_from: NaiveDate,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> Result<(Vec<Candle>, bool), String> {
    // One REST call returns the whole daily series (split-adjusted when
    // `adjusted`); closed sessions are then served from the per-day disk cache
    // on later loads. The sessions older than that series come from the daily
    // archive, read at the same time. The sessions before a symbol change
    // are the earlier symbol's and go in front of both; the sessions under a
    // symbol used in between go into the hole of the joined series.
    let (bars, archive, listing) = tokio::join!(
        provider.daily_aggs(sym, from, to, adjusted),
        provider.daily_archive(sym, adjusted),
        listing_of(provider.as_ref(), sym),
    );
    let bars = bars.map_err(|e| e.to_string())?;
    if bars.is_empty() {
        return Ok((bars, false));
    }
    // A failed archive read leaves the chart on the recent series, as without
    // an archive, and is not memoised so the next load reads it again.
    Ok(match archive {
        Ok(archive) => {
            let from_sec = wanted_from.and_hms_opt(0, 0, 0).map_or(0.0, |dt| dt.and_utc().timestamp() as f64);
            let mut bars = prepend_archive(bars, archive, from_sec, &listing);
            let mut complete = true;
            if !listing.earlier.is_empty() {
                match earlier_bars(provider, cal, sym, &listing.earlier, Span::Day, wanted_from, to, adjusted, true).await {
                    Ok(older) => bars = prepend_older(bars, older),
                    Err(e) => {
                        eprintln!("[history] {sym}: bars of the earlier symbol not loaded: {e:#}");
                        complete = false;
                    }
                }
            }
            if !listing.between.is_empty() {
                match earlier_bars(provider, cal, sym, &listing.between, Span::Day, wanted_from, to, adjusted, true).await {
                    Ok(between) => bars = merge_between(bars, between),
                    Err(e) => {
                        eprintln!("[history] {sym}: bars of the symbol used in between not loaded: {e:#}");
                        complete = false;
                    }
                }
            }
            (bars, complete)
        }
        Err(e) => {
            eprintln!("[history] {sym}: daily archive not loaded: {e:#}");
            (bars, false)
        }
    })
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

    let (bars, complete) = joined_daily(&provider, &cal, &sym, wanted_from, from, to, adjusted).await?;
    if bars.is_empty() {
        return Err(format!("no daily data for {sym} in last {days} days"));
    }
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

    let bars = chained_aggs(&provider, &cal, &sym, Span::Minute(interval_min.max(1)), from, to, adjusted, true)
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
    let cal = calendar_of(&provider, &sym).await?;
    let to = cal.window_end();
    // Pad the lookback by a day so a `days = 1` request still spans the
    // most recent full session even before today's bars exist.
    let from = to - Duration::days((days.max(1) as i64) + 1);
    let Some((from, to)) = clamp_to_floor(BarFamily::Second, from, to).await else {
        return Ok(Vec::new());
    };
    chained_aggs(&provider, &cal, &sym, Span::Second(mult), from, to, adjusted, true)
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

    let span = match timespan.as_str() {
        "second" => Span::Second(mult),
        "minute" => Span::MinuteChunked(mult),
        other => return Err(format!("unsupported timespan for aggregates-before: {other}")),
    };
    let bars = chained_aggs(&provider, &cal, &sym, span, from, to, adjusted, false).await.map_err(|e| e.to_string())?;

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
    // Same series as the initial load: the days before the company took the
    // symbol are read under its earlier symbol.
    let bars = chained_aggs(&provider, &cal, &sym, Span::Day, from, end, adjusted, false).await.map_err(|e| e.to_string())?;
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

    fn segment(ticker: &str, start: i64, end: i64) -> Segment {
        Segment { ticker: ticker.into(), start_sec: (start * 86_400) as f64, end_sec: (end * 86_400) as f64 }
    }

    /// Every older entry of the symbol history is one earlier symbol, from
    /// its date to the next entry's; none when the company never moved here
    /// from another symbol.
    #[test]
    fn earlier_symbols_follow_the_symbol_history() {
        let listing = Listing::new("C", None, &[change(1200, "C"), change(1100, "B"), change(1000, "A")]);
        assert_eq!(listing.earlier, vec![segment("B", 1100, 1200), segment("A", 1000, 1100)]);
        assert!(Listing::new("GSL", None, &[change(1004, "GSL")]).earlier.is_empty());
        assert!(Listing::new("TLF", None, &[change(1500, "TLFA"), change(900, "TLF")]).earlier.is_empty());
    }

    /// An entry with another symbol that is newer than the oldest entry of
    /// the symbol is a stretch in between: to the next entry, or without an
    /// end when the history does not hold the return.
    #[test]
    fn symbols_in_between_follow_the_symbol_history() {
        let open = |ticker: &str, start: i64| Segment { ticker: ticker.into(), start_sec: (start * 86_400) as f64, end_sec: f64::MAX };
        let listing = Listing::new("FISV", None, &[change(1500, "FI"), change(900, "FISV")]);
        assert_eq!((listing.between, listing.taken_sec), (vec![open("FI", 1500)], None));
        let listing = Listing::new("ABC", None, &[change(1004, "ABC"), change(1002, "XYZ"), change(900, "ABC")]);
        assert_eq!(listing.between, vec![segment("XYZ", 1002, 1004)]);
        let listing = Listing::new("C", None, &[change(1300, "E"), change(1250, "D"), change(1200, "C"), change(1100, "B")]);
        assert_eq!(listing.between, vec![open("E", 1300), segment("D", 1250, 1300)]);
        assert_eq!(listing.earlier, vec![segment("B", 1100, 1200)]);
        assert!(Listing::new("META", None, &[change(1008, "META"), change(900, "FB")]).between.is_empty());
        assert!(Listing::new("GOOGL", None, &[change(1004, "GOOG")]).between.is_empty());
    }

    /// Bars of a symbol used in between go into the hole of the series (in
    /// front of it when the window starts inside the hole), never over one
    /// of its bars.
    #[test]
    fn bars_in_between_fill_the_hole() {
        let series: Vec<Candle> = [1000, 1001, 1005, 1006].into_iter().map(bar).collect();
        let mut other = bar(1001);
        other.close = 9.0;
        let between = vec![bar(999), other, bar(1002), bar(1003), bar(1004)];
        let merged = merge_between(series.clone(), between.clone());
        assert_eq!(days(&merged), vec![999, 1000, 1001, 1002, 1003, 1004, 1005, 1006]);
        assert_eq!(merged[2].close, 1.0);
        assert_eq!(days(&merge_between(series, Vec::new())).len(), 4);
        assert_eq!(days(&merge_between(Vec::new(), between)).len(), 5);
        assert_eq!(times_inside(&merged, (1001 * 86_400) as f64, (1004 * 86_400) as f64), Some(((1001 * 86_400) as f64, (1003 * 86_400) as f64)));
        assert_eq!(times_inside(&merged, (2000 * 86_400) as f64, (2004 * 86_400) as f64), None);
    }

    /// The oldest earlier symbol starts where its own bars do: back from the
    /// change to the first long hole (an earlier user of that symbol).
    #[test]
    fn stretch_starts_after_the_last_long_hole() {
        let bars: Vec<Candle> = [100, 101, 1000, 1001, 1002, 1500].into_iter().map(bar).collect();
        assert_eq!(stretch_start(&bars, (1003 * 86_400) as f64), (1000 * 86_400) as f64);
        assert_eq!(stretch_start(&bars, (102 * 86_400) as f64), (100 * 86_400) as f64);
        assert_eq!(stretch_start(&bars, (50 * 86_400) as f64), (50 * 86_400) as f64);
    }

    /// Earlier-symbol bars go in front of the series and never over it.
    #[test]
    fn older_bars_end_before_the_series() {
        let older: Vec<Candle> = (1000..=1004).map(bar).collect();
        assert_eq!(days(&prepend_older(vec![bar(1003), bar(1005)], older.clone())), vec![1000, 1001, 1002, 1003, 1005]);
        assert_eq!(days(&prepend_older(Vec::new(), older)).len(), 5);
    }

    /// Unadjusted bars are scaled by the splits executed after their session
    /// (the execution day itself trades on the new scale).
    #[test]
    fn earlier_bars_are_scaled_by_later_splits() {
        let cal = us();
        // 16:00 UTC of 16/05 and 17/05/2017, a 2:1 split executed on the 17th.
        let at = |d: u32| NaiveDate::from_ymd_opt(2017, 5, d).unwrap().and_hms_opt(16, 0, 0).unwrap().and_utc().timestamp() as f64;
        let candle = |time: f64| Candle { time, open: 80.0, high: 82.0, low: 78.0, close: 80.0, volume: 100.0 };
        let mut bars = vec![candle(at(16)), candle(at(17))];
        let split = SplitEvent { date: midnight(NaiveDate::from_ymd_opt(2017, 5, 17).unwrap()).unwrap(), from: 1.0, to: 2.0 };
        scale_by_splits(&mut bars, &[split], &cal);
        assert_eq!((bars[0].close, bars[0].high, bars[0].volume), (40.0, 41.0, 200.0));
        assert_eq!((bars[1].close, bars[1].volume), (80.0, 100.0));
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
        assert_eq!(listing.taken_sec, Some((1003 * 86_400) as f64));
        assert_eq!(listing.earlier, vec![segment("WXS", 990, 1003)]);
        assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listing)), vec![1003, 1004, 1005, 1006]);
        // META shape: the symbol taken inside the live window; the live bars
        // before that date go too.
        let live: Vec<Candle> = (1006..=1009).map(bar).collect();
        let listing = Listing::new("META", None, &[change(1008, "META"), change(900, "FB")]);
        let cut = prepend_archive(live, archive.clone(), 0.0, &listing);
        assert_eq!(days(&cut), vec![1008, 1009]);
        // Its own bars under the earlier symbol then go in front.
        assert_eq!(days(&prepend_older(cut, vec![bar(1006), bar(1007)])), vec![1006, 1007, 1008, 1009]);
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
                let named = Listing::new(&sym.ticker, listed, &changes).taken_sec.is_some();
                let dropped = if named && listing.taken_sec.is_none() { " (move not proven, ignored)" } else { "" };
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

    /// The series across a symbol change (network), for each ticker of
    /// `OT_TICKERS`: where the daily series starts, the closes on both sides
    /// of the change, the largest daily close move, and the 5-minute bars of
    /// the 20 sessions around the change (which symbols they come from is
    /// told by the count per side). Run with:
    ///   OT_TICKERS=META,T,WEX cargo test --lib symbol_chain_live -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the gateway; run explicitly"]
    async fn symbol_chain_live() {
        let provider: Provider = Arc::new(MassiveProvider);
        let cal = SessionCalendar::new(&provider.symbol_session(&SymbolRef::parse("NASDAQ:AAPL")).await.unwrap());
        let to = cal.window_end();
        let wanted_from = *cal.last_trading_days(7560).first().unwrap();
        let from = clamp_to_floor(BarFamily::Day, wanted_from, to).await.unwrap().0;
        // No entitlement store in a test: the oldest minute bar is probed.
        let probe = provider.probe_history().await.unwrap();
        let minute_floor = NaiveDate::parse_from_str(&probe.floor.minute.unwrap(), "%Y-%m-%d").unwrap();
        let tickers = std::env::var("OT_TICKERS").unwrap_or_else(|_| "META,T,WEX,BALL,ELV,COR,KELYA,AAPL,TLF,GHC".into());
        let mut rows = vec!["ticker,earlier_symbols,bars,first_bar,first_close,last_before_change,close_before,first_after_change,open_after,largest_close_move_pct,largest_move_date,minute_bars_before,minute_bars_after,complete".to_string()];
        for t in tickers.split(',') {
            let sym = SymbolRef::parse(t);
            let listing = listing_of(provider.as_ref(), &sym).await;
            let (bars, complete) = joined_daily(&provider, &cal, &sym, wanted_from, from, to, true).await.unwrap();
            assert!(bars.windows(2).all(|w| w[0].time < w[1].time), "{t}: times not strictly ascending");
            let day = |b: &Candle| cal.date_of(b.time as i64).unwrap().format("%d/%m/%Y").to_string();
            let (mut big, mut at) = (0.0_f64, String::new());
            for w in bars.windows(2) {
                let m = (w[1].close / w[0].close - 1.0).abs();
                if m > big {
                    (big, at) = (m, day(&w[1]));
                }
            }
            let earlier = listing.earlier.iter().map(|s| format!("{} {:?}..{:?}", s.ticker, day_of(s.start_sec), day_of(s.end_sec))).collect::<Vec<_>>().join(" | ");
            for s in &listing.between {
                let (start, end) = (day_of(s.start_sec).unwrap(), day_of(s.end_sec).unwrap());
                let (i, j) = (bars.iter().position(|b| cal.date_of(b.time as i64).unwrap() >= start).unwrap(), bars.iter().position(|b| cal.date_of(b.time as i64).unwrap() >= end).unwrap());
                eprintln!(
                    "{t}: in between {} {start}..{end}: {} daily bars inside; {} close {:.4} -> {} open {:.4}; {} close {:.4} -> {} open {:.4}",
                    s.ticker, j - i, day(&bars[i - 1]), bars[i - 1].close, day(&bars[i]), bars[i].open, day(&bars[j - 1]), bars[j - 1].close, day(&bars[j]), bars[j].open,
                );
                if end - Duration::days(30) >= minute_floor {
                    let m = chained_aggs(&provider, &cal, &sym, Span::MinuteChunked(5), end - Duration::days(30), end + Duration::days(13), true, false).await.unwrap();
                    assert!(m.windows(2).all(|w| w[0].time < w[1].time), "{t}: minute times not strictly ascending");
                    let n = m.iter().filter(|c| cal.date_of(c.time as i64).unwrap() < end).count();
                    let lows = m.iter().take(n).map(|c| c.low).fold(f64::MAX, f64::min);
                    let highs = m.iter().take(n).map(|c| c.high).fold(f64::MIN, f64::max);
                    eprintln!("{t}: 5-minute bars of the 30 days before {end}: {n} (low {lows:.2}, high {highs:.2}), after: {}", m.len() - n);
                }
            }
            let (mut before, mut after, mut minutes) = ((String::new(), 0.0), (String::new(), 0.0), (0, 0));
            if let Some(taken) = listing.taken_sec {
                let i = bars.iter().position(|b| b.time >= taken).unwrap();
                if i > 0 {
                    before = (day(&bars[i - 1]), bars[i - 1].close);
                }
                after = (day(&bars[i]), bars[i].open);
                let taken_day = day_of(taken).unwrap();
                let a = *cal.trading_days_before(taken_day, 11).first().unwrap();
                let b = taken_day + Duration::days(13);
                if a >= minute_floor {
                    let m = chained_aggs(&provider, &cal, &sym, Span::MinuteChunked(5), a, b, true, false).await.unwrap();
                    assert!(m.windows(2).all(|w| w[0].time < w[1].time), "{t}: minute times not strictly ascending");
                    let n = m.iter().filter(|c| cal.date_of(c.time as i64).unwrap() < taken_day).count();
                    minutes = (n, m.len() - n);
                }
            }
            let row = format!(
                "{t},{earlier},{},{},{:.4},{},{:.4},{},{:.4},{:.2},{at},{},{},{complete}",
                bars.len(), day(&bars[0]), bars[0].close, before.0, before.1, after.0, after.1, big * 100.0, minutes.0, minutes.1,
            );
            eprintln!("{row}");
            rows.push(row);
        }
        if let Ok(out) = std::env::var("OT_OUT") {
            std::fs::write(out, rows.join("\n") + "\n").unwrap();
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
