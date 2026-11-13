/*
 * The Plugin API's server: plugins connect to 127.0.0.1:<port> and exchange JSON-RPC 2.0 messages, one per line
 * (plugins/PROTOCOL.md). A connection opens with the plugin's `hello` (its id, its token, its API version); then both
 * sides send requests and notifications. The app asks a plugin (`request`: `data.bars`, `broker.place`…), the plugin
 * pushes what changes (`data.tick`, `broker.state`…) as notifications, which reach the app's consumers through
 * `subscribe`.
 *
 * Only installed, enabled plugins get in (`set_allowed`: their tokens), and each only for what its manifest provides:
 * a data plugin is neither asked nor heard on `broker.*`.
 */
use super::manifest::Capability;
use super::API_VERSION;
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, oneshot};

/// A message longer than this closes the connection (a year of 1-minute bars is ~40 MB of JSON).
const MAX_LINE: u64 = 64 * 1024 * 1024;
/// The plugin's `hello` must come within this.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// A plugin that may connect.
#[derive(Clone, Debug, PartialEq)]
pub struct Allowed {
    pub id: String,
    pub token: String,
    pub provides: Vec<Capability>,
}

/// What a connected plugin said in its `hello`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Hello {
    pub plugin: String,
    #[serde(default)]
    pub version: String,
    pub api: u32,
}

#[derive(Clone, Debug)]
pub enum HubEvent {
    Connected { plugin: String, hello: Hello },
    Disconnected { plugin: String },
    /// A notification of the plugin (`data.tick`, `broker.state`, `log`…).
    Notification { plugin: String, method: String, params: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub enum PluginError {
    NotConnected(String),
    /// The plugin's manifest doesn't provide the method's capability.
    NotProvided(String),
    Timeout,
    /// The plugin answered with an error.
    Rpc { code: i64, message: String },
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginError::NotConnected(p) => write!(f, "The plugin {p} is not connected"),
            PluginError::NotProvided(m) => write!(f, "The plugin does not provide {m}"),
            PluginError::Timeout => write!(f, "The plugin did not answer in time"),
            PluginError::Rpc { message, .. } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for PluginError {}

type Reply = oneshot::Sender<Result<Value, PluginError>>;

struct Session {
    conn: u64,
    out: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    hello: Hello,
    /// Dropped with the session (replaced, disconnected): its connection closes.
    _close: oneshot::Sender<()>,
}

struct Inner {
    allowed: Mutex<HashMap<String, Allowed>>,
    sessions: Mutex<HashMap<String, Session>>,
    events: broadcast::Sender<HubEvent>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    seq: AtomicU64,
}

/// The server; cheap to clone.
#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Hub {
        let (events, _) = broadcast::channel(4096);
        Hub {
            inner: Arc::new(Inner {
                allowed: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                events,
                stop: Mutex::new(None),
                seq: AtomicU64::new(1),
            }),
        }
    }

    /// Listen on 127.0.0.1:`port` (0: any free port) and return the port. Bound before returning, so a taken port is
    /// an error here. Listening again first stops the previous listener; connected plugins stay.
    pub fn listen(&self, port: u16) -> Result<u16, String> {
        self.stop();
        let listener = std::net::TcpListener::bind(("127.0.0.1", port))
            .and_then(|l| {
                l.set_nonblocking(true)?;
                Ok(l)
            })
            .map_err(|e| format!("Port {port} is not available: {e}"))?;
        let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
        let (tx, mut rx) = oneshot::channel::<()>();
        *self.inner.stop.locked() = Some(tx);
        let hub = self.clone();
        crate::rt::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else { return };
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            let hub = hub.clone();
                            crate::rt::spawn(async move { hub.serve(stream).await });
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                    },
                }
            }
        });
        Ok(bound)
    }

    /// Stop listening (connected plugins stay until `set_allowed` drops them).
    pub fn stop(&self) {
        if let Some(tx) = self.inner.stop.locked().take() {
            let _ = tx.send(());
        }
    }

    pub fn listening(&self) -> bool {
        self.inner.stop.locked().is_some()
    }

    /// The plugins that may connect. A connected plugin no longer in the list, or with another token, is dropped.
    pub fn set_allowed(&self, list: Vec<Allowed>) {
        let list: HashMap<String, Allowed> = list.into_iter().map(|a| (a.id.clone(), a)).collect();
        let dropped: Vec<String> = {
            let old = self.inner.allowed.locked();
            old.iter().filter(|(id, a)| list.get(*id) != Some(a)).map(|(id, _)| id.clone()).collect()
        };
        *self.inner.allowed.locked() = list;
        for id in dropped {
            self.disconnect(&id);
        }
    }

    /// Close a plugin's connection.
    pub fn disconnect(&self, plugin: &str) {
        // Dropping the session drops its writer: the connection's tasks end and report `Disconnected`.
        self.inner.sessions.locked().remove(plugin);
    }

    pub fn connected(&self, plugin: &str) -> Option<Hello> {
        self.inner.sessions.locked().get(plugin).map(|s| s.hello.clone())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        self.inner.events.subscribe()
    }

    fn may(&self, plugin: &str, method: &str) -> bool {
        match Capability::of_method(method) {
            None => true,
            Some(c) => self.inner.allowed.locked().get(plugin).is_some_and(|a| a.provides.contains(&c)),
        }
    }

    /// Ask `plugin` and wait for its answer.
    pub async fn request(&self, plugin: &str, method: &str, params: Value, timeout: Duration) -> Result<Value, PluginError> {
        if !self.may(plugin, method) {
            return Err(PluginError::NotProvided(method.into()));
        }
        let id = self.inner.seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let pending = {
            let sessions = self.inner.sessions.locked();
            let s = sessions.get(plugin).ok_or_else(|| PluginError::NotConnected(plugin.into()))?;
            s.pending.locked().insert(id, tx);
            let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
            if s.out.send(line).is_err() {
                s.pending.locked().remove(&id);
                return Err(PluginError::NotConnected(plugin.into()));
            }
            s.pending.clone()
        };
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            // The connection closed: its pending requests were dropped.
            Ok(Err(_)) => Err(PluginError::NotConnected(plugin.into())),
            Err(_) => {
                pending.locked().remove(&id);
                Err(PluginError::Timeout)
            }
        }
    }

    /// Tell `plugin` without waiting for an answer.
    pub fn notify(&self, plugin: &str, method: &str, params: Value) -> Result<(), PluginError> {
        if !self.may(plugin, method) {
            return Err(PluginError::NotProvided(method.into()));
        }
        let sessions = self.inner.sessions.locked();
        let s = sessions.get(plugin).ok_or_else(|| PluginError::NotConnected(plugin.into()))?;
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        s.out.send(line).map_err(|_| PluginError::NotConnected(plugin.into()))
    }

    async fn serve(&self, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let first = match tokio::time::timeout(HELLO_TIMEOUT, read_line(&mut reader)).await {
            Ok(Some(line)) => line,
            _ => return,
        };
        let hello = match self.check_hello(&first) {
            Ok(h) => h,
            Err((id, message)) => {
                let _ = write.write_all(format!("{}\n", rpc_error(&id, -32001, &message)).as_bytes()).await;
                return;
            }
        };
        let hello_id = serde_json::from_str::<Value>(&first).ok().and_then(|v| v.get("id").cloned()).unwrap_or(Value::Null);
        let plugin = hello.plugin.clone();
        let conn = self.inner.seq.fetch_add(1, Ordering::Relaxed);
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::new(Mutex::new(HashMap::new()));
        let welcome = json!({ "jsonrpc": "2.0", "id": hello_id, "result": { "app": "OpenTrader", "api": API_VERSION } });
        let _ = out.send(welcome.to_string());
        let (close, mut closed) = oneshot::channel::<()>();
        // A second connection of the same plugin replaces the first (whose `close` drops).
        let session = Session { conn, out: out.clone(), pending: pending.clone(), hello: hello.clone(), _close: close };
        self.inner.sessions.locked().insert(plugin.clone(), session);
        let _ = self.inner.events.send(HubEvent::Connected { plugin: plugin.clone(), hello });

        let writer = tokio::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                if write.write_all(line.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });
        let mut writer = writer;
        loop {
            tokio::select! {
                line = read_line(&mut reader) => {
                    let Some(line) = line else { break };
                    self.on_message(&plugin, &line, &out, &pending);
                }
                _ = &mut writer => break,
                _ = &mut closed => break,
            }
        }
        // Both halves dropped: the plugin sees the connection close.
        writer.abort();
        // Gone, unless a newer connection of the plugin replaced this one.
        let gone = {
            let mut sessions = self.inner.sessions.locked();
            match sessions.get(&plugin) {
                Some(s) if s.conn == conn => {
                    sessions.remove(&plugin);
                    true
                }
                Some(_) => false,
                None => true,
            }
        };
        pending.locked().clear();
        if gone {
            let _ = self.inner.events.send(HubEvent::Disconnected { plugin });
        }
    }

    /// The `hello`, or the error to answer (with the request id).
    fn check_hello(&self, line: &str) -> Result<Hello, (Value, String)> {
        let msg: Value = serde_json::from_str(line).map_err(|_| (Value::Null, "Parse error".to_string()))?;
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        if msg.get("method").and_then(Value::as_str) != Some("hello") {
            return Err((id, "Send hello first".into()));
        }
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let token = params.get("token").and_then(Value::as_str).unwrap_or("").to_string();
        let hello: Hello = serde_json::from_value(params).map_err(|e| (id.clone(), format!("hello: {e}")))?;
        let allowed = self.inner.allowed.locked().get(&hello.plugin).cloned();
        let Some(allowed) = allowed else {
            return Err((id, format!("The plugin {} is not installed or not enabled in OpenTrader", hello.plugin)));
        };
        if !same(token.as_bytes(), allowed.token.as_bytes()) {
            return Err((id, "Wrong token: reinstall or re-enable the plugin in OpenTrader".into()));
        }
        if hello.api == 0 || hello.api > API_VERSION {
            return Err((id, format!("Plugin API {} is not supported (OpenTrader speaks {API_VERSION})", hello.api)));
        }
        Ok(hello)
    }

    fn on_message(&self, plugin: &str, line: &str, out: &mpsc::UnboundedSender<String>, pending: &Mutex<HashMap<u64, Reply>>) {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            let _ = out.send(rpc_error(&Value::Null, -32700, "Parse error"));
            return;
        };
        let id = msg.get("id").cloned().filter(|v| !v.is_null());
        match (msg.get("method").and_then(Value::as_str), id) {
            // A request of the plugin: the app answers only `ping`.
            (Some(method), Some(id)) => {
                let answer = match method {
                    "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }).to_string(),
                    _ => rpc_error(&id, -32601, &format!("Method not found: {method}")),
                };
                let _ = out.send(answer);
            }
            (Some(method), None) => {
                if !self.may(plugin, method) {
                    return;
                }
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let _ = self.inner.events.send(HubEvent::Notification { plugin: plugin.into(), method: method.into(), params });
            }
            // An answer to one of the app's requests.
            (None, Some(id)) => {
                let Some(n) = id.as_u64() else { return };
                let Some(reply) = pending.locked().remove(&n) else { return };
                let answer = match msg.get("error") {
                    Some(e) => Err(PluginError::Rpc {
                        code: e.get("code").and_then(Value::as_i64).unwrap_or(-32000),
                        message: e.get("message").and_then(Value::as_str).unwrap_or("Plugin error").to_string(),
                    }),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(answer);
            }
            (None, None) => {}
        }
    }
}

/// One line without its end, or None at the end of the connection (or past `MAX_LINE`).
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Option<String> {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = (&mut *reader).take(MAX_LINE + 1).read_until(b'\n', &mut buf).await.ok()?;
        if n == 0 || (buf.last() != Some(&b'\n') && n as u64 > MAX_LINE) {
            return None;
        }
        let text = String::from_utf8_lossy(&buf);
        let text = text.trim_end_matches(['\r', '\n']);
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
        if buf.last() != Some(&b'\n') {
            return None;
        }
    }
}

fn rpc_error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// Compares in constant time (the token).
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    /// A plugin on the other end of the socket.
    struct Fake {
        lines: tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
        write: tokio::net::tcp::OwnedWriteHalf,
    }

    impl Fake {
        async fn connect(port: u16) -> Fake {
            let s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let (r, w) = s.into_split();
            Fake { lines: BufReader::new(r).lines(), write: w }
        }
        async fn send(&mut self, v: Value) {
            self.write.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        }
        async fn recv(&mut self) -> Option<Value> {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line()).await.ok()?.ok()??;
            serde_json::from_str(&line).ok()
        }
        async fn hello(port: u16, plugin: &str, token: &str) -> (Fake, Value) {
            let mut f = Fake::connect(port).await;
            f.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "hello", "params": { "plugin": plugin, "token": token, "api": 1, "version": "0.1.0" } })).await;
            let answer = f.recv().await.unwrap();
            (f, answer)
        }
    }

    fn hub() -> (Hub, u16) {
        let hub = Hub::new();
        hub.set_allowed(vec![
            Allowed { id: "feed".into(), token: "t1".into(), provides: vec![Capability::Datafeed] },
            Allowed { id: "brk".into(), token: "t2".into(), provides: vec![Capability::Broker] },
        ]);
        let port = hub.listen(0).unwrap();
        (hub, port)
    }

    async fn wait_connected(hub: &Hub, plugin: &str) {
        for _ in 0..100 {
            if hub.connected(plugin).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{plugin} never connected");
    }

    #[tokio::test]
    async fn refuses_a_wrong_token_or_an_unknown_plugin() {
        let (hub, port) = hub();
        let (_, a) = Fake::hello(port, "feed", "nope").await;
        assert!(a["error"]["message"].as_str().unwrap().contains("Wrong token"));
        let (_, a) = Fake::hello(port, "other", "t1").await;
        assert!(a["error"]["message"].as_str().unwrap().contains("not installed"));
        assert!(hub.connected("feed").is_none());
    }

    #[tokio::test]
    async fn requests_and_answers_both_ways() {
        let (hub, port) = hub();
        let mut events = hub.subscribe();
        let (mut f, a) = Fake::hello(port, "feed", "t1").await;
        assert_eq!(a["result"]["api"], API_VERSION);
        wait_connected(&hub, "feed").await;
        assert!(matches!(events.recv().await.unwrap(), HubEvent::Connected { plugin, .. } if plugin == "feed"));

        // The app asks; the plugin answers.
        let h = hub.clone();
        let asked = tokio::spawn(async move { h.request("feed", "data.bars", json!({ "symbol": "X:Y" }), Duration::from_secs(5)).await });
        let req = f.recv().await.unwrap();
        assert_eq!(req["method"], "data.bars");
        f.send(json!({ "jsonrpc": "2.0", "id": req["id"], "result": { "bars": [] } })).await;
        assert_eq!(asked.await.unwrap().unwrap(), json!({ "bars": [] }));

        // An error answer.
        let h = hub.clone();
        let asked = tokio::spawn(async move { h.request("feed", "data.search", json!({}), Duration::from_secs(5)).await });
        let req = f.recv().await.unwrap();
        f.send(json!({ "jsonrpc": "2.0", "id": req["id"], "error": { "code": 5, "message": "no" } })).await;
        assert_eq!(asked.await.unwrap(), Err(PluginError::Rpc { code: 5, message: "no".into() }));

        // The plugin pings and notifies.
        f.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" })).await;
        assert_eq!(f.recv().await.unwrap()["result"], json!({}));
        f.send(json!({ "jsonrpc": "2.0", "method": "data.tick", "params": { "symbol": "X:Y", "price": 1.5 } })).await;
        loop {
            if let HubEvent::Notification { method, params, .. } = events.recv().await.unwrap() {
                assert_eq!(method, "data.tick");
                assert_eq!(params["price"], 1.5);
                break;
            }
        }
    }

    #[tokio::test]
    async fn keeps_each_plugin_to_what_it_provides() {
        let (hub, port) = hub();
        let mut events = hub.subscribe();
        let (mut f, _) = Fake::hello(port, "feed", "t1").await;
        wait_connected(&hub, "feed").await;
        let asked = hub.request("feed", "broker.place", json!({}), Duration::from_secs(1)).await;
        assert_eq!(asked, Err(PluginError::NotProvided("broker.place".into())));
        // A broker notification from a data plugin is not heard; the next data one is.
        f.send(json!({ "jsonrpc": "2.0", "method": "broker.state", "params": {} })).await;
        f.send(json!({ "jsonrpc": "2.0", "method": "log", "params": { "message": "hi" } })).await;
        loop {
            match events.recv().await.unwrap() {
                HubEvent::Notification { method, .. } => {
                    assert_eq!(method, "log");
                    break;
                }
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn a_disabled_plugin_is_dropped_and_its_requests_fail() {
        let (hub, port) = hub();
        let mut events = hub.subscribe();
        let (mut f, _) = Fake::hello(port, "brk", "t2").await;
        wait_connected(&hub, "brk").await;
        let h = hub.clone();
        let asked = tokio::spawn(async move { h.request("brk", "broker.accounts", json!({}), Duration::from_secs(5)).await });
        let _ = f.recv().await.unwrap();
        hub.set_allowed(vec![]);
        assert_eq!(asked.await.unwrap(), Err(PluginError::NotConnected("brk".into())));
        loop {
            if let HubEvent::Disconnected { plugin } = events.recv().await.unwrap() {
                assert_eq!(plugin, "brk");
                break;
            }
        }
        // The socket is closed on the plugin's side too.
        assert!(f.recv().await.is_none());
        assert_eq!(
            hub.request("brk", "broker.accounts", json!({}), Duration::from_secs(1)).await,
            Err(PluginError::NotProvided("broker.accounts".into()))
        );
    }

    #[tokio::test]
    async fn a_request_without_answer_times_out() {
        let (hub, port) = hub();
        let (_f, _) = Fake::hello(port, "feed", "t1").await;
        wait_connected(&hub, "feed").await;
        let asked = hub.request("feed", "data.bars", json!({}), Duration::from_millis(100)).await;
        assert_eq!(asked, Err(PluginError::Timeout));
    }
}
