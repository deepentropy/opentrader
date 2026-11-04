/*
 * The AI assistant panel's connection to OpenTrader's model, which runs on this computer (local_model.rs: its llama.cpp
 * server on 127.0.0.1, started with the first chat). A chat streams the server's events to the window as they come
 * (a Channel); the window runs the agent loop and the tools (src/data/assistant/).
 */
use opentrader_core::net::SharedClient;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::sync::oneshot;

static CLIENT: SharedClient = SharedClient::new(|b| b.connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(300)));
/// The chats under way: their stop.
static RUNNING: Mutex<Option<HashMap<u32, oneshot::Sender<()>>>> = Mutex::new(None);

/// The server's own error message when it gives one.
fn server_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("The model answered with an error ({status}): {msg}")
}

/// One chat request (POST /chat/completions with `body`, the JSON the window builds). Each event of the stream is
/// sent on `on_event` (its JSON text). Returns when the answer is complete, stopped (assistant_cancel) or failed.
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat(app: AppHandle, request: u32, body: String, on_event: Channel<String>) -> Result<(), String> {
    let base_url = crate::local_model::ensure_server(&app).await?;
    let payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let (stop_tx, mut stop_rx) = oneshot::channel();
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).insert(request, stop_tx);
    let result = async {
        let req = CLIENT.get().post(format!("{base_url}/chat/completions")).json(&payload);
        let mut res = tokio::select! {
            r = req.send() => r.map_err(|e| format!("The model did not answer: {e}"))?,
            _ = &mut stop_rx => return Ok(()),
        };
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(server_error(status.as_u16(), &text));
        }
        let mut buf = String::new();
        loop {
            let chunk = tokio::select! {
                c = res.chunk() => c.map_err(|e| format!("The answer stopped: {e}"))?,
                _ = &mut stop_rx => return Ok(()),
            };
            let Some(bytes) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            // Server-sent events: one `data: …` line per event, a blank line between them.
            while let Some(at) = buf.find('\n') {
                let line = buf[..at].trim_end_matches('\r').to_string();
                buf.drain(..=at);
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        return Ok(());
                    }
                    if !data.is_empty() {
                        on_event.send(data.to_string()).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }
    .await;
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&request);
    if result.is_ok() {
        crate::local_model::save_prefix(&app).await;
    }
    result
}

/// Stops a chat request under way (its answer so far stays).
#[tauri::command]
#[specta::specta]
pub fn assistant_cancel(request: u32) {
    if let Some(tx) = RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&request) {
        let _ = tx.send(());
    }
}
