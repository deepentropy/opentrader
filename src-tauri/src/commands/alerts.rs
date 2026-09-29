/*
 * Alert-delivery commands — the webhook POST routed through Rust. The webview's
 * fetch originates from tauri.localhost, so most webhook receivers reject its
 * CORS preflight and never see the payload; a native reqwest call has no such
 * gate. The engine (src/data/alert-engine.ts) treats delivery as
 * fire-and-forget and only logs the returned error string.
 */
use std::sync::OnceLock;

/// Dedicated client rather than the pooled Massive one: a webhook wants a short
/// overall deadline (a slow receiver must not hold the fire path open), which
/// the data client deliberately doesn't set.
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("build webhook reqwest client")
    })
}

/// POST `payload` (a pre-serialised JSON string) to `url` with a JSON
/// content-type. One attempt, ~5s deadline, no retry; a non-2xx status is an
/// error too so the frontend log names the receiver's rejection.
#[tauri::command]
#[specta::specta]
pub async fn post_webhook(url: String, payload: String) -> Result<(), String> {
    let resp = http()
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.error_for_status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
