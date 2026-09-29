/*
 * The screener's in-memory table: one row per ticker of the full-market
 * snapshot, joined with the reference list (name, type, exchange) and the
 * daily state file. Rebuilt after every poll and swapped in whole, so a scan
 * never waits on the network.
 */
use crate::data::massive_rest::{MarketRow, RefTicker};
use crate::screener::clock;
use crate::screener::state::StateFile;
use chrono::NaiveDate;
use std::collections::HashMap;
use std::sync::Arc;

/// How a row's live values join the daily state.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Join {
    /// The row shows the session the state was built from: the state values
    /// are the answer.
    AtClose,
    /// The row shows the session after the state's: live values are one step
    /// from the state (e.g. EMA = prev + a * (price - prev)).
    Step,
    /// No state for this ticker, or the state is more than one session old.
    Missing,
}

pub struct Row {
    pub m: MarketRow,
    /// Index into `Table::refs`.
    pub r: Option<usize>,
    /// Index into the state file columns.
    pub st: Option<usize>,
    pub join: Join,
}

pub struct Table {
    pub version: u32,
    /// Newest snapshot update stamp, UNIX ms.
    pub updated_ms: Option<f64>,
    pub rows: Vec<Row>,
    pub refs: Arc<Vec<RefTicker>>,
    pub state: Option<Arc<StateFile>>,
}

impl Table {
    pub fn empty() -> Self {
        Table { version: 0, updated_ms: None, rows: Vec::new(), refs: Arc::new(Vec::new()), state: None }
    }

    pub fn state_asof(&self) -> Option<NaiveDate> {
        self.state.as_ref().map(|s| s.asof)
    }

    pub fn reference(&self, row: &Row) -> Option<&RefTicker> {
        row.r.and_then(|i| self.refs.get(i))
    }

    pub fn build(
        version: u32,
        market: Vec<MarketRow>,
        refs: Arc<Vec<RefTicker>>,
        state: Option<Arc<StateFile>>,
    ) -> Table {
        let ref_idx: HashMap<&str, usize> =
            refs.iter().enumerate().map(|(i, r)| (r.ticker.as_str(), i)).collect();
        let st_idx = state.as_ref().map(|s| s.index());
        let today = clock::ny_date_ms(chrono::Utc::now().timestamp_millis() as f64)
            .unwrap_or_else(|| chrono::Utc::now().date_naive());
        // Session of the not-yet-traded rows: the last session before today.
        let quiet_day = if clock::trading_day_on_or_before(today) == Some(today) {
            clock::prev_trading_day(today)
        } else {
            clock::trading_day_on_or_before(today)
        };
        // The calendar walk is not free: resolve each distinct shown day once.
        let mut memo: HashMap<NaiveDate, Join> = HashMap::new();
        let updated_ms = market.iter().map(|m| m.updated_ms).filter(|t| *t > 0.0).reduce(f64::max);
        let rows = market
            .into_iter()
            .map(|m| {
                let r = ref_idx.get(m.ticker.as_str()).copied();
                let st = st_idx.as_ref().and_then(|ix| ix.get(m.ticker.as_str()).copied());
                let shown = if m.live { clock::ny_date_ms(m.updated_ms) } else { quiet_day };
                let join = match (&state, st, shown) {
                    (Some(s), Some(_), Some(d)) => {
                        *memo.entry(d).or_insert_with(|| join_mode(s.asof, d))
                    }
                    _ => Join::Missing,
                };
                Row { m, r, st, join }
            })
            .collect();
        Table { version, updated_ms, rows, refs, state }
    }
}

/// How a row showing session `shown` joins a state built at the close of
/// `asof`. A traded row shows the New York day of its update stamp; a row
/// that has not traded today (pre-open, illiquid ticker, closed day) shows
/// the last session before today.
fn join_mode(asof: NaiveDate, shown: NaiveDate) -> Join {
    if shown <= asof {
        Join::AtClose
    } else if clock::prev_trading_day(shown) == Some(asof) {
        Join::Step
    } else {
        Join::Missing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn join_rules() {
        // State at Fri 25/09/2026.
        assert_eq!(join_mode(d(2026, 9, 25), d(2026, 9, 25)), Join::AtClose);
        assert_eq!(join_mode(d(2026, 9, 25), d(2026, 9, 28)), Join::Step);
        assert_eq!(join_mode(d(2026, 9, 25), d(2026, 9, 29)), Join::Missing);
    }
}
