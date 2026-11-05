/*
 * Alert delivery — the webhook POST routed through Rust. The webview's
 * fetch originates from tauri.localhost, so most webhook receivers reject its
 * CORS preflight and never see the payload; a native reqwest call has no such
 * gate. The engine (src/data/alert-engine.ts) does not wait on delivery; it
 * writes the outcome on the event (the Alerts log's "Webhook status").
 */

/// Dedicated client rather than the pooled market-data one: a webhook wants a short
/// overall deadline (a slow receiver must not hold the fire path open), which
/// the data client deliberately doesn't set.
fn http() -> reqwest::Client {
    static CLIENT: crate::net::SharedClient = crate::net::SharedClient::new(|b| b.timeout(std::time::Duration::from_secs(5)));
    CLIENT.get()
}

/// What a webhook POST came to: the receiver's HTTP status, or the error that
/// kept the request from getting one (unreachable host, timeout).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebhookResult {
    pub http_code: Option<u16>,
    pub error: Option<String>,
}

/// POST `payload` (a pre-serialised JSON string) to `url` with a JSON
/// content-type. One attempt, ~5s deadline, no retry.
pub async fn post_webhook(url: String, payload: String) -> WebhookResult {
    match http()
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
    {
        Ok(resp) => WebhookResult { http_code: Some(resp.status().as_u16()), error: None },
        Err(e) => WebhookResult { http_code: e.status().map(|s| s.as_u16()), error: Some(e.to_string()) },
    }
}
