//! A bar family and its bucket width, and the ranged fetch of one span
//! (minute and second windows longer than one request are fetched in chunks).
use crate::data::calendar::SessionCalendar;
use crate::data::provider::capabilities::BarFamily;
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::Candle;
use chrono::{Duration, NaiveDate};

/// A bar family and its bucket width, for a ranged fetch.
#[derive(Clone, Copy)]
pub(super) enum Span {
    Day,
    Minute(u32),
    /// Minutes over a window that can exceed one request (see
    /// [`minute_aggs_chunked`]).
    MinuteChunked(u32),
    Second(u32),
}

impl Span {
    pub(super) fn family(self) -> BarFamily {
        match self {
            Span::Day => BarFamily::Day,
            Span::Minute(_) | Span::MinuteChunked(_) => BarFamily::Minute,
            Span::Second(_) => BarFamily::Second,
        }
    }
}

/// `span` bars of the symbol `sym` itself over `[from, to]`.
pub(super) async fn span_aggs(
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
        Span::Second(mult) => {
            let windows = chunk_windows(cal, from, to, SECOND_CHUNK_DAYS);
            fetch_windows(windows, SECOND_CHUNK_CONCURRENCY, |a, b| provider.second_aggs(sym, mult, a, b, adjusted)).await
        }
    }
}

/// Trading days per minute-family request. The gateway reads at most 50 000 base
/// minutes per request and drops the OLDEST ones beyond that; 50 full extended
/// sessions (16 h = 960 minutes each) stay under it, so a chunk is never cut.
const MINUTE_CHUNK_DAYS: usize = 50;
/// Trading days per second-family request. The same 50 000 cap counts 1-second
/// bars: about 2 extended sessions of a busy ticker (measured 19/10/2026: SPY,
/// AAPL, INTC 10-second bars cut after 2-2.5 sessions), so one session per
/// request; a session still cut is paged by the fetcher.
const SECOND_CHUNK_DAYS: usize = 1;
/// Chunk requests in flight at once.
const CHUNK_CONCURRENCY: usize = 6;
/// Second-family chunks in flight at once: one session takes 2-3 s at the
/// source, and the gateway answered 128 concurrent seconds requests without
/// slowing down (19/10/2026), so a 3-week window comes back in one round.
const SECOND_CHUNK_CONCURRENCY: usize = 16;

/// Minute bars over `[from, to]`, split into [`MINUTE_CHUNK_DAYS`] windows
/// fetched concurrently, so a long window (a time-sync or go-to target months
/// back) comes back complete in about one request's time instead of cut at
/// 50 000 minutes.
async fn minute_aggs_chunked(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    mult: u32,
    from: NaiveDate,
    to: NaiveDate,
    adjusted: bool,
) -> anyhow::Result<Vec<Candle>> {
    let windows = chunk_windows(cal, from, to, MINUTE_CHUNK_DAYS);
    fetch_windows(windows, CHUNK_CONCURRENCY, |a, b| provider.minute_aggs(sym, mult, a, b, adjusted)).await
}

/// `[from, to]` cut into calendar-contiguous windows of `days` trading days
/// each (one window when the range is not longer).
pub(super) fn chunk_windows(cal: &SessionCalendar, from: NaiveDate, to: NaiveDate, days: usize) -> Vec<(NaiveDate, NaiveDate)> {
    let sessions = cal.trading_days_in_range(from, to);
    if sessions.len() <= days {
        return vec![(from, to)];
    }
    let mut windows = Vec::new();
    let mut start = from;
    for chunk in sessions.chunks(days) {
        let last = *chunk.last().unwrap_or(&to);
        let end = if last >= to || chunk.len() < days { to } else { last };
        windows.push((start, end));
        start = end + Duration::days(1);
    }
    windows
}

/// The bars of every window, `concurrency` requests in flight, oldest-first.
async fn fetch_windows<F, Fut>(windows: Vec<(NaiveDate, NaiveDate)>, concurrency: usize, fetch: F) -> anyhow::Result<Vec<Candle>>
where
    F: Fn(NaiveDate, NaiveDate) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<Candle>>>,
{
    use futures_util::stream::{self, StreamExt, TryStreamExt};
    let pages: Vec<Vec<Candle>> = stream::iter(windows)
        .map(|(a, b)| fetch(a, b))
        .buffered(concurrency)
        .try_collect()
        .await?;
    Ok(pages.into_iter().flatten().collect())
}
