//! The daily series joined from the recent source, the daily archive and
//! the bars of the company's other symbols.
use super::listing::{listing_of, Listing, ARCHIVE_MAX_HOLE_SECS};
use super::span::Span;
use super::symbol_chain::{earlier_bars, merge_between, prepend_older};
use crate::data::calendar::SessionCalendar;
use crate::data::gateway;
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::Candle;
use chrono::NaiveDate;

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
pub(super) fn prepend_archive(mut bars: Vec<Candle>, archive: Vec<Candle>, from_sec: f64, listing: &Listing) -> Vec<Candle> {
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
/// the hole they left. `complete` is false when a part older than the
/// recent series could not be read (the series is then not memoised);
/// `partial` when such a part failed because the server could not be
/// reached (the app reads the series again once it can). Empty when the
/// recent source has no bar.
pub(super) async fn joined_daily(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    wanted_from: NaiveDate,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> Result<JoinedDaily, String> {
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
        return Ok(JoinedDaily { bars, complete: false, partial: false });
    }
    let mut partial = listing.partial;
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
                        partial |= gateway::is_transient(&e);
                    }
                }
            }
            if !listing.between.is_empty() {
                match earlier_bars(provider, cal, sym, &listing.between, Span::Day, wanted_from, to, adjusted, true).await {
                    Ok(between) => bars = merge_between(bars, between),
                    Err(e) => {
                        eprintln!("[history] {sym}: bars of the symbol used in between not loaded: {e:#}");
                        complete = false;
                        partial |= gateway::is_transient(&e);
                    }
                }
            }
            JoinedDaily { bars, complete: complete && !partial, partial }
        }
        Err(e) => {
            eprintln!("[history] {sym}: daily archive not loaded: {e:#}");
            JoinedDaily { bars, complete: false, partial: partial || gateway::is_transient(&e) }
        }
    })
}

/// A joined daily series (see [`joined_daily`]).
pub(super) struct JoinedDaily {
    pub(super) bars: Vec<Candle>,
    pub(super) complete: bool,
    pub(super) partial: bool,
}
