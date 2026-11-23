/*
 * install_token — this install's own gateway token (gateway#14).
 *
 * The shared token compiled into every build can be extracted from any copy,
 * so it only registers: `POST <gateway>/auth/v1/install` with it gives the
 * install its own token (`oti1.<id>.<sig>`), kept in a file and sent with
 * every gateway call from then on (`gateway::token`). The gateway can then
 * tell installs apart and revoke one without touching the others.
 *
 * Data calls made while the first registration runs wait for it (`settle`,
 * gateway#16): the shared token is meant for registering only. Until a
 * registration succeeds (offline at first start, the network's daily cap
 * reached), and after the gateway refuses the install token, the shared token
 * still stands in. A refused install token is dropped and registration tried
 * again, at most once an hour.
 *
 * A copy the gateway disabled (`INSTALL_DISABLED`, a revocation) keeps its token
 * and does not fall back: its calls fail with the gateway's message, which
 * names the code to quote, and `disabled()` tells the app to say so. Lifted on
 * the gateway's side, the same token works again.
 */
use crate::data::gateway;
use crate::sync::{LockExt, RwLockExt};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Prefix of a token the gateway issued to an install.
const PREFIX: &str = "oti1.";
/// Shortest wait between two registrations of the same run.
const RETRY_AFTER: Duration = Duration::from_secs(60 * 60);

static CURRENT: RwLock<Option<&'static str>> = RwLock::new(None);
static FILE: OnceLock<PathBuf> = OnceLock::new();
static LAST_TRY: Mutex<Option<Instant>> = Mutex::new(None);
/// Longest wait of a data call for the registration in flight.
const SETTLE_WAIT: Duration = Duration::from_secs(15);

/// True while the first registration of the run is in flight.
fn registering() -> &'static tokio::sync::watch::Sender<bool> {
    static FLAG: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();
    FLAG.get_or_init(|| tokio::sync::watch::channel(false).0)
}

/// Wait (up to `SETTLE_WAIT`) for the registration in flight, so the first
/// data calls of a new install go with its own token, not the shared one.
pub async fn settle() {
    let mut rx = registering().subscribe();
    let _ = tokio::time::timeout(SETTLE_WAIT, rx.wait_for(|busy| !*busy)).await;
}

fn disabled_flag() -> &'static tokio::sync::watch::Sender<Option<String>> {
    static FLAG: OnceLock<tokio::sync::watch::Sender<Option<String>>> = OnceLock::new();
    FLAG.get_or_init(|| tokio::sync::watch::channel(None).0)
}

/// The code (install id) of this copy once the gateway answered that it is
/// disabled; `None` while it is served.
pub fn disabled() -> tokio::sync::watch::Receiver<Option<String>> {
    disabled_flag().subscribe()
}

/// The gateway disabled this copy (`INSTALL_DISABLED`): the token is kept (no
/// fallback to the shared one) and the app says so with `code`.
pub fn mark_disabled(code: &str) {
    disabled_flag().send_if_modified(|v| {
        let changed = v.as_deref() != Some(code);
        *v = Some(code.to_string());
        changed
    });
}

/// A call went through: a disabled copy that the gateway serves again is no longer flagged.
pub fn mark_served() {
    if disabled_flag().borrow().is_some() {
        disabled_flag().send_replace(None);
    }
}

/// This install's token, once registered.
pub fn current() -> Option<&'static str> {
    *CURRENT.read_locked()
}

fn set(token: Option<String>) {
    // Leaked: a handful a run at most (`gateway::token` hands out `&'static str`).
    *CURRENT.write_locked() = token.map(|t| &*Box::leak(t.into_boxed_str()));
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Saved {
    token: String,
}

fn load(file: &Path) -> Option<String> {
    let saved: Saved = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    saved.token.starts_with(PREFIX).then_some(saved.token)
}

fn save(file: &Path, token: &str) -> Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(file, serde_json::to_vec(&Saved { token: token.to_string() })?)?;
    Ok(())
}

/// Use the token saved in `file`, or register one in the background. Once, at
/// start, before or soon after the first gateway call.
pub fn init(file: PathBuf) {
    let saved = load(&file);
    let _ = FILE.set(file);
    match saved {
        Some(token) => set(Some(token)),
        None => {
            registering().send_replace(true);
            crate::rt::spawn(async {
                register_and_keep().await;
                registering().send_replace(false);
            });
        }
    }
}

async fn register_and_keep() {
    let Some(file) = FILE.get() else { return };
    {
        let mut last = LAST_TRY.locked();
        if last.is_some_and(|t| t.elapsed() < RETRY_AFTER) {
            return;
        }
        *last = Some(Instant::now());
    }
    match register(gateway::BASE).await {
        Ok(token) => {
            if let Err(e) = save(file, &token) {
                eprintln!("[install-token] keep {}: {e:#}", file.display());
            }
            set(Some(token));
        }
        Err(e) => eprintln!("[install-token] register: {e:#} (the shared token is used meanwhile)"),
    }
}

/// A new install token from the gateway at `base`, asked with the shared token.
pub(crate) async fn register(base: &str) -> Result<String> {
    let shared = gateway::shared_token().context(gateway::NO_TOKEN)?;
    let resp = crate::data::market_rest::http()
        .post(format!("{base}/auth/v1/install"))
        .bearer_auth(shared)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("request failed")?;
    let status = resp.status();
    if !status.is_success() {
        bail!("HTTP {}", status.as_u16());
    }
    #[derive(serde::Deserialize)]
    struct Answer {
        token: String,
    }
    let answer: Answer = resp.json().await.context("unreadable answer")?;
    if !answer.token.starts_with(PREFIX) {
        bail!("not an install token");
    }
    Ok(answer.token)
}

/// The gateway refused this install's token (revoked): back to the shared
/// token, the saved one forgotten, and a new registration tried.
pub fn refused() {
    if current().is_none() {
        return;
    }
    set(None);
    if let Some(file) = FILE.get() {
        let _ = std::fs::remove_file(file);
    }
    crate::rt::spawn(register_and_keep());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_token_round_trip_and_only_install_tokens() {
        let dir = std::env::temp_dir().join(format!("ot-install-{}", std::process::id()));
        let file = dir.join("install.json");
        save(&file, "oti1.abc.def").unwrap();
        assert_eq!(load(&file).as_deref(), Some("oti1.abc.def"));
        save(&file, "shared-token").unwrap();
        assert_eq!(load(&file), None, "a file holding anything else is ignored");
        std::fs::write(&file, b"not json").unwrap();
        assert_eq!(load(&file), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Registration posts the shared token and takes the install token of the answer.
    #[tokio::test]
    async fn registers_with_the_shared_token() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if gateway::shared_token().is_none() {
            eprintln!("no shared token in this build: skipped");
            return;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut head = vec![0u8; 8192];
            let n = tcp.read(&mut head).await.unwrap();
            let body = br#"{"token":"oti1.0123456789abcdef0123456789abcdef.sig","id":"0123456789abcdef0123456789abcdef"}"#;
            let answer = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            tcp.write_all(answer.as_bytes()).await.unwrap();
            tcp.write_all(body).await.unwrap();
            String::from_utf8_lossy(&head[..n]).to_string()
        });
        let token = register(&format!("http://127.0.0.1:{port}")).await.unwrap();
        assert!(token.starts_with("oti1.0123"), "{token}");
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /auth/v1/install "), "{request}");
        assert!(request.to_lowercase().contains(&format!("authorization: bearer {}", gateway::shared_token().unwrap()).to_lowercase()));
    }
}
