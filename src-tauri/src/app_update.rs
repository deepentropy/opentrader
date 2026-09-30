/*
 * In-app update, after the reference desktop app's AutoUpdateService (capture and
 * rules: .tmp/app-update/doc).
 *
 *  - Check at startup, then every hour (the reference app's appinstaller HoursBetweenUpdateChecks
 *    = 1), and again when Settings > About opens. Not on Linux (the reference app skips it too).
 *  - A found update is downloaded silently (signature checked by the updater
 *    plugin). The user is told only when it is ready to install.
 *  - Install on request: every window first writes its pending settings, then
 *    the settings store and the window session go to disk, then the installer
 *    runs. User data lives outside the install folder (%APPDATA%\<identifier>),
 *    so the installer never touches it.
 *
 * One state for the whole app; windows follow it through `AppUpdateStatus`.
 */
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tauri_specta::Event;

/// The reference app's statuses (`system-requirements-unmet` is macOS-only in the reference app and has no
/// source here).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateState {
    UpToDate,
    Checking,
    Downloading,
    ReadyToInstall,
    Installing,
    Error,
}

/// Current update state, sent to every window on each change.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub state: UpdateState,
    /// The new version while downloading / ready / installing.
    pub version: Option<String>,
}

/// Sent to every window right before the install: write pending settings now,
/// then call `app_update_flushed`.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, Event)]
pub struct AppUpdateBeforeInstall {
    pub version: String,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    /// `YYYY-MM-DD` (UTC).
    pub build_date: String,
}

pub struct AppUpdate {
    status: Mutex<AppUpdateStatus>,
    /// The downloaded, verified update.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    flushed: Mutex<HashSet<String>>,
    flushed_notify: tokio::sync::Notify,
}

impl Default for AppUpdate {
    fn default() -> Self {
        Self {
            status: Mutex::new(AppUpdateStatus { state: UpdateState::UpToDate, version: None }),
            ready: Mutex::new(None),
            flushed: Mutex::new(HashSet::new()),
            flushed_notify: tokio::sync::Notify::new(),
        }
    }
}

const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// Longest wait for the windows to write their settings before installing.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);
/// The settings store file (src/data/kv.ts STORE_FILE).
const STORE_FILE: &str = "opentrader.json";

/// Release builds on Windows / macOS. A dev build checks only with
/// `OPENTRADER_DEV_UPDATE=1` (the reference app's forceDevUpdate).
fn enabled() -> bool {
    if cfg!(target_os = "linux") {
        return false;
    }
    !cfg!(debug_assertions) || std::env::var_os("OPENTRADER_DEV_UPDATE").is_some()
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    #[allow(unused_mut)]
    let mut builder = app.updater_builder();
    // Dev builds may point at a local latest.json (the reference app's dev-app-update.yml).
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("OPENTRADER_UPDATE_ENDPOINT") {
        let url = url.parse().map_err(|e| format!("OPENTRADER_UPDATE_ENDPOINT: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

fn set_status(app: &AppHandle, state: UpdateState, version: Option<String>) {
    let status = AppUpdateStatus { state, version };
    *app.state::<AppUpdate>().status.lock().unwrap() = status.clone();
    let _ = status.emit(app);
}

/// Start the check loop (setup).
pub fn init(app: &AppHandle) {
    app.manage(AppUpdate::default());
    if !enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(CHECK_EVERY);
        loop {
            tick.tick().await;
            check(&app);
        }
    });
}

/// Start a check unless one is running or an install started (the reference app runs it only
/// from up-to-date, ready-to-install or error).
fn check(app: &AppHandle) {
    let update = app.state::<AppUpdate>();
    let prev = {
        let mut st = update.status.lock().unwrap();
        if !matches!(st.state, UpdateState::UpToDate | UpdateState::ReadyToInstall | UpdateState::Error) {
            return;
        }
        let prev = st.clone();
        st.state = UpdateState::Checking;
        prev
    };
    let _ = AppUpdateStatus { state: UpdateState::Checking, version: prev.version }.emit(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_and_download(&app).await {
            eprintln!("[app-update] {e}");
            set_status(&app, UpdateState::Error, None);
        }
    });
}

async fn check_and_download(app: &AppHandle) -> Result<(), String> {
    let found = updater(app)?.check().await.map_err(|e| format!("check: {e}"))?;
    let state = app.state::<AppUpdate>();
    let Some(update) = found else {
        *state.ready.lock().unwrap() = None;
        set_status(app, UpdateState::UpToDate, None);
        return Ok(());
    };
    let version = update.version.clone();
    let have = state.ready.lock().unwrap().as_ref().is_some_and(|(u, _)| u.version == version);
    if !have {
        set_status(app, UpdateState::Downloading, Some(version.clone()));
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| format!("download {version}: {e}"))?;
        *state.ready.lock().unwrap() = Some((update, bytes));
    }
    set_status(app, UpdateState::ReadyToInstall, Some(version));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn app_update_status(state: State<'_, AppUpdate>) -> AppUpdateStatus {
    state.status.lock().unwrap().clone()
}

/// Check now (Settings > About opened).
#[tauri::command]
#[specta::specta]
pub fn app_update_check(app: AppHandle) {
    if enabled() {
        check(&app);
    }
}

/// A window has written its pending settings (answer to AppUpdateBeforeInstall).
#[tauri::command]
#[specta::specta]
pub fn app_update_flushed(window: tauri::WebviewWindow, state: State<'_, AppUpdate>) {
    state.flushed.lock().unwrap().insert(window.label().to_string());
    state.flushed_notify.notify_waiters();
}

/// "Relaunch to update": save everything, install, restart. On Windows the
/// installer closes this process and starts the new version itself.
#[tauri::command]
#[specta::specta]
pub async fn app_update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppUpdate>();
    let (update, bytes) = {
        let mut st = state.status.lock().unwrap();
        if st.state != UpdateState::ReadyToInstall {
            return Err("no update is ready to install".into());
        }
        let Some(ready) = state.ready.lock().unwrap().take() else {
            return Err("no update is ready to install".into());
        };
        st.state = UpdateState::Installing;
        ready
    };
    let version = update.version.clone();
    let _ = AppUpdateStatus { state: UpdateState::Installing, version: Some(version.clone()) }.emit(&app);

    // 1. Every window writes its pending settings.
    let windows: HashSet<String> = app.webview_windows().into_keys().collect();
    state.flushed.lock().unwrap().clear();
    let _ = AppUpdateBeforeInstall { version: version.clone() }.emit(&app);
    let all_flushed = async {
        loop {
            let notified = state.flushed_notify.notified();
            if windows.is_subset(&state.flushed.lock().unwrap()) {
                return;
            }
            notified.await;
        }
    };
    if tokio::time::timeout(FLUSH_TIMEOUT, all_flushed).await.is_err() {
        eprintln!("[app-update] not every window confirmed its settings write; installing anyway");
    }

    // 2. Settings store and window session to disk.
    if let Some(store) = app.get_store(STORE_FILE) {
        if let Err(e) = store.save() {
            eprintln!("[app-update] store save failed: {e}");
        }
    }
    crate::window_session::save(&app);

    // 3. Install. Windows: runs the installer and exits. macOS: replaces the app bundle.
    if let Err(e) = update.install(&bytes) {
        eprintln!("[app-update] install {version}: {e}");
        *state.ready.lock().unwrap() = Some((update, bytes));
        set_status(&app, UpdateState::ReadyToInstall, Some(version));
        return Err(e.to_string());
    }
    app.restart();
}

#[tauri::command]
#[specta::specta]
pub fn app_build_info(app: AppHandle) -> BuildInfo {
    BuildInfo {
        version: app.package_info().version.to_string(),
        build_date: env!("OPENTRADER_BUILD_DATE").to_string(),
    }
}
