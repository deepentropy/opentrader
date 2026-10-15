/*
 * Massive WebSocket client — Feature 9.
 *
 * One long-lived background task holds the connection. The frontend
 * (Solid) sends subscription updates via the commands in
 * `commands/realtime.rs`, which push messages onto an mpsc channel that
 * this task drains. Incoming Massive events are parsed and re-emitted as
 * typed tauri-specta events for the frontend to consume.
 *
 * Endpoint: the OpenTrader gateway (`gateway::WS_URL`). It speaks the
 * Massive protocol with the app token in place of the key, shares one
 * upstream connection between all apps, and picks the delayed or real-time
 * Massive feed itself.
 *
 * Reconnect strategy:
 *   • Outer loop wraps connect + auth + session. On any error the loop
 *     waits with exponential backoff (1s → 30s, doubling) before
 *     retrying. While waiting, the mpsc receiver still drains so any
 *     subscription updates from the frontend update the desired state;
 *     on reconnect we replay it.
 *   • A clean session-end (rx closed = app shutting down) returns the
 *     task. A graceful WS close resets the backoff.
 *   • `max_connections` (another client on the same key took the one
 *     allowed connection) waits `KICKED_BACKOFF` instead of fighting back.
 *     The gateway never sends it (many apps share its upstream slot); the
 *     handling stays for a direct Massive connection.
 *
 * Modes (see `Mode`):
 *   • SECOND_BARS — spawned today, next to the REST poller: `A.<sym>` for
 *     charted symbols, gated on the probed `StreamCaps.second_bars`, and
 *     connected only while a chart is open.
 *   • MINUTE_AND_TRADES — the original AM + T feed, not spawned: `T` carries
 *     every trade (pre/post included) while the watchlist shows the
 *     regular-session Last, and AM has no day bar, so the poller serves those.
 *
 * Massive protocol cheat-sheet:
 *   • Auth     {"action":"auth","params":"<gateway token>"}
 *   • Sub      {"action":"subscribe","params":"AM.AAPL,T.AAPL"}
 *   • Unsub    {"action":"unsubscribe","params":"AM.AAPL"}
 *   • Events come in as JSON *arrays*, each element {"ev":"AM"|"A"|"T"|"status",…}.
 */
// MINUTE_AND_TRADES / `spawn` / `parse_trade` are unused while SECOND_BARS is
// the only spawned mode. Which channels the key may use is measured by
// `probe_channels`: on 27/09/2026 the delayed endpoint accepted AM / A / T and
// refused Q (direct, user key); through the gateway on 29/09/2026, AM / A
// accepted, T / Q refused. Allow dead code module-wide rather than per-fn attributes.
#![allow(dead_code)]
use crate::data::gateway;
use crate::data::provider::capabilities::StreamCaps;
use crate::data::provider::entitlements;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
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

const WS_URL: &str = gateway::WS_URL;
/// Longest wait for one subscribe reply during `probe_channels`.
const PROBE_REPLY_WAIT: Duration = Duration::from_secs(4);
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
    /// Channel prefix for charted symbols ("AM." minute bars, "A." second bars).
    chart: &'static str,
    /// Channel prefix for watchlist symbols ("T."), or none.
    watch: Option<&'static str>,
    /// Stream entitlement required before connecting; `None` = always.
    gate: Option<fn(&StreamCaps) -> bool>,
    /// Hold the connection only while something is subscribed. Massive allows
    /// one stream connection per key, and other programs may need it.
    lazy: bool,
}

fn wants_second_bars(s: &StreamCaps) -> bool {
    s.second_bars
}

/// Minute aggregates for charts + trades for the watchlist (the original
/// push feed, kept for a switch-over; not spawned today).
const MINUTE_AND_TRADES: Mode = Mode { chart: "AM.", watch: Some("T."), gate: None, lazy: false };

/// 1-second aggregates for charted symbols: the live source of the seconds
/// charts, running next to the REST poller (which keeps the watchlist quotes
/// and the minute / day bars).
const SECOND_BARS: Mode = Mode { chart: "A.", watch: None, gate: Some(wants_second_bars), lazy: true };

/// One stream connection per key: the live session and the entitlement probe
/// both hold this while connected, so they never overlap.
static WS_SLOT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Longest the entitlement probe waits for the connection slot.
const PROBE_SLOT_WAIT: Duration = Duration::from_secs(10);
/// Pause after another client on the same key took the connection
/// (`max_connections`), so the app does not fight it for the slot.
const KICKED_BACKOFF: Duration = Duration::from_secs(300);

pub fn spawn(app: AppHandle) -> WsHandle {
    spawn_mode(app, MINUTE_AND_TRADES)
}

/// The second-bars stream task. Connects only when the probed entitlements
/// allow the `A` channel and a chart is open; otherwise it stays idle and the
/// seconds charts keep their REST tail refresh.
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
            eprintln!("[massive_ws] task exited fatally: {e:#}");
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
        // Gate: wait (still applying subscription updates) until the key is
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
        let Some(api_key) = gateway::token() else {
            if wait_with_drain(&mut rx, NO_KEY_RETRY, &mut state).await {
                return Ok(()); // mpsc closed — app shutting down
            }
            continue;
        };

        match run_session(&app, api_key, &mut rx, &mut state, mode, &mut ent_rx).await {
            Ok(SessionExit::ShuttingDown) => {
                // mpsc closed — the app handle was dropped. Exit cleanly.
                return Ok(());
            }
            Ok(SessionExit::Idle) => {
                // Nothing left to stream, or the entitlement went away (e.g. a
                // new key is being probed): back to the gate, no wait.
                backoff = BACKOFF_START;
                continue;
            }
            Ok(SessionExit::Kicked) => {
                eprintln!(
                    "[massive_ws] another client took the key's stream connection; retrying in {}s",
                    KICKED_BACKOFF.as_secs()
                );
                if wait_with_drain(&mut rx, KICKED_BACKOFF, &mut state).await {
                    return Ok(());
                }
                continue;
            }
            Ok(SessionExit::WsClosed) => {
                eprintln!("[massive_ws] ws closed cleanly; reconnecting");
                backoff = BACKOFF_START;
            }
            Err(e) => {
                eprintln!(
                    "[massive_ws] session error: {e:#}; reconnecting in {}s",
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
    /// Another connection on the same key closed this one (`max_connections`).
    Kicked,
}

/// Channel list "<prefix><SYM>" for a symbol set.
fn channels(prefix: &str, syms: &HashSet<String>) -> Vec<String> {
    syms.iter().map(|s| format!("{prefix}{s}")).collect()
}

async fn run_session(
    app: &AppHandle,
    api_key: &str,
    rx: &mut mpsc::Receiver<SubscribeMsg>,
    state: &mut SubscriptionState,
    mode: Mode,
    ent_rx: &mut tokio::sync::watch::Receiver<entitlements::State>,
) -> Result<SessionExit> {
    // Held for the whole session: the entitlement probe waits on it.
    let _slot = WS_SLOT.lock().await;
    let (ws, _resp) = connect_async(WS_URL)
        .await
        .context("massive ws connect failed")?;
    let (mut write, mut read) = ws.split();

    // Auth.
    let auth = serde_json::json!({ "action": "auth", "params": api_key });
    write
        .send(Message::Text(auth.to_string()))
        .await
        .context("ws send auth failed")?;
    wait_for_auth(&mut read).await?;
    eprintln!("[massive_ws] connected + authed ({}*)", mode.chart);

    // Replay desired subscription state. The frontend may have churned
    // the chart slots / watchlists while we were disconnected.
    let charts = channels(mode.chart, &state.chart_tickers());
    if !charts.is_empty() {
        send_action(&mut write, "subscribe", &charts.join(",")).await?;
    }
    if let Some(prefix) = mode.watch {
        let watch = channels(prefix, &state.watch_tickers());
        if !watch.is_empty() {
            send_action(&mut write, "subscribe", &watch.join(",")).await?;
        }
    }

    // Main loop — diff incoming subscription updates against current
    // state and emit minimal sub/unsub frames; forward incoming text
    // frames as typed events.
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
                if !drops.is_empty() {
                    send_action(&mut write, "unsubscribe", &drops.join(",")).await?;
                }
                if !adds.is_empty() {
                    send_action(&mut write, "subscribe", &adds.join(",")).await?;
                }
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
                let frame = frame.context("ws read error")?;
                if let Message::Text(txt) = frame {
                    if handle_text(app, state, &txt) {
                        return Ok(SessionExit::Kicked);
                    }
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

async fn wait_for_auth<S>(read: &mut S) -> Result<()>
where
    S: futures_util::Stream<
            Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    while let Some(frame) = read.next().await {
        let frame = frame.context("ws closed before auth")?;
        let Message::Text(txt) = frame else { continue };
        let arr: serde_json::Value = serde_json::from_str(&txt).unwrap_or(serde_json::Value::Null);
        for ev in arr.as_array().into_iter().flatten() {
            if ev.get("ev").and_then(|v| v.as_str()) == Some("status") {
                match ev.get("status").and_then(|v| v.as_str()) {
                    Some("auth_success") => return Ok(()),
                    Some("auth_failed") => {
                        return Err(anyhow!(
                            "massive auth failed: {}",
                            ev.get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("(no message)")
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
    Err(anyhow!("ws closed without auth response"))
}

async fn send_action<W>(write: &mut W, action: &str, params: &str) -> Result<()>
where
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    // Log the outgoing params. Massive's `status=error message="not
    // authorized"` reply names no symbol, so this adjacent line is the only
    // way to correlate an auth rejection with the exact tickers/channel that
    // triggered it.
    eprintln!("[massive_ws] -> {action} {params}");
    let msg = serde_json::json!({ "action": action, "params": params });
    write
        .send(Message::Text(msg.to_string()))
        .await
        .context("ws send failed")?;
    Ok(())
}

/// Entitlement probe: connect to `url`, authenticate, and subscribe to each of
/// `channels` (e.g. "AM.AAPL") ONE AT A TIME — Massive's "not authorized"
/// reply names no channel, so only a sequential exchange attributes it.
/// Returns one bool per channel (true = subscribed), then closes.
///
/// Massive allows ONE stream connection per key: a second connection closes
/// the first with `max_connections` (observed 27/09/2026). It waits (up to
/// `PROBE_SLOT_WAIT`) for the live session's `WS_SLOT`, so the two never
/// overlap; another program on the same key still can, and its
/// `max_connections` reply aborts the probe with an error.
pub async fn probe_channels(url: &str, api_key: &str, channels: &[&str]) -> Result<Vec<bool>> {
    // Never overlap the live session's connection (one per key).
    let _slot = tokio::time::timeout(PROBE_SLOT_WAIT, WS_SLOT.lock())
        .await
        .map_err(|_| anyhow!("stream connection in use by the live session; channels not re-probed"))?;
    let (ws, _resp) = connect_async(url).await.context("massive ws probe connect failed")?;
    let (mut write, mut read) = ws.split();
    let auth = serde_json::json!({ "action": "auth", "params": api_key });
    write
        .send(Message::Text(auth.to_string()))
        .await
        .context("ws probe send auth failed")?;
    wait_for_auth(&mut read).await?;

    let mut out = Vec::with_capacity(channels.len());
    for ch in channels {
        send_action(&mut write, "subscribe", ch).await?;
        let deadline = Instant::now() + PROBE_REPLY_WAIT;
        let granted = 'reply: loop {
            let frame = tokio::time::timeout_at(deadline, read.next())
                .await
                .map_err(|_| anyhow!("no subscribe reply for {ch}"))?
                .ok_or_else(|| anyhow!("ws closed during probe"))?
                .context("ws probe read error")?;
            let Message::Text(txt) = frame else { continue };
            let arr: serde_json::Value = serde_json::from_str(&txt).unwrap_or(serde_json::Value::Null);
            for ev in arr.as_array().into_iter().flatten() {
                if ev.get("ev").and_then(|v| v.as_str()) != Some("status") {
                    continue; // a data event from an earlier granted channel
                }
                let msg = ev.get("message").and_then(|v| v.as_str()).unwrap_or("");
                match ev.get("status").and_then(|v| v.as_str()) {
                    Some("success") if msg.ends_with(ch) => break 'reply true,
                    Some("error") => break 'reply false,
                    Some("max_connections") => {
                        return Err(anyhow!("massive ws probe: {msg}"));
                    }
                    _ => {}
                }
            }
        };
        out.push(granted);
    }
    let _ = write.send(Message::Close(None)).await;
    Ok(out)
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
                raw_status: "DELAYED".into(),
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
        assert!(!may_connect(SECOND_BARS, &ent(caps(false)), &state), "A not granted");
        assert!(!may_connect(SECOND_BARS, &ent(None), &state), "stream not probed yet");
        assert!(!may_connect(SECOND_BARS, &entitlements::State::default(), &state), "no entitlements");
        // A watchlist alone is no work for a chart-only mode.
        let mut w = SubscriptionState::default();
        w.apply(SubscribeMsg::SetWatchlist { owner: "main".into(), symbols: vec!["AAPL".into()] });
        assert!(!may_connect(SECOND_BARS, &ent(caps(true)), &w));
    }
}
