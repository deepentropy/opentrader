/*
 * Broker plugins (#315): the account of the broker plugin the user connected (Trade > Connect broker), as the
 * plugin pushes it (`broker.state`), and the order commands sent to it.
 *
 * Orders that open or change risk (place, modify, brackets) are refused here unless trading is turned on (off by
 * default): a plugin is never asked to trade before the user allowed it. Cancelling an order and closing a position
 * stay possible, so a position can always be got out of.
 */
use super::{installed_manifest, Plugins};
use opentrader_core::plugins::broker::{BrokerEvent, BrokerState, OrderTicket};
use opentrader_core::plugins::hub::HubEvent;
use opentrader_core::plugins::manifest::Capability;
use opentrader_core::sync::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

const ORDER_TIMEOUT: Duration = Duration::from_secs(30);
const NOTICES: usize = 200;

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrokerPlugin {
    pub id: String,
    pub name: String,
    pub connected: bool,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrokerNotice {
    pub time_ms: f64,
    /// "info" | "warn" | "error"
    pub level: String,
    pub message: String,
}

/// The trading side as the window reads it; sent again (`broker-status`) whenever it changes.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub version: u32,
    /// The enabled broker plugins.
    pub brokers: Vec<BrokerPlugin>,
    /// The broker plugin the user connected.
    pub active: Option<String>,
    pub active_name: Option<String>,
    /// The active plugin is connected to the app.
    pub plugin_connected: bool,
    /// The exchange of the active plugin's own symbols when it is a data plugin too: its symbols trade as they are.
    pub data_exchange: Option<String>,
    /// The exchanges of a data plugin that serves several (#331): its tickers are whole symbols (`NSE:RELIANCE`).
    pub data_exchanges: Vec<String>,
    pub trading_enabled: bool,
    /// Its account, as the plugin last sent it.
    pub state: Option<BrokerState>,
    pub notices: Vec<BrokerNotice>,
}

/// An order notification of the active broker (`broker.event`): a toast.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BrokerOrderEvent {
    pub event: BrokerEvent,
}

/// Bid / ask / last of a ticker the order ticket watches (`broker.quote`).
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BrokerQuote {
    pub ticker: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
}

#[derive(Default)]
pub struct PluginBroker {
    states: Mutex<HashMap<String, BrokerState>>,
    notices: Mutex<VecDeque<BrokerNotice>>,
    /// Chart symbol → the active broker's ticker (None: not traded there), asked once per connection.
    resolved: Mutex<HashMap<String, Option<String>>>,
    version: AtomicU32,
    dirty: AtomicBool,
}

fn state(app: &AppHandle) -> &PluginBroker {
    &app.state::<Plugins>().inner().broker
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

fn notice(app: &AppHandle, level: &str, message: String) {
    let mut n = state(app).notices.locked();
    n.push_front(BrokerNotice { time_ms: now_ms(), level: level.into(), message });
    n.truncate(NOTICES);
    drop(n);
    changed(app);
}

/// Something changed: the status goes out with the next tick (at most 4 a second).
pub fn changed(app: &AppHandle) {
    let s = state(app);
    s.version.fetch_add(1, Ordering::Relaxed);
    s.dirty.store(true, Ordering::Relaxed);
}

fn active(app: &AppHandle) -> Option<String> {
    let plugins = app.state::<Plugins>();
    let c = plugins.config.locked();
    let id = c.active_broker.clone()?;
    c.plugins.get(&id).is_some_and(|p| p.enabled).then_some(id)
}

pub fn status(app: &AppHandle) -> BrokerStatus {
    let plugins = app.state::<Plugins>();
    let enabled: Vec<String> = plugins.config.locked().plugins.iter().filter(|(_, p)| p.enabled).map(|(id, _)| id.clone()).collect();
    let brokers: Vec<BrokerPlugin> = enabled
        .iter()
        .filter_map(|id| installed_manifest(app, id))
        .filter(|m| m.provides(Capability::Broker) && m.supported_here())
        .map(|m| BrokerPlugin { connected: plugins.hub.connected(&m.id).is_some(), id: m.id, name: m.name })
        .collect();
    let active = active(app).filter(|id| brokers.iter().any(|b| &b.id == id));
    let manifest = active.as_deref().and_then(|id| installed_manifest(app, id));
    let s = state(app);
    let trading_enabled = plugins.config.locked().trading_enabled;
    let account = active.as_deref().and_then(|id| s.states.locked().get(id).cloned());
    let notices = s.notices.locked().iter().cloned().collect();
    BrokerStatus {
        version: s.version.load(Ordering::Relaxed),
        plugin_connected: active.as_deref().is_some_and(|id| plugins.hub.connected(id).is_some()),
        active_name: manifest.as_ref().map(|m| m.name.clone()),
        data_exchange: manifest.as_ref().filter(|m| m.provides(Capability::Datafeed) && !m.whole_symbols()).and_then(|m| m.exchange.clone()),
        data_exchanges: manifest.filter(|m| m.provides(Capability::Datafeed) && m.whole_symbols()).map(|m| m.exchanges).unwrap_or_default(),
        trading_enabled,
        state: account,
        notices,
        brokers,
        active,
    }
}

pub fn init(app: &AppHandle) {
    let mut events = app.state::<Plugins>().hub.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(HubEvent::Connected { .. }) => {
                    state(&handle).resolved.locked().clear();
                    changed(&handle);
                }
                Ok(HubEvent::Disconnected { plugin }) => {
                    state(&handle).states.locked().remove(&plugin);
                    state(&handle).resolved.locked().clear();
                    if active(&handle).as_deref() == Some(&plugin) {
                        notice(&handle, "warn", "The broker plugin disconnected".into());
                    }
                    changed(&handle);
                }
                Ok(HubEvent::Notification { plugin, method, params }) => on_notification(&handle, &plugin, &method, params),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
    });
    // The status goes out at most every 250 ms: a plugin may send its state on every tick.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tick.tick().await;
            if state(&handle).dirty.swap(false, Ordering::Relaxed) {
                let _ = status(&handle).emit(&handle);
            }
        }
    });
}

fn on_notification(app: &AppHandle, plugin: &str, method: &str, params: Value) {
    match method {
        "broker.state" => match serde_json::from_value::<BrokerState>(params) {
            Ok(s) => {
                state(app).states.locked().insert(plugin.to_string(), s);
                if active(app).as_deref() == Some(plugin) {
                    changed(app);
                }
            }
            Err(e) => super::log(app, plugin, format!("[error] broker.state: {e}")),
        },
        "broker.event" if active(app).as_deref() == Some(plugin) => match serde_json::from_value::<BrokerEvent>(params) {
            Ok(event) => {
                if event.kind == "rejected" {
                    notice(app, "error", format!("{} {}: {}", event.ticker, "rejected", event.message.clone().unwrap_or_default()));
                }
                let _ = BrokerOrderEvent { event }.emit(app);
            }
            Err(e) => super::log(app, plugin, format!("[error] broker.event: {e}")),
        },
        "broker.notice" if active(app).as_deref() == Some(plugin) => {
            let level = params.get("level").and_then(Value::as_str).unwrap_or("info").to_string();
            let message = params.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
            notice(app, &level, message);
        }
        "broker.quote" if active(app).as_deref() == Some(plugin) => {
            if let Ok(q) = serde_json::from_value::<BrokerQuote>(params) {
                let _ = q.emit(app);
            }
        }
        _ => {}
    }
}

/// The active broker plugin, connected.
fn connected_broker(app: &AppHandle) -> Result<String, String> {
    let id = active(app).ok_or("No broker is connected")?;
    if app.state::<Plugins>().hub.connected(&id).is_none() {
        return Err("The broker plugin is not connected".into());
    }
    Ok(id)
}

fn require_trading(app: &AppHandle) -> Result<(), String> {
    if app.state::<Plugins>().config.locked().trading_enabled {
        Ok(())
    } else {
        Err("Trading is turned off (Trade menu)".into())
    }
}

async fn ask(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let id = connected_broker(app)?;
    let hub = app.state::<Plugins>().hub.clone();
    hub.request(&id, method, params, ORDER_TIMEOUT).await.map_err(|e| e.to_string())
}

/// A refused or failed command: in the notifications log too.
fn failed(app: &AppHandle, what: &str, e: String) -> String {
    notice(app, "error", format!("{what}: {e}"));
    e
}

#[tauri::command]
#[specta::specta]
pub fn broker_status(app: AppHandle) -> BrokerStatus {
    status(&app)
}

/// Connect the window's trading to a broker plugin (None: disconnect).
#[tauri::command]
#[specta::specta]
pub fn broker_set_active(app: AppHandle, id: Option<String>) -> Result<BrokerStatus, String> {
    if let Some(id) = &id {
        let m = installed_manifest(&app, id).ok_or_else(|| format!("{id} is not installed"))?;
        if !m.provides(Capability::Broker) {
            return Err(format!("{} is not a broker plugin", m.name));
        }
    }
    let plugins = app.state::<Plugins>();
    let config = {
        let mut c = plugins.config.locked();
        c.active_broker = id;
        c.clone()
    };
    super::write_config(&app, &config)?;
    state(&app).resolved.locked().clear();
    changed(&app);
    Ok(status(&app))
}

/// Allow or stop placing and changing orders. Turned off whenever the broker changes is not needed: the switch is the
/// user's, for every broker.
#[tauri::command]
#[specta::specta]
pub fn broker_set_trading_enabled(app: AppHandle, enabled: bool) -> Result<BrokerStatus, String> {
    let plugins = app.state::<Plugins>();
    let config = {
        let mut c = plugins.config.locked();
        c.trading_enabled = enabled;
        c.clone()
    };
    super::write_config(&app, &config)?;
    notice(&app, "info", if enabled { "Trading turned on".into() } else { "Trading turned off".into() });
    Ok(status(&app))
}

#[tauri::command]
#[specta::specta]
pub async fn broker_select_account(app: AppHandle, account: String) -> Result<(), String> {
    ask(&app, "broker.selectAccount", json!({ "account": account })).await.map(|_| ()).map_err(|e| failed(&app, "Account", e))
}

/// The active broker's ticker for a chart symbol, None when it doesn't trade it. The user's own mapping (Settings >
/// Plugins) first, then the plugin's own symbols, then the plugin's answer.
#[tauri::command]
#[specta::specta]
pub async fn broker_resolve_symbol(app: AppHandle, symbol: String) -> Result<Option<String>, String> {
    let id = connected_broker(&app)?;
    let symbol = symbol.trim().to_string();
    if let Some(t) = app.state::<Plugins>().config.locked().plugins.get(&id).and_then(|p| p.symbol_map.get(&symbol.to_uppercase()).cloned()) {
        return Ok(Some(t));
    }
    if let Some(r) = super::data::route(&app, &symbol).filter(|r| r.plugin == id) {
        return Ok(Some(r.ticker));
    }
    if let Some(known) = state(&app).resolved.locked().get(&symbol) {
        return Ok(known.clone());
    }
    let ticker = symbol.split_once(':').map_or(symbol.as_str(), |(_, t)| t).to_string();
    let v = ask(&app, "broker.resolveSymbol", json!({ "symbol": symbol, "ticker": ticker })).await?;
    let found = v.get("ticker").and_then(Value::as_str).map(str::to_string).filter(|t| !t.is_empty());
    state(&app).resolved.locked().insert(symbol, found.clone());
    Ok(found)
}

#[tauri::command]
#[specta::specta]
pub async fn broker_place(app: AppHandle, ticket: OrderTicket) -> Result<String, String> {
    require_trading(&app).map_err(|e| failed(&app, "Order", e))?;
    let v = ask(&app, "broker.place", serde_json::to_value(&ticket).map_err(|e| e.to_string())?).await.map_err(|e| failed(&app, "Order", e))?;
    Ok(v.get("orderId").map(|id| id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string())).unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
pub async fn broker_modify(app: AppHandle, order_id: String, ticket: OrderTicket) -> Result<(), String> {
    require_trading(&app).map_err(|e| failed(&app, "Modify", e))?;
    let mut params = serde_json::to_value(&ticket).map_err(|e| e.to_string())?;
    params["orderId"] = json!(order_id);
    ask(&app, "broker.modify", params).await.map(|_| ()).map_err(|e| failed(&app, "Modify", e))
}

#[tauri::command]
#[specta::specta]
pub async fn broker_cancel(app: AppHandle, order_id: String) -> Result<(), String> {
    ask(&app, "broker.cancel", json!({ "orderId": order_id })).await.map(|_| ()).map_err(|e| failed(&app, "Cancel", e))
}

/// Close a position, whole (`qty` None) or in part.
#[tauri::command]
#[specta::specta]
pub async fn broker_close_position(app: AppHandle, position_id: String, qty: Option<f64>) -> Result<(), String> {
    ask(&app, "broker.closePosition", json!({ "positionId": position_id, "qty": qty })).await.map(|_| ()).map_err(|e| failed(&app, "Close", e))
}

#[tauri::command]
#[specta::specta]
pub async fn broker_set_position_brackets(app: AppHandle, position_id: String, take_profit: Option<f64>, stop_loss: Option<f64>) -> Result<(), String> {
    require_trading(&app).map_err(|e| failed(&app, "Protect", e))?;
    ask(&app, "broker.setPositionBrackets", json!({ "positionId": position_id, "takeProfit": take_profit, "stopLoss": stop_loss }))
        .await
        .map(|_| ())
        .map_err(|e| failed(&app, "Protect", e))
}

/// The tickers whose bid / ask the order ticket shows (the whole set; empty: none).
#[tauri::command]
#[specta::specta]
pub fn broker_watch_quotes(app: AppHandle, tickers: Vec<String>) -> Result<(), String> {
    let id = connected_broker(&app)?;
    app.state::<Plugins>().hub.notify(&id, "broker.watchQuote", json!({ "tickers": tickers })).map_err(|e| e.to_string())
}

/// The user's chart symbol → broker ticker mapping of a broker plugin (Settings > Plugins).
#[tauri::command]
#[specta::specta]
pub fn broker_set_symbol_map(app: AppHandle, id: String, map: std::collections::BTreeMap<String, String>) -> Result<super::PluginsStatus, String> {
    let map = map.into_iter().map(|(k, v)| (k.trim().to_uppercase(), v.trim().to_string())).filter(|(k, v)| k.contains(':') && !v.is_empty()).collect();
    super::update_plugin(&app, &id, |p| p.symbol_map = map)?;
    state(&app).resolved.locked().clear();
    changed(&app);
    Ok(super::status(&app))
}
