//! The events re-emitted to the frontend and the parsing of the stream's
//! text frames into them.
use super::subscriptions::SubscriptionState;
use crate::data::live_quotes;
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

/// The trades of a charted symbol over a tenth of a second (`trade` channel, a
/// subscriber's): what the forming bar of every interval above one second takes
/// in. `time` is the last one's, UNIX seconds.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
pub struct ChartTrade {
    pub symbol: String,
    pub time: f64,
    pub price: f64,
    pub high: f64,
    pub low: f64,
    /// Shares traded: added to the bar's.
    pub volume: f64,
    /// In the regular session: daily and longer bars take no other.
    pub regular: bool,
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
    /// High and low of that minute so far: what an alert read in the window
    /// (web build) needs to see the range the backend engine sees.
    #[serde(default)]
    pub trade_high: Option<f64>,
    #[serde(default)]
    pub trade_low: Option<f64>,
    /// The regular session's high and low (today's once traded, else the prior
    /// session's, as `last`), so the details panel's day range moves with the
    /// quote. `None` on the WS push path: the UI keeps the prior range.
    #[serde(default)]
    pub day_high: Option<f64>,
    #[serde(default)]
    pub day_low: Option<f64>,
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
    /// "not_allowed" (the pass opens no real-time session). None: the connection
    /// was lost, and is being made again.
    pub reason: Option<String>,
}

/// One trade of a tick chart: when, its price and its size.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    /// UNIX milliseconds.
    pub time_ms: f64,
    pub price: f64,
    pub volume: f64,
}

/// The new trades of a symbol on a tick chart (`ticks` channel, real-time only), in order.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
#[serde(rename_all = "camelCase")]
pub struct LiveTicks {
    pub symbol: String,
    pub ticks: Vec<Tick>,
}

/// The best bid and ask of a charted symbol: the chart's bid and ask lines. From the stream's `quote` channel (a
/// real-time session's, the newest per 100 ms), a real-time snapshot's last quote, or a data plugin's quote.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
#[serde(rename_all = "camelCase")]
pub struct ChartQuote {
    pub symbol: String,
    /// UNIX milliseconds of the quote (0 when not known): an older one does not replace a newer.
    pub time: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub bid_size: Option<f64>,
    pub ask_size: Option<f64>,
}

event!(MarketTier, "market-tier");
event!(ChartQuote, "chart-quote");
event!(LiveTicks, "live-ticks");
event!(ChartAggregate, "chart-aggregate");
event!(SecondAggregate, "second-aggregate");
event!(TradeTick, "trade-tick");
event!(ChartTrade, "chart-trade");

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
    /// Every trade of the charts: each adds its volume.
    chart_trades: Vec<ChartTrade>,
    /// The ticks of the tick charts, in order.
    ticks: Vec<LiveTicks>,
    /// The newest quote of each charted symbol.
    quotes: HashMap<String, ChartQuote>,
    trades: HashMap<String, TradeTick>,
    trades_sent: Instant,
    /// The trades of each symbol's current minute, as the bar the host's
    /// alert rules read with each trade.
    trade_bars: HashMap<String, Candle>,
}

impl Pending {
    pub(super) fn new(app: &HostRef) -> Self {
        Self { app: app.clone(), minute: HashMap::new(), second: HashMap::new(), chart_trades: Vec::new(), ticks: Vec::new(), quotes: HashMap::new(), trades: HashMap::new(), trades_sent: Instant::now(), trade_bars: HashMap::new() }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.minute.is_empty() && self.second.is_empty() && self.chart_trades.is_empty() && self.ticks.is_empty() && self.quotes.is_empty() && self.trades.is_empty()
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
    /// every trade (#265), with what its minute traded so far. `tick.price` is
    /// the regular session's last, `trade_price` the trade's, `trade_high` and
    /// `trade_low` its range.
    fn trade(&mut self, mut tick: TradeTick) {
        let price = tick.trade_price.unwrap_or(tick.price);
        let (high, low) = (tick.trade_high.unwrap_or(price), tick.trade_low.unwrap_or(price));
        let bar = tick.trade_time.map(|time| {
            let new = Candle { time, open: price, high, low, close: price, volume: 0.0 };
            let bar = self.trade_bars.entry(tick.symbol.clone()).or_insert_with(|| new.clone());
            if bar.time != time {
                *bar = new;
            }
            bar.high = bar.high.max(high);
            bar.low = bar.low.min(low);
            bar.close = price;
            bar.clone()
        });
        self.app.on_quote(&tick.symbol, tick.price, bar.as_ref());
        // The views get the newest trade only: it carries the minute's range.
        tick.trade_high = bar.as_ref().map(|b| b.high);
        tick.trade_low = bar.as_ref().map(|b| b.low);
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
        for trade in self.chart_trades.drain(..) {
            let _ = trade.emit(&self.app);
        }
        for ticks in self.ticks.drain(..) {
            let _ = ticks.emit(&self.app);
        }
        for (_, quote) in self.quotes.drain() {
            let _ = quote.emit(&self.app);
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
                            pending.minute(ChartAggregate { symbol: symbol.clone(), ..agg.clone() });
                        }
                    }
                }
                Some("1s") => {
                    if let Some(bar) = parse_second(&m) {
                        for symbol in state.chart_symbols_for(&bar.symbol) {
                            pending.second(SecondAggregate { symbol: symbol.clone(), ..bar.clone() });
                        }
                    }
                }
                _ => {}
            },
            "trade" => {
                if let Some(t) = parse_trade(&m) {
                    let regular = live_quotes::regular_session(t.ms);
                    for symbol in state.chart_symbols_for(&t.ticker) {
                        pending.chart_trades.push(t.chart(symbol, regular));
                    }
                    // Its regular last, change and range: none until the symbol was polled once.
                    if let Some(q) = live_quotes::traded(&t.ticker, t.ms, t.price, t.high, t.low) {
                        for symbol in state.symbols_for(&t.ticker) {
                            pending.trade(t.quote(symbol, &q));
                        }
                    }
                }
            }
            "quote" => {
                if let Some((ticker, quote)) = parse_quote(&m) {
                    for symbol in state.chart_symbols_for(&ticker) {
                        pending.quotes.insert(symbol.clone(), ChartQuote { symbol: symbol.clone(), ..quote.clone() });
                    }
                }
            }
            "ticks" => {
                if let Some((ticker, ticks)) = parse_ticks(&m) {
                    for symbol in state.tick_symbols_for(&ticker) {
                        pending.ticks.push(LiveTicks { symbol: symbol.clone(), ticks: ticks.clone() });
                    }
                }
            }
            kind @ ("subscribed" | "unsubscribed") => {
                if let Some(ticker) = m.get("channel").and_then(|v| v.as_str()).and_then(|c| c.strip_prefix(super::TRADES)) {
                    live_quotes::set_streamed(ticker, kind == "subscribed");
                }
            }
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

/// A `quote` message: its ticker and its bid and ask (a quote without either is left out).
fn parse_quote(m: &serde_json::Value) -> Option<(String, ChartQuote)> {
    let ticker = m.get("ticker")?.as_str()?.to_string();
    let num = |k: &str| m.get(k).and_then(|v| v.as_f64()).filter(|v| v.is_finite());
    let price = |k: &str| num(k).filter(|v| *v > 0.0);
    let quote = ChartQuote { symbol: String::new(), time: num("t").unwrap_or(0.0), bid: price("bid"), ask: price("ask"), bid_size: num("bidSize"), ask_size: num("askSize") };
    (quote.bid.is_some() || quote.ask.is_some()).then_some((ticker, quote))
}

/// A `ticks` message: its ticker and its trades `[t, p, size]` (a row without a time or a price is left out).
fn parse_ticks(m: &serde_json::Value) -> Option<(String, Vec<Tick>)> {
    let ticker = m.get("ticker")?.as_str()?.to_string();
    let ticks: Vec<Tick> = m
        .get("ticks")?
        .as_array()?
        .iter()
        .filter_map(|r| {
            let r = r.as_array()?;
            let n = |i: usize| r.get(i).and_then(|v| v.as_f64());
            let tick = Tick { time_ms: n(0)?, price: n(1)?, volume: n(2).unwrap_or(0.0) };
            (tick.price > 0.0).then_some(tick)
        })
        .collect();
    (!ticks.is_empty()).then_some((ticker, ticks))
}

fn parse_second(m: &serde_json::Value) -> Option<SecondAggregate> {
    let (symbol, time, [open, high, low, close], volume) = bar_values(m)?;
    Some(SecondAggregate { symbol, time, open, high, low, close, volume })
}

fn parse_minute(m: &serde_json::Value) -> Option<ChartAggregate> {
    let (symbol, time, [open, high, low, close], volume) = bar_values(m)?;
    Some(ChartAggregate { symbol, time, open, high, low, close, volume, day: None })
}

/// One `trade` message: the last price, the range and the volume of its trades.
struct StreamTrade {
    ticker: String,
    ms: f64,
    price: f64,
    high: f64,
    low: f64,
    volume: f64,
}

impl StreamTrade {
    fn chart(&self, symbol: &str, regular: bool) -> ChartTrade {
        ChartTrade {
            symbol: symbol.to_string(),
            time: (self.ms / 1000.0).floor(),
            price: self.price,
            high: self.high,
            low: self.low,
            volume: self.volume,
            regular,
        }
    }

    /// The watchlist quote; the session's volume stays the polled one.
    fn quote(&self, symbol: &str, q: &live_quotes::Quote) -> TradeTick {
        TradeTick {
            symbol: symbol.to_string(),
            price: q.last,
            change: Some(q.change),
            change_percent: Some(q.change_percent),
            ext_change_percent: q.ext_change_percent,
            volume: None,
            source: Some(q.source.to_string()),
            trade_price: Some(self.price),
            trade_time: Some((self.ms / 60_000.0).floor() * 60.0),
            // Made the minute's as they arrive (`Pending::trade`).
            trade_high: Some(self.high),
            trade_low: Some(self.low),
            day_high: Some(q.day_high),
            day_low: Some(q.day_low),
        }
    }
}

fn parse_trade(m: &serde_json::Value) -> Option<StreamTrade> {
    let num = |k: &str| m.get(k).and_then(|v| v.as_f64());
    let price = num("p").filter(|p| *p > 0.0)?;
    Some(StreamTrade {
        ticker: m.get("ticker")?.as_str()?.to_string(),
        ms: num("t")?,
        price,
        high: num("h").unwrap_or(price).max(price),
        low: num("l").filter(|l| *l > 0.0).unwrap_or(price).min(price),
        volume: num("size").unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_quote_message_gives_its_bid_and_ask() {
        let m: serde_json::Value = serde_json::from_str(r#"{"type":"quote","ticker":"AAPL","t":1000,"bid":10.5,"bidSize":3,"ask":10.6,"askSize":null}"#).unwrap();
        let (ticker, q) = super::parse_quote(&m).unwrap();
        assert_eq!(ticker, "AAPL");
        assert_eq!((q.time, q.bid, q.ask, q.bid_size, q.ask_size), (1000.0, Some(10.5), Some(10.6), Some(3.0), None));
        assert!(super::parse_quote(&serde_json::json!({"type":"quote","ticker":"AAPL","bid":0,"ask":null})).is_none());
    }

    #[test]
    fn a_ticks_message_gives_its_trades() {
        let m: serde_json::Value = serde_json::from_str(r#"{"type":"ticks","ticker":"AAPL","ticks":[[1000,10.5,100],[1001,0,5],[1002,10.6]]}"#).unwrap();
        let (ticker, ticks) = super::parse_ticks(&m).unwrap();
        assert_eq!(ticker, "AAPL");
        assert_eq!(ticks, vec![super::Tick { time_ms: 1000.0, price: 10.5, volume: 100.0 }, super::Tick { time_ms: 1002.0, price: 10.6, volume: 0.0 }]);
        assert!(super::parse_ticks(&serde_json::json!({"type":"ticks","ticker":"AAPL","ticks":[]})).is_none());
    }

    use super::*;
    use crate::sync::LockExt;

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
            serde_json::from_str(r#"{"type":"trade","ticker":"SPY","t":1792000061700,"p":601.5,"size":100,"h":602,"l":601}"#).unwrap();
        let t = parse_trade(&trade).unwrap();
        let c = t.chart("AMEX:SPY", true);
        assert_eq!((c.symbol.as_str(), c.time, c.price, c.high, c.low, c.volume), ("AMEX:SPY", 1_792_000_061.0, 601.5, 602.0, 601.0, 100.0));
        let one: serde_json::Value = serde_json::from_str(r#"{"type":"trade","ticker":"SPY","t":1,"p":601.5,"size":100}"#).unwrap();
        let t = parse_trade(&one).unwrap();
        assert_eq!((t.high, t.low), (601.5, 601.5));
    }

    /// The events sent, by name and with their payload.
    struct Recorder(std::sync::Mutex<Vec<(&'static str, serde_json::Value)>>);
    impl crate::host::Host for Recorder {
        fn emit_value(&self, name: &'static str, payload: serde_json::Value) {
            self.0.locked().push((name, payload));
        }
    }

    /// A quote the host's alert rules read: price and bar (time, high, low).
    type Quote = (f64, Option<(f64, f64, f64)>);

    #[derive(Default)]
    struct Quotes(std::sync::Mutex<Vec<Quote>>);
    impl crate::host::Host for Quotes {
        fn emit_value(&self, _: &'static str, _: serde_json::Value) {}
        fn on_quote(&self, _symbol: &str, last: f64, minute: Option<&Candle>) {
            self.0.locked().push((last, minute.map(|b| (b.time, b.high, b.low))));
        }
    }

    #[test]
    fn every_trade_reaches_the_alert_rules_with_its_minute_so_far() {
        let quotes = std::sync::Arc::new(Quotes::default());
        let host: HostRef = quotes.clone();
        let trade = |price: f64, time: Option<f64>| TradeTick { symbol: "A".into(), price, change: None, change_percent: None, ext_change_percent: None, volume: None, source: None, trade_price: Some(price), trade_time: time, trade_high: None, trade_low: None, day_high: None, day_low: None };
        let mut p = Pending::new(&host);
        p.trade(trade(10.0, Some(60.0)));
        p.trade(trade(12.0, Some(60.0)));
        p.trade(trade(11.0, Some(60.0)));
        p.trade(trade(9.0, Some(120.0)));
        p.trade(trade(8.0, None));
        let got = quotes.0.locked().clone();
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
        let sent = |rec: &Recorder| rec.0.locked().drain(..).map(|(n, v)| (n, v["symbol"].as_str().unwrap().to_string(), v["time"].as_f64(), v["close"].as_f64())).collect::<Vec<_>>();
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
        let trade = |price: f64| TradeTick { symbol: "A".into(), price, change: None, change_percent: None, ext_change_percent: None, volume: None, source: None, trade_price: Some(price), trade_time: None, trade_high: None, trade_low: None, day_high: None, day_low: None };
        let mut p = Pending::new(&host);
        p.trade(trade(1.0));
        p.trade(trade(2.0));
        p.flush();
        assert!(rec.0.locked().is_empty());
        // the trade interval is over
        p.trades_sent = Instant::now() - TRADE_FLUSH;
        p.flush();
        let out: Vec<_> = rec.0.locked().drain(..).map(|(n, v)| (n, v["price"].as_f64())).collect();
        assert_eq!(out, vec![("trade-tick", Some(2.0))]);
        // the session ends: what is left is sent
        p.trade(trade(3.0));
        drop(p);
        assert_eq!(rec.0.locked().len(), 1);
    }
}
