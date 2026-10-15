//! The events re-emitted to the frontend and the parsing of the stream's
//! text frames into them.
use super::subscriptions::SubscriptionState;
use crate::data::massive_rest::Candle;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_specta::Event;

/// Per-minute aggregate (`AM`) re-emitted to the chart. One bar per minute
/// per symbol. `time` is the bar's start in **UNIX seconds** so it lines
/// up with lightweight-charts' UTCTimestamp type and the existing daily +
/// minute history payloads.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct ChartAggregate {
    pub symbol: String,
    pub time: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    /// Today's full-session daily bar when the transport knows it (the REST
    /// snapshot poller does; the WS `AM` path doesn't). Lets the frontend
    /// update the daily-family chart bar exactly — a warm daily load skips
    /// today's forming bar on purpose (see `fetch_daily_history`) and this is
    /// what fills it. The Candle's `time` is the snapshot's update stamp; the
    /// frontend re-buckets it to the daily-bar convention (midnight ET).
    pub day: Option<Candle>,
}

/// One 1-second bar (`A` channel) for a charted symbol: the live source of
/// the seconds charts (1S…45S). `time` is the bar start in UNIX seconds.
/// Separate from `ChartAggregate` because its volume covers ONE second, so
/// the frontend adds it into a coarser bucket instead of replacing.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct SecondAggregate {
    pub symbol: String,
    pub time: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// Trade (`T`) re-emitted to the watchlist for live last-price updates.
/// `change`/`change_percent`/`volume` ride along from the REST snapshot
/// poller (`massive_poll`) so the watchlist's Chg/Chg%/Vol columns go live
/// too; they're `Option` because a raw WS trade carries only a price, so the
/// push path leaves them `None` and the UI keeps the prior value.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TradeTick {
    pub symbol: String,
    /// Regular-session "Last" (not the latest pre/post trade — see
    /// `massive_rest::shape_snapshot`).
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

/// Parse one text frame and emit its events, once per subscribed full name
/// of the event's ticker. Returns `true` when the frame says another
/// connection on the same key closed this one (`max_connections`).
pub(super) fn handle_text(app: &AppHandle, state: &SubscriptionState, txt: &str) -> bool {
    let arr: serde_json::Value = match serde_json::from_str(txt) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Some(events) = arr.as_array() else {
        return false;
    };
    let mut kicked = false;
    for ev in events {
        let kind = ev.get("ev").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "AM" => {
                if let Some(agg) = parse_aggregate(ev) {
                    for symbol in state.chart_symbols_for(&agg.symbol) {
                        let _ = ChartAggregate { symbol, ..agg.clone() }.emit(app);
                    }
                }
            }
            "A" => {
                if let Some(bar) = parse_second(ev) {
                    for symbol in state.chart_symbols_for(&bar.symbol) {
                        let _ = SecondAggregate { symbol, ..bar.clone() }.emit(app);
                    }
                }
            }
            "T" => {
                if let Some(tick) = parse_trade(ev) {
                    for symbol in state.symbols_for(&tick.symbol) {
                        let _ = TradeTick { symbol, ..tick.clone() }.emit(app);
                    }
                }
            }
            "status" => {
                if let Some(msg) = ev.get("message").and_then(|v| v.as_str()) {
                    let status = ev.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    eprintln!("[massive_ws] status={status} message={msg}");
                    kicked |= status == "max_connections";
                    // On an error, also dump the raw frame — Massive does not
                    // name the offending symbol in `message`, but the preceding
                    // `-> subscribe …` line (see send_action) shows the exact
                    // params that drew this reply.
                    if status == "error" {
                        eprintln!("[massive_ws]    raw status frame: {ev}");
                    }
                }
            }
            _ => {}
        }
    }
    kicked
}

fn parse_second(ev: &serde_json::Value) -> Option<SecondAggregate> {
    Some(SecondAggregate {
        symbol: ev.get("sym")?.as_str()?.to_string(),
        // Bar start in ms, to seconds.
        time: (ev.get("s")?.as_f64()? / 1000.0).floor(),
        open: ev.get("o")?.as_f64()?,
        high: ev.get("h")?.as_f64()?,
        low: ev.get("l")?.as_f64()?,
        close: ev.get("c")?.as_f64()?,
        volume: ev.get("v").and_then(|v| v.as_f64()).unwrap_or(0.0),
    })
}

fn parse_aggregate(ev: &serde_json::Value) -> Option<ChartAggregate> {
    Some(ChartAggregate {
        symbol: ev.get("sym")?.as_str()?.to_string(),
        // Massive sends ms. Lightweight-charts wants seconds.
        time: (ev.get("s")?.as_f64()? / 1000.0).floor(),
        open: ev.get("o")?.as_f64()?,
        high: ev.get("h")?.as_f64()?,
        low: ev.get("l")?.as_f64()?,
        close: ev.get("c")?.as_f64()?,
        volume: ev.get("v").and_then(|v| v.as_f64()).unwrap_or(0.0),
        day: None,
    })
}

fn parse_trade(ev: &serde_json::Value) -> Option<TradeTick> {
    Some(TradeTick {
        symbol: ev.get("sym")?.as_str()?.to_string(),
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
