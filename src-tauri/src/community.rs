/*
 * Community sign-in (deploy/community). The app opens the sign-in page in the system browser; once signed in, the
 * browser comes back to the app on a loopback address (RFC 8252): `community_auth_listen` opens it on a free port,
 * `community_auth_wait` returns the query the browser brings (the one-time code), which the app trades for a session
 * itself. The session token goes to the system's encrypted credential store; where that store isn't available it
 * lasts until the app closes.
 */
use std::sync::Mutex;
use opentrader_core::sync::LockExt;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

/// Name of the session token in the credential store (the service is the app's identifier).
const ACCOUNT: &str = "community-session";
/// A sign-in left unfinished in the browser ends after this.
const WAIT: Duration = Duration::from_secs(600);

static LISTENER: Mutex<Option<std::net::TcpListener>> = Mutex::new(None);
static CANCEL: Notify = Notify::const_new();
static UNSAVED_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// Opens the loopback address the browser returns to; its port.
#[tauri::command]
#[specta::specta]
pub fn community_auth_listen() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    *LISTENER.locked() = Some(listener);
    Ok(port)
}

fn page(ok: bool) -> String {
    let (title, text) = if ok {
        ("Signed in", "You are signed in to OpenTrader Community. You can close this tab and return to the app.")
    } else {
        ("Sign-in cancelled", "The sign-in did not complete. You can close this tab and try again from the app.")
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>body{{font:15px system-ui,sans-serif;\
         background:#131722;color:#d1d4dc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}}\
         main{{max-width:420px;padding:32px;background:#1e222d;border-radius:8px}}h1{{font-size:20px;margin:0 0 12px}}</style>\
         </head><body><main><h1>{title}</h1><p>{text}</p></main></body></html>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// Waits for the browser on the address `community_auth_listen` opened; the query it brings (`state`, then `code`
/// or `error`).
#[tauri::command]
#[specta::specta]
pub async fn community_auth_wait() -> Result<String, String> {
    let listener = LISTENER.locked().take().ok_or("no sign-in in progress")?;
    let listener = tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;
    let receive = async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = match tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buf)).await {
                Ok(Ok(n)) => n,
                _ => continue,
            };
            let head = String::from_utf8_lossy(&buf[..n]);
            let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
            if let Some(query) = target.strip_prefix("/community-auth?") {
                let ok = query.split('&').any(|p| p.starts_with("code="));
                let _ = socket.write_all(page(ok).as_bytes()).await;
                return Ok::<String, String>(query.to_string());
            }
            // The browser's other requests (the tab icon).
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        }
    };
    tokio::select! {
        r = receive => r,
        _ = tokio::time::sleep(WAIT) => Err("the sign-in took too long".into()),
        _ = CANCEL.notified() => Err("cancelled".into()),
    }
}

/// Ends a sign-in in progress.
#[tauri::command]
#[specta::specta]
pub fn community_auth_cancel() {
    LISTENER.locked().take();
    CANCEL.notify_waiters();
}

fn credential(app: &AppHandle) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(&app.config().identifier, ACCOUNT)
}

/// The saved session token, if any.
#[tauri::command]
#[specta::specta]
pub fn community_token_get(app: AppHandle) -> Option<String> {
    if let Some(token) = UNSAVED_TOKEN.locked().clone() {
        return Some(token);
    }
    match credential(&app).and_then(|e| e.get_password()) {
        Ok(token) => Some(token),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[community] session not read: {e}");
            None
        }
    }
}

/// Saves the session token (none: signed out). An error: it lasts until the app closes.
#[tauri::command]
#[specta::specta]
pub fn community_token_set(app: AppHandle, token: Option<String>) -> Result<(), String> {
    let stored = credential(&app).and_then(|entry| match &token {
        Some(t) => entry.set_password(t),
        None => match entry.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        },
    });
    *UNSAVED_TOKEN.locked() = if stored.is_ok() { None } else { token };
    stored.map_err(|e| format!("credential store: {e}"))
}
