/*
 * Realtime subscription commands — Feature 9.
 *
 * Both commands push messages onto the live-data task's mpsc channel (the
 * `WsHandle` the active provider spawned into app state); the task diffs against
 * its previous state to emit the minimal subscribe / unsubscribe frames. The
 * frontend just declares its desired state — which provider/transport backs the
 * handle (REST poll vs WebSocket) is invisible here. The symbol clean-up is
 * shared with the web server (`opentrader_core::commands`).
 */
use crate::data::types::{SubscribeMsg, WsHandle};
use opentrader_core::commands as core;
use tauri::State;

/// Chart slots are owner-keyed "<window label>:<pane id>" so multi-pane
/// layouts and detached windows each hold their own charted symbol; the
/// live task unions them (see SubscriptionState). `pane` is the caller's
/// pane identity within its window.
#[tauri::command]
#[specta::specta]
pub async fn set_chart_subscription(
    live: State<'_, WsHandle>,
    window: tauri::Window,
    pane: String,
    symbol: Option<String>,
) -> Result<(), String> {
    let owner = core::chart_owner(window.label(), &pane);
    Ok(core::subscribe(&live, SubscribeMsg::SetChart { owner, symbol: core::live_symbol(symbol) }).await?)
}

/// Watchlist contributions are keyed by the calling window's label — every
/// window declares its own union and the live task merges them, so a second
/// window can no longer clobber the first's subscription.
#[tauri::command]
#[specta::specta]
pub async fn set_watchlist_subscription(
    live: State<'_, WsHandle>,
    window: tauri::Window,
    symbols: Vec<String>,
) -> Result<(), String> {
    let owner = window.label().to_string();
    Ok(core::subscribe(&live, SubscribeMsg::SetWatchlist { owner, symbols: core::live_symbols(symbols) }).await?)
}

/// The subscribed account's pass (#252) from the frontend, or none (signed out,
/// free plan). `exp`: its expiry, UNIX seconds. Market calls and the stream
/// use it from now on (`data::pass`).
#[tauri::command]
#[specta::specta]
pub fn market_pass_set(pass: Option<String>, exp: Option<f64>) {
    crate::data::pass::set(pass.zip(exp).map(|(token, exp)| crate::data::pass::Pass { token, exp: exp as i64 }));
}

/// Take the account's real-time session back on this device after another one
/// took it ("signed in elsewhere"): that device goes back to delayed data.
#[tauri::command]
#[specta::specta]
pub fn market_pass_resume() {
    crate::data::pass::set_elsewhere(false);
}
