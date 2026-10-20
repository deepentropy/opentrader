//! The events re-emitted to the frontend and the parsing of the stream's
//! text frames into them.
use super::subscriptions::SubscriptionState;
use crate::data::market_rest::Candle;
use serde::{Deserialize, Serialize};
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

event!(ChartAggregate, "chart-aggregate");
event!(SecondAggregate, "second-aggregate");
event!(TradeTick, "trade-tick");

/// Parse one text frame and emit its events, once per subscribed full name
/// of the message's ticker. Replies and errors are logged.
pub(super) fn handle_text(app: &HostRef, state: &SubscriptionState, txt: &str) {
    for m in super::messages(txt) {
        match m.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "bar" => match m.get("tf").and_then(|v| v.as_str()) {
                Some("1m") => {
                    if let Some(agg) = parse_minute(&m) {
                        for symbol in state.chart_symbols_for(&agg.symbol) {
                            let _ = ChartAggregate { symbol, ..agg.clone() }.emit(app);
                        }
                    }
                }
                Some("1s") => {
                    if let Some(bar) = parse_second(&m) {
                        for symbol in state.chart_symbols_for(&bar.symbol) {
                            let _ = SecondAggregate { symbol, ..bar.clone() }.emit(app);
                        }
                    }
                }
                _ => {}
            },
            "trade" => {
                if let Some(tick) = parse_trade(&m) {
                    for symbol in state.symbols_for(&tick.symbol) {
                        let _ = TradeTick { symbol, ..tick.clone() }.emit(app);
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
}
