//! What the provider knows of the company behind a symbol: its listing
//! date, the earlier symbols it traded under and the symbols it used in
//! between, each proven by the bars.
use super::{clamp_to_floor, day_of, midnight};
use crate::data::calendar::SessionCalendar;
use crate::data::gateway;
use crate::data::provider::capabilities::BarFamily;
use crate::data::provider::{DataProvider, SymbolChange};
use crate::data::symbol::SymbolRef;
use crate::data::types::Candle;
use chrono::{Duration, NaiveDate};

/// Longest stretch without a bar inside one listing. A ticker symbol can be
/// used again by another company years later (one archive file holds both), so
/// archived bars beyond a longer hole are another listing and are left out.
pub(super) const ARCHIVE_MAX_HOLE_SECS: f64 = 366.0 * 86_400.0;

/// What the provider knows of the company now behind a symbol, as times
/// (midnight UTC seconds of the dates): where its bars start in an archive
/// that holds every company that ever used the symbol.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Listing {
    /// Start of the current listing, from the reference data.
    pub(super) listed_sec: Option<f64>,
    /// Dates the company took this very symbol.
    pub(super) held_since: Vec<f64>,
    /// Date the company moved to this symbol from another one: its older
    /// bars are under that other symbol.
    pub(super) taken_sec: Option<f64>,
    /// The symbols it traded under before that date, newest first.
    pub(super) earlier: Vec<Segment>,
    /// The other symbols it traded under after it first held this one, before
    /// it came back to it, newest first: this symbol has no bar there.
    pub(super) between: Vec<Segment>,
    /// A lookup behind these facts could not reach the server: a part of the
    /// company's history may be missing until it is read again.
    pub(super) partial: bool,
}

/// Another symbol of a company and the stretch of that symbol's bars that
/// is the company's (the symbol can be used by others before and after).
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Segment {
    pub(super) ticker: String,
    /// Start of the stretch, `f64::MIN` when not known.
    pub(super) start_sec: f64,
    /// Date the company left the symbol (not part of the stretch),
    /// `f64::MAX` when not known.
    pub(super) end_sec: f64,
}

impl Listing {
    /// From the listing date and the company's symbol history (newest
    /// first). The history's dates are not listing dates (a lone entry can
    /// be years after the first bar), so one is a start only when the
    /// company came from another symbol.
    pub(super) fn new(ticker: &str, listed: Option<NaiveDate>, changes: &[SymbolChange]) -> Self {
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
            partial: false,
        }
    }
}

/// `result`'s value, or `fallback` when it failed; a failure that a later
/// try can get past marks `partial`.
fn or_partial<T>(result: anyhow::Result<T>, fallback: T, partial: &mut bool) -> T {
    match result {
        Ok(v) => v,
        Err(e) => {
            *partial |= gateway::is_transient(&e);
            fallback
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
pub(super) fn stretch_start(bars: &[Candle], end_sec: f64) -> f64 {
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
pub(super) async fn listing_of<P: DataProvider + ?Sized>(provider: &P, sym: &SymbolRef) -> Listing {
    let (listed, changes) = tokio::join!(provider.listing_date(sym), provider.symbol_changes(sym));
    let mut partial = false;
    let listed = or_partial(listed, None, &mut partial);
    let changes = or_partial(changes, Vec::new(), &mut partial);
    let mut listing = Listing::new(&sym.ticker, listed, &changes);
    listing.partial = partial;
    let (mut proven, mut oldest_start) = (0, f64::MIN);
    for segment in &listing.earlier {
        let earlier = SymbolRef { exchange: sym.exchange.clone(), ticker: segment.ticker.clone() };
        let bars = match provider.daily_archive(&earlier, false).await {
            Ok(bars) => bars,
            Err(e) => {
                listing.partial |= gateway::is_transient(&e);
                break;
            }
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
    listing.between = proven_between(provider, sym, std::mem::take(&mut listing.between), &mut listing.partial).await;
    listing
}

/// First and last time of the bars inside `[start_sec, end_sec)`.
pub(super) fn times_inside(bars: &[Candle], start_sec: f64, end_sec: f64) -> Option<(f64, f64)> {
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
/// A lookup that could not reach the server marks `partial`.
async fn proven_between<P: DataProvider + ?Sized>(
    provider: &P,
    sym: &SymbolRef,
    candidates: Vec<Segment>,
    partial: &mut bool,
) -> Vec<Segment> {
    if candidates.is_empty() {
        return candidates;
    }
    let own = match provider.daily_archive(sym, false).await {
        Ok(own) => own,
        Err(e) => {
            *partial |= gateway::is_transient(&e);
            return Vec::new();
        }
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
                    next = or_partial(provider.daily_aggs(sym, a, b, false).await.map(Some), None, partial)
                        .and_then(|bars| bars.first().map(|b| b.time));
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
        let archived = or_partial(provider.daily_archive(&other, false).await, Vec::new(), partial);
        let mut span = times_inside(&archived, segment.start_sec, segment.end_sec);
        if span.is_none() {
            // No archive for that symbol: its recent bars.
            if let Some((a, b)) = clamp_to_floor(BarFamily::Day, start, end - Duration::days(1)).await {
                let recent = or_partial(provider.daily_aggs(&other, a, b, false).await, Vec::new(), partial);
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
