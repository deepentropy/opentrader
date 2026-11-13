/*
 * The AI assistant's model, on this computer (#239): nothing in the installer, downloaded when the user asks for it.
 * Three files: the llama.cpp server for this system (a pinned build: Vulkan where there is one, with a CPU build to
 * fall back on; Metal on Apple silicon), the open base model (Qwen3-4B-Instruct-2507, Q4_K_M) and OpenTrader's
 * fine-tune of it (a LoRA, the small file that changes with each version). Each is checked against its sha256; a
 * download stopped midway goes on from where it was.
 *
 * Fine-tunes are versioned (ADAPTERS): the newest one on disk runs, and the window sends it the prompt it was trained
 * with (src/data/assistant/prompts.ts). A computer with an older one is offered the newest (Update in the assistant
 * panel): only that file is downloaded, then the older one is deleted and the server restarts on the new one.
 *
 * The server runs on 127.0.0.1 only, started with the first chat and stopped with the app.
 */
use opentrader_core::net::SharedClient;
use opentrader_core::sync::LockExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

static CLIENT: SharedClient = SharedClient::new(|b| b.connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(60)));

#[derive(Clone, Copy)]
struct Asset {
    /// The file name kept on disk.
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

macro_rules! runtime {
    ($name:literal, $sha:literal, $size:literal) => {
        Asset { file: $name, url: concat!("https://github.com/ggml-org/llama.cpp/releases/download/b12110/", $name), sha256: $sha, size: $size }
    };
}

/// The server builds for this system (llama.cpp release b12110): the one to try first, then the one to fall back on.
fn runtimes() -> Vec<Asset> {
    let mut out = Vec::new();
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        out.push(runtime!("llama-b12110-bin-win-vulkan-x64.zip", "9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f", 37661146));
        out.push(runtime!("llama-b12110-bin-win-cpu-x64.zip", "98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2", 24708445));
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        out.push(runtime!("llama-b12110-bin-win-vulkan-arm64.zip", "2be672cf538aabfc9fcb22c21648422b01d623673f15c2742bd43a9bd1a11ce2", 25728494));
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        out.push(runtime!("llama-b12110-bin-macos-arm64.tar.gz", "4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662", 16650691));
    } else if cfg!(target_os = "macos") {
        out.push(runtime!("llama-b12110-bin-macos-x64.tar.gz", "c8094268b6bf62f4998f0e45656fd9f5e2d4afb6b1cd0044d761db64be1dd47d", 12388601));
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        out.push(runtime!("llama-b12110-bin-ubuntu-vulkan-x64.tar.gz", "a5d741940956ec62e8783aee7e5a4c7c761af867d6f027c3277a51e1a3ac59b0", 35858360));
        out.push(runtime!("llama-b12110-bin-ubuntu-x64.tar.gz", "368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55", 23051958));
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        out.push(runtime!("llama-b12110-bin-ubuntu-arm64.tar.gz", "4758b51335e37b4346251f2687d64841ff1c07ecb27fc46323945bb2ec9c44d2", 18723578));
    }
    out
}

const BASE: Asset = Asset {
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    url: "https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    sha256: "8cdb57cbb880d313736a9bc4e3d3d2485f145b5e19cf33783746e753e82641fc",
    size: 2_497_280_448,
};

/// A version of OpenTrader's fine-tune and the prompt it was trained with (src/data/assistant/prompts.ts).
#[derive(Clone, Copy)]
struct Adapter {
    version: u32,
    asset: Asset,
}

/// The fine-tunes, oldest first: the last one is offered (each on the app's release `assistant-model-v<version>`).
const ADAPTERS: &[Adapter] = &[
    // Prompt-distillation v2, trained with the short tool list src/data/assistant/compact-v1.txt.
    Adapter {
        version: 2,
        asset: Asset {
            file: "opentrader-assistant-v2-lora-f16.gguf",
            url: "https://github.com/deepentropy/opentrader/releases/download/assistant-model-v2/opentrader-assistant-v2-lora-f16.gguf",
            sha256: "22bb391e1c8cde89ad43a37887865eba1e9cd68f81da025beacd225cf53a6277",
            size: 66_095_232,
        },
    },
];

fn latest() -> &'static Adapter {
    ADAPTERS.last().expect("an adapter")
}

/// The newest fine-tune on disk.
fn installed_adapter(base: &Path) -> Option<&'static Adapter> {
    ADAPTERS.iter().rev().find(|a| present(base, &a.asset))
}

/// RAM the server needs with an 8k context (measured: about 4.3 GB private at 16k), with a margin.
const RAM_NEEDED: u64 = 6 * 1024 * 1024 * 1024;

struct Server {
    child: tokio::process::Child,
    port: u16,
    /// It has answered its health check (it was still loading the model before).
    ready: bool,
    /// The prompt work was saved to disk this session.
    saved: bool,
    /// The fine-tune it runs (its saved prompt work is that version's).
    version: u32,
}

/// The server, kept from its start on (so a quit stops it even while it loads). Held only for quick reads: never
/// across a start or a health wait, which would block Settings and the chats.
static SERVER: tokio::sync::Mutex<Option<Server>> = tokio::sync::Mutex::const_new(None);
/// One start at a time: two chats at once start one server.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The download under way: its number and its stop.
static INSTALL_STOP: Mutex<Option<(u64, oneshot::Sender<()>)>> = Mutex::new(None);
static INSTALLS: AtomicU64 = AtomicU64::new(0);

/// Frees the download's slot however `local_model_install` ends: the window may drop the call midway. A cancelled
/// download already gave its slot up and may have a successor, which is left alone.
struct Installing(u64);

impl Drop for Installing {
    fn drop(&mut self) {
        let mut slot = INSTALL_STOP.locked();
        if slot.as_ref().is_some_and(|(id, _)| *id == self.0) {
            *slot = None;
        }
    }
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("assistant-model"))
}

fn runtime_dir(base: &Path, a: &Asset) -> PathBuf {
    base.join(a.file.trim_end_matches(".zip").trim_end_matches(".tar.gz"))
}

fn server_exe(runtime: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    walk(runtime).into_iter().find(|p| p.file_name().is_some_and(|n| n == name))
}

fn walk(p: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

/// What Settings shows about the model on this computer.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    /// This build has a model to offer for this system.
    pub available: bool,
    pub installed: bool,
    pub running: bool,
    /// Bytes still to download (all of it when nothing is there).
    pub download_bytes: f64,
    /// Bytes on disk when installed.
    pub disk_bytes: f64,
    pub ram_bytes: f64,
    pub ram_needed_bytes: f64,
    pub free_disk_bytes: f64,
    pub installing: bool,
    /// The fine-tune on disk (null when none): the window sends it the prompt it was trained with.
    pub version: Option<u32>,
    /// The fine-tune this build offers.
    pub latest_version: u32,
    /// Bytes of the newer fine-tune when an older one is on disk (0 when up to date or not installed).
    pub update_bytes: f64,
}

fn present(base: &Path, a: &Asset) -> bool {
    std::fs::metadata(base.join(a.file)).is_ok_and(|m| m.len() == a.size)
}

fn installed(base: &Path) -> bool {
    let rts = runtimes();
    !rts.is_empty() && rts.iter().any(|r| server_exe(&runtime_dir(base, r)).is_some()) && present(base, &BASE) && installed_adapter(base).is_some()
}

fn free_disk(path: &Path) -> u64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
        .unwrap_or(0)
}

#[tauri::command]
#[specta::specta]
pub async fn local_model_info(app: AppHandle) -> Result<LocalModelInfo, String> {
    let base = dir(&app)?;
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let running = SERVER.lock().await.as_ref().is_some_and(|s| s.ready);
    let installing = INSTALL_STOP.locked().is_some();
    // Walks the model's folder (thousands of files) and asks the system for its disks: on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || {
        let rts = runtimes();
        let parts: Vec<Asset> = [BASE, latest().asset].into_iter().chain(rts.first().copied()).collect();
        let missing: u64 = parts
            .iter()
            .map(|a| if present(&base, a) || (a.file.contains("llama-") && server_exe(&runtime_dir(&base, a)).is_some()) { 0 } else { a.size })
            .sum();
        let disk: u64 = walk(&base).iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let probe = if base.exists() { base.clone() } else { data_dir };
        let is_installed = installed(&base);
        let version = installed_adapter(&base).map(|a| a.version);
        LocalModelInfo {
            available: !rts.is_empty(),
            installed: is_installed,
            running,
            download_bytes: missing as f64,
            disk_bytes: disk as f64,
            ram_bytes: sys.total_memory() as f64,
            ram_needed_bytes: RAM_NEEDED as f64,
            free_disk_bytes: free_disk(&probe) as f64,
            installing,
            version,
            latest_version: latest().version,
            update_bytes: if is_installed && version != Some(latest().version) { latest().asset.size as f64 } else { 0.0 },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Download progress over the whole install: the file under way, the bytes so far and the size of all that is
/// downloaded, so the bar fills once instead of once per file.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalProgress {
    pub file: String,
    pub done: f64,
    pub total: f64,
}

/// The install's progress: bytes of the files already done, and the size of all the files to download.
struct Tally {
    before: u64,
    total: u64,
}

/// Downloads `a` into `base` (resuming a `.part` file), checks its sha256 and keeps it under its name.
async fn fetch(base: &Path, a: &Asset, on: &Channel<LocalProgress>, t: &mut Tally, stop: &mut oneshot::Receiver<()>) -> Result<(), String> {
    let path = base.join(a.file);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() == a.size) {
        return Ok(());
    }
    let send = |file: String, have: u64| {
        let _ = on.send(LocalProgress { file, done: (t.before + have) as f64, total: t.total as f64 });
    };
    let part = base.join(format!("{}.part", a.file));
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > a.size {
        let _ = std::fs::remove_file(&part);
        have = 0;
    }
    if have < a.size {
        let mut req = CLIENT.get().get(a.url);
        if have > 0 {
            req = req.header("Range", format!("bytes={have}-"));
        }
        let mut res = req.send().await.map_err(|e| format!("Download of {} failed: {e}", a.file))?;
        if !res.status().is_success() {
            return Err(format!("Download of {} failed: HTTP {}", a.file, res.status().as_u16()));
        }
        // A server that ignores the range sends the whole file again.
        if have > 0 && res.status().as_u16() != 206 {
            have = 0;
        }
        let mut f = tokio::fs::OpenOptions::new().create(true).append(have > 0).write(true).truncate(have == 0).open(&part).await.map_err(|e| e.to_string())?;
        let mut last = std::time::Instant::now();
        loop {
            let chunk = tokio::select! {
                c = res.chunk() => c.map_err(|e| format!("Download of {} stopped: {e}", a.file))?,
                _ = &mut *stop => {
                    f.flush().await.ok();
                    return Err("Stopped.".into());
                }
            };
            let Some(bytes) = chunk else { break };
            f.write_all(&bytes).await.map_err(|e| e.to_string())?;
            have += bytes.len() as u64;
            if last.elapsed() > Duration::from_millis(250) {
                last = std::time::Instant::now();
                send(a.file.into(), have);
            }
        }
        f.flush().await.map_err(|e| e.to_string())?;
    }
    send(format!("Checking {}", a.file), a.size);
    let p = part.clone();
    let sum = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        let mut h = Sha256::new();
        let mut f = std::fs::File::open(&p)?;
        std::io::copy(&mut f, &mut h)?;
        Ok(format!("{:x}", h.finalize()))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if sum != a.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{} is not the expected file (checksum): download it again.", a.file));
    }
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    t.before += a.size;
    Ok(())
}

fn unpack(archive: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if archive.extension().is_some_and(|e| e == "zip") {
        zip::ZipArchive::new(f).and_then(|mut z| z.extract(to)).map_err(|e| e.to_string())
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(to).map_err(|e| e.to_string())
    }
}

/// Downloads what is missing: everything on a first install, the newest fine-tune on an update (then the older ones
/// are deleted and a server running one is stopped: the next chat starts it on the new one).
#[tauri::command]
#[specta::specta]
pub async fn local_model_install(app: AppHandle, on_progress: Channel<LocalProgress>) -> Result<(), String> {
    let base = dir(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let (tx, mut rx) = oneshot::channel();
    let id = INSTALLS.fetch_add(1, Ordering::Relaxed);
    {
        let mut slot = INSTALL_STOP.locked();
        if slot.is_some() {
            return Err("The download is already under way.".into());
        }
        *slot = Some((id, tx));
    }
    let _installing = Installing(id);
    let b = base.clone();
    let runtimes: Vec<Asset> =
        blocking(move || runtimes().into_iter().filter(|r| server_exe(&runtime_dir(&b, r)).is_none()).collect()).await?;
    let adapter = latest().asset;
    let total = runtimes.iter().chain([&adapter, &BASE]).filter(|a| !present(&base, a)).map(|a| a.size).sum();
    let mut t = Tally { before: 0, total };
    for r in &runtimes {
        fetch(&base, r, &on_progress, &mut t, &mut rx).await?;
        let (archive, to) = (base.join(r.file), runtime_dir(&base, r));
        blocking(move || {
            unpack(&archive, &to)?;
            let _ = std::fs::remove_file(&archive);
            Ok::<_, String>(())
        })
        .await??;
    }
    let updated = ADAPTERS.iter().any(|a| a.version != latest().version && present(&base, &a.asset));
    fetch(&base, &adapter, &on_progress, &mut t, &mut rx).await?;
    fetch(&base, &BASE, &on_progress, &mut t, &mut rx).await?;
    if updated {
        stop_server().await;
        let b = base.clone();
        blocking(move || {
            for a in ADAPTERS.iter().filter(|a| a.version != latest().version) {
                let _ = std::fs::remove_file(b.join(a.asset.file));
                let _ = std::fs::remove_file(b.join(prefix_file(a.version)));
            }
        })
        .await?;
    }
    Ok(())
}

/// `f` on a blocking thread (file walks, archives, deletions of gigabytes).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn local_model_cancel() {
    if let Some((_, tx)) = INSTALL_STOP.locked().take() {
        let _ = tx.send(());
    }
}

/// Stops the server and deletes the files.
#[tauri::command]
#[specta::specta]
pub async fn local_model_remove(app: AppHandle) -> Result<(), String> {
    stop_server().await;
    let base = dir(&app)?;
    blocking(move || {
        if base.exists() {
            std::fs::remove_dir_all(&base).map_err(|e| format!("The files could not all be deleted: {e}"))?;
        }
        Ok(())
    })
    .await?
}

pub async fn stop_server() {
    if let Some(mut s) = SERVER.lock().await.take() {
        let _ = s.child.kill().await;
    }
}

/// Stops the server when the app quits (it would outlive it otherwise).
pub fn shutdown() {
    if let Ok(mut guard) = SERVER.try_lock() {
        if let Some(s) = guard.as_mut() {
            let _ = s.child.start_kill();
        }
        *guard = None;
    }
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())
}

async fn healthy(port: u16) -> bool {
    CLIENT.get().get(format!("http://127.0.0.1:{port}/health")).timeout(Duration::from_secs(2)).send().await.is_ok_and(|r| r.status().is_success())
}

/// Starts the server and keeps it in `SERVER` at once (a quit stops it from then on), then waits for it to answer.
async fn start(base: &Path, exe: &Path, gpu: bool) -> Result<u16, String> {
    let adapter = installed_adapter(base).ok_or("The assistant's model is not downloaded yet.")?;
    let port = free_port()?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("-m")
        .arg(base.join(BASE.file))
        .arg("--lora")
        .arg(base.join(adapter.asset.file))
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", "8192", "--parallel", "1", "--jinja"])
        .arg("--slot-save-path")
        .arg(base)
        .args(["-ngl", if gpu { "99" } else { "0" }])
        .current_dir(exe.parent().unwrap_or(base))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window.
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| format!("The model server did not start: {e}"))?;
    // A server left from before (stopped, or not answering) is replaced; dropping it kills it.
    *SERVER.lock().await = Some(Server { child, port, ready: false, saved: false, version: adapter.version });
    wait_ready(port).await?;
    Ok(port)
}

/// Waits up to 2 minutes for the server on `port` to answer its health check; an error when it stopped, was
/// replaced, or never answered (it is then stopped).
async fn wait_ready(port: u16) -> Result<(), String> {
    for _ in 0..240 {
        {
            let mut guard = SERVER.lock().await;
            let Some(s) = guard.as_mut().filter(|s| s.port == port) else {
                return Err("The model server was stopped.".into());
            };
            if let Ok(Some(status)) = s.child.try_wait() {
                *guard = None;
                return Err(format!("The model server stopped ({status})."));
            }
        }
        if healthy(port).await {
            if let Some(s) = SERVER.lock().await.as_mut().filter(|s| s.port == port) {
                s.ready = true;
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if let Some(mut s) = SERVER.lock().await.take_if(|s| s.port == port) {
        let _ = s.child.kill().await;
    }
    Err("The model server did not answer within 2 minutes.".into())
}

fn api_root(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

/// The running server's API root, starting it when needed (the GPU build first, then the CPU one).
pub async fn ensure_server(app: &AppHandle) -> Result<String, String> {
    let _one_start = STARTING.lock().await;
    let current = {
        let mut guard = SERVER.lock().await;
        let alive = guard.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none());
        if !alive {
            *guard = None;
        }
        guard.as_ref().map(|s| (s.port, s.ready))
    };
    match current {
        Some((port, true)) if healthy(port).await => return Ok(api_root(port)),
        // Still loading the model: a start whose chat was stopped midway. Its wait goes on here.
        Some((port, false)) => match wait_ready(port).await {
            Ok(()) => return Ok(api_root(port)),
            Err(e) => eprintln!("[local-model] {e}"),
        },
        // Not answering any more: replaced by the start below.
        _ => {}
    }
    let base = dir(app)?;
    let b = base.clone();
    // The first build uses the graphics card (Vulkan, Metal); the fallback runs on the processor.
    let exes: Option<Vec<(bool, PathBuf)>> = blocking(move || {
        installed(&b).then(|| runtimes().iter().enumerate().filter_map(|(i, r)| Some((i == 0, server_exe(&runtime_dir(&b, r))?))).collect())
    })
    .await?;
    let Some(exes) = exes else {
        return Err("The assistant's model is not downloaded yet.".into());
    };
    let mut last = String::new();
    for (gpu, exe) in exes {
        match start(&base, &exe, gpu).await {
            Ok(port) => {
                if let Some(a) = installed_adapter(&base) {
                    restore_prefix(&base, port, a.version).await;
                }
                return Ok(api_root(port));
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// The saved prompt work of a fine-tune version (its prompt read once): "prefix-v2.bin" for v2.
fn prefix_file(version: u32) -> String {
    format!("prefix-v{version}.bin")
}

/// Puts back the prompt work saved by an earlier session (the short tool list read once), so the first answer
/// skips it.
async fn restore_prefix(base: &Path, port: u16, version: u32) {
    let file = prefix_file(version);
    if base.join(&file).exists() {
        let _ = CLIENT
            .get()
            .post(format!("http://127.0.0.1:{port}/slots/0?action=restore"))
            .json(&serde_json::json!({ "filename": file }))
            .timeout(Duration::from_secs(30))
            .send()
            .await;
    }
}

/// After the first answer of a session: saves the prompt work for the next launch.
pub async fn save_prefix(app: &AppHandle) {
    let mut guard = SERVER.lock().await;
    let Some(s) = guard.as_mut() else { return };
    if s.saved {
        return;
    }
    s.saved = true;
    let (port, file) = (s.port, prefix_file(s.version));
    drop(guard);
    if let Ok(base) = dir(app) {
        if !base.join(&file).exists() {
            let _ = CLIENT
                .get()
                .post(format!("http://127.0.0.1:{port}/slots/0?action=save"))
                .json(&serde_json::json!({ "filename": file }))
                .timeout(Duration::from_secs(30))
                .send()
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fine-tune "on disk": a sparse file of its size (presence is checked by size).
    fn put(base: &Path, a: &Adapter) {
        std::fs::File::create(base.join(a.asset.file)).and_then(|f| f.set_len(a.asset.size)).unwrap();
    }

    #[test]
    fn the_newest_fine_tune_on_disk_runs() {
        let base = std::env::temp_dir().join(format!("ot-local-model-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(installed_adapter(&base).is_none());
        // A partial download is not a fine-tune.
        std::fs::File::create(base.join(ADAPTERS[0].asset.file)).and_then(|f| f.set_len(10)).unwrap();
        assert!(installed_adapter(&base).is_none());
        for a in ADAPTERS {
            put(&base, a);
            assert_eq!(installed_adapter(&base).map(|x| x.version), Some(a.version));
        }
        assert_eq!(latest().version, ADAPTERS.iter().map(|a| a.version).max().unwrap());
        assert_eq!(prefix_file(2), "prefix-v2.bin");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn versions_rise_and_files_differ() {
        assert!(ADAPTERS.windows(2).all(|w| w[0].version < w[1].version && w[0].asset.file != w[1].asset.file));
    }
}
