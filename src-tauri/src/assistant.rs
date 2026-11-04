/*
 * The AI assistant panel's connection to a model: any server that speaks the OpenAI chat-completions API (a cloud
 * provider, or a model run on this computer). The models the user adds are saved in the app's config folder; their API
 * keys go to the system's encrypted credential store (as the proxy password, network.rs), or last until the app
 * closes where that store isn't available.
 *
 * Requests go through Rust so that they take the proxy (opentrader_core::net) and carry the key without the page ever
 * holding it. A chat streams the server's events to the window as they come (a Channel); the window runs the agent
 * loop and the tools (src/data/assistant/).
 */
use opentrader_core::net::SharedClient;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const FILE: &str = "assistant.json";
const EFFORTS: [&str; 3] = ["low", "medium", "high"];

static CLIENT: SharedClient = SharedClient::new(|b| b.connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(300)));
/// Keys of this session where the credential store can't keep them, by model id.
static UNSAVED_KEYS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// The chats under way: their stop.
static RUNNING: Mutex<Option<HashMap<u32, oneshot::Sender<()>>>> = Mutex::new(None);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredModel {
    id: String,
    label: String,
    description: String,
    base_url: String,
    model: String,
    has_key: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct SavedFile {
    models: Vec<StoredModel>,
    selected: Option<String>,
    effort: Option<String>,
}

/// A model the panel offers.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantModel {
    pub id: String,
    /// As the model picker names it.
    pub label: String,
    pub description: String,
    /// The API root, up to `/v1` ("https://…/v1", "http://127.0.0.1:8080/v1").
    pub base_url: String,
    /// The model id the server takes.
    pub model: String,
    pub has_key: bool,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConfig {
    pub models: Vec<AssistantModel>,
    pub selected: Option<String>,
    /// "low", "medium", "high", or none: the server's default.
    pub effort: Option<String>,
}

/// A model added or edited in the panel. `api_key`: none = keep the stored one, "" = remove it.
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantModelInput {
    pub id: Option<String>,
    pub label: String,
    pub description: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

fn credential(app: &AppHandle, id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(&app.config().identifier, &format!("assistant-key-{id}"))
}

fn unsaved() -> std::sync::MutexGuard<'static, Option<HashMap<String, String>>> {
    UNSAVED_KEYS.lock().unwrap()
}

/// Stores a key (or removes it with ""): true when the credential store holds it.
fn store_key(app: &AppHandle, id: &str, key: &str) -> bool {
    let stored = credential(app, id).and_then(|entry| {
        if key.is_empty() {
            match entry.delete_credential() {
                Err(keyring::Error::NoEntry) => Ok(()),
                other => other,
            }
        } else {
            entry.set_password(key)
        }
    });
    let mut keys = unsaved();
    let keys = keys.get_or_insert_with(HashMap::new);
    match stored {
        Ok(()) => {
            keys.remove(id);
            true
        }
        Err(e) => {
            eprintln!("[assistant] key not stored: {e}");
            if key.is_empty() {
                keys.remove(id);
            } else {
                keys.insert(id.to_string(), key.to_string());
            }
            false
        }
    }
}

fn read_key(app: &AppHandle, id: &str) -> Option<String> {
    if let Some(k) = unsaved().as_ref().and_then(|m| m.get(id).cloned()) {
        return Some(k);
    }
    credential(app, id).and_then(|e| e.get_password()).ok().filter(|k| !k.is_empty())
}

fn read_file(app: &AppHandle) -> SavedFile {
    let path = app.path().app_config_dir().ok().map(|d| d.join(FILE));
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_file(app: &AppHandle, file: &SavedFile) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), text).map_err(|e| e.to_string())
}

fn config_of(file: &SavedFile) -> AssistantConfig {
    let keys = unsaved();
    AssistantConfig {
        models: file
            .models
            .iter()
            .map(|m| AssistantModel {
                id: m.id.clone(),
                label: m.label.clone(),
                description: m.description.clone(),
                base_url: m.base_url.clone(),
                model: m.model.clone(),
                has_key: m.has_key || keys.as_ref().is_some_and(|k| k.contains_key(&m.id)),
            })
            .collect(),
        selected: file.selected.clone().filter(|s| file.models.iter().any(|m| &m.id == s)),
        effort: file.effort.clone(),
    }
}

/// "https://host/v1/" → "https://host/v1"; refuses anything but http(s).
fn base_of(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(u).map_err(|_| format!("\"{url}\" is not an address (https://…/v1)."))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("The address starts with http:// or https://.".into());
    }
    Ok(u.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn assistant_config(app: AppHandle) -> AssistantConfig {
    config_of(&read_file(&app))
}

/// Adds or edits a model (it becomes the selected one). An error: the key couldn't go to the credential store; it lasts
/// until the app closes (the rest is saved).
#[tauri::command]
#[specta::specta]
pub fn assistant_save_model(app: AppHandle, input: AssistantModelInput) -> Result<AssistantConfig, String> {
    let base_url = base_of(&input.base_url)?;
    if input.model.trim().is_empty() {
        return Err("The model id is required.".into());
    }
    let mut file = read_file(&app);
    let id = input.id.clone().filter(|id| file.models.iter().any(|m| &m.id == id)).unwrap_or_else(|| {
        let mut n = file.models.len() + 1;
        while file.models.iter().any(|m| m.id == format!("m{n}")) {
            n += 1;
        }
        format!("m{n}")
    });
    let mut warning = None;
    let had_key = file.models.iter().find(|m| m.id == id).is_some_and(|m| m.has_key);
    let has_key = match &input.api_key {
        None => had_key,
        Some(key) => {
            let key = key.trim();
            let stored = store_key(&app, &id, key);
            if !stored && !key.is_empty() {
                warning = Some("The system's credential store is not available: the key lasts until the app closes.".to_string());
            }
            stored && !key.is_empty()
        }
    };
    let label = if input.label.trim().is_empty() { input.model.trim().to_string() } else { input.label.trim().to_string() };
    let entry = StoredModel { id: id.clone(), label, description: input.description.trim().to_string(), base_url, model: input.model.trim().to_string(), has_key };
    match file.models.iter_mut().find(|m| m.id == id) {
        Some(m) => *m = entry,
        None => file.models.push(entry),
    }
    file.selected = Some(id);
    write_file(&app, &file)?;
    match warning {
        Some(w) => Err(w),
        None => Ok(config_of(&file)),
    }
}

#[tauri::command]
#[specta::specta]
pub fn assistant_remove_model(app: AppHandle, id: String) -> Result<AssistantConfig, String> {
    let mut file = read_file(&app);
    file.models.retain(|m| m.id != id);
    if file.selected.as_deref() == Some(id.as_str()) {
        file.selected = file.models.first().map(|m| m.id.clone());
    }
    store_key(&app, &id, "");
    write_file(&app, &file)?;
    Ok(config_of(&file))
}

/// The model and the effort of the next requests.
#[tauri::command]
#[specta::specta]
pub fn assistant_select(app: AppHandle, id: Option<String>, effort: Option<String>) -> Result<AssistantConfig, String> {
    let mut file = read_file(&app);
    if let Some(id) = id {
        if !file.models.iter().any(|m| m.id == id) {
            return Err(format!("No model \"{id}\"."));
        }
        file.selected = Some(id);
    }
    file.effort = effort.filter(|e| EFFORTS.contains(&e.as_str()));
    write_file(&app, &file)?;
    Ok(config_of(&file))
}

/// The model ids a server offers (GET /models): to check an address and a key before saving. `key`: the one typed,
/// else the stored key of model `id`.
#[tauri::command]
#[specta::specta]
pub async fn assistant_list_models(app: AppHandle, base_url: String, key: Option<String>, id: Option<String>) -> Result<Vec<String>, String> {
    let base = base_of(&base_url)?;
    let key = key.filter(|k| !k.trim().is_empty()).or_else(|| id.and_then(|id| read_key(&app, &id)));
    let mut req = CLIENT.get().get(format!("{base}/models")).timeout(Duration::from_secs(20));
    if let Some(k) = key {
        req = req.bearer_auth(k.trim());
    }
    let res = req.send().await.map_err(|e| format!("No answer from {base}: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(server_error(status.as_u16(), &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "The server's answer is not the OpenAI API's.".to_string())?;
    let mut ids: Vec<String> = v["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(String::from)).collect();
    ids.sort();
    Ok(ids)
}

/// The server's own error message when it gives one.
fn server_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status {
        401 | 403 => format!("The server refused the key ({status}): {msg}"),
        404 => format!("Not found ({status}): check the address and the model id. {msg}"),
        429 => format!("Too many requests or no credit left ({status}): {msg}"),
        _ => format!("Server error {status}: {msg}"),
    }
}

/// One chat request (POST /chat/completions with `body`, the JSON the window builds) on model `id`. Each event of
/// the stream is sent on `on_event` (its JSON text); a server that answers without streaming sends its whole answer
/// once. Returns when the answer is complete, stopped (assistant_cancel) or failed.
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat(app: AppHandle, id: String, request: u32, body: String, on_event: Channel<String>) -> Result<(), String> {
    let file = read_file(&app);
    let m = file.models.iter().find(|m| m.id == id).ok_or_else(|| format!("No model \"{id}\": add one in the model picker."))?;
    let mut payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    payload["model"] = serde_json::Value::String(m.model.clone());
    let (stop_tx, mut stop_rx) = oneshot::channel();
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).insert(request, stop_tx);
    let result = async {
        let mut req = CLIENT.get().post(format!("{}/chat/completions", m.base_url)).json(&payload);
        if let Some(k) = read_key(&app, &m.id) {
            req = req.bearer_auth(k);
        }
        let mut res = tokio::select! {
            r = req.send() => r.map_err(|e| format!("No answer from {}: {e}", m.base_url))?,
            _ = &mut stop_rx => return Ok(()),
        };
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(server_error(status.as_u16(), &text));
        }
        let streamed = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("event-stream"));
        let mut buf = String::new();
        loop {
            let chunk = tokio::select! {
                c = res.chunk() => c.map_err(|e| format!("The answer stopped: {e}"))?,
                _ = &mut stop_rx => return Ok(()),
            };
            let Some(bytes) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            if !streamed {
                continue;
            }
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
        if !streamed && !buf.trim().is_empty() {
            on_event.send(buf).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    .await;
    RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&request);
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
