/*
 * The server's `Host` and its clients. Every event the core emits goes to a
 * broadcast channel; each client's WebSocket task forwards the ones it wants:
 * the bars and quotes of the symbols it subscribed, the screener updates while
 * it has a screener panel open, and everything else.
 */
use opentrader_core::host::Host;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// Request header naming the calling client (browser tab).
pub const CLIENT_HEADER: &str = "x-opentrader-client";

/// Events kept for a slow client before it misses some.
const EVENT_BUFFER: usize = 1024;

/// A client id: 1-64 of `[A-Za-z0-9_-]` (it becomes a subscription owner).
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// One event, serialized once for every client.
pub struct Outgoing {
    pub name: &'static str,
    /// The payload's `symbol`, for the per-symbol events.
    pub symbol: Option<String>,
    /// `{"event": name, "payload": ...}`.
    pub text: String,
}

pub struct ServerHost {
    tx: broadcast::Sender<Arc<Outgoing>>,
}

impl ServerHost {
    pub fn new() -> Self {
        Self { tx: broadcast::channel(EVENT_BUFFER).0 }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Outgoing>> {
        self.tx.subscribe()
    }
}

impl Host for ServerHost {
    fn emit_value(&self, name: &'static str, payload: serde_json::Value) {
        let symbol = payload.get("symbol").and_then(|s| s.as_str()).map(str::to_string);
        let text = serde_json::json!({ "event": name, "payload": payload }).to_string();
        // No receiver = no client connected.
        let _ = self.tx.send(Arc::new(Outgoing { name, symbol, text }));
    }
}

/// What one client subscribed.
#[derive(Default)]
pub struct Subs {
    /// Pane id → charted symbol.
    pub charts: HashMap<String, String>,
    pub watchlist: HashSet<String>,
    /// Screener owners it opened (already prefixed with the client id).
    pub screener_owners: HashSet<String>,
    /// Open WebSockets of the client (a reload can overlap the old one).
    sockets: usize,
}

impl Subs {
    pub fn wants(&self, ev: &Outgoing) -> bool {
        match ev.name {
            "chart-aggregate" | "second-aggregate" | "trade-tick" => ev
                .symbol
                .as_ref()
                .is_some_and(|s| self.watchlist.contains(s) || self.charts.values().any(|c| c == s)),
            "screener-update" => !self.screener_owners.is_empty(),
            _ => true,
        }
    }
}

#[derive(Default)]
pub struct Clients {
    map: Mutex<HashMap<String, Arc<Mutex<Subs>>>>,
}

impl Clients {
    /// The subscriptions of a client with an open WebSocket. Subscribing needs
    /// one: its close is what releases them.
    pub fn connected(&self, id: &str) -> Option<Arc<Mutex<Subs>>> {
        self.map.lock().unwrap().get(id).filter(|s| s.lock().unwrap().sockets > 0).cloned()
    }

    /// A WebSocket of the client opened.
    pub fn connect(&self, id: &str) -> Arc<Mutex<Subs>> {
        let subs = self.map.lock().unwrap().entry(id.to_string()).or_default().clone();
        subs.lock().unwrap().sockets += 1;
        subs
    }

    /// A WebSocket of the client closed. When it was the last one the client
    /// is forgotten and its subscriptions are returned for cleanup.
    pub fn disconnect(&self, id: &str, subs: &Arc<Mutex<Subs>>) -> Option<Subs> {
        let mut map = self.map.lock().unwrap();
        let mut s = subs.lock().unwrap();
        s.sockets = s.sockets.saturating_sub(1);
        if s.sockets > 0 {
            return None;
        }
        map.remove(id);
        Some(std::mem::take(&mut *s))
    }
}
