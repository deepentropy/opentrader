/*
 * The AI assistant panel's connection to OpenTrader's model, which runs on this computer (local_model.rs: its llama.cpp
 * server on 127.0.0.1, started with the first chat). A chat streams the server's events to the window as they come
 * (a Channel); the window runs the agent loop and the tools (src/data/assistant/).
 */
use opentrader_core::net::SharedClient;
use opentrader_core::sync::LockExt;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::sync::oneshot;

static CLIENT: SharedClient = SharedClient::new(|b| b.connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(300)));
/// The chats under way: their stop.
static RUNNING: Mutex<Option<HashMap<u32, oneshot::Sender<()>>>> = Mutex::new(None);

/// A chat's entry in `RUNNING`, removed however the chat ends (the window may drop the call midway).
struct Running(u32);

impl Running {
    fn new(request: u32) -> (Self, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        RUNNING.locked().get_or_insert_with(HashMap::new).insert(request, tx);
        (Running(request), rx)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(running) = RUNNING.locked().as_mut() {
            running.remove(&self.0);
        }
    }
}

/// The server's own error message when it gives one.
fn server_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("The model answered with an error ({status}): {msg}")
}

/// The next whole line of `buf` (without its line end), taken out of it. Lines are cut at the byte `\n`, which is
/// never part of a multi-byte character: a character split between two chunks of the stream stays whole.
fn next_line(buf: &mut Vec<u8>) -> Option<String> {
    let at = buf.iter().position(|&b| b == b'\n')?;
    let line: Vec<u8> = buf.drain(..=at).collect();
    Some(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string())
}

/// How a chat request ended.
enum Ended {
    /// The answer is complete.
    Answered,
    /// Stopped by `assistant_cancel`.
    Stopped,
}

/// One chat request (POST /chat/completions with `body`, the JSON the window builds). Each event of the stream is
/// sent on `on_event` (its JSON text). Returns when the answer is complete, stopped (assistant_cancel) or failed.
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat(app: AppHandle, request: u32, body: String, on_event: Channel<String>) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    // Registered before the model starts, so a stop also ends the wait for its start (up to 2 minutes).
    let (_running, mut stop_rx) = Running::new(request);
    let ended = async {
        let base_url = tokio::select! {
            r = crate::local_model::ensure_server(&app) => r?,
            _ = &mut stop_rx => return Ok(Ended::Stopped),
        };
        let req = CLIENT.get().post(format!("{base_url}/chat/completions")).json(&payload);
        let mut res = tokio::select! {
            r = req.send() => r.map_err(|e| format!("The model did not answer: {e}"))?,
            _ = &mut stop_rx => return Ok(Ended::Stopped),
        };
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(server_error(status.as_u16(), &text));
        }
        let mut buf = Vec::new();
        loop {
            let chunk = tokio::select! {
                c = res.chunk() => c.map_err(|e| format!("The answer stopped: {e}"))?,
                _ = &mut stop_rx => return Ok(Ended::Stopped),
            };
            let Some(bytes) = chunk else { break };
            buf.extend_from_slice(&bytes);
            // Server-sent events: one `data: …` line per event, a blank line between them.
            while let Some(line) = next_line(&mut buf) {
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        return Ok(Ended::Answered);
                    }
                    if !data.is_empty() {
                        on_event.send(data.to_string()).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        Ok(Ended::Answered)
    }
    .await?;
    // The prompt work is worth keeping once the model has answered (not after a chat stopped before its answer).
    if let Ended::Answered = ended {
        crate::local_model::save_prefix(&app).await;
    }
    Ok(())
}

/// Stops a chat request under way (its answer so far stays).
#[tauri::command]
#[specta::specta]
pub fn assistant_cancel(request: u32) {
    if let Some(tx) = RUNNING.locked().as_mut().and_then(|running| running.remove(&request)) {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_between_chunks_stays_whole() {
        let line = "data: {\"content\":\"€ é\"}\r\n".as_bytes();
        // Cut inside the three bytes of "€".
        let cut = line.iter().position(|&b| b == 0xE2).unwrap() + 1;
        let mut buf = Vec::new();
        buf.extend_from_slice(&line[..cut]);
        assert_eq!(next_line(&mut buf), None);
        buf.extend_from_slice(&line[cut..]);
        buf.extend_from_slice(b"\ndata: [DONE]");
        assert_eq!(next_line(&mut buf).as_deref(), Some("data: {\"content\":\"€ é\"}"));
        assert_eq!(next_line(&mut buf).as_deref(), Some(""));
        assert_eq!(next_line(&mut buf), None, "no line end yet");
        assert_eq!(buf, b"data: [DONE]");
    }

    #[test]
    fn a_dropped_chat_leaves_no_stop_behind() {
        let (running, _rx) = Running::new(7);
        assert!(RUNNING.locked().as_ref().is_some_and(|r| r.contains_key(&7)));
        drop(running);
        assert!(!RUNNING.locked().as_ref().is_some_and(|r| r.contains_key(&7)));
    }
}
