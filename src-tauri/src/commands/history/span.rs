//! A bar family and its bucket width, and the ranged fetch of one span
//! (minute windows longer than one request are fetched in chunks).
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
        Span::Second(mult) => provider.second_aggs(sym, mult, from, to, adjusted).await,
    }
}

/// Trading days per minute-family request. The gateway reads at most 50 000 base
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
