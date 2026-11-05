/*
 * Alert-delivery commands — the webhook POST routed through Rust (see
 * `opentrader_core::webhook`: the webview's own fetch is blocked by most
 * receivers' CORS preflight).
 */

/// POST `payload` (a pre-serialised JSON string) to `url` with a JSON
/// content-type. One attempt, ~5s deadline, no retry; returns the receiver's
/// HTTP status or the error that prevented one.
#[tauri::command]
#[specta::specta]
pub async fn post_webhook(url: String, payload: String) -> opentrader_core::webhook::WebhookResult {
    opentrader_core::webhook::post_webhook(url, payload).await
}
