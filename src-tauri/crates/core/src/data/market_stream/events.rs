//! The events re-emitted to the frontend and the parsing of the stream's
//! text frames into them.
use super::subscriptions::SubscriptionState;
use crate::data::market_rest::Candle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::Instant;
use crate::host::{event, Event, HostRef};

/// Per-minute bar (`bar1m` channel, or the polled snapshot) re-emitted to
/// the chart. One bar per minute per symbol. `time` is the bar's start in **UNIX seconds** so it lines
/// up with lightweight-charts' UTCTimestamp type and the existing daily +
/// minute history payloads.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
pub struct ChartAggregate {
    pub symbol: String,
    pub time: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    /// Today's full-session daily bar when the transport knows it (the REST
    /// snapshot poller does; the stream minute bars don't). Lets the frontend
    /// update the daily-family chart bar exactly — a warm daily load skips
    /// today's forming bar on purpose (see `fetch_daily_history`) and this is
    /// what fills it. The Candle's `time` is the snapshot's update stamp; the
    /// frontend re-buckets it to the daily-bar convention (midnight ET).
    pub day: Option<Candle>,
}

/// One 1-second bar (`bar1s` channel) for a charted symbol: the live source of
/// the seconds charts (1S…45S). `time` is the bar start in UNIX seconds.
/// Separate from `ChartAggregate` because its volume covers ONE second, so
/// the frontend adds it into a coarser bucket instead of replacing.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
pub struct SecondAggregate {
    pub symbol: String,
    pub time: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// Trade (`trade` channel, or the polled snapshot) re-emitted to the
/// watchlist for live last-price updates. `change`/`change_percent`/`volume` ride along from the REST snapshot
/// poller (`quote_poll`) so the watchlist's Chg/Chg%/Vol columns go live
/// too; they're `Option` because a raw WS trade carries only a price, so the
/// push path leaves them `None` and the UI keeps the prior value.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
#[serde(rename_all = "camelCase")]
pub struct TradeTick {
    pub symbol: String,
    /// Regular-session "Last" (not the latest pre/post trade — see
    /// `market_rest::shape_snapshot`).
    pub price: f64,
    pub change: Option<f64>,
    pub change_percent: Option<f64>,
    /// Pre/post-market move vs the regular close — the watchlist "Ext" column.
    pub ext_change_percent: Option<f64>,
    pub volume: Option<f64>,
    /// "live" (today's session traded) or "prev" — lets the UI blank Ext during
    /// regular hours. `None` on the WS push path.
    pub source: Option<String>,
    /// Latest trade, pre- and post-market included: its price and the start
    /// of its minute (UNIX seconds). `None` when the quote has no minute bar.
    pub trade_price: Option<f64>,
    pub trade_time: Option<f64>,
}

/// The live stream left or joined real-time data (#252). Sent when a session
/// authenticates (`reason` none), and when the gateway sends this device back
/// to delayed data.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
pub struct MarketTier {
    /// "realtime" | "delayed"
    pub tier: String,
    /// Why real-time ended: "expired", "renewal_refused", "invalid", "revoked"
    /// (the gateway's `downgraded` reasons), "signed_in_elsewhere", or
    /// "not_allowed" (the pass opens no real-time session).
    pub reason: Option<String>,
}

event!(MarketTier, "market-tier");
event!(ChartAggregate, "chart-aggregate");
event!(SecondAggregate, "second-aggregate");
event!(TradeTick, "trade-tick");

/// How often the bars of the stream go to the views: about one display frame.
pub(super) const BAR_FLUSH: Duration = Duration::from_millis(16);
/// How often the trades do: the watchlist and the alerts read the last price.
const TRADE_FLUSH: Duration = Duration::from_millis(100);

/// The stream's events since the last flush, the newest per symbol: a busy symbol (hundreds of messages a second)
/// sends the views one event per flush instead of one per message, each a JSON message the page parses and handles
/// (#261). A bar of another time first sends the one it follows, so a closed bar keeps its last values.
pub(super) struct Pending {
    app: HostRef,
    minute: HashMap<String, ChartAggregate>,
    second: HashMap<String, SecondAggregate>,
    trades: HashMap<String, TradeTick>,
    trades_sent: Instant,
    /// The trades of each symbol's current minute, as the bar the host's
    /// alert rules read with each trade.
    trade_bars: HashMap<String, Candle>,
}

impl Pending {
    pub(super) fn new(app: &HostRef) -> Self {
        Self { app: app.clone(), minute: HashMap::new(), second: HashMap::new(), trades: HashMap::new(), trades_sent: Instant::now(), trade_bars: HashMap::new() }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.minute.is_empty() && self.second.is_empty() && self.trades.is_empty()
    }

    fn minute(&mut self, agg: ChartAggregate) {
        let time = agg.time;
        if let Some(prev) = self.minute.insert(agg.symbol.clone(), agg) {
            if prev.time != time {
                let _ = prev.emit(&self.app);
            }
        }
    }

    fn second(&mut self, bar: SecondAggregate) {
        let time = bar.time;
        if let Some(prev) = self.second.insert(bar.symbol.clone(), bar) {
            if prev.time != time {
                let _ = prev.emit(&self.app);
            }
        }
    }

    /// The views get the newest trade per flush; the host's alert rules get
    /// every trade (#265), with what its minute traded so far.
    fn trade(&mut self, tick: TradeTick) {
        let price = tick.price;
        let bar = tick.trade_time.map(|time| {
            let bar = self.trade_bars.entry(tick.symbol.clone()).or_insert(Candle { time, open: price, high: price, low: price, close: price, volume: 0.0 });
            if bar.time != time {
                *bar = Candle { time, open: price, high: price, low: price, close: price, volume: 0.0 };
            }
            bar.high = bar.high.max(price);
            bar.low = bar.low.min(price);
            bar.close = price;
            bar.clone()
        });
        self.app.on_quote(&tick.symbol, price, bar.as_ref());
        self.trades.insert(tick.symbol.clone(), tick);
    }

    /// Send the bars, and the trades when their interval is over.
    pub(super) fn flush(&mut self) {
        for (_, agg) in self.minute.drain() {
            let _ = agg.emit(&self.app);
        }
        for (_, bar) in self.second.drain() {
            let _ = bar.emit(&self.app);
        }
        if self.trades_sent.elapsed() >= TRADE_FLUSH {
            self.flush_trades();
        }
    }

    fn flush_trades(&mut self) {
        for (_, tick) in self.trades.drain() {
            let _ = tick.emit(&self.app);
        }
        self.trades_sent = Instant::now();
    }
}

impl Drop for Pending {
    /// The session ended: what it received is sent.
    fn drop(&mut self) {
        self.flush();
        self.flush_trades();
    }
}

/// Parse one text frame and queue its events, once per subscribed full name
/// of the message's ticker. Replies and errors are logged.
pub(super) fn handle_text(pending: &mut Pending, state: &SubscriptionState, txt: &str) {
    for m in super::messages(txt) {
        match m.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "bar" => match m.get("tf").and_then(|v| v.as_str()) {
                Some("1m") => {
                    if let Some(agg) = parse_minute(&m) {
                        for symbol in state.chart_symbols_for(&agg.symbol) {
                            pending.minute(ChartAggregate { symbol, ..agg.clone() });
                        }
                    }
                }
                Some("1s") => {
                    if let Some(bar) = parse_second(&m) {
                        for symbol in state.chart_symbols_for(&bar.symbol) {
                            pending.second(SecondAggregate { symbol, ..bar.clone() });
                        }
                    }
                }
                _ => {}
            },
            "trade" => {
                if let Some(tick) = parse_trade(&m) {
                    for symbol in state.symbols_for(&tick.symbol) {
                        pending.trade(TradeTick { symbol, ..tick.clone() });
                    }
                }
            }
            "subscribed" | "unsubscribed" => {}
            "error" => {
                let channel = m.get("channel").and_then(|v| v.as_str()).unwrap_or("-");
                eprintln!("[market_stream] {channel}: {}", super::error_text(&m));
            }
            "status" => {
                let status = m.get("status").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("[market_stream] status {status}");
            }
            _ => {}
        }
    }
}

/// The OHLCV of a `bar` message, its start (`t`, ms) in seconds. A bar
/// without its ticker, start or a price is dropped; a missing volume reads 0.
fn bar_values(m: &serde_json::Value) -> Option<(String, f64, [f64; 4], f64)> {
    let num = |k: &str| m.get(k).and_then(|v| v.as_f64());
    Some((
        m.get("ticker")?.as_str()?.to_string(),
        (num("t")? / 1000.0).floor(),
        [num("o")?, num("h")?, num("l")?, num("c")?],
        num("v").unwrap_or(0.0),
    ))
}

fn parse_second(m: &serde_json::Value) -> Option<SecondAggregate> {
    let (symbol, time, [open, high, low, close], volume) = bar_values(m)?;
    Some(SecondAggregate { symbol, time, open, high, low, close, volume })
}

fn parse_minute(m: &serde_json::Value) -> Option<ChartAggregate> {
    let (symbol, time, [open, high, low, close], volume) = bar_values(m)?;
    Some(ChartAggregate { symbol, time, open, high, low, close, volume, day: None })
}

fn parse_trade(ev: &serde_json::Value) -> Option<TradeTick> {
    Some(TradeTick {
        symbol: ev.get("ticker")?.as_str()?.to_string(),
        price: ev.get("p")?.as_f64()?,
        // A raw WS trade carries no session change / volume — the watchlist
        // keeps whatever the snapshot poller last supplied.
        change: None,
        change_percent: None,
        ext_change_percent: None,
        volume: None,
        source: None,
        trade_price: ev.get("p").and_then(|v| v.as_f64()),
        trade_time: ev.get("t").and_then(|v| v.as_f64()).map(|ms| (ms / 60_000.0).floor() * 60.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_data_messages_parse() {
        let bar: serde_json::Value = serde_json::from_str(
            r#"{"type":"bar","tf":"1s","ticker":"SPY","t":1792000001000,"end":1792000002000,"o":1,"h":2,"l":0.5,"c":1.5,"v":null,"vw":1.2}"#,
        )
        .unwrap();
        let s = parse_second(&bar).unwrap();
        assert_eq!((s.symbol.as_str(), s.time, s.close, s.volume), ("SPY", 1_792_000_001.0, 1.5, 0.0));
        let m = parse_minute(&bar).unwrap();
        assert!(m.day.is_none());
        let no_price: serde_json::Value =
            serde_json::from_str(r#"{"type":"bar","tf":"1m","ticker":"SPY","t":1,"o":null,"h":1,"l":1,"c":1}"#).unwrap();
        assert!(parse_minute(&no_price).is_none());
        let trade: serde_json::Value =
            serde_json::from_str(r#"{"type":"trade","ticker":"SPY","t":1792000061000,"p":601.5,"size":100}"#).unwrap();
        let t = parse_trade(&trade).unwrap();
        assert_eq!((t.symbol.as_str(), t.price, t.trade_time), ("SPY", 601.5, Some(1_792_000_020.0)));
    }

    /// The events sent, by name and with their payload.
    struct Recorder(std::sync::Mutex<Vec<(&'static str, serde_json::Value)>>);
    impl crate::host::Host for Recorder {
        fn emit_value(&self, name: &'static str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((name, payload));
        }
    }

    /// The quotes the host's alert rules read: price and bar (time, high, low).
    #[derive(Default)]
    struct Quotes(std::sync::Mutex<Vec<(f64, Option<(f64, f64, f64)>)>>);
    impl crate::host::Host for Quotes {
        fn emit_value(&self, _: &'static str, _: serde_json::Value) {}
        fn on_quote(&self, _symbol: &str, last: f64, minute: Option<&Candle>) {
            self.0.lock().unwrap().push((last, minute.map(|b| (b.time, b.high, b.low))));
        }
    }

    #[test]
    fn every_trade_reaches_the_alert_rules_with_its_minute_so_far() {
        let quotes = std::sync::Arc::new(Quotes::default());
        let host: HostRef = quotes.clone();
        let trade = |price: f64, time: Option<f64>| TradeTick { symbol: "A".into(), price, change: None, change_percent: None, ext_change_percent: None, volume: None, source: None, trade_price: Some(price), trade_time: time };
        let mut p = Pending::new(&host);
        p.trade(trade(10.0, Some(60.0)));
        p.trade(trade(12.0, Some(60.0)));
        p.trade(trade(11.0, Some(60.0)));
        p.trade(trade(9.0, Some(120.0)));
        p.trade(trade(8.0, None));
        let got = quotes.0.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![
                (10.0, Some((60.0, 10.0, 10.0))),
                (12.0, Some((60.0, 12.0, 10.0))),
                (11.0, Some((60.0, 12.0, 10.0))),
                (9.0, Some((120.0, 9.0, 9.0))),
                (8.0, None),
            ]
        );
    }

    fn minute(symbol: &str, time: f64, close: f64) -> ChartAggregate {
        ChartAggregate { symbol: symbol.into(), time, open: 1.0, high: close, low: 1.0, close, volume: 1.0, day: None }
    }

    #[test]
    fn pending_sends_the_newest_bar_per_symbol_and_closed_bars() {
        let rec = std::sync::Arc::new(Recorder(Default::default()));
        let host: HostRef = rec.clone();
        let sent = |rec: &Recorder| rec.0.lock().unwrap().drain(..).map(|(n, v)| (n, v["symbol"].as_str().unwrap().to_string(), v["time"].as_f64(), v["close"].as_f64())).collect::<Vec<_>>();
        let mut p = Pending::new(&host);
        for c in [2.0, 3.0, 4.0] {
            p.minute(minute("A", 60.0, c));
        }
        p.minute(minute("B", 60.0, 9.0));
        assert!(sent(&rec).is_empty());
        p.flush();
        let mut out = sent(&rec);
        out.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(out, vec![("chart-aggregate", "A".into(), Some(60.0), Some(4.0)), ("chart-aggregate", "B".into(), Some(60.0), Some(9.0))]);
        // a new bar sends the one it follows at once
        p.minute(minute("A", 60.0, 5.0));
        p.minute(minute("A", 120.0, 6.0));
        assert_eq!(sent(&rec), vec![("chart-aggregate", "A".into(), Some(60.0), Some(5.0))]);
        p.flush();
        assert_eq!(sent(&rec), vec![("chart-aggregate", "A".into(), Some(120.0), Some(6.0))]);
        assert!(p.is_empty());
    }

    #[test]
    fn pending_sends_trades_every_trade_flush() {
        let rec = std::sync::Arc::new(Recorder(Default::default()));
        let host: HostRef = rec.clone();
        let trade = |price: f64| TradeTick { symbol: "A".into(), price, change: None, change_percent: None, ext_change_percent: None, volume: None, source: None, trade_price: Some(price), trade_time: None };
        let mut p = Pending::new(&host);
        p.trade(trade(1.0));
        p.trade(trade(2.0));
        p.flush();
        assert!(rec.0.lock().unwrap().is_empty());
        // the trade interval is over
        p.trades_sent = Instant::now() - TRADE_FLUSH;
        p.flush();
        let out: Vec<_> = rec.0.lock().unwrap().drain(..).map(|(n, v)| (n, v["price"].as_f64())).collect();
        assert_eq!(out, vec![("trade-tick", Some(2.0))]);
        // the session ends: what is left is sent
        p.trade(trade(3.0));
        drop(p);
        assert_eq!(rec.0.lock().unwrap().len(), 1);
    }
}
