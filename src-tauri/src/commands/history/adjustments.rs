//! Split and dividend adjustment of bars read unadjusted or split-adjusted.
use super::{daily_series, midnight, DIVIDEND_BASIS_DAYS};
use crate::data::calendar::SessionCalendar;
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::{Candle, DividendEvent, SplitEvent};

/// Unadjusted `bars` put on the split-adjusted scale: prices times
/// `from / to` of every split executed after the bar's session, volume
/// divided by it.
pub(super) fn scale_by_splits(bars: &mut [Candle], splits: &[SplitEvent], cal: &SessionCalendar) {
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

/// One factor per dividend of `dividends`, as (ex-dividend date, factor):
/// `1 - amount / close` of the session before the ex-dividend date, both on
/// the split-adjusted scale (`daily`, oldest first). The amounts are as
/// declared, so one paid before a split is scaled by `splits` first. A
/// dividend without an earlier session in `daily` has no factor.
pub(super) fn dividend_steps(daily: &[Candle], dividends: &[DividendEvent], splits: &[SplitEvent], cal: &SessionCalendar) -> Vec<(f64, f64)> {
    let sessions: Vec<f64> = daily.iter().map(|b| cal.date_of(b.time as i64).and_then(midnight).unwrap_or(b.time)).collect();
    dividends
        .iter()
        .filter_map(|d| {
            let before = sessions.partition_point(|s| *s < d.date).checked_sub(1)?;
            let close = daily[before].close;
            let scale: f64 =
                splits.iter().filter(|s| s.date > d.date && s.from > 0.0 && s.to > 0.0).map(|s| s.from / s.to).product();
            let amount = d.amount * scale;
            (amount > 0.0 && amount < close).then(|| (d.date, 1.0 - amount / close))
        })
        .collect()
}

/// Split-adjusted `bars` put on the dividend-adjusted scale: prices times the
/// factor of every dividend whose ex-dividend date is after the bar's session.
/// Volume stays as it is.
pub(super) fn scale_by_dividends(bars: &mut [Candle], steps: &[(f64, f64)], cal: &SessionCalendar) {
    if steps.is_empty() {
        return;
    }
    for bar in bars {
        let session = cal.date_of(bar.time as i64).and_then(midnight).unwrap_or(bar.time);
        let factor: f64 = steps.iter().filter(|(ex, _)| *ex > session).map(|(_, f)| f).product();
        bar.open *= factor;
        bar.high *= factor;
        bar.low *= factor;
        bar.close *= factor;
    }
}

/// `bars` (split-adjusted) adjusted for dividends too when `dividends`. An
/// error when a part of the factors could not be read, so the chart never
/// shows a series adjusted in part.
pub(super) async fn with_dividends(
    provider: &Provider,
    cal: &SessionCalendar,
    sym: &SymbolRef,
    mut bars: Vec<Candle>,
    dividends: bool,
) -> Result<Vec<Candle>, String> {
    if !dividends || bars.is_empty() {
        return Ok(bars);
    }
    let (daily, paid, splits) =
        tokio::join!(daily_series(provider, cal, sym, DIVIDEND_BASIS_DAYS), provider.paid_dividends(sym), provider.executed_splits(sym));
    let paid = paid.ok_or_else(|| format!("no dividend list for {sym}"))?;
    if paid.is_empty() {
        return Ok(bars);
    }
    let splits = splits.ok_or_else(|| format!("no split list for {sym}"))?;
    scale_by_dividends(&mut bars, &dividend_steps(&daily?, &paid, &splits, cal), cal);
    Ok(bars)
}
