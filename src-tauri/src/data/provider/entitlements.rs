/*
 * Entitlement store — what the credential allows, probed in the background.
 *
 * Latency / non-blocking rules:
 *   • startup never waits on the network: the last probe result is read from
 *     `<cache_dir>/opentrader/provider_caps.json` and published at once;
 *   • a new probe runs in the background when the cache is missing, from an
 *     earlier UTC day, or for another key/provider, and when the key changes;
 *   • the probe publishes in two steps: history (REST, ~0.4 s) first, then the
 *     stream channels (WebSocket, a few seconds). Each step emits
 *     `provider-capabilities`.
 *
 * History commands read the floor through `history_floor`. Only when no result
 * exists yet (first launch, new key) do they wait for the history step, capped
 * at `FLOOR_WAIT`.
 *
 * A generation counter drops the result of a probe that a newer one (key
 * change) superseded.
 */
use super::capabilities::{BarFamily, Entitlements, ProviderCapabilities, StreamCaps};
use super::Provider;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::watch;

/// Longest a history command waits for the first history probe.
const FLOOR_WAIT: Duration = Duration::from_secs(5);

/// Published state. `settled` is false only while the first probe for the
/// current key is running with nothing cached — history commands wait on it.
/// `ent` is `None` while a new key is being probed, so the live stream task
/// (see `massive_ws::spawn_second_bars`) drops a connection made with the old
/// key's entitlements.
#[derive(Clone, Default)]
pub struct State {
    pub settled: bool,
    pub ent: Option<Entitlements>,
}

impl State {
    /// True when the probed stream channels satisfy `pred`.
    pub fn stream_allows(&self, pred: impl Fn(&StreamCaps) -> bool) -> bool {
        self.ent
            .as_ref()
            .and_then(|e| e.stream.as_ref())
            .is_some_and(pred)
    }
}

/// Watch the published entitlements (the live stream task gates on them).
pub fn subscribe() -> watch::Receiver<State> {
    cell().subscribe()
}

fn cell() -> &'static watch::Sender<State> {
    static CELL: OnceLock<watch::Sender<State>> = OnceLock::new();
    CELL.get_or_init(|| watch::channel(State::default()).0)
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// On-disk cache entry. The key itself is never stored, only a fingerprint.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    provider: String,
    credential: String,
    entitlements: Entitlements,
}

fn cache_path() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("opentrader")
        .join("provider_caps.json")
}

fn read_cache(provider: &str, credential: &str) -> Option<Entitlements> {
    let bytes = std::fs::read(cache_path()).ok()?;
    let c: CacheFile = serde_json::from_slice(&bytes).ok()?;
    (c.provider == provider && c.credential == credential).then_some(c.entitlements)
}

fn write_cache(provider: &str, credential: &str, ent: &Entitlements) {
    let path = cache_path();
    let file = CacheFile {
        provider: provider.to_owned(),
        credential: credential.to_owned(),
        entitlements: ent.clone(),
    };
    if let (Some(parent), Ok(json)) = (path.parent(), serde_json::to_vec_pretty(&file)) {
        let _ = std::fs::create_dir_all(parent);
        let _ = std::fs::write(&path, json);
    }
}

/// True when the result was probed on an earlier UTC day (the history floor
/// is rolling, and a plan change must be picked up).
fn is_stale(ent: &Entitlements) -> bool {
    DateTime::parse_from_rfc3339(&ent.checked_at)
        .map(|t| t.with_timezone(&Utc).date_naive() != Utc::now().date_naive())
        .unwrap_or(true)
}

/// Static capabilities of `provider` plus the current entitlements.
pub fn full_capabilities(provider: &Provider) -> ProviderCapabilities {
    let mut caps = provider.capabilities();
    caps.entitlements = cell().borrow().ent.clone();
    caps
}

fn publish(app: &AppHandle, provider: &Provider, state: State) {
    cell().send_replace(state);
    if let Err(e) = full_capabilities(provider).emit(app) {
        eprintln!("[entitlements] emit failed: {e}");
    }
}

/// Startup: publish the cached result for this provider + key, then refresh in
/// the background when it is missing or stale.
pub fn init(app: &AppHandle, provider: Provider) {
    let cached = provider
        .credential_id()
        .and_then(|cred| read_cache(provider.name(), &cred));
    let fresh = cached.as_ref().is_some_and(|e| !is_stale(e));
    cell().send_replace(State {
        // With no key there is nothing to probe: settle at once so history
        // commands fail fast with the "no key" error instead of waiting.
        settled: cached.is_some() || provider.credential_id().is_none(),
        ent: cached,
    });
    if !fresh {
        refresh(app.clone(), provider);
    }
}

/// Re-probe in the background. Call after the credential changed.
pub fn refresh(app: AppHandle, provider: Provider) {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move { run(app, provider, gen).await });
}

async fn run(app: AppHandle, provider: Provider, gen: u64) {
    let current = || GENERATION.load(Ordering::SeqCst) == gen;
    let Some(cred) = provider.credential_id() else {
        publish(&app, &provider, State { settled: true, ent: None });
        return;
    };
    // Keep a result only if it belongs to this key; otherwise history commands
    // must wait for the new probe rather than clamp with another plan's floor.
    let previous = cell()
        .borrow()
        .ent
        .clone()
        .filter(|_| read_cache(provider.name(), &cred).is_some());
    if previous.is_none() {
        cell().send_replace(State { settled: false, ent: None });
    }

    // Step 1 — history (REST).
    let history = match provider.probe_history().await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[entitlements] history probe failed: {e:#}");
            if current() {
                publish(&app, &provider, State { settled: true, ent: previous });
            }
            return;
        }
    };
    if !current() {
        return;
    }
    let mut ent = Entitlements {
        data_status: history.data_status,
        raw_status: history.raw_status,
        delay_sec: history.delay_sec,
        history_floor: history.floor,
        // Keep the last known channels until the stream probe replaces them.
        stream: previous.and_then(|p| p.stream),
        checked_at: Utc::now().to_rfc3339(),
    };
    write_cache(provider.name(), &cred, &ent);
    publish(&app, &provider, State { settled: true, ent: Some(ent.clone()) });

    // Step 2 — stream channels (WebSocket).
    match provider.probe_stream(ent.data_status).await {
        Ok(stream) => {
            if !current() {
                return;
            }
            ent.stream = Some(stream);
            write_cache(provider.name(), &cred, &ent);
            publish(&app, &provider, State { settled: true, ent: Some(ent) });
        }
        Err(e) => eprintln!("[entitlements] stream probe failed: {e:#}"),
    }
}

/// Oldest available bar date for `family`, or `None` when unknown (no key,
/// probe failed, or the first probe took longer than `FLOOR_WAIT`). Waits only
/// while the first probe for the current key is running.
pub async fn history_floor(family: BarFamily) -> Option<NaiveDate> {
    let mut rx = cell().subscribe();
    let settled = tokio::time::timeout(FLOOR_WAIT, rx.wait_for(|s| s.settled))
        .await
        .map(|r| r.map(|s| s.clone()));
    let state = match settled {
        Ok(Ok(s)) => s,
        _ => cell().borrow().clone(),
    };
    state.ent.and_then(|e| e.history_floor.get(family))
}

/// Stable fingerprint of a credential (FNV-1a 64), so the cache can tell keys
/// apart without storing the key.
pub fn fingerprint(secret: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in secret.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_distinct() {
        assert_eq!(fingerprint("abc"), fingerprint("abc"));
        assert_ne!(fingerprint("abc"), fingerprint("abd"));
        assert_eq!(fingerprint("").len(), 16);
    }
}
