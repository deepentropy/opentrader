/*
 * Settings > Network: the proxy (opentrader_core::net), saved in the app's config folder. Applied at startup before any
 * connection is made. The password is never written there: it goes to the system's encrypted credential store
 * (Credential Manager, Keychain, Secret Service). Where that store isn't available it lasts until the app closes.
 */
use opentrader_core::net::{self, ProxySettings};
use opentrader_core::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const FILE: &str = "network.json";
/// Name of the password in the credential store (the service is the app's identifier).
const ACCOUNT: &str = "proxy-password";

/// The password of this session where the credential store can't keep it.
static UNSAVED_PASSWORD: Mutex<Option<String>> = Mutex::new(None);

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct SavedFile {
    #[serde(flatten)]
    settings: ProxySettings,
    /// The credential store holds a password (it isn't read without one: the system may ask the user).
    has_password: bool,
}

fn credential(app: &AppHandle) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(&app.config().identifier, ACCOUNT)
}

fn store_password(app: &AppHandle, password: &str) -> keyring::Result<()> {
    let entry = credential(app)?;
    if !password.is_empty() {
        return entry.set_password(password);
    }
    match entry.delete_credential() {
        Err(keyring::Error::NoEntry) => Ok(()),
        other => other,
    }
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

/// Saves the settings, the password apart. An error: the password couldn't be stored (the rest is saved).
fn save(app: &AppHandle, settings: &ProxySettings) -> Result<(), String> {
    let stored = store_password(app, &settings.password);
    let saved = stored.is_ok();
    *UNSAVED_PASSWORD.locked() = (!saved).then(|| settings.password.clone());
    let mut settings = settings.clone();
    let has_password = saved && !settings.password.is_empty();
    settings.password.clear();
    write_file(app, &SavedFile { settings, has_password })?;
    stored.map_err(|e| format!("credential store: {e}"))
}

fn load(app: &AppHandle) -> ProxySettings {
    let file = read_file(app);
    let mut settings = file.settings;
    // A password in the file (an earlier build): moved out of it.
    if !settings.password.is_empty() {
        if let Err(e) = save(app, &settings) {
            eprintln!("[network] proxy password not stored: {e}");
        }
        return settings;
    }
    if let Some(password) = UNSAVED_PASSWORD.locked().clone() {
        settings.password = password;
    } else if file.has_password {
        match credential(app).and_then(|entry| entry.get_password()) {
            Ok(password) => settings.password = password,
            Err(e) => eprintln!("[network] proxy password not read: {e}"),
        }
    }
    settings
}

pub fn init(app: &AppHandle) {
    if let Err(e) = net::set_proxy(&load(app)) {
        eprintln!("[network] saved proxy not applied: {e:#}");
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_proxy_settings(app: AppHandle) -> ProxySettings {
    load(&app)
}

/// Applies and saves. Unusable settings (a port that is no number) are refused. An error after applying: the password
/// lasts until the app closes (the system's credential store is not available).
#[tauri::command]
#[specta::specta]
pub fn set_proxy_settings(app: AppHandle, settings: ProxySettings) -> Result<(), String> {
    net::set_proxy(&settings).map_err(|e| format!("{e:#}"))?;
    save(&app, &settings)
}

/// Factory reset: no proxy, the file and the stored password gone.
#[tauri::command]
#[specta::specta]
pub fn reset_proxy_settings(app: AppHandle) -> Result<(), String> {
    net::set_proxy(&ProxySettings::default()).map_err(|e| format!("{e:#}"))?;
    *UNSAVED_PASSWORD.locked() = None;
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(dir.join(FILE));
    }
    store_password(&app, "").map_err(|e| format!("credential store: {e}"))
}
