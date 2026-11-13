/*
 * Settings > Plugins: the plugins installed on this computer, from the catalog or from a file, and the Plugin API they
 * connect to (`opentrader_core::plugins::hub`, plugins/PROTOCOL.md).
 *
 * A plugin lives in `<app data>/plugins/<id>/` (its package unpacked); its state (enabled, token, settings, the files
 * its installation copied elsewhere) in `plugins.json` of the config folder. While at least one plugin is enabled the
 * API listens on 127.0.0.1. An enabled `process` plugin is started here and started again when it stops; an `external`
 * one runs inside another application and finds the address and its token in the connection file written for it.
 */
pub mod broker;
pub mod data;
mod package;

use opentrader_core::files;
use opentrader_core::plugins::hub::{Allowed, Hub, HubEvent};
use opentrader_core::plugins::manifest::{self, Manifest, Runtime};
use opentrader_core::plugins::API_VERSION;
use opentrader_core::sync::LockExt;
use package::CatalogEntry;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::io::AsyncBufReadExt;
use tokio::sync::oneshot;

const FILE: &str = "plugins.json";
pub const DEFAULT_PORT: u16 = 47_822;
const CATALOG_URL: &str = "https://raw.githubusercontent.com/deepentropy/opentrader/main/plugins/catalog.json";
const LOG_LINES: usize = 300;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    port: u16,
    plugins: BTreeMap<String, PluginConfig>,
    /// The broker plugin the window trades with (Trade > Connect broker).
    active_broker: Option<String>,
    /// Orders may be placed and changed (off by default; plugins/broker.rs).
    trading_enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { port: DEFAULT_PORT, plugins: BTreeMap::new(), active_broker: None, trading_enabled: false }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PluginConfig {
    enabled: bool,
    token: String,
    settings: BTreeMap<String, String>,
    /// The files the installation steps copied outside the plugin's folder (removed with the plugin).
    copied: Vec<String>,
    verified: bool,
    /// A broker plugin's tickers for chart symbols, set by the user ("NASDAQ:AAPL" → "AAPL.US").
    symbol_map: BTreeMap<String, String>,
}

/// One installed plugin, as Settings shows it.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: Manifest,
    /// Its package's signature checked against the app's release key.
    pub verified: bool,
    pub enabled: bool,
    pub connected: bool,
    /// A `process` plugin's program is running.
    pub running: bool,
    /// The version the plugin gave when it connected.
    pub connected_version: Option<String>,
    pub settings: BTreeMap<String, String>,
    pub copied: Vec<String>,
    pub symbol_map: BTreeMap<String, String>,
    /// Runs on this computer.
    pub supported: bool,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginsStatus {
    pub port: u16,
    pub listening: bool,
    /// Why the API isn't listening (port in use…).
    pub error: Option<String>,
    pub plugins: Vec<PluginInfo>,
}

/// A package chosen by hand, before it is installed.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PackagePreview {
    pub path: String,
    pub manifest: Manifest,
    pub verified: bool,
    /// The installed version it replaces.
    pub replaces: Option<String>,
}

/// Something changed (installed, enabled, connected…): read `plugins_status` again.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct PluginsChanged;

pub struct Plugins {
    pub hub: Hub,
    pub data: data::PluginData,
    pub broker: broker::PluginBroker,
    config: Mutex<Config>,
    error: Mutex<Option<String>>,
    /// The port the API listens on now.
    listening_on: Mutex<Option<u16>>,
    processes: Mutex<HashMap<String, oneshot::Sender<()>>>,
    running: Mutex<std::collections::HashSet<String>>,
    /// The process id of each running plugin program, to stop it with the processes it started.
    pids: Mutex<HashMap<String, u32>>,
    logs: Mutex<HashMap<String, VecDeque<String>>>,
}

fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("plugins")).map_err(|e| e.to_string())
}

fn read_config(app: &AppHandle) -> Config {
    app.path().app_config_dir().map(|d| files::load_or_default(&d.join(FILE))).unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    files::save_json(&dir.join(FILE), config).map_err(|e| e.to_string())
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The installed plugins' manifests (a folder whose manifest no longer reads is skipped).
fn installed(app: &AppHandle) -> Vec<Manifest> {
    let Ok(dir) = plugins_dir(app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut list: Vec<Manifest> = entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| std::fs::read(e.path().join(manifest::FILE)).ok())
        .filter_map(|bytes| Manifest::parse(&bytes).ok())
        .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

pub fn installed_manifest(app: &AppHandle, id: &str) -> Option<Manifest> {
    installed(app).into_iter().find(|m| m.id == id)
}

fn log(app: &AppHandle, id: &str, line: impl Into<String>) {
    let state = app.state::<Plugins>();
    let mut logs = state.logs.locked();
    let ring = logs.entry(id.to_string()).or_default();
    ring.push_back(format!("{} {}", chrono::Local::now().format("%H:%M:%S"), line.into()));
    while ring.len() > LOG_LINES {
        ring.pop_front();
    }
}

fn changed(app: &AppHandle) {
    let _ = PluginsChanged.emit(app);
    broker::changed(app);
}

fn status(app: &AppHandle) -> PluginsStatus {
    let state = app.state::<Plugins>();
    let config = state.config.locked().clone();
    let running = state.running.locked().clone();
    let plugins = installed(app)
        .into_iter()
        .map(|m| {
            let c = config.plugins.get(&m.id).cloned().unwrap_or_default();
            let hello = state.hub.connected(&m.id);
            PluginInfo {
                verified: c.verified,
                enabled: c.enabled,
                connected: hello.is_some(),
                running: running.contains(&m.id),
                connected_version: hello.map(|h| h.version).filter(|v| !v.is_empty()),
                settings: c.settings,
                copied: c.copied,
                symbol_map: c.symbol_map,
                supported: m.supported_here(),
                manifest: m,
            }
        })
        .collect();
    let error = state.error.locked().clone();
    PluginsStatus { port: config.port, listening: state.hub.listening(), error, plugins }
}

pub fn init(app: &AppHandle) {
    app.manage(Plugins {
        hub: Hub::new(),
        data: Default::default(),
        broker: Default::default(),
        config: Mutex::new(read_config(app)),
        error: Mutex::new(None),
        listening_on: Mutex::new(None),
        processes: Mutex::new(HashMap::new()),
        pids: Mutex::new(HashMap::new()),
        running: Mutex::new(Default::default()),
        logs: Mutex::new(HashMap::new()),
    });
    let mut events = app.state::<Plugins>().hub.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(HubEvent::Connected { plugin, hello }) => {
                    log(&handle, &plugin, format!("Connected (version {}, API {})", hello.version, hello.api));
                    configure(&handle, &plugin);
                    changed(&handle);
                }
                Ok(HubEvent::Disconnected { plugin }) => {
                    log(&handle, &plugin, "Disconnected");
                    changed(&handle);
                }
                Ok(HubEvent::Notification { plugin, method, params }) if method == "log" => {
                    let level = params.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                    let message = params.get("message").and_then(|v| v.as_str()).unwrap_or_default();
                    log(&handle, &plugin, format!("[{level}] {message}"));
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
    });
    data::init(app);
    broker::init(app);
    apply(app);
}

/// Send the plugin its settings (`plugin.configure`).
fn configure(app: &AppHandle, id: &str) {
    let state = app.state::<Plugins>();
    let settings = state.config.locked().plugins.get(id).map(|c| c.settings.clone()).unwrap_or_default();
    let defaults: BTreeMap<String, String> = installed_manifest(app, id)
        .map(|m| m.settings.into_iter().filter_map(|f| f.default.map(|d| (f.key, d))).collect())
        .unwrap_or_default();
    let mut all = defaults;
    all.extend(settings);
    let _ = state.hub.notify(id, "plugin.configure", serde_json::json!({ "settings": all }));
}

/// Make the running state follow the config: the plugins allowed in, the API listening or not, the connection files,
/// the plugin programs.
fn apply(app: &AppHandle) {
    let state = app.state::<Plugins>();
    let config = state.config.locked().clone();
    let manifests = installed(app);
    let enabled: Vec<&Manifest> = manifests
        .iter()
        .filter(|m| m.supported_here() && config.plugins.get(&m.id).is_some_and(|c| c.enabled && !c.token.is_empty()))
        .collect();
    // The exchanges of the enabled data plugins: their symbols go to them (`data::route`).
    let feeds: Vec<&&Manifest> = enabled.iter().filter(|m| m.provides(manifest::Capability::Datafeed)).collect();
    data::set_exchanges(
        app,
        feeds.iter().flat_map(|m| m.data_exchanges().into_iter().map(|e| (e, m.id.clone()))).collect(),
        feeds.iter().filter(|m| m.whole_symbols()).map(|m| m.id.clone()).collect(),
    );
    state.hub.set_allowed(
        enabled
            .iter()
            .map(|m| Allowed { id: m.id.clone(), token: config.plugins[&m.id].token.clone(), provides: m.provides.clone() })
            .collect(),
    );
    if enabled.is_empty() {
        state.hub.stop();
        *state.listening_on.locked() = None;
        *state.error.locked() = None;
    } else if *state.listening_on.locked() != Some(config.port) || !state.hub.listening() {
        match state.hub.listen(config.port) {
            Ok(port) => {
                *state.listening_on.locked() = Some(port);
                *state.error.locked() = None;
            }
            Err(e) => {
                *state.listening_on.locked() = None;
                *state.error.locked() = Some(e);
            }
        }
    }
    let listening = *state.listening_on.locked();
    for m in &manifests {
        let on = enabled.iter().any(|e| e.id == m.id) && listening.is_some();
        match &m.runtime {
            Runtime::External { connection_file: Some(t) } => {
                let Some(path) = manifest::expand(t) else { continue };
                match (on, listening) {
                    (true, Some(port)) => {
                        let body = serde_json::json!({
                            "plugin": m.id, "host": "127.0.0.1", "port": port,
                            "token": config.plugins[&m.id].token, "api": API_VERSION,
                        });
                        if let Err(e) = files::save_json(&path, &body) {
                            log(app, &m.id, format!("Could not write {}: {e}", path.display()));
                        }
                    }
                    _ => {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
            Runtime::External { connection_file: None } => {}
            Runtime::Process { entry, args } => {
                let has = state.processes.locked().contains_key(&m.id);
                if on && !has {
                    start_process(app, m, entry, args, listening.unwrap_or(config.port), &config.plugins[&m.id].token);
                } else if !on && has {
                    stop_process(app, &m.id);
                }
            }
        }
    }
    // Programs of plugins removed meanwhile.
    let gone: Vec<String> =
        state.processes.locked().keys().filter(|id| !manifests.iter().any(|m| &m.id == *id)).cloned().collect();
    for id in gone {
        stop_process(app, &id);
    }
    changed(app);
}

fn stop_process(app: &AppHandle, id: &str) {
    let state = app.state::<Plugins>();
    let tx = state.processes.locked().remove(id);
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
}

/// Start the plugin's program and keep it running (started again after it stops, waiting longer each time) until
/// stopped.
fn start_process(app: &AppHandle, m: &Manifest, entry: &str, args: &[String], port: u16, token: &str) {
    let Ok(dir) = plugins_dir(app).map(|d| d.join(&m.id)) else { return };
    let exe = dir.join(entry);
    let (tx, mut stop) = oneshot::channel::<()>();
    app.state::<Plugins>().processes.locked().insert(m.id.clone(), tx);
    let (app, id, args, token) = (app.clone(), m.id.clone(), args.to_vec(), token.to_string());
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(2);
        loop {
            let mut cmd = tokio::process::Command::new(&exe);
            cmd.args(&args)
                .current_dir(&dir)
                .env("OPENTRADER_PLUGIN_ADDR", format!("127.0.0.1:{port}"))
                .env("OPENTRADER_PLUGIN_ID", &id)
                .env("OPENTRADER_PLUGIN_TOKEN", &token)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            {
                // No console window.
                cmd.creation_flags(0x0800_0000);
            }
            // Its own process group, so that stopping it stops what it started too.
            #[cfg(unix)]
            cmd.process_group(0);
            let started = std::time::Instant::now();
            match cmd.spawn() {
                Ok(mut child) => {
                    log(&app, &id, format!("Started {}", exe.display()));
                    app.state::<Plugins>().running.locked().insert(id.clone());
                    if let Some(pid) = child.id() {
                        app.state::<Plugins>().pids.locked().insert(id.clone(), pid);
                    }
                    changed(&app);
                    for out in [child.stdout.take().map(|o| Box::new(o) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), child.stderr.take().map(|e| Box::new(e) as _)]
                        .into_iter()
                        .flatten()
                    {
                        let (app, id) = (app.clone(), id.clone());
                        tauri::async_runtime::spawn(async move {
                            let mut lines = tokio::io::BufReader::new(out).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                log(&app, &id, line);
                            }
                        });
                    }
                    let stopped = tokio::select! {
                        status = child.wait() => {
                            log(&app, &id, format!("Stopped ({})", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string())));
                            false
                        }
                        _ = &mut stop => {
                            if let Some(pid) = child.id() {
                                kill_tree(pid);
                            }
                            let _ = child.kill().await;
                            log(&app, &id, "Stopped");
                            true
                        }
                    };
                    app.state::<Plugins>().running.locked().remove(&id);
                    app.state::<Plugins>().pids.locked().remove(&id);
                    changed(&app);
                    if stopped {
                        return;
                    }
                }
                Err(e) => log(&app, &id, format!("Could not start {}: {e}", exe.display())),
            }
            // A program that ran a while starts again soon; one that keeps failing, less and less often.
            if started.elapsed() > Duration::from_secs(60) {
                wait = Duration::from_secs(2);
            }
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = &mut stop => return,
            }
            wait = (wait * 2).min(Duration::from_secs(120));
        }
    });
}

/// Stop the plugin programs (the app is quitting): now, since the tasks that would stop them end with the app.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<Plugins>() {
        let ids: Vec<String> = state.processes.locked().keys().cloned().collect();
        for pid in state.pids.locked().drain().map(|(_, pid)| pid) {
            kill_tree(pid);
        }
        for id in ids {
            stop_process(app, &id);
        }
    }
}

/// End a plugin program and the processes it started: a launcher (a one-file Python build runs as two processes)
/// would otherwise leave its child running, holding the plugin's files.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Install a package (zip bytes): unpacked into the plugin's folder, kept enabled when it was, with a token.
fn install(app: &AppHandle, bytes: &[u8], verified: bool) -> Result<Manifest, String> {
    let m = package::read_manifest(bytes)?;
    if !m.supported_here() {
        return Err(format!("{} does not run on this computer", m.name));
    }
    let dir = plugins_dir(app)?.join(&m.id);
    // A running program holds its files: stop it while they are replaced.
    stop_process(app, &m.id);
    package::unpack(bytes, &dir)?;
    let state = app.state::<Plugins>();
    // An update refreshes the files its installation copied elsewhere (same names, same folders).
    let copied = state.config.locked().plugins.get(&m.id).map(|p| p.copied.clone()).unwrap_or_default();
    for target in copied {
        let target = PathBuf::from(target);
        let name = target.file_name().map(|n| n.to_os_string());
        let step = m.install.iter().find(|s| Path::new(&s.copy).file_name().map(|n| n.to_os_string()) == name);
        if let Some(step) = step {
            if let Err(e) = std::fs::copy(dir.join(&step.copy), &target) {
                log(app, &m.id, format!("Could not update {}: {e}", target.display()));
            }
        }
    }
    let config = {
        let mut c = state.config.locked();
        let p = c.plugins.entry(m.id.clone()).or_default();
        if p.token.is_empty() {
            p.token = new_token()?;
        }
        p.verified = verified;
        c.clone()
    };
    write_config(app, &config)?;
    log(app, &m.id, format!("Installed version {}{}", m.version, if verified { "" } else { " (unverified)" }));
    apply(app);
    Ok(m)
}

fn verified(app: &AppHandle, bytes: &[u8], signature: Option<&str>) -> bool {
    signature.is_some_and(|s| crate::app_update::verify(app, bytes, s).is_ok())
}

static CLIENT: opentrader_core::net::SharedClient =
    opentrader_core::net::SharedClient::new(|b| b.connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(300)));

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let res = CLIENT.get().get(url).send().await.map_err(|e| format!("Download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status().as_u16()));
    }
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("Download failed: {e}"))
}

fn update_plugin(app: &AppHandle, id: &str, f: impl FnOnce(&mut PluginConfig)) -> Result<(), String> {
    let state = app.state::<Plugins>();
    let config = {
        let mut c = state.config.locked();
        f(c.plugins.entry(id.to_string()).or_default());
        c.clone()
    };
    write_config(app, &config)
}

#[tauri::command]
#[specta::specta]
pub fn plugins_status(app: AppHandle) -> PluginsStatus {
    status(&app)
}

/// The API's port (1024–65535); listens there now when a plugin is enabled. External plugins read the new port from
/// their connection file when they connect again.
#[tauri::command]
#[specta::specta]
pub fn plugins_set_port(app: AppHandle, port: u16) -> Result<PluginsStatus, String> {
    if port < 1024 {
        return Err("Use a port from 1024 to 65535".into());
    }
    let state = app.state::<Plugins>();
    let config = {
        let mut c = state.config.locked();
        c.port = port;
        c.clone()
    };
    write_config(&app, &config)?;
    // Programs started with the old address start again with the new one.
    let ids: Vec<String> = state.processes.locked().keys().cloned().collect();
    for id in &ids {
        stop_process(&app, id);
    }
    apply(&app);
    Ok(status(&app))
}

/// The catalog's plugins.
#[tauri::command]
#[specta::specta]
pub async fn plugin_catalog() -> Result<Vec<CatalogEntry>, String> {
    let bytes = download(CATALOG_URL).await?;
    package::parse_catalog(&bytes)
}

/// Install (or update) a plugin of the catalog: its package must match the catalog's checksum and signature.
#[tauri::command]
#[specta::specta]
pub async fn plugin_install_catalog(app: AppHandle, id: String) -> Result<PluginsStatus, String> {
    let entry = package::parse_catalog(&download(CATALOG_URL).await?)?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("{id} is not in the catalog"))?;
    let bytes = download(&entry.url).await?;
    if package::sha256(&bytes) != entry.sha256.to_lowercase() {
        return Err("The downloaded package is not the published one (checksum)".into());
    }
    if !verified(&app, &bytes, Some(&entry.signature)) {
        return Err("The downloaded package's signature does not check".into());
    }
    let m = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || install(&app, &bytes, true)
    })
    .await
    .map_err(|e| e.to_string())??;
    if m.id != id {
        return Err(format!("The catalog's package for {id} is {}", m.id));
    }
    Ok(status(&app))
}

/// Choose a package file; nothing is installed yet.
#[tauri::command]
#[specta::specta]
pub async fn plugin_pick_file(app: AppHandle) -> Result<Option<PackagePreview>, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog.dialog().file().set_title("Plugin package").add_filter("Plugin package", &["zip"]).blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let (bytes, signature) = package::read_file(&path)?;
    let manifest = package::read_manifest(&bytes)?;
    let replaces = installed_manifest(&app, &manifest.id).map(|m| m.version);
    Ok(Some(PackagePreview {
        path: path.to_string_lossy().into_owned(),
        verified: verified(&app, &bytes, signature.as_deref()),
        manifest,
        replaces,
    }))
}

/// Install the package file chosen with `plugin_pick_file` (the user accepted it).
#[tauri::command]
#[specta::specta]
pub async fn plugin_install_file(app: AppHandle, path: String) -> Result<PluginsStatus, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, signature) = package::read_file(Path::new(&path))?;
        let ok = verified(&handle, &bytes, signature.as_deref());
        install(&handle, &bytes, ok)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(status(&app))
}

#[tauri::command]
#[specta::specta]
pub fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<PluginsStatus, String> {
    installed_manifest(&app, &id).ok_or_else(|| format!("{id} is not installed"))?;
    update_plugin(&app, &id, |p| p.enabled = enabled)?;
    log(&app, &id, if enabled { "Enabled" } else { "Disabled" });
    apply(&app);
    Ok(status(&app))
}

/// The plugin's settings (its manifest's fields); a connected plugin gets them at once.
#[tauri::command]
#[specta::specta]
pub fn plugin_set_settings(app: AppHandle, id: String, settings: BTreeMap<String, String>) -> Result<PluginsStatus, String> {
    let m = installed_manifest(&app, &id).ok_or_else(|| format!("{id} is not installed"))?;
    let settings = settings.into_iter().filter(|(k, _)| m.settings.iter().any(|f| &f.key == k)).collect();
    update_plugin(&app, &id, |p| p.settings = settings)?;
    configure(&app, &id);
    Ok(status(&app))
}

/// A new token: the plugin is disconnected and must connect with the new one (its connection file is rewritten).
#[tauri::command]
#[specta::specta]
pub fn plugin_new_token(app: AppHandle, id: String) -> Result<PluginsStatus, String> {
    let token = new_token()?;
    update_plugin(&app, &id, |p| p.token = token)?;
    stop_process(&app, &id);
    apply(&app);
    Ok(status(&app))
}

/// Remove the plugin: its program stops, its folder, connection file and copied files are deleted.
#[tauri::command]
#[specta::specta]
pub async fn plugin_remove(app: AppHandle, id: String) -> Result<PluginsStatus, String> {
    let m = installed_manifest(&app, &id).ok_or_else(|| format!("{id} is not installed"))?;
    stop_process(&app, &id);
    let state = app.state::<Plugins>();
    state.hub.disconnect(&id);
    let removed = state.config.locked().plugins.remove(&id);
    if let Runtime::External { connection_file: Some(t) } = &m.runtime {
        if let Some(p) = manifest::expand(t) {
            let _ = std::fs::remove_file(p);
        }
    }
    for f in removed.map(|p| p.copied).unwrap_or_default() {
        let _ = std::fs::remove_file(f);
    }
    let dir = plugins_dir(&app)?.join(&id);
    // The program may take a moment to let go of its files.
    let mut last = Ok(());
    for _ in 0..20 {
        last = std::fs::remove_dir_all(&dir);
        if last.is_ok() || !dir.exists() {
            last = Ok(());
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let config = state.config.locked().clone();
    write_config(&app, &config)?;
    state.logs.locked().remove(&id);
    apply(&app);
    last.map_err(|e| format!("The plugin's folder could not be deleted: {e}"))?;
    Ok(status(&app))
}

/// The folders installation step `step` suggests (its template's matches).
#[tauri::command]
#[specta::specta]
pub fn plugin_folder_candidates(app: AppHandle, id: String, step: u32) -> Result<Vec<String>, String> {
    let m = installed_manifest(&app, &id).ok_or_else(|| format!("{id} is not installed"))?;
    let s = m.install.get(step as usize).ok_or("no such installation step")?;
    Ok(s.to.suggest.as_deref().map(manifest::candidates).unwrap_or_default().into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_pick_folder(app: AppHandle, title: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title(title).blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    match picked {
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

/// Run installation step `step`: copy its file into each folder (which must end as the step expects).
#[tauri::command]
#[specta::specta]
pub fn plugin_copy_files(app: AppHandle, id: String, step: u32, folders: Vec<String>) -> Result<PluginsStatus, String> {
    let m = installed_manifest(&app, &id).ok_or_else(|| format!("{id} is not installed"))?;
    let s = m.install.get(step as usize).ok_or("no such installation step")?;
    let source = plugins_dir(&app)?.join(&id).join(&s.copy);
    let name = source.file_name().ok_or("bad file")?.to_owned();
    let mut copied = Vec::new();
    for folder in &folders {
        let folder = Path::new(folder);
        if let Some(expect) = &s.to.expect {
            if !manifest::folder_matches(folder, expect) {
                return Err(format!("{} is not a {expect} folder", folder.display()));
            }
        }
        let target = folder.join(&name);
        std::fs::copy(&source, &target).map_err(|e| format!("Could not copy to {}: {e}", folder.display()))?;
        log(&app, &id, format!("Copied {} to {}", s.copy, folder.display()));
        copied.push(target.to_string_lossy().into_owned());
    }
    update_plugin(&app, &id, |p| {
        for c in copied {
            if !p.copied.contains(&c) {
                p.copied.push(c);
            }
        }
    })?;
    changed(&app);
    Ok(status(&app))
}

#[tauri::command]
#[specta::specta]
pub fn plugin_logs(app: AppHandle, id: String) -> Vec<String> {
    app.state::<Plugins>().logs.locked().get(&id).map(|r| r.iter().cloned().collect()).unwrap_or_default()
}
