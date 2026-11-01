/*
 * Settings > Network: the proxy (opentrader_core::net), saved in the app's config folder. Applied at startup before any
 * connection is made.
 */
use opentrader_core::net::{self, ProxySettings};
use tauri::{AppHandle, Manager};

const FILE: &str = "network.json";

fn saved(app: &AppHandle) -> ProxySettings {
    let path = app.path().app_config_dir().ok().map(|d| d.join(FILE));
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn init(app: &AppHandle) {
    if let Err(e) = net::set_proxy(&saved(app)) {
        eprintln!("[network] saved proxy not applied: {e:#}");
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_proxy_settings(app: AppHandle) -> ProxySettings {
    saved(&app)
}

/// Applies and saves. Unusable settings (a port that is no number) are refused.
#[tauri::command]
#[specta::specta]
pub fn set_proxy_settings(app: AppHandle, settings: ProxySettings) -> Result<(), String> {
    net::set_proxy(&settings).map_err(|e| format!("{e:#}"))?;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), text).map_err(|e| e.to_string())
}
