//! Bars of the company behind a symbol across symbol changes: the bars
//! under its earlier symbols and under a symbol it used in between.
use super::adjustments::scale_by_splits;
use super::listing::{listing_of, Segment};
use super::span::{span_aggs, Span};
use super::{clamp_to_floor, day_of};
use crate::data::calendar::SessionCalendar;
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::Candle;
use chrono::{Duration, NaiveDate};

/// The company's bars over `[from, to]` under its other symbols (`segments`,
/// newest first), oldest first: each symbol is read inside its own stretch
/// only. With `with_archive` (daily bars) the sessions older than the
/// recent source come from that symbol's archive. The bars are read
/// unadjusted and, when `adjusted`, scaled by the splits of `sym`: the
/// current symbol's list is the company's (an earlier symbol's list can be a
/// later user's).
#[allow(clippy::too_many_arguments)]
pub(super) async fn earlier_bars(
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
pub(super) async fn chained_aggs(
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
pub(super) fn merge_between(mut bars: Vec<Candle>, mut between: Vec<Candle>) -> Vec<Candle> {
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
pub(super) fn prepend_older(bars: Vec<Candle>, mut older: Vec<Candle>) -> Vec<Candle> {
    if let Some(first) = bars.first().map(|b| b.time) {
        older.retain(|b| b.time < first);
    }
    older.extend(bars);
    older
}
