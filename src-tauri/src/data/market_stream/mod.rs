/*
 * Market stream client — the gateway's `/market/v1/stream`.
 *
 * One long-lived background task holds the connection. The frontend
 * (Solid) sends subscription updates via the commands in
 * `commands/realtime.rs`, which push messages onto an mpsc channel that
 * this task drains. Incoming stream messages are parsed and re-emitted as
 * typed tauri-specta events for the frontend to consume.
 *
 * The gateway holds the one upstream connection and shares it between all
 * apps, so several connections of this app (the live session, the
 * entitlement probe) may be open at once, and no other program can take the
 * slot away.
 *
 * Reconnect strategy:
 *   • Outer loop wraps connect + auth + session. On any error the loop
 *     waits with exponential backoff (1s → 30s, doubling) before
 *     retrying. While waiting, the mpsc receiver still drains so any
 *     subscription updates from the frontend update the desired state;
 *     on reconnect we replay it.
 *   • A clean session-end (rx closed = app shutting down) returns the
 *     task. A graceful WS close resets the backoff.
 *
 * Modes (see `Mode`):
 *   • SECOND_BARS — spawned today, next to the REST poller: `bar1s:<T>` for
 *     charted symbols, gated on the probed `StreamCaps.second_bars`, and
 *     connected only while a chart is open.
 *   • MINUTE_AND_TRADES — `bar1m:` + `trade:`, not spawned: trades carry every
 *     print (pre/post included) while the watchlist shows the regular-session
 *     Last, and minute bars have no day bar, so the poller serves those.
 *
 * Protocol (`gateway/doc/README.md`, "Market API (v2)"; every server message
 * is a JSON array of objects):
 *   • Auth     {"op":"auth","token":"<gateway token>"} as the first message →
 *              {"type":"status","status":"authenticated"}, or
 *              {"type":"error","code":"UNAUTHORIZED"} and the socket closes
 *   • Sub      {"op":"subscribe","channels":["bar1s:AAPL","trade:AAPL"]}
 *   • Unsub    {"op":"unsubscribe","channels":["bar1s:AAPL"]}
 *   • Replies  {"type":"subscribed"|"unsubscribed","channel"},
 *              {"type":"error","code":"NOT_ENTITLED"|"INVALID_CHANNEL","channel"}
 *   • Data     {"type":"bar","tf":"1s"|"1m","ticker","t","end","o","h","l","c","v","vw"},
 *              {"type":"trade","ticker","t","p","size"},
 *              {"type":"quote","ticker","t","bid","bidSize","ask","askSize"}
 */
// MINUTE_AND_TRADES / `spawn` / `parse_trade` are unused while SECOND_BARS is
// the only spawned mode. Which channels the plan may use is measured by
// `probe_channels` (13/10/2026 through the gateway: bar1m / bar1s granted,
// trade / quote NOT_ENTITLED). Allow dead code module-wide rather than
// per-fn attributes.
#![allow(dead_code)]
use crate::data::gateway::{self, STREAM_URL};
use crate::data::provider::capabilities::StreamCaps;
use crate::data::provider::entitlements;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

mod events;
mod subscriptions;

pub use events::{ChartAggregate, SecondAggregate, TradeTick};
use events::handle_text;
pub use subscriptions::{SubscribeMsg, SubscriptionState};

/// Longest wait for the subscribe replies during `probe_channels`.
const PROBE_REPLY_WAIT: Duration = Duration::from_secs(6);
/// Longest wait for the auth answer.
const AUTH_WAIT: Duration = Duration::from_secs(10);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Re-check this often while the build has no gateway token. A local read.
const NO_KEY_RETRY: Duration = Duration::from_secs(2);

/// State managed by the connection task — exposed via app state so the
/// command handlers can push messages onto the mpsc.
pub struct WsHandle {
    pub tx: mpsc::Sender<SubscribeMsg>,
}

/// Which channels a live session carries, and when it may connect.
#[derive(Clone, Copy)]
struct Mode {
    /// Channel prefix for charted symbols ("bar1m:" minute bars, "bar1s:"
    /// second bars).
    chart: &'static str,
    /// Channel prefix for watchlist symbols ("trade:"), or none.
    watch: Option<&'static str>,
    /// Stream entitlement required before connecting; `None` = always.
    gate: Option<fn(&StreamCaps) -> bool>,
    /// Hold the connection only while something is subscribed.
    lazy: bool,
}

fn wants_second_bars(s: &StreamCaps) -> bool {
    s.second_bars
}

/// Minute bars for charts + trades for the watchlist (the push feed, kept for
/// a switch-over; not spawned today).
const MINUTE_AND_TRADES: Mode = Mode { chart: "bar1m:", watch: Some("trade:"), gate: None, lazy: false };

/// 1-second bars for charted symbols: the live source of the seconds charts,
/// running next to the REST poller (which keeps the watchlist quotes and the
/// minute / day bars).
const SECOND_BARS: Mode = Mode { chart: "bar1s:", watch: None, gate: Some(wants_second_bars), lazy: true };

pub fn spawn(app: AppHandle) -> WsHandle {
    spawn_mode(app, MINUTE_AND_TRADES)
}

/// The second-bars stream task. Connects only when the probed entitlements
/// allow the `bar1s` channel and a chart is open; otherwise it stays idle and
/// the seconds charts keep their REST tail refresh.
pub fn spawn_second_bars(app: AppHandle) -> WsHandle {
    spawn_mode(app, SECOND_BARS)
}

/// One `WsHandle` feeding several live tasks (the poller + the stream task):
/// every subscription update is copied to each.
pub fn fan_out(handles: Vec<WsHandle>) -> WsHandle {
    let (tx, mut rx) = mpsc::channel::<SubscribeMsg>(32);
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            for h in &handles {
                let _ = h.tx.send(msg.clone()).await;
            }
        }
    });
    WsHandle { tx }
}

fn spawn_mode(app: AppHandle, mode: Mode) -> WsHandle {
    let (tx, rx) = mpsc::channel::<SubscribeMsg>(32);
    // NOTE: use Tauri's async runtime, not `tokio::spawn`. This is called
    // from the `.setup()` hook, which runs outside any ambient Tokio
    // runtime context — a bare `tokio::spawn` there panics with "there is
    // no reactor running". `tauri::async_runtime::spawn` targets Tauri's
    // managed Tokio runtime explicitly, so it works from anywhere.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_connection(app, rx, mode).await {
            eprintln!("[market_stream] task exited fatally: {e:#}");
        }
    });
    WsHandle { tx }
}

/// Something for this mode to subscribe to.
fn has_work(mode: Mode, state: &SubscriptionState) -> bool {
    !state.chart_symbols().is_empty() || (mode.watch.is_some() && !state.watch_union().is_empty())
}

/// Entitled (per the probe) and, for a lazy mode, something to subscribe to.
fn may_connect(mode: Mode, ent: &entitlements::State, state: &SubscriptionState) -> bool {
    let entitled = mode.gate.is_none_or(|g| ent.stream_allows(g));
    entitled && (!mode.lazy || has_work(mode, state))
}

async fn run_connection(
    app: AppHandle,
    mut rx: mpsc::Receiver<SubscribeMsg>,
    mode: Mode,
) -> Result<()> {
    // Subscription state outlives any single session so we can replay
    // after a reconnect. The frontend's "desired state" wins.
    let mut state = SubscriptionState::default();
    let mut backoff = BACKOFF_START;
    let mut ent_rx = entitlements::subscribe();

    loop {
        // Gate: wait (still applying subscription updates) until the plan is
        // entitled and there is something to stream.
        let ready = may_connect(mode, &ent_rx.borrow(), &state);
        if !ready {
            tokio::select! {
                msg = rx.recv() => {
                    let Some(msg) = msg else { return Ok(()) }; // app shutting down
                    state.apply(msg);
                }
                r = ent_rx.changed() => {
                    if r.is_err() {
                        return Ok(());
                    }
                }
            }
            continue;
        }

        // No token compiled in: stay idle (still draining subscription
        // updates) rather than end the task.
        let Some(token) = gateway::token() else {
            if wait_with_drain(&mut rx, NO_KEY_RETRY, &mut state).await {
                return Ok(()); // mpsc closed — app shutting down
            }
            continue;
        };

        match run_session(&app, token, &mut rx, &mut state, mode, &mut ent_rx).await {
            Ok(SessionExit::ShuttingDown) => {
                // mpsc closed — the app handle was dropped. Exit cleanly.
                return Ok(());
            }
            Ok(SessionExit::Idle) => {
                // Nothing left to stream, or the entitlement went away (e.g. a
                // new token is being probed): back to the gate, no wait.
                backoff = BACKOFF_START;
                continue;
            }
            Ok(SessionExit::WsClosed) => {
                eprintln!("[market_stream] closed cleanly; reconnecting");
                backoff = BACKOFF_START;
            }
            Err(e) => {
                eprintln!(
                    "[market_stream] session error: {e:#}; reconnecting in {}s",
                    backoff.as_secs()
                );
            }
        }
        // Backoff wait, but keep draining subscription updates so the
        // desired state is current when we reconnect.
        if wait_with_drain(&mut rx, backoff, &mut state).await {
            return Ok(()); // mpsc closed during wait
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

enum SessionExit {
    WsClosed,
    ShuttingDown,
    /// Nothing to stream or no longer entitled: disconnect and re-gate.
    Idle,
}

/// Channel list "<prefix><TICKER>" for a ticker set.
fn channels(prefix: &str, syms: &HashSet<String>) -> Vec<String> {
    syms.iter().map(|s| format!("{prefix}{s}")).collect()
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect and authenticate (the token as the first message, so it never
/// rides in a URL).
async fn connect_authed(token: &str) -> Result<WsStream> {
    let (mut ws, _resp) = connect_async(STREAM_URL).await.context("stream connect failed")?;
    let auth = serde_json::json!({ "op": "auth", "token": token });
    ws.send(Message::Text(auth.to_string())).await.context("stream send auth failed")?;
    tokio::time::timeout(AUTH_WAIT, wait_for_auth(&mut ws))
        .await
        .map_err(|_| anyhow!("stream: no auth answer after {} s", AUTH_WAIT.as_secs()))??;
    Ok(ws)
}

async fn run_session(
    app: &AppHandle,
    token: &str,
    rx: &mut mpsc::Receiver<SubscribeMsg>,
    state: &mut SubscriptionState,
    mode: Mode,
    ent_rx: &mut tokio::sync::watch::Receiver<entitlements::State>,
) -> Result<SessionExit> {
    let ws = connect_authed(token).await?;
    let (mut write, mut read) = ws.split();
    eprintln!("[market_stream] connected + authenticated ({}*)", mode.chart);

    // Replay desired subscription state. The frontend may have churned
    // the chart slots / watchlists while we were disconnected.
    let mut replay = channels(mode.chart, &state.chart_tickers());
    if let Some(prefix) = mode.watch {
        replay.extend(channels(prefix, &state.watch_tickers()));
    }
    send_op(&mut write, "subscribe", &replay).await?;

    // Main loop — diff incoming subscription updates against current
    // state and emit minimal sub/unsub messages; forward incoming data
    // messages as typed events.
    loop {
        tokio::select! {
            sub = rx.recv() => {
                let Some(sub) = sub else { return Ok(SessionExit::ShuttingDown); };
                // Diff the UNION views before/after applying — an owner update
                // only touches the wire when it changes the merged sets.
                let prev_c = state.chart_tickers();
                let prev_w = state.watch_tickers();
                state.apply(sub);
                if mode.lazy && !has_work(mode, state) {
                    return Ok(SessionExit::Idle);
                }
                let next_c = state.chart_tickers();
                let next_w = state.watch_tickers();
                let mut drops = channels(mode.chart, &prev_c.difference(&next_c).cloned().collect());
                let mut adds = channels(mode.chart, &next_c.difference(&prev_c).cloned().collect());
                if let Some(p) = mode.watch {
                    drops.extend(channels(p, &prev_w.difference(&next_w).cloned().collect()));
                    adds.extend(channels(p, &next_w.difference(&prev_w).cloned().collect()));
                }
                send_op(&mut write, "unsubscribe", &drops).await?;
                send_op(&mut write, "subscribe", &adds).await?;
            }
            r = ent_rx.changed() => {
                if r.is_err() {
                    return Ok(SessionExit::ShuttingDown);
                }
                if let Some(gate) = mode.gate {
                    if !ent_rx.borrow().stream_allows(gate) {
                        return Ok(SessionExit::Idle);
                    }
                }
            }
            frame = read.next() => {
                let Some(frame) = frame else { return Ok(SessionExit::WsClosed); };
                let frame = frame.context("stream read error")?;
                match frame {
                    Message::Text(txt) => handle_text(app, state, &txt),
                    Message::Close(_) => return Ok(SessionExit::WsClosed),
                    _ => {}
                }
            }
        }
    }
}

/// Sleep up to `duration` while still draining subscription updates so
/// the desired state stays current. Returns `true` if the mpsc closed
/// (app shutting down) so the caller can exit.
async fn wait_with_drain(
    rx: &mut mpsc::Receiver<SubscribeMsg>,
    duration: Duration,
    state: &mut SubscriptionState,
) -> bool {
    let deadline = Instant::now() + duration;
    loop {
        tokio::select! {
            _ = sleep_until(deadline) => return false,
            msg = rx.recv() => {
                let Some(msg) = msg else { return true };
                state.apply(msg);
            }
        }
    }
}

/// The server messages of one text frame (a JSON array of objects).
fn messages(txt: &str) -> Vec<serde_json::Value> {
    match serde_json::from_str::<serde_json::Value>(txt) {
        Ok(serde_json::Value::Array(items)) => items,
        Ok(v @ serde_json::Value::Object(_)) => vec![v],
        _ => Vec::new(),
    }
}

fn field<'a>(m: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    m.get(key).and_then(|v| v.as_str())
}

/// The stream's error message: its code and text (no ref on the stream).
fn error_text(m: &serde_json::Value) -> String {
    let code = field(m, "code").unwrap_or("ERROR");
    match field(m, "error") {
        Some(e) => format!("{e} ({code})"),
        None => code.to_string(),
    }
}

async fn wait_for_auth(ws: &mut WsStream) -> Result<()> {
    while let Some(frame) = ws.next().await {
        let frame = frame.context("stream closed before auth")?;
        let Message::Text(txt) = frame else { continue };
        for m in messages(&txt) {
            match field(&m, "type") {
                Some("status") if field(&m, "status") == Some("authenticated") => return Ok(()),
                Some("error") => return Err(anyhow!("stream auth failed: {}", error_text(&m))),
                _ => {}
            }
        }
    }
    Err(anyhow!("stream closed without auth answer"))
}

/// Send one subscribe / unsubscribe for `channels` (nothing when empty).
async fn send_op<W>(write: &mut W, op: &str, channels: &[String]) -> Result<()>
where
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    if channels.is_empty() {
        return Ok(());
    }
    eprintln!("[market_stream] -> {op} {}", channels.join(","));
    let msg = serde_json::json!({ "op": op, "channels": channels });
    write.send(Message::Text(msg.to_string())).await.context("stream send failed")?;
    Ok(())
}

/// Entitlement probe: connect, authenticate and subscribe to `channels`
/// (e.g. "bar1m:AAPL") in one message; every reply names its channel. Returns
/// one bool per channel (true = subscribed), then closes. A channel without a
/// reply within `PROBE_REPLY_WAIT` is an error.
pub async fn probe_channels(channels: &[String]) -> Result<Vec<bool>> {
    let token = gateway::token().ok_or_else(|| anyhow!(gateway::NO_TOKEN))?;
    let mut ws = connect_authed(token).await?;
    send_op(&mut ws, "subscribe", channels).await?;
    let mut granted: HashMap<&str, bool> = HashMap::new();
    let deadline = Instant::now() + PROBE_REPLY_WAIT;
    while granted.len() < channels.len() {
        let frame = tokio::time::timeout_at(deadline, ws.next())
            .await
            .map_err(|_| {
                let missing: Vec<&str> = channels.iter().map(String::as_str).filter(|c| !granted.contains_key(c)).collect();
                anyhow!("stream probe: no subscribe reply for {}", missing.join(","))
            })?
            .ok_or_else(|| anyhow!("stream closed during probe"))?
            .context("stream probe read error")?;
        let Message::Text(txt) = frame else { continue };
        for m in messages(&txt) {
            let Some(ch) = field(&m, "channel").and_then(|c| channels.iter().map(String::as_str).find(|x| *x == c)) else {
                continue; // data, or a reply without channel
            };
            match field(&m, "type") {
                Some("subscribed") => {
                    granted.insert(ch, true);
                }
                Some("error") => {
                    eprintln!("[market_stream] probe {ch}: {}", error_text(&m));
                    granted.insert(ch, false);
                }
                _ => {}
            }
        }
    }
    let _ = ws.close(None).await;
    Ok(channels.iter().map(|c| granted.get(c.as_str()).copied().unwrap_or(false)).collect())
}

/// Look up the WsHandle from app state — used by the realtime commands.
pub fn handle(app: &AppHandle) -> tauri::State<'_, WsHandle> {
    app.state::<WsHandle>()
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use crate::data::provider::capabilities::{DataStatus, Entitlements, HistoryFloor};

    fn ent(stream: Option<StreamCaps>) -> entitlements::State {
        entitlements::State {
            settled: true,
            ent: Some(Entitlements {
                data_status: DataStatus::DelayedStreaming,
                raw_status: "delayed".into(),
                delay_sec: 900,
                history_floor: HistoryFloor { second: None, minute: None, day: None },
                stream,
                checked_at: String::new(),
            }),
        }
    }
    fn caps(second_bars: bool) -> Option<StreamCaps> {
        Some(StreamCaps { minute_bars: true, second_bars, trades: true, quotes: false })
    }

    /// The second-bars session connects only when entitled AND a chart is open.
    #[test]
    fn second_bars_gate() {
        let mut state = SubscriptionState::default();
        assert!(!may_connect(SECOND_BARS, &ent(caps(true)), &state), "no chart open");
        state.apply(SubscribeMsg::SetChart { owner: "main:0".into(), symbol: Some("AAPL".into()) });
        assert!(may_connect(SECOND_BARS, &ent(caps(true)), &state));
        assert!(!may_connect(SECOND_BARS, &ent(caps(false)), &state), "bar1s not granted");
        assert!(!may_connect(SECOND_BARS, &ent(None), &state), "stream not probed yet");
        assert!(!may_connect(SECOND_BARS, &entitlements::State::default(), &state), "no entitlements");
        // A watchlist alone is no work for a chart-only mode.
        let mut w = SubscriptionState::default();
        w.apply(SubscribeMsg::SetWatchlist { owner: "main".into(), symbols: vec!["AAPL".into()] });
        assert!(!may_connect(SECOND_BARS, &ent(caps(true)), &w));
    }

    #[test]
    fn server_messages_are_arrays_of_objects() {
        let m = messages(r#"[{"type":"status","status":"connected"},{"type":"error","code":"NOT_ENTITLED","channel":"trade:AAPL","error":"this data is not available"}]"#);
        assert_eq!(m.len(), 2);
        assert_eq!(error_text(&m[1]), "this data is not available (NOT_ENTITLED)");
        assert!(messages("not json").is_empty());
    }

    /// Live probe of the stream channels through the gateway. Run with:
    ///   cargo test --lib live_stream_probe -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the gateway stream; run explicitly"]
    async fn live_stream_probe() {
        let chans: Vec<String> = ["bar1m:AAPL", "bar1s:AAPL", "trade:AAPL", "quote:AAPL"].map(String::from).to_vec();
        let granted = probe_channels(&chans).await.expect("probe");
        eprintln!("granted: {granted:?}");
        assert_eq!(granted.len(), 4);
    }
}
