/*
 * Settings > Coding agents: a local MCP endpoint (`http://127.0.0.1:<port>/mcp`, streamable HTTP, JSON answers) so a
 * coding agent can work with the running app. Off by default; saved in the app's config folder.
 *
 * Rust only carries the messages. It refuses a request without the token or from a web page (an `Origin` that is not
 * this computer), hands the JSON-RPC body to the window the user focused last (event `AgentRequest`) and returns that
 * window's answer (`agent_reply`). The window runs the MCP methods with the app's own stores (src/agent/).
 */
use axum::{
    extract::State as AxState,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::sync::oneshot;

const FILE: &str = "agent.json";
pub const DEFAULT_PORT: u16 = 47_821;
/// A tool call that runs a backtest or loads bars may take a while; past this the agent gets an error.
const REPLY_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    port: u16,
    token: String,
}

impl Default for Config {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, token: String::new() }
    }
}

/// What Settings shows.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentServerStatus {
    pub enabled: bool,
    /// Listening now.
    pub running: bool,
    pub port: u16,
    pub token: String,
    /// The endpoint an agent connects to.
    pub url: String,
    /// Why it isn't listening (port in use…).
    pub error: Option<String>,
}

/// One JSON-RPC message for `window` (its label; the other windows ignore it) to answer with `agent_reply` (same id).
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct AgentRequest {
    pub window: String,
    pub id: u32,
    pub body: String,
}

pub struct AgentServer {
    config: Mutex<Config>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    error: Mutex<Option<String>>,
    pending: Mutex<HashMap<u32, oneshot::Sender<String>>>,
    seq: AtomicU32,
    /// Windows listening for `AgentRequest` (a window still loading would miss it).
    ready: Mutex<HashSet<String>>,
}

fn read_config(app: &AppHandle) -> Config {
    let path = app.path().app_config_dir().ok().map(|d| d.join(FILE));
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), text).map_err(|e| e.to_string())
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn status(app: &AppHandle) -> AgentServerStatus {
    let state = app.state::<AgentServer>();
    let config = state.config.lock().unwrap().clone();
    let running = state.stop.lock().unwrap().is_some();
    let error = state.error.lock().unwrap().clone();
    AgentServerStatus {
        enabled: config.enabled,
        running,
        port: config.port,
        url: format!("http://127.0.0.1:{}/mcp", config.port),
        token: config.token,
        error,
    }
}

pub fn init(app: &AppHandle) {
    let mut config = read_config(app);
    if config.token.is_empty() {
        if let Ok(token) = new_token() {
            config.token = token;
            let _ = write_config(app, &config);
        }
    }
    let enabled = config.enabled;
    app.manage(AgentServer {
        config: Mutex::new(config),
        stop: Mutex::new(None),
        error: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        seq: AtomicU32::new(0),
        ready: Mutex::new(HashSet::new()),
    });
    if enabled {
        start(app);
    }
}

fn stop(app: &AppHandle) {
    let state = app.state::<AgentServer>();
    if let Some(tx) = state.stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    // Requests still waiting get no answer: their senders drop and the handlers return an error.
    state.pending.lock().unwrap().clear();
}

fn start(app: &AppHandle) {
    stop(app);
    let state = app.state::<AgentServer>();
    let port = state.config.lock().unwrap().port;
    // Bound here (not in the task) so Settings learns at once that the port is taken.
    let listener = match std::net::TcpListener::bind(("127.0.0.1", port)).and_then(|l| {
        l.set_nonblocking(true)?;
        Ok(l)
    }) {
        Ok(l) => l,
        Err(e) => {
            *state.error.lock().unwrap() = Some(format!("Port {port} is not available: {e}"));
            return;
        }
    };
    *state.error.lock().unwrap() = None;
    let (tx, rx) = oneshot::channel::<()>();
    *state.stop.lock().unwrap() = Some(tx);
    let router = Router::new()
        .route("/mcp", post(on_post).get(not_allowed).delete(not_allowed))
        .with_state(app.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let served = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = served {
            let state = app.state::<AgentServer>();
            *state.error.lock().unwrap() = Some(e);
            state.stop.lock().unwrap().take();
        }
    });
}

/// No server-to-client stream (GET) and no sessions to end (DELETE): the spec's 405.
async fn not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

/// A web page may reach 127.0.0.1 too: a request a browser sends carries its `Origin`. Only this computer's origins
/// pass (a coding agent sends none).
fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else { return true };
    let Ok(origin) = origin.to_str() else { return false };
    let host = origin.split("://").nth(1).unwrap_or("");
    let host = host.rsplit_once(':').map_or(host, |(h, port)| if port.chars().all(|c| c.is_ascii_digit()) { h } else { host });
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// Compares in constant time (the token).
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn rpc_error(id: &serde_json::Value, code: i64, message: &str) -> Response {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } });
    ([(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

async fn on_post(AxState(app): AxState<AppHandle>, headers: HeaderMap, body: String) -> Response {
    if !origin_ok(&headers) {
        return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }
    let state = app.state::<AgentServer>();
    let expected = format!("Bearer {}", state.config.lock().unwrap().token);
    let given = headers.get(header::AUTHORIZATION).map(|v| v.as_bytes()).unwrap_or_default();
    if !same(given, expected.as_bytes()) {
        return (StatusCode::UNAUTHORIZED, "Missing or wrong token (Settings > Coding agents)").into_response();
    }
    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return rpc_error(&serde_json::Value::Null, -32700, "Parse error"),
    };
    let id = parsed.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let Some(window) = target_window(&app) else {
        return rpc_error(&id, -32000, "OpenTrader is starting (no window ready yet): try again in a few seconds");
    };
    let n = state.seq.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(n, tx);
    if let Err(e) = (AgentRequest { window, id: n, body }).emit(&app) {
        state.pending.lock().unwrap().remove(&n);
        return rpc_error(&id, -32000, &format!("OpenTrader window unreachable: {e}"));
    }
    match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
        // A notification (or a response from the client): nothing to answer.
        Ok(Ok(reply)) if reply.is_empty() => StatusCode::ACCEPTED.into_response(),
        Ok(Ok(reply)) => ([(header::CONTENT_TYPE, "application/json")], reply).into_response(),
        Ok(Err(_)) => rpc_error(&id, -32000, "The request was dropped (coding agents turned off or window closed)"),
        Err(_) => {
            state.pending.lock().unwrap().remove(&n);
            rpc_error(&id, -32000, "OpenTrader did not answer in time")
        }
    }
}

/// Of the windows ready for requests: the one the user focused last, else the main window, else any.
fn target_window(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    let ready = app.state::<AgentServer>().ready.lock().unwrap().clone();
    let usable = |l: &str| windows.contains_key(l) && ready.contains(l);
    if let Some(label) = crate::window_session::focused(app).filter(|l| usable(l)) {
        return Some(label);
    }
    if usable("main") {
        return Some("main".into());
    }
    ready.into_iter().find(|l| windows.contains_key(l))
}

/// The calling window listens for `AgentRequest` from now on.
#[tauri::command]
#[specta::specta]
pub fn agent_ready(window: tauri::Window, state: State<'_, AgentServer>) {
    state.ready.lock().unwrap().insert(window.label().to_string());
}

#[tauri::command]
#[specta::specta]
pub fn agent_server_status(app: AppHandle) -> AgentServerStatus {
    status(&app)
}

/// Turn the endpoint on (listens now) or off; saved.
#[tauri::command]
#[specta::specta]
pub fn agent_server_set_enabled(app: AppHandle, enabled: bool) -> Result<AgentServerStatus, String> {
    let state = app.state::<AgentServer>();
    let config = {
        let mut c = state.config.lock().unwrap();
        c.enabled = enabled;
        c.clone()
    };
    write_config(&app, &config)?;
    if enabled {
        start(&app);
    } else {
        stop(&app);
        *state.error.lock().unwrap() = None;
    }
    Ok(status(&app))
}

/// Another port (1024–65535); listens there now when on.
#[tauri::command]
#[specta::specta]
pub fn agent_server_set_port(app: AppHandle, port: u16) -> Result<AgentServerStatus, String> {
    if port < 1024 {
        return Err("Use a port from 1024 to 65535".into());
    }
    let state = app.state::<AgentServer>();
    let config = {
        let mut c = state.config.lock().unwrap();
        c.port = port;
        c.clone()
    };
    write_config(&app, &config)?;
    if config.enabled {
        start(&app);
    }
    Ok(status(&app))
}

/// A new token: agents set up with the old one are refused from now on.
#[tauri::command]
#[specta::specta]
pub fn agent_server_new_token(app: AppHandle) -> Result<AgentServerStatus, String> {
    let token = new_token()?;
    let state = app.state::<AgentServer>();
    let config = {
        let mut c = state.config.lock().unwrap();
        c.token = token;
        c.clone()
    };
    write_config(&app, &config)?;
    Ok(status(&app))
}

/// The window's answer to `AgentRequest` `id` (empty: nothing to answer).
#[tauri::command]
#[specta::specta]
pub fn agent_reply(state: State<'_, AgentServer>, id: u32, body: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_origin(o: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::ORIGIN, o.parse().unwrap());
        h
    }

    #[test]
    fn origins() {
        assert!(origin_ok(&HeaderMap::new()));
        assert!(origin_ok(&with_origin("http://127.0.0.1:5173")));
        assert!(origin_ok(&with_origin("http://localhost")));
        assert!(!origin_ok(&with_origin("https://example.com")));
        assert!(!origin_ok(&with_origin("http://127.0.0.1.example.com")));
        assert!(!origin_ok(&with_origin("null")));
    }

    #[test]
    fn token_compare() {
        assert!(same(b"Bearer abc", b"Bearer abc"));
        assert!(!same(b"Bearer abd", b"Bearer abc"));
        assert!(!same(b"", b"Bearer abc"));
    }
}
