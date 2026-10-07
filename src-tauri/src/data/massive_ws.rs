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
use crate::data::massive_rest::Candle;
use crate::data::provider::capabilities::StreamCaps;
use crate::data::provider::entitlements;
use crate::data::symbol::SymbolRef;
use crate::data::ticker_case;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::mpsc;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const WS_URL: &str = gateway::WS_URL;
/// Longest wait for one subscribe reply during `probe_channels`.
const PROBE_REPLY_WAIT: Duration = Duration::from_secs(4);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Re-check this often while the build has no gateway token. A local read.
const NO_KEY_RETRY: Duration = Duration::from_secs(2);

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
}

/// Sent by `commands/realtime.rs` to update what we're subscribed to.
/// The connection task diffs each update against its previous state and
/// emits subscribe / unsubscribe frames accordingly.
///
/// Owner-keyed: every window (and every chart pane within it) declares its
/// own desired state and the transport unions them. The previous single
/// global slot let the last writer win — a second window silently
/// unsubscribed the first's symbols, and in multi-pane layouts only one
/// pane received chart bars.
#[derive(Debug, Clone)]
pub enum SubscribeMsg {
    /// One pane's charted symbol. `owner` = "<window label>:<pane id>";
    /// None clears that pane's slot.
    SetChart { owner: String, symbol: Option<String> },
    /// One window's watchlist-union contribution. `owner` = window label.
    SetWatchlist { owner: String, symbols: Vec<String> },
    /// Window destroyed — drop its watchlist and every chart slot it owned.
    DropOwner { owner: String },
}

/// Owner-keyed desired-subscription state shared by the REST poller and the
/// WS transport: applies `SubscribeMsg`s and exposes the union views the
/// transports consume. Symbols are full names ("NASDAQ:AAPL"); the vendor
/// subscribes the ticker part and events go back under every full name that
/// subscribed that ticker.
#[derive(Debug, Default)]
pub struct SubscriptionState {
    /// "<window>:<pane>" → charted symbol.
    charts: std::collections::HashMap<String, String>,
    /// window label → that window's watchlist union.
    watchlists: std::collections::HashMap<String, HashSet<String>>,
}

impl SubscriptionState {
    pub fn apply(&mut self, msg: SubscribeMsg) {
        match msg {
            SubscribeMsg::SetChart { owner, symbol } => match symbol {
                Some(s) => {
                    self.charts.insert(owner, s);
                }
                None => {
                    self.charts.remove(&owner);
                }
            },
            SubscribeMsg::SetWatchlist { owner, symbols } => {
                if symbols.is_empty() {
                    self.watchlists.remove(&owner);
                } else {
                    self.watchlists.insert(owner, symbols.into_iter().collect());
                }
            }
            SubscribeMsg::DropOwner { owner } => {
                self.watchlists.remove(&owner);
                let prefix = format!("{owner}:");
                self.charts.retain(|k, _| !k.starts_with(&prefix));
            }
        }
    }

    /// Every currently-charted symbol (any window, any pane), deduped.
    pub fn chart_symbols(&self) -> HashSet<String> {
        self.charts.values().cloned().collect()
    }

    /// Union of every window's watchlist contribution.
    pub fn watch_union(&self) -> HashSet<String> {
        self.watchlists.values().flatten().cloned().collect()
    }

    /// Everything worth polling: watch union + charted symbols.
    pub fn all_symbols(&self) -> HashSet<String> {
        let mut out = self.watch_union();
        out.extend(self.chart_symbols());
        out
    }

    /// TRUE when any pane in any window charts `sym` (gates ChartAggregate emission).
    pub fn is_chart_symbol(&self, sym: &str) -> bool {
        self.charts.values().any(|s| s == sym)
    }

    /// Vendor tickers of the charted symbols.
    pub fn chart_tickers(&self) -> HashSet<String> {
        self.charts.values().map(|s| ticker_of(s)).collect()
    }

    /// Vendor tickers of the watchlist union.
    pub fn watch_tickers(&self) -> HashSet<String> {
        self.watch_union().iter().map(|s| ticker_of(s)).collect()
    }

    /// Vendor tickers of everything subscribed.
    pub fn all_tickers(&self) -> HashSet<String> {
        self.all_symbols().iter().map(|s| ticker_of(s)).collect()
    }

    /// Charted full names whose vendor ticker is `ticker`.
    pub fn chart_symbols_for(&self, ticker: &str) -> Vec<String> {
        self.chart_symbols().into_iter().filter(|s| ticker_of(s) == ticker).collect()
    }

    /// Subscribed full names (charts + watchlists) whose vendor ticker is `ticker`.
    pub fn symbols_for(&self, ticker: &str) -> Vec<String> {
        self.all_symbols().into_iter().filter(|s| ticker_of(s) == ticker).collect()
    }
}

/// Vendor ticker of a full name ("NASDAQ:AAPL" → "AAPL", "NYSE:BAC/PB" →
/// "BACpB": the vendor's spelling, see `ticker_case`).
fn ticker_of(symbol: &str) -> String {
    ticker_case::to_source(&SymbolRef::parse(symbol).ticker)
}

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

/// Parse one text frame and emit its events, once per subscribed full name
/// of the event's ticker. Returns `true` when the frame says another
/// connection on the same key closed this one (`max_connections`).
fn handle_text(app: &AppHandle, state: &SubscriptionState, txt: &str) -> bool {
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
    })
}

/// Look up the WsHandle from app state — used by the realtime commands.
pub fn handle(app: &AppHandle) -> tauri::State<'_, WsHandle> {
    app.state::<WsHandle>()
}

#[cfg(test)]
mod subscription_state_tests {
    use super::*;

    fn set_chart(s: &mut SubscriptionState, owner: &str, sym: Option<&str>) {
        s.apply(SubscribeMsg::SetChart {
            owner: owner.into(),
            symbol: sym.map(Into::into),
        });
    }
    fn set_watch(s: &mut SubscriptionState, owner: &str, syms: &[&str]) {
        s.apply(SubscribeMsg::SetWatchlist {
            owner: owner.into(),
            symbols: syms.iter().map(|x| x.to_string()).collect(),
        });
    }

    #[test]
    fn windows_merge_instead_of_clobbering() {
        let mut s = SubscriptionState::default();
        set_watch(&mut s, "main", &["AAPL", "TSLA"]);
        set_watch(&mut s, "chart-x", &["NVDA"]);
        let union = s.watch_union();
        assert!(union.contains("AAPL") && union.contains("TSLA") && union.contains("NVDA"));
        // Replacing one window's set leaves the other's intact.
        set_watch(&mut s, "chart-x", &["AMD"]);
        let union = s.watch_union();
        assert!(union.contains("AAPL") && union.contains("AMD") && !union.contains("NVDA"));
    }

    #[test]
    fn panes_hold_independent_chart_slots() {
        let mut s = SubscriptionState::default();
        set_chart(&mut s, "main:1", Some("AAPL"));
        set_chart(&mut s, "main:2", Some("TSLA"));
        assert!(s.is_chart_symbol("AAPL") && s.is_chart_symbol("TSLA"));
        // One pane clearing its slot must not silence the sibling.
        set_chart(&mut s, "main:1", None);
        assert!(!s.is_chart_symbol("AAPL") && s.is_chart_symbol("TSLA"));
        assert!(s.all_symbols().contains("TSLA"));
    }

    #[test]
    fn drop_owner_clears_window_and_its_panes_only() {
        let mut s = SubscriptionState::default();
        set_watch(&mut s, "main", &["AAPL"]);
        set_watch(&mut s, "chart-x", &["NVDA"]);
        set_chart(&mut s, "main:1", Some("SPY"));
        set_chart(&mut s, "chart-x:1", Some("QQQ"));
        set_chart(&mut s, "chart-x:2", Some("IWM"));
        s.apply(SubscribeMsg::DropOwner {
            owner: "chart-x".into(),
        });
        assert!(!s.watch_union().contains("NVDA"));
        assert!(!s.is_chart_symbol("QQQ") && !s.is_chart_symbol("IWM"));
        assert!(s.watch_union().contains("AAPL") && s.is_chart_symbol("SPY"));
        // A label that PREFIXES another must not over-match ("chart" vs "chart-x").
        set_chart(&mut s, "chart:9", Some("DIA"));
        s.apply(SubscribeMsg::DropOwner { owner: "char".into() });
        assert!(s.is_chart_symbol("DIA"));
    }

    /// Full names subscribe their vendor ticker; events map back to every
    /// full name of that ticker.
    #[test]
    fn full_names_map_to_tickers_and_back() {
        let mut s = SubscriptionState::default();
        set_chart(&mut s, "main:1", Some("NASDAQ:INTC"));
        set_chart(&mut s, "main:2", Some("BOATS:INTC"));
        set_watch(&mut s, "main", &["NYSE:IBM", "NASDAQ:INTC"]);
        assert_eq!(s.chart_tickers(), HashSet::from(["INTC".to_string()]));
        assert!(s.watch_tickers().contains("IBM"));
        let mut charts = s.chart_symbols_for("INTC");
        charts.sort();
        assert_eq!(charts, vec!["BOATS:INTC", "NASDAQ:INTC"]);
        assert_eq!(s.symbols_for("IBM"), vec!["NYSE:IBM"]);
        assert!(s.chart_symbols_for("IBM").is_empty());
    }

    #[test]
    fn empty_watchlist_removes_the_owner_entry() {
        let mut s = SubscriptionState::default();
        set_watch(&mut s, "main", &["AAPL"]);
        set_watch(&mut s, "main", &[]);
        assert!(s.watch_union().is_empty());
        assert!(s.all_symbols().is_empty());
    }
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
