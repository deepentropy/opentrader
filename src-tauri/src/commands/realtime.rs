/*
 * Realtime subscription commands — Feature 9.
 *
 * Both commands push messages onto the live-data task's mpsc channel (the
 * `WsHandle` the active provider spawned into app state); the task diffs against
 * its previous state to emit the minimal subscribe / unsubscribe frames. The
 * frontend just declares its desired state — which provider/transport backs the
 * handle (REST poll vs WebSocket) is invisible here.
 */
use crate::data::types::{SubscribeMsg, WsHandle};
use tauri::{AppHandle, Manager};

/// "ECONOMICS:<ID>": an economic series (no live data).
fn is_economic_symbol(symbol: &str) -> bool {
    symbol.split_once(':').is_some_and(|(ex, _)| crate::data::market_rest::economics::is_economic(ex))
}

/// Chart slots are owner-keyed "<window label>:<pane id>" so multi-pane
/// layouts and detached windows each hold their own charted symbol; the
/// live task unions them (see SubscriptionState). `pane` is the caller's
/// pane identity within its window.
#[tauri::command]
#[specta::specta]
pub async fn set_chart_subscription(
    app: AppHandle,
    window: tauri::Window,
    pane: String,
    symbol: Option<String>,
) -> Result<(), String> {
    let owner = format!("{}:{}", window.label(), pane);
    // Economic series have no live data.
    let normalized = symbol.map(|s| s.to_uppercase()).filter(|s| !is_economic_symbol(s));
    app.state::<WsHandle>()
        .tx
        .send(SubscribeMsg::SetChart {
            owner,
            symbol: normalized,
        })
        .await
        .map_err(|e| format!("realtime task dropped: {e}"))?;
    Ok(())
}

/// Watchlist contributions are keyed by the calling window's label — every
/// window declares its own union and the live task merges them, so a second
/// window can no longer clobber the first's subscription.
#[tauri::command]
#[specta::specta]
pub async fn set_watchlist_subscription(
    app: AppHandle,
    window: tauri::Window,
    symbols: Vec<String>,
) -> Result<(), String> {
    let owner = window.label().to_string();
    let normalized: Vec<String> = symbols.into_iter().map(|s| s.to_uppercase()).filter(|s| !is_economic_symbol(s)).collect();
    app.state::<WsHandle>()
        .tx
        .send(SubscribeMsg::SetWatchlist {
            owner,
            symbols: normalized,
        })
        .await
        .map_err(|e| format!("realtime task dropped: {e}"))?;
    Ok(())
}
