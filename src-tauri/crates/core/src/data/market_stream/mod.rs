/*
 * Market stream client — the gateway's `/market/v1/stream`.
 *
 * One long-lived background task holds the connection. The frontend
 * (Solid) sends subscription updates via the commands in
 * `commands/realtime.rs`, which push messages onto an mpsc channel that
 * this task drains. Incoming stream messages are parsed and re-emitted as
 * typed events (`host::Event`) for the frontend to consume.
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
 * Real-time tier (#252): with a pass (`data::pass`, a subscribed account)
 * the session connects to `/market/v1/stream/rt` with the pass instead of the
 * app token, renews the pass on the open socket when the frontend hands a new
 * one, and stays connected while there is nothing to stream, so the gateway's
 * one-session-per-account rule sees this device. The gateway's `downgraded`
 * (pass expired, renewal refused, revoked) or `signed_in_elsewhere` ends the
 * session and the next one uses the delayed route (`MarketTier` tells the
 * frontend why).
 *
 * Mode (see `Mode`): SECOND_BARS, next to the REST poller: `bar1s:<T>` for
 * charted symbols, gated on the probed `StreamCaps.second_bars`, and connected
 * only while a chart is open. The watchlist and the minute bars stay with the
 * poller. A real-time session streams the trades of the charts and the
 * watchlists too (`desired`): charts above one second and quotes follow them
 * (`data::live_quotes` puts them together with the poller's snapshots).
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
use crate::data::gateway::{self, STREAM_RT_URL, STREAM_URL};
use crate::data::live_quotes;
use crate::data::pass;
use crate::data::symbol::could_be_ticker;
use crate::host::Event;
use crate::data::provider::capabilities::StreamCaps;
use crate::data::provider::entitlements;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use crate::host::HostRef;
use tokio::sync::mpsc;
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::tungstenite::Message;

mod events;
mod subscriptions;

pub use events::{ChartAggregate, ChartQuote, ChartTrade, LiveTicks, MarketTier, SecondAggregate, Tick, TradeTick};
use events::handle_text;
pub use subscriptions::{ticker_of, SubscribeMsg, SubscriptionState};

/// Longest wait for the subscribe replies during `probe_channels`.
const PROBE_REPLY_WAIT: Duration = Duration::from_secs(6);
/// Longest wait for the auth answer.
const AUTH_WAIT: Duration = Duration::from_secs(10);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Channel prefix of the trades.
const TRADES: &str = "trade:";
/// Every trade of a symbol, for tick charts (real-time only).
const TICKS: &str = "ticks:";
/// The bid and ask of a charted symbol (real-time only).
const QUOTES: &str = "quote:";
/// Channels a real-time session asks for: under the gateway's 500.
const MAX_CHANNELS: usize = 490;
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
    /// Channel prefix for charted symbols ("bar1s:" second bars).
    chart: &'static str,
    /// Stream entitlement required before connecting; `None` = always.
    gate: Option<fn(&StreamCaps) -> bool>,
    /// Hold the connection only while something is subscribed.
    lazy: bool,
}

fn wants_second_bars(s: &StreamCaps) -> bool {
    s.second_bars
}

/// 1-second bars for charted symbols: the live source of the seconds charts,
/// running next to the REST poller (which keeps the watchlist quotes and the
/// minute / day bars).
const SECOND_BARS: Mode = Mode { chart: "bar1s:", gate: Some(wants_second_bars), lazy: true };

/// The second-bars stream task. Connects only when the probed entitlements
/// allow the `bar1s` channel and a chart is open; otherwise it stays idle and
/// the seconds charts keep their REST tail refresh.
pub fn spawn_second_bars(app: HostRef) -> WsHandle {
    spawn_mode(app, SECOND_BARS)
}

/// One `WsHandle` feeding several live tasks (the poller + the stream task):
/// every subscription update is copied to each.
pub fn fan_out(handles: Vec<WsHandle>) -> WsHandle {
    let (tx, mut rx) = mpsc::channel::<SubscribeMsg>(32);
    crate::rt::spawn(async move {
        while let Some(msg) = rx.recv().await {
            for h in &handles {
                let _ = h.tx.send(msg.clone()).await;
            }
        }
    });
    WsHandle { tx }
}

fn spawn_mode(app: HostRef, mode: Mode) -> WsHandle {
    let (tx, rx) = mpsc::channel::<SubscribeMsg>(32);
    // `rt::spawn`, not `tokio::spawn`: the desktop app calls this from its
    // setup hook, outside any ambient Tokio runtime context.
    crate::rt::spawn(async move {
        if let Err(e) = run_connection(app, rx, mode).await {
            eprintln!("[market_stream] task exited fatally: {e:#}");
        }
    });
    WsHandle { tx }
}

/// Something for this mode to subscribe to: an open chart.
fn has_work(state: &SubscriptionState) -> bool {
    !state.chart_symbols().is_empty()
}

/// Entitled (per the probe) and, for a lazy mode, something to subscribe to.
/// A subscriber connects at once, before any probe: its session is what
/// gives the account's REST calls real-time answers (gateway#19).
fn may_connect(mode: Mode, ent: &entitlements::State, state: &SubscriptionState, realtime: bool) -> bool {
    realtime || (mode.gate.is_none_or(|g| ent.stream_allows(g)) && (!mode.lazy || has_work(state)))
}

/// The route of the next session: real-time with the pass when there is one,
/// else delayed with the app token. `None`: neither.
fn route() -> Option<Route> {
    if let Some(credential) = pass::current() {
        return Some(Route { url: STREAM_RT_URL, credential, realtime: true });
    }
    gateway::token().map(|t| Route { url: STREAM_URL, credential: t.to_string(), realtime: false })
}

struct Route {
    url: &'static str,
    credential: String,
    realtime: bool,
}

/// The stream refused the credential (an auth error answer), as opposed to a
/// network failure.
#[derive(Debug)]
struct AuthRefused(String);

impl std::fmt::Display for AuthRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "stream auth failed: {}", self.0)
    }
}

impl std::error::Error for AuthRefused {}

/// `pass::State::session` while a real-time session runs.
struct LiveGuard(bool);

impl LiveGuard {
    fn new(session: Option<String>) -> Self {
        let on = session.is_some();
        if on {
            pass::set_session(session);
        }
        LiveGuard(on)
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        if self.0 {
            pass::set_session(None);
            live_quotes::clear();
        }
    }
}

fn emit_tier(app: &HostRef, realtime: bool, reason: Option<&str>) {
    let ev = MarketTier { tier: if realtime { "realtime" } else { "delayed" }.into(), reason: reason.map(str::to_string) };
    if let Err(e) = ev.emit(app) {
        eprintln!("[market_stream] tier event: {e}");
    }
}

async fn run_connection(
    app: HostRef,
    mut rx: mpsc::Receiver<SubscribeMsg>,
    mode: Mode,
) -> Result<()> {
    // Subscription state outlives any single session so we can replay
    // after a reconnect. The frontend's "desired state" wins.
    let mut state = SubscriptionState::default();
    let mut backoff = BACKOFF_START;
    let mut ent_rx = entitlements::subscribe();
    let mut pass_rx = pass::subscribe();

    loop {
        // Gate: wait (still applying subscription updates) until the plan is
        // entitled and there is something to stream.
        let ready = may_connect(mode, &ent_rx.borrow(), &state, pass::realtime());
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
                r = pass_rx.changed() => {
                    if r.is_err() {
                        return Ok(());
                    }
                }
            }
            continue;
        }

        // No token compiled in: stay idle (still draining subscription
        // updates) rather than end the task.
        // A new install's first session goes with its own token (gateway#16).
        crate::data::install_token::settle().await;
        let Some(route) = route() else {
            if wait_with_drain(&mut rx, NO_KEY_RETRY, &mut state).await {
                return Ok(()); // mpsc closed — app shutting down
            }
            continue;
        };

        let end = run_session(&app, &route, &mut rx, &mut state, mode, &mut ent_rx, &mut pass_rx).await;
        // The connection was lost: delayed until the next one is up.
        if route.realtime && (matches!(end, Ok(SessionExit::WsClosed)) || matches!(&end, Err(e) if e.downcast_ref::<AuthRefused>().is_none())) {
            emit_tier(&app, false, None);
        }
        match end {
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
            Err(e) if route.realtime && e.downcast_ref::<AuthRefused>().is_some() => {
                // A pass that opens no real-time session (an account outside the
                // pilot, a plan just ended): delayed data, at once.
                eprintln!("[market_stream] real-time refused: {e:#}; delayed data");
                pass::set(None);
                emit_tier(&app, false, Some("not_allowed"));
                backoff = BACKOFF_START;
                continue;
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

/// The channels of a session: the bars of the charted symbols; on a real-time
/// one the ticks of the tick charts and the charts' quotes and trades too, then
/// the watchlists' trades up to MAX_CHANNELS (the others keep the poller's quotes).
fn desired(state: &SubscriptionState, mode: Mode, realtime: bool) -> HashSet<String> {
    let charts = state.chart_tickers();
    let mut out: HashSet<String> = charts.iter().map(|t| format!("{}{t}", mode.chart)).collect();
    if realtime {
        out.extend(state.tick_tickers().into_iter().filter(|t| could_be_ticker(t)).map(|t| format!("{TICKS}{t}")));
        out.extend(charts.iter().filter(|t| could_be_ticker(t)).map(|t| format!("{QUOTES}{t}")));
        let mut rest: Vec<String> = state.all_tickers().into_iter().filter(|t| could_be_ticker(t)).collect();
        // The charts' first; the same list gives the same channels.
        rest.sort_by(|a, b| charts.contains(b).cmp(&charts.contains(a)).then_with(|| a.cmp(b)));
        for t in rest {
            if out.len() >= MAX_CHANNELS {
                break;
            }
            out.insert(format!("{TRADES}{t}"));
        }
    }
    out
}

/// Subscribe and unsubscribe what changed between two channel sets.
async fn send_changes<W>(write: &mut W, prev: &HashSet<String>, next: &HashSet<String>) -> Result<()>
where
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let drops: Vec<String> = prev.difference(next).cloned().collect();
    let adds: Vec<String> = next.difference(prev).cloned().collect();
    send_op(write, "unsubscribe", &drops).await?;
    send_op(write, "subscribe", &adds).await
}

use crate::net::{self, WsStream};

/// Connect and authenticate (the token as the first message, so it never
/// rides in a URL). A `probe` gets subscribe replies only and never takes the
/// account's real-time session. With the socket, the key a real-time session
/// was given.
async fn connect_authed(url: &str, token: &str, probe: bool) -> Result<(WsStream, Option<String>)> {
    let mut ws = net::connect_ws(url).await.context("stream connect failed")?;
    let auth = if probe {
        serde_json::json!({ "op": "auth", "token": token, "probe": true })
    } else {
        serde_json::json!({ "op": "auth", "token": token })
    };
    ws.send(Message::Text(auth.to_string())).await.context("stream send auth failed")?;
    let session = tokio::time::timeout(AUTH_WAIT, wait_for_auth(&mut ws))
        .await
        .map_err(|_| anyhow!("stream: no auth answer after {} s", AUTH_WAIT.as_secs()))??;
    Ok((ws, session))
}

async fn run_session(
    app: &HostRef,
    route: &Route,
    rx: &mut mpsc::Receiver<SubscribeMsg>,
    state: &mut SubscriptionState,
    mode: Mode,
    ent_rx: &mut tokio::sync::watch::Receiver<entitlements::State>,
    pass_rx: &mut tokio::sync::watch::Receiver<pass::State>,
) -> Result<SessionExit> {
    let mut proxy_changes = net::proxy_changes();
    let (ws, session) = connect_authed(route.url, &route.credential, false).await?;
    let (mut write, mut read) = ws.split();
    // Down again whichever way the session ends.
    let _live = LiveGuard::new(session.filter(|_| route.realtime));
    let tier = if route.realtime { "real-time" } else { "delayed" };
    eprintln!("[market_stream] connected + authenticated ({}*, {tier})", mode.chart);
    emit_tier(app, route.realtime, None);
    // The pass last sent on this socket: a new one is a renewal.
    let mut sent = route.credential.clone();

    // Replay desired subscription state. The frontend may have churned
    // the chart slots / watchlists while we were disconnected.
    let mut held = desired(state, mode, route.realtime);
    send_changes(&mut write, &HashSet::new(), &held).await?;

    // The data messages wait here for the next flush (#261).
    let mut pending = events::Pending::new(app);
    let mut flush = tokio::time::interval(events::BAR_FLUSH);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Main loop — diff incoming subscription updates against current
    // state and emit minimal sub/unsub messages; forward incoming data
    // messages as typed events.
    loop {
        tokio::select! {
            _ = flush.tick(), if !pending.is_empty() => pending.flush(),
            sub = rx.recv() => {
                let Some(sub) = sub else { return Ok(SessionExit::ShuttingDown); };
                // Diff the UNION view before/after applying — an owner update
                // only touches the wire when it changes the merged set.
                state.apply(sub);
                if mode.lazy && !route.realtime && !has_work(state) {
                    return Ok(SessionExit::Idle);
                }
                let next = desired(state, mode, route.realtime);
                send_changes(&mut write, &held, &next).await?;
                held = next;
            }
            // Connect again through the new proxy.
            _ = proxy_changes.changed() => return Ok(SessionExit::WsClosed),
            r = pass_rx.changed() => {
                if r.is_err() {
                    return Ok(SessionExit::ShuttingDown);
                }
                match (route.realtime, pass::current()) {
                    // A renewed pass: on this socket, no reconnect.
                    (true, Some(p)) if p != sent => {
                        let auth = serde_json::json!({ "op": "auth", "token": p });
                        write.send(Message::Text(auth.to_string())).await.context("stream send renewal failed")?;
                        sent = p;
                    }
                    (true, Some(_)) | (false, None) => {}
                    // The tier changed: the next session takes the other route.
                    _ => return Ok(SessionExit::Idle),
                }
            }
            r = ent_rx.changed() => {
                if r.is_err() {
                    return Ok(SessionExit::ShuttingDown);
                }
                // A subscriber holds its session whatever the probe found.
                if let Some(gate) = mode.gate.filter(|_| !route.realtime) {
                    if !ent_rx.borrow().stream_allows(gate) {
                        return Ok(SessionExit::Idle);
                    }
                }
            }
            frame = read.next() => {
                let Some(frame) = frame else { return Ok(SessionExit::WsClosed); };
                let frame = frame.context("stream read error")?;
                match frame {
                    Message::Text(txt) => {
                        if let Some(reason) = tier_exit(&txt) {
                            eprintln!("[market_stream] real-time ended: {reason}");
                            if reason == "signed_in_elsewhere" || reason == "too_many_devices" {
                                // Until the user takes it back: the devices would go on taking it from each other.
                                pass::set_elsewhere(true);
                            } else {
                                // The frontend asks a new pass; still subscribed, it brings real-time back.
                                pass::set(None);
                            }
                            emit_tier(app, false, Some(&reason));
                            return Ok(SessionExit::Idle);
                        }
                        handle_text(&mut pending, state, &txt)
                    }
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

/// The gateway's reason for sending this device back to delayed data, when
/// the frame carries one (`downgraded` and its reason, `signed_in_elsewhere`).
fn tier_exit(txt: &str) -> Option<String> {
    if !txt.contains("downgraded") && !txt.contains("signed_in_elsewhere") {
        return None;
    }
    messages(txt).iter().find_map(|m| match (field(m, "type"), field(m, "status")) {
        (Some("status"), Some("signed_in_elsewhere")) => Some("signed_in_elsewhere".to_string()),
        (Some("status"), Some("downgraded")) => Some(field(m, "reason").unwrap_or("downgraded").to_string()),
        _ => None,
    })
}

/// The key of the session, when the gateway gave one (real-time).
async fn wait_for_auth(ws: &mut WsStream) -> Result<Option<String>> {
    while let Some(frame) = ws.next().await {
        let frame = frame.context("stream closed before auth")?;
        let Message::Text(txt) = frame else { continue };
        for m in messages(&txt) {
            match field(&m, "type") {
                Some("status") if field(&m, "status") == Some("authenticated") => return Ok(field(&m, "session").map(str::to_string)),
                Some("error") => return Err(AuthRefused(error_text(&m)).into()),
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
    eprintln!("[market_stream] -> {op} {} channels: {}", channels.len(), channels.iter().take(20).cloned().collect::<Vec<_>>().join(","));
    let msg = serde_json::json!({ "op": op, "channels": channels });
    write.send(Message::Text(msg.to_string())).await.context("stream send failed")?;
    Ok(())
}

/// Entitlement probe: connect, authenticate and subscribe to `channels`
/// (e.g. "bar1m:AAPL") in one message; every reply names its channel. Returns
/// one bool per channel (true = subscribed), then closes. A channel without a
/// reply within `PROBE_REPLY_WAIT` is an error.
pub async fn probe_channels(channels: &[String]) -> Result<Vec<bool>> {
    crate::data::install_token::settle().await;
    let route = route().ok_or_else(|| anyhow!(gateway::NO_TOKEN))?;
    let (mut ws, _) = connect_authed(route.url, &route.credential, true).await?;
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
        assert!(!may_connect(SECOND_BARS, &ent(caps(true)), &state, false), "no chart open");
        assert!(may_connect(SECOND_BARS, &ent(caps(true)), &state, true), "a subscriber holds the session");
        assert!(may_connect(SECOND_BARS, &entitlements::State::default(), &state, true), "before any probe");
        state.apply(SubscribeMsg::SetChart { owner: "main:0".into(), symbol: Some("AAPL".into()) });
        assert!(may_connect(SECOND_BARS, &ent(caps(true)), &state, false));
        assert!(!may_connect(SECOND_BARS, &ent(caps(false)), &state, false), "bar1s not granted");
        assert!(!may_connect(SECOND_BARS, &ent(None), &state, false), "stream not probed yet");
        assert!(!may_connect(SECOND_BARS, &entitlements::State::default(), &state, false), "no entitlements");
        // A watchlist alone is no work for a chart-only mode.
        let mut w = SubscriptionState::default();
        w.apply(SubscribeMsg::SetWatchlist { owner: "main".into(), symbols: vec!["AAPL".into()] });
        assert!(!may_connect(SECOND_BARS, &ent(caps(true)), &w, false));
    }

    #[test]
    fn a_real_time_session_streams_trades_charts_first_within_its_channels() {
        let mut state = SubscriptionState::default();
        state.apply(SubscribeMsg::SetChart { owner: "main:0".into(), symbol: Some("NASDAQ:ZM".into()) });
        state.apply(SubscribeMsg::SetWatchlist { owner: "main".into(), symbols: vec!["NASDAQ:AAPL".into(), "NYMEX:CL1!".into()] });
        let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<HashSet<_>>();
        assert_eq!(desired(&state, SECOND_BARS, false), set(&["bar1s:ZM"]));
        assert_eq!(desired(&state, SECOND_BARS, true), set(&["bar1s:ZM", "quote:ZM", "trade:ZM", "trade:AAPL"]), "CL1! is no ticker of the source");
        let many: Vec<String> = (0..1000).map(|i| format!("NYSE:A{i}X")).collect();
        state.apply(SubscribeMsg::SetWatchlist { owner: "main".into(), symbols: many });
        let d = desired(&state, SECOND_BARS, true);
        assert_eq!(d.len(), MAX_CHANNELS);
        assert!(d.contains("trade:ZM"), "the chart's");
    }

    #[test]
    fn a_real_time_session_streams_the_ticks_of_the_tick_charts() {
        let mut state = SubscriptionState::default();
        state.apply(SubscribeMsg::SetChart { owner: "main:0".into(), symbol: Some("NASDAQ:AAPL".into()) });
        state.apply(SubscribeMsg::SetTicks { owner: "main:0".into(), symbol: Some("NASDAQ:AAPL".into()) });
        let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<HashSet<_>>();
        assert_eq!(desired(&state, SECOND_BARS, false), set(&["bar1s:AAPL"]), "no ticks on the delayed stream");
        assert_eq!(desired(&state, SECOND_BARS, true), set(&["bar1s:AAPL", "ticks:AAPL", "quote:AAPL", "trade:AAPL"]));
    }

    #[test]
    fn tier_exit_reads_the_gateway_reasons() {
        assert_eq!(tier_exit(r#"[{"type":"status","status":"downgraded","reason":"revoked"}]"#).as_deref(), Some("revoked"));
        assert_eq!(tier_exit(r#"[{"type":"status","status":"signed_in_elsewhere"}]"#).as_deref(), Some("signed_in_elsewhere"));
        assert_eq!(tier_exit(r#"[{"type":"bar","ticker":"AAPL","c":1}]"#), None);
        // Text that only looks like one is no status.
        assert_eq!(tier_exit(r#"[{"type":"error","code":"NOT_ENTITLED","error":"downgraded"}]"#), None);
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
