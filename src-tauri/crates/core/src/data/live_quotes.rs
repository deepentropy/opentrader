/*
 * live_quotes — a subscriber's quotes: the polled snapshot and the streamed
 * trades of the same symbol put together.
 *
 * A trade of the stream is a price and a range; the watchlist shows the
 * regular session's last, its change and its range, which only the snapshot
 * knows (`quote_poll`). And a snapshot is seconds old when it arrives: shown as
 * it is, it would put back prices the stream has already moved. Each side reads
 * the other here. Without a stream (the free tier) the snapshots pass through.
 */
use crate::data::market_rest::{Candle, LiveTick};
use crate::data::trading_calendar;
use crate::screener::clock::ny_offset_hours;
use crate::sync::LockExt;
use chrono::{DateTime, Timelike, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

/// A streamed trade older than this no longer overrides a snapshot (ms): the
/// stream may have stopped, the snapshot knows better.
const TRADE_KEEP_MS: f64 = 30_000.0;

/// What a trade makes of a symbol's quote.
#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    /// The regular session's last.
    pub last: f64,
    pub change: f64,
    pub change_percent: f64,
    pub ext_change_percent: Option<f64>,
    pub day_high: f64,
    pub day_low: f64,
    pub source: &'static str,
}

/// The last snapshot of a symbol.
#[derive(Clone)]
struct Base {
    last: f64,
    prev_close: f64,
    live: bool,
    day_high: f64,
    day_low: f64,
}

/// What the stream made of the symbol since.
#[derive(Clone)]
struct Streamed {
    /// Time of the last trade, and of the last one in the regular session (Unix ms).
    ms: f64,
    price: f64,
    regular: Option<Regular>,
}

#[derive(Clone)]
struct Regular {
    ms: f64,
    last: f64,
    prev_close: f64,
    high: f64,
    low: f64,
}

#[derive(Default)]
struct Quotes {
    symbols: HashMap<String, (Base, Option<Streamed>)>,
    /// Tickers whose trades are streamed now.
    streamed: HashSet<String>,
}

fn quotes() -> &'static Mutex<Quotes> {
    static CELL: OnceLock<Mutex<Quotes>> = OnceLock::new();
    CELL.get_or_init(Default::default)
}

/// The gateway streams this ticker's trades (its subscribe reply), or no longer.
pub fn set_streamed(ticker: &str, on: bool) {
    let mut q = quotes().locked();
    if on {
        q.streamed.insert(ticker.to_string());
    } else {
        q.streamed.remove(ticker);
    }
}

/// The ticker's trades are streamed: its chart follows them, not the polled minute bar.
pub fn streamed(ticker: &str) -> bool {
    quotes().locked().streamed.contains(ticker)
}

/// The real-time session ended: what it streamed must not hold back the delayed snapshots.
pub fn clear() {
    let mut q = quotes().locked();
    q.streamed.clear();
    for (_, s) in q.symbols.values_mut() {
        *s = None;
    }
}

/// A trade of the stream. `None` until the symbol was polled once.
pub fn traded(ticker: &str, ms: f64, price: f64, high: f64, low: f64) -> Option<Quote> {
    quotes().locked().traded(ticker, ms, price, high, low, regular_session(ms))
}

/// A polled snapshot, with what the stream knows better.
pub fn polled(tick: LiveTick) -> LiveTick {
    quotes().locked().polled(tick, Utc::now().timestamp_millis() as f64)
}

impl Quotes {
    fn traded(&mut self, ticker: &str, ms: f64, price: f64, high: f64, low: f64, in_session: bool) -> Option<Quote> {
        let (base, streamed) = self.symbols.get_mut(ticker)?;
        let was = streamed.take();
        let mut regular = was.and_then(|s| s.regular);
        if in_session {
            // Of today: the snapshot's session, else (its first trades) the one after the last close.
            let (prev_close, h, l) = match (&regular, base.live) {
                (Some(r), _) => (r.prev_close, r.high.max(high), r.low.min(low)),
                (None, true) => (base.prev_close, base.day_high.max(high), base.day_low.min(low)),
                (None, false) => (base.last, high, low),
            };
            regular = Some(Regular { ms, last: price, prev_close, high: h, low: l });
        }
        let out = {
            let r = regular.as_ref();
            let last = r.map_or(base.last, |r| r.last);
            let prev = r.map_or(base.prev_close, |r| r.prev_close);
            Quote {
                last,
                change: last - prev,
                change_percent: percent(last, prev),
                ext_change_percent: (last > 0.0).then(|| percent(price, last)),
                day_high: r.map_or(base.day_high, |r| r.high),
                day_low: r.map_or(base.day_low, |r| r.low),
                source: if r.is_some() || base.live { "live" } else { "prev" },
            }
        };
        *streamed = Some(Streamed { ms, price, regular });
        Some(out)
    }

    fn polled(&mut self, mut t: LiveTick, now_ms: f64) -> LiveTick {
        let base = Base { last: t.last, prev_close: t.last - t.change, live: t.source == "live", day_high: t.day_high, day_low: t.day_low };
        let entry = self.symbols.entry(t.ticker.clone()).or_insert_with(|| (base.clone(), None));
        entry.0 = base.clone();
        let Some(s) = entry.1.as_mut() else { return t };
        let newer = |ms: f64| ms > t.updated_ms && ms > now_ms - TRADE_KEEP_MS;
        if !newer(s.ms) {
            entry.1 = None;
            return t;
        }
        match s.regular.as_mut() {
            Some(r) if newer(r.ms) => {
                if base.live {
                    r.prev_close = base.prev_close;
                    r.high = r.high.max(base.day_high);
                    r.low = r.low.min(base.day_low);
                }
                t.last = r.last;
                t.change = r.last - r.prev_close;
                t.change_percent = percent(r.last, r.prev_close);
                t.day_high = r.high;
                t.day_low = r.low;
                t.source = "live".into();
                if let Some(day) = t.day.as_mut() {
                    day.close = r.last;
                    day.high = day.high.max(r.high);
                    day.low = day.low.min(r.low);
                }
            }
            // The snapshot has the session's last trade.
            _ => s.regular = None,
        }
        t.ext_change_percent = (t.last > 0.0).then(|| percent(s.price, t.last));
        let minute = (s.ms / 60_000.0).floor() * 60.0;
        match t.minute.as_mut() {
            Some(m) if m.time > minute => {}
            Some(m) if m.time == minute => {
                m.close = s.price;
                m.high = m.high.max(s.price);
                m.low = m.low.min(s.price);
            }
            _ => t.minute = Some(Candle { time: minute, open: s.price, high: s.price, low: s.price, close: s.price, volume: 0.0 }),
        }
        t
    }
}

fn percent(value: f64, from: f64) -> f64 {
    if from > 0.0 {
        (value - from) / from * 100.0
    } else {
        0.0
    }
}

/// `ms` (Unix ms) is in a regular session: a trading day from 09:30 to its
/// close, New York time. The answer of a minute is kept.
pub fn regular_session(ms: f64) -> bool {
    static LAST: Mutex<(i64, bool)> = Mutex::new((i64::MIN, false));
    let minute = (ms / 60_000.0).floor() as i64;
    let mut last = LAST.locked();
    if last.0 != minute {
        *last = (minute, in_regular(minute));
    }
    last.1
}

fn in_regular(minute: i64) -> bool {
    let Some(utc) = DateTime::<Utc>::from_timestamp(minute * 60, 0) else { return false };
    let local = utc + chrono::Duration::hours(ny_offset_hours(utc));
    let day = local.date_naive();
    if trading_calendar::trading_days_in_range(day, day).is_empty() {
        return false;
    }
    let close = if trading_calendar::is_early_close(day) { 13 * 60 } else { 16 * 60 };
    (9 * 60 + 30..close).contains(&(local.hour() * 60 + local.minute()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn tick(last: f64, change: f64, source: &str, updated_ms: f64) -> LiveTick {
        LiveTick {
            ticker: "A".into(),
            last,
            change,
            change_percent: percent(last, last - change),
            ext_change_percent: None,
            volume: 1000.0,
            day_high: last + 1.0,
            day_low: last - 1.0,
            source: source.into(),
            minute: None,
            day: (source == "live").then_some(Candle { time: 0.0, open: last, high: last + 1.0, low: last - 1.0, close: last, volume: 1000.0 }),
            updated_ms,
        }
    }

    #[test]
    fn a_trade_moves_the_last_its_change_and_the_range() {
        let mut q = Quotes::default();
        assert_eq!(q.traded("A", 1.0, 10.0, 10.0, 10.0, true), None, "not polled yet");
        q.polled(tick(100.0, 2.0, "live", 1_000.0), 1_000.0);
        let x = q.traded("A", 2_000.0, 102.0, 103.0, 101.0, true).unwrap();
        assert_eq!((x.last, x.change, x.day_high, x.day_low, x.source), (102.0, 4.0, 103.0, 99.0, "live"));
        assert!((x.change_percent - 4.0 / 98.0 * 100.0).abs() < 1e-9);
        // The range stays over the trades.
        assert_eq!(q.traded("A", 2_100.0, 101.0, 101.0, 101.0, true).unwrap().day_high, 103.0);
    }

    #[test]
    fn the_first_trades_of_a_session_are_measured_from_the_last_close() {
        let mut q = Quotes::default();
        q.polled(tick(100.0, 2.0, "prev", 1_000.0), 1_000.0);
        let x = q.traded("A", 2_000.0, 101.0, 101.0, 101.0, true).unwrap();
        assert_eq!((x.last, x.change, x.day_high, x.day_low, x.source), (101.0, 1.0, 101.0, 101.0, "live"));
        // A snapshot that has not seen the open yet does not put yesterday back.
        let t = q.polled(tick(100.0, 2.0, "prev", 1_500.0), 2_500.0);
        assert_eq!((t.last, t.change, t.source.as_str()), (101.0, 1.0, "live"));
    }

    #[test]
    fn a_trade_out_of_the_session_moves_the_extended_change_only() {
        let mut q = Quotes::default();
        q.polled(tick(100.0, 2.0, "prev", 1_000.0), 1_000.0);
        let x = q.traded("A", 2_000.0, 105.0, 106.0, 104.0, false).unwrap();
        assert_eq!((x.last, x.change, x.day_high, x.source), (100.0, 2.0, 101.0, "prev"));
        assert!((x.ext_change_percent.unwrap() - 5.0).abs() < 1e-9);
        let t = q.polled(tick(100.0, 2.0, "prev", 1_500.0), 2_500.0);
        assert!((t.ext_change_percent.unwrap() - 5.0).abs() < 1e-9);
        assert_eq!(t.minute.unwrap().close, 105.0);
    }

    #[test]
    fn an_older_snapshot_does_not_put_prices_back_and_a_newer_one_does() {
        let mut q = Quotes::default();
        q.polled(tick(100.0, 2.0, "live", 1_000.0), 1_000.0);
        q.traded("A", 5_000.0, 110.0, 110.0, 110.0, true);
        let t = q.polled(tick(100.5, 2.5, "live", 3_000.0), 5_500.0);
        assert_eq!((t.last, t.change, t.day_high), (110.0, 12.0, 110.0));
        assert_eq!(t.day.unwrap().close, 110.0);
        let t = q.polled(tick(111.0, 13.0, "live", 6_000.0), 6_500.0);
        assert_eq!((t.last, t.change), (111.0, 13.0));
        // A trade long past overrides nothing, whatever the snapshot's time.
        q.traded("A", 7_000.0, 90.0, 90.0, 90.0, true);
        assert_eq!(q.polled(tick(111.0, 13.0, "live", 6_900.0), 60_000.0).last, 111.0);
    }

    #[test]
    fn regular_sessions() {
        let at = |m, d, h, min| in_regular(Utc.with_ymd_and_hms(2026, m, d, h, min, 0).unwrap().timestamp() / 60);
        // Wed 25/11/2026, New York = UTC-5.
        assert!(!at(11, 25, 14, 29));
        assert!(at(11, 25, 14, 30));
        assert!(at(11, 25, 20, 59));
        assert!(!at(11, 25, 21, 0));
        // Thanksgiving, and the early close of the day after.
        assert!(!at(11, 26, 15, 0));
        assert!(at(11, 27, 17, 59));
        assert!(!at(11, 27, 18, 0));
        // Summer time.
        assert!(at(7, 7, 13, 30));
    }
}
