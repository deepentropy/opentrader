/*
 * The screener's in-memory table: one row per ticker of the full-market
 * snapshot, joined with the reference list (name, type, exchange) and the
 * daily state file. Rebuilt after every poll and swapped in whole, so a scan
 * never waits on the network.
 */
use crate::data::market_rest::{ExtHours, MarketRow, RefTicker};
use crate::data::ticker_case;
use crate::screener::clock;
use crate::screener::state::StateFile;
use chrono::NaiveDate;
use std::collections::{HashMap, HashSet};
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
    /// New York date of the session the row shows (today once traded, else
    /// the last session before today).
    pub day: Option<NaiveDate>,
}

pub struct Table {
    pub version: u32,
    /// Newest snapshot update stamp, UNIX ms.
    pub updated_ms: Option<f64>,
    pub rows: Vec<Row>,
    pub refs: Arc<Vec<RefTicker>>,
    pub state: Option<Arc<StateFile>>,
    /// No download it waits on is pending (the reference list, the daily state): filters on names, types and
    /// state values can match. Set by the poll loop; a table built here counts as complete.
    pub complete: bool,
    /// The latest regular session that has opened when the table was built: a ticker whose last update is older
    /// did not trade in it (the "Last trade time" filter).
    pub session: Option<NaiveDate>,
}

impl Table {
    pub fn empty() -> Self {
        Table { version: 0, updated_ms: None, rows: Vec::new(), refs: Arc::new(Vec::new()), state: None, complete: false, session: None }
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
        let today = clock::ny_date_ms(crate::clock::utc().timestamp_millis() as f64)
            .unwrap_or_else(|| crate::clock::utc().date_naive());
        // Session of the not-yet-traded rows: the last session before today.
        let quiet_day = if clock::trading_day_on_or_before(today) == Some(today) {
            clock::prev_trading_day(today)
        } else {
            clock::trading_day_on_or_before(today)
        };
        // The calendar walk is not free: resolve each distinct shown day once.
        let mut memo: HashMap<NaiveDate, Join> = HashMap::new();
        let updated_ms = market.iter().map(|m| m.updated_ms).filter(|t| *t > 0.0).reduce(f64::max);
        // The snapshot holds the symbols that traded in its last sessions; the state, those with a trade in the last
        // 10 sessions, as the reference lists them (its OTC symbols, measured 26/11/2026). The others show their
        // last bar.
        let quiet: Vec<MarketRow> = match &state {
            Some(s) => {
                let seen: HashSet<&str> = market.iter().map(|m| m.ticker.as_str()).collect();
                (0..s.tickers.len()).filter(|&i| !seen.contains(s.tickers[i].as_str())).filter_map(|i| last_bar(s, i)).collect()
            }
            None => Vec::new(),
        };
        let rows = market
            .into_iter()
            .map(|mut m| {
                let r = ref_idx.get(m.ticker.as_str()).copied();
                let st = st_idx.as_ref().and_then(|ix| ix.get(m.ticker.as_str()).copied());
                let shown = if m.live { clock::ny_date_ms(m.updated_ms) } else { quiet_day };
                let join = match (&state, st, shown) {
                    (Some(s), Some(_), Some(d)) => {
                        *memo.entry(d).or_insert_with(|| join_mode(s.asof, d))
                    }
                    _ => Join::Missing,
                };
                // The reference list and the state are keyed by the source's
                // spelling; from here on the row carries the app's name.
                m.ticker = ticker_case::to_app(&m.ticker);
                Row { m, r, st, join, day: shown }
            })
            .chain(quiet.into_iter().map(|mut m| {
                let r = ref_idx.get(m.ticker.as_str()).copied();
                let st = st_idx.as_ref().and_then(|ix| ix.get(m.ticker.as_str()).copied());
                let shown = clock::ny_date_ms(m.updated_ms);
                let join = match (&state, shown) {
                    (Some(s), Some(d)) => join_mode(s.asof, d),
                    _ => Join::Missing,
                };
                m.ticker = ticker_case::to_app(&m.ticker);
                Row { m, r, st, join, day: shown }
            }))
            .collect();
        let session = clock::last_opened_session(crate::clock::utc());
        Table { version, updated_ms, rows, refs, state, complete: true, session }
    }
}

/// The row of a symbol without a trade in the snapshot: its last bar from the state (`bar.*` columns), stamped at
/// 16:00 New York that day. None when the state has no bar for it.
fn last_bar(s: &StateFile, i: usize) -> Option<MarketRow> {
    let day = NaiveDate::from_num_days_from_ce_opt(s.num("bar.day", i)? as i32 + EPOCH_DAYS_FROM_CE)?;
    let close = s.num("close", i)?;
    let prev_close = s.num("bar.prev_close", i);
    let change = prev_close.map_or(0.0, |p| close - p);
    let change_percent = prev_close.filter(|p| *p != 0.0).map_or(0.0, |p| 100.0 * (close / p - 1.0));
    Some(MarketRow {
        ticker: s.tickers[i].clone(),
        last: close,
        change,
        change_percent,
        open: s.num("bar.open", i).unwrap_or(close),
        high: s.num("bar.high", i).unwrap_or(close),
        low: s.num("bar.low", i).unwrap_or(close),
        volume: s.num("bar.volume", i).unwrap_or(0.0),
        prev_close,
        live: false,
        updated_ms: (clock::ny_midnight_sec(day)? + 16.0 * 3600.0) * 1000.0,
        ext: ExtHours::default(),
    })
}

/// Days from 0001-01-01 to 1970-01-01 (`bar.day` counts from the latter).
const EPOCH_DAYS_FROM_CE: i32 = 719_163;

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
    fn symbols_without_a_trade_show_their_last_bar() {
        // OTCX last traded on Wed 18/11/2026 (day 20775 since 1970-01-01); AAPL is in the snapshot.
        let col = |v: Vec<Option<f64>>| v;
        let num: HashMap<String, Vec<Option<f64>>> = [
            ("close", col(vec![Some(1.4), Some(200.0)])),
            ("bar.day", col(vec![Some(20775.0), Some(20779.0)])),
            ("bar.open", col(vec![Some(1.1), Some(199.0)])),
            ("bar.high", col(vec![Some(1.5), Some(201.0)])),
            ("bar.low", col(vec![Some(1.0), Some(198.0)])),
            ("bar.volume", col(vec![Some(700.0), Some(1e6)])),
            ("bar.prev_close", col(vec![Some(1.25), None])),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let state = StateFile { version: 1, asof: d(2026, 11, 20), tickers: vec!["OTCX".into(), "AAPL".into()], num, text: HashMap::new() };
        let live = MarketRow {
            ticker: "AAPL".into(), last: 201.0, change: 1.0, change_percent: 0.5, open: 200.0, high: 202.0, low: 199.0, volume: 5e5,
            prev_close: Some(200.0), live: true, updated_ms: 1_795_800_000_000.0, ext: ExtHours::default(),
        };
        let t = Table::build(1, vec![live], Arc::new(Vec::new()), Some(Arc::new(state)));
        assert_eq!(t.rows.len(), 2, "the snapshot's row and OTCX's last bar");
        let otc = t.rows.iter().find(|r| r.m.ticker == "OTCX").unwrap();
        assert_eq!((otc.m.open, otc.m.high, otc.m.low, otc.m.last, otc.m.volume), (1.1, 1.5, 1.0, 1.4, 700.0));
        assert_eq!(otc.m.prev_close, Some(1.25));
        assert!((otc.m.change - 0.15).abs() < 1e-9 && (otc.m.change_percent - 12.0).abs() < 1e-9);
        assert!(!otc.m.live);
        assert_eq!(otc.day, Some(d(2026, 11, 18)));
        assert_eq!(otc.join, Join::AtClose);
        assert_eq!(otc.st, Some(0));
    }

    #[test]
    fn join_rules() {
        // State at Fri 25/09/2026.
        assert_eq!(join_mode(d(2026, 9, 25), d(2026, 9, 25)), Join::AtClose);
        assert_eq!(join_mode(d(2026, 9, 25), d(2026, 9, 28)), Join::Step);
        assert_eq!(join_mode(d(2026, 9, 25), d(2026, 9, 29)), Join::Missing);
    }
}
