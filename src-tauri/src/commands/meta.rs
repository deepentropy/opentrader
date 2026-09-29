/*
 * Provider metadata command — lets the frontend learn which data provider the
 * backend selected (the `DATA_PROVIDER` env var) so it can pick the matching
 * presentation adapter instead of hardcoding one. See `data/provider`.
 */
use crate::data::provider::capabilities::ProviderCapabilities;
use crate::data::provider::{entitlements, Provider};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub fn get_data_provider(provider: State<'_, Provider>) -> String {
    provider.name().to_string()
}

/// What the active provider can serve (the datafeed `onReady` equivalent):
/// the static capabilities plus the last probed entitlements (`None` until the
/// first probe settles). No I/O — later changes arrive as the
/// `provider-capabilities` event.
#[tauri::command]
#[specta::specta]
pub fn get_provider_capabilities(provider: State<'_, Provider>) -> ProviderCapabilities {
    entitlements::full_capabilities(&provider)
}

/// Write a PNG snapshot to a temp file and open it with the OS default viewer
/// (the local backing for "Open image in new tab").
#[tauri::command]
#[specta::specta]
pub fn open_snapshot(app: tauri::AppHandle, png_base64: String) -> Result<(), String> {
    use base64::Engine as _;
    use tauri_plugin_opener::OpenerExt as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("opentrader-snapshot-{stamp}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
