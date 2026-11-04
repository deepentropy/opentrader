/*
 * The AI assistant's model, on this computer (#239): nothing in the installer, downloaded when the user asks for it.
 * Three files: the llama.cpp server for this system (a pinned build: Vulkan where there is one, with a CPU build to
 * fall back on; Metal on Apple silicon), the open base model (Qwen3-4B-Instruct-2507, Q4_K_M) and OpenTrader's
 * fine-tune of it (a LoRA, the small file that changes with each version). Each is checked against its sha256; a
 * download stopped midway goes on from where it was.
 *
 * The server runs on 127.0.0.1 only, started with the first chat and stopped with the app.
 */
use opentrader_core::net::SharedClient;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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

/// OpenTrader's fine-tune (prompt-distillation v2, trained with the short tool list src/data/assistant/compact-v1.txt).
const ADAPTER: Asset = Asset {
    file: "opentrader-assistant-v2-lora-f16.gguf",
    url: "https://github.com/deepentropy/opentrader/releases/download/assistant-model-v2/opentrader-assistant-v2-lora-f16.gguf",
    sha256: "22bb391e1c8cde89ad43a37887865eba1e9cd68f81da025beacd225cf53a6277",
    size: 66_095_232,
};
/// The fine-tune is on the release page: the download is offered.
const PUBLISHED: bool = true;

/// RAM the server needs with an 8k context (measured: about 4.3 GB private at 16k), with a margin.
const RAM_NEEDED: u64 = 6 * 1024 * 1024 * 1024;

struct Server {
    child: tokio::process::Child,
    port: u16,
    /// The prompt work was saved to disk this session.
    saved: bool,
}

static SERVER: tokio::sync::Mutex<Option<Server>> = tokio::sync::Mutex::const_new(None);
static INSTALL_STOP: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

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
}

fn present(base: &Path, a: &Asset) -> bool {
    std::fs::metadata(base.join(a.file)).is_ok_and(|m| m.len() == a.size)
}

fn installed(base: &Path) -> bool {
    let rts = runtimes();
    !rts.is_empty() && rts.iter().any(|r| server_exe(&runtime_dir(base, r)).is_some()) && present(base, &BASE) && present(base, &ADAPTER)
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
    let rts = runtimes();
    let parts: Vec<Asset> = [BASE, ADAPTER].into_iter().chain(rts.first().copied()).collect();
    let missing: u64 = parts
        .iter()
        .map(|a| if present(&base, a) || (a.file.contains("llama-") && server_exe(&runtime_dir(&base, a)).is_some()) { 0 } else { a.size })
        .sum();
    let disk: u64 = walk(&base).iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let probe = if base.exists() { base.clone() } else { app.path().app_local_data_dir().map_err(|e| e.to_string())? };
    Ok(LocalModelInfo {
        available: !rts.is_empty() && PUBLISHED,
        installed: installed(&base),
        running: SERVER.lock().await.is_some(),
        download_bytes: missing as f64,
        disk_bytes: disk as f64,
        ram_bytes: sys.total_memory() as f64,
        ram_needed_bytes: RAM_NEEDED as f64,
        free_disk_bytes: free_disk(&probe) as f64,
        installing: INSTALL_STOP.lock().unwrap().is_some(),
    })
}

/// Download progress: the file, its bytes so far and its size.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalProgress {
    pub file: String,
    pub done: f64,
    pub total: f64,
}

/// Downloads `a` into `base` (resuming a `.part` file), checks its sha256 and keeps it under its name.
async fn fetch(base: &Path, a: &Asset, on: &Channel<LocalProgress>, stop: &mut oneshot::Receiver<()>) -> Result<(), String> {
    let path = base.join(a.file);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() == a.size) {
        return Ok(());
    }
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
                let _ = on.send(LocalProgress { file: a.file.into(), done: have as f64, total: a.size as f64 });
            }
        }
        f.flush().await.map_err(|e| e.to_string())?;
    }
    let _ = on.send(LocalProgress { file: format!("Checking {}", a.file), done: a.size as f64, total: a.size as f64 });
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
    std::fs::rename(&part, &path).map_err(|e| e.to_string())
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

/// Downloads what is missing.
#[tauri::command]
#[specta::specta]
pub async fn local_model_install(app: AppHandle, on_progress: Channel<LocalProgress>) -> Result<(), String> {
    let base = dir(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let (tx, mut rx) = oneshot::channel();
    {
        let mut slot = INSTALL_STOP.lock().unwrap();
        if slot.is_some() {
            return Err("The download is already under way.".into());
        }
        *slot = Some(tx);
    }
    let result = async {
        for r in runtimes() {
            let to = runtime_dir(&base, &r);
            if server_exe(&to).is_some() {
                continue;
            }
            fetch(&base, &r, &on_progress, &mut rx).await?;
            unpack(&base.join(r.file), &to)?;
            let _ = std::fs::remove_file(base.join(r.file));
        }
        fetch(&base, &ADAPTER, &on_progress, &mut rx).await?;
        fetch(&base, &BASE, &on_progress, &mut rx).await
    }
    .await;
    *INSTALL_STOP.lock().unwrap() = None;
    result
}

#[tauri::command]
#[specta::specta]
pub fn local_model_cancel() {
    if let Some(tx) = INSTALL_STOP.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

/// Stops the server and deletes the files.
#[tauri::command]
#[specta::specta]
pub async fn local_model_remove(app: AppHandle) -> Result<(), String> {
    stop_server().await;
    let base = dir(&app)?;
    if base.exists() {
        std::fs::remove_dir_all(&base).map_err(|e| format!("The files could not all be deleted: {e}"))?;
    }
    Ok(())
}

pub async fn stop_server() {
    if let Some(mut s) = SERVER.lock().await.take() {
        let _ = s.child.kill().await;
    }
}

/// Stops the server when the app quits (it would outlive it otherwise).
pub fn shutdown() {
    if let Some(mut guard) = SERVER.try_lock().ok() {
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

async fn start(base: &Path, exe: &Path, gpu: bool) -> Result<Server, String> {
    let port = free_port()?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("-m")
        .arg(base.join(BASE.file))
        .arg("--lora")
        .arg(base.join(ADAPTER.file))
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
    let mut child = cmd.spawn().map_err(|e| format!("The model server did not start: {e}"))?;
    for _ in 0..240 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("The model server stopped ({status})."));
        }
        if healthy(port).await {
            return Ok(Server { child, port, saved: false });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = child.kill().await;
    Err("The model server did not answer within 2 minutes.".into())
}

/// The running server's API root, starting it when needed (the GPU build first, then the CPU one).
pub async fn ensure_server(app: &AppHandle) -> Result<String, String> {
    let mut guard = SERVER.lock().await;
    if let Some(s) = guard.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() && healthy(s.port).await {
            return Ok(format!("http://127.0.0.1:{}/v1", s.port));
        }
        *guard = None;
    }
    let base = dir(app)?;
    if !installed(&base) {
        return Err("The assistant's model is not downloaded yet.".into());
    }
    let mut last = String::new();
    for (i, r) in runtimes().iter().enumerate() {
        let Some(exe) = server_exe(&runtime_dir(&base, r)) else { continue };
        // The first build uses the graphics card (Vulkan, Metal); the fallback runs on the processor.
        match start(&base, &exe, i == 0).await {
            Ok(s) => {
                let port = s.port;
                *guard = Some(s);
                drop(guard);
                restore_prefix(&base, port).await;
                return Ok(format!("http://127.0.0.1:{port}/v1"));
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

const PREFIX_FILE: &str = "prefix-v2.bin";

/// Puts back the prompt work saved by an earlier session (the short tool list read once), so the first answer
/// skips it.
async fn restore_prefix(base: &Path, port: u16) {
    if base.join(PREFIX_FILE).exists() {
        let _ = CLIENT
            .get()
            .post(format!("http://127.0.0.1:{port}/slots/0?action=restore"))
            .json(&serde_json::json!({ "filename": PREFIX_FILE }))
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
    let port = s.port;
    drop(guard);
    if let Ok(base) = dir(app) {
        if !base.join(PREFIX_FILE).exists() {
            let _ = CLIENT
                .get()
                .post(format!("http://127.0.0.1:{port}/slots/0?action=save"))
                .json(&serde_json::json!({ "filename": PREFIX_FILE }))
                .timeout(Duration::from_secs(30))
                .send()
                .await;
        }
    }
}
