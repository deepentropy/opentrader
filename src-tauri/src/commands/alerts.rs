/*
 * Alert-delivery commands — the webhook POST routed through Rust (see
 * `opentrader_core::webhook`: the webview's own fetch is blocked by most
 * receivers' CORS preflight).
 */

/// POST `payload` (a pre-serialised JSON string) to `url` with a JSON
/// content-type. One attempt, ~5s deadline, no retry; a non-2xx status is an
/// error too so the frontend log names the receiver's rejection.
#[tauri::command]
#[specta::specta]
pub async fn post_webhook(url: String, payload: String) -> Result<(), String> {
    opentrader_core::webhook::post_webhook(url, payload).await
}
