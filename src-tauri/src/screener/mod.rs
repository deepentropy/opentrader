/*
 * Stock screener engine.
 *
 * While at least one screener panel is open, a task polls the full-market
 * snapshot every 10 s through the gateway, joins it with the reference list
 * and the daily state file, and swaps the result in as one immutable
 * `Table`. Scans (`scan.rs`) read the current table only, so filter / sort /
 * scroll never wait on the network. Each new table is announced with a
 * `ScreenerUpdate` event; the panel then re-runs its scan.
 */
pub mod clock;
pub mod fields;
pub mod scan;
pub mod state;
pub mod table;

use crate::data::massive_rest::{self, RefTicker};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use state::StateFile;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use table::Table;
use tauri::AppHandle;
use tauri_specta::Event;

/// Snapshot poll cadence while a panel is open.
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// How often to ask the gateway for a newer state file while the one held is
/// older than the last closed session.
const STATE_RECHECK: Duration = Duration::from_secs(15 * 60);

/// Sent after every poll (new table or error).
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerUpdate {
    pub version: u32,
    pub updated_ms: Option<f64>,
    pub total: u32,
    pub state_asof: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerStatus {
    pub version: u32,
    pub updated_ms: Option<f64>,
    pub total: u32,
    pub state_asof: Option<String>,
}

#[derive(Default)]
struct Inner {
    owners: Mutex<HashSet<String>>,
    table: RwLock<Option<Arc<Table>>>,
    running: AtomicBool,
}

/// Managed app state (`app.manage(Screener::default())`).
#[derive(Default, Clone)]
pub struct Screener {
    inner: Arc<Inner>,
}

impl Screener {
    pub fn table(&self) -> Arc<Table> {
        self.inner.table.read().expect("screener table lock").clone().unwrap_or_else(|| Arc::new(Table::empty()))
    }

    pub fn status(&self) -> ScreenerStatus {
        let t = self.table();
        ScreenerStatus {
            version: t.version,
            updated_ms: t.updated_ms,
            total: t.rows.len() as u32,
            state_asof: t.state_asof().map(|d| d.to_string()),
        }
    }

    /// Register a panel; starts the poll task when it is the first one.
    pub fn open(&self, app: AppHandle, owner: String) -> ScreenerStatus {
        let mut owners = self.inner.owners.lock().expect("screener owners lock");
        owners.insert(owner);
        if !self.inner.running.swap(true, Ordering::SeqCst) {
            let inner = self.inner.clone();
            tauri::async_runtime::spawn(async move { run(app, inner).await });
        }
        drop(owners);
        self.status()
    }

    /// Unregister a panel; the task stops after its current poll when none is left.
    pub fn close(&self, owner: &str) {
        self.inner.owners.lock().expect("screener owners lock").remove(owner);
    }
}

async fn run(app: AppHandle, inner: Arc<Inner>) {
    let mut version = inner.table.read().expect("screener table lock").as_ref().map_or(0, |t| t.version);
    let mut refs: Arc<Vec<RefTicker>> = Arc::new(Vec::new());
    let mut refs_day: Option<NaiveDate> = None;
    if let Some((day, list)) = read_refs_cache() {
        refs = Arc::new(list);
        refs_day = Some(day);
    }
    let mut refs_task: Option<tauri::async_runtime::JoinHandle<Option<Vec<RefTicker>>>> = None;
    let mut state: Option<Arc<StateFile>> = state::read_cache().map(Arc::new);
    let mut state_checked: Option<Instant> = None;

    loop {
        {
            let owners = inner.owners.lock().expect("screener owners lock");
            if owners.is_empty() {
                inner.running.store(false, Ordering::SeqCst);
                return;
            }
        }
        let started = Instant::now();
        let today = clock::ny_date_ms(chrono::Utc::now().timestamp_millis() as f64);

        // Reference list: once per New York day, in the background so the
        // first table does not wait for its ~13 pages.
        if let Some(task) = refs_task.as_ref() {
            if task.inner().is_finished() {
                if let Ok(Some(list)) = refs_task.take().expect("refs task").await {
                    write_refs_cache(today, &list);
                    refs = Arc::new(list);
                    refs_day = today;
                }
            }
        } else if refs_day != today {
            refs_task = Some(tauri::async_runtime::spawn(async {
                match massive_rest::fetch_reference_tickers().await {
                    Ok(list) => Some(list),
                    Err(e) => {
                        eprintln!("[screener] reference tickers: {e:#}");
                        None
                    }
                }
            }));
        }

        // Daily state: fetch when missing or older than the last closed
        // session, at most every STATE_RECHECK.
        let expected = clock::last_closed_session(chrono::Utc::now());
        let stale = state.as_ref().map(|s| s.asof) < expected;
        let fetch_state = stale && state_checked.map_or(true, |t| t.elapsed() >= STATE_RECHECK);
        let (snap, fresh_state) = tokio::join!(massive_rest::fetch_market_snapshot(), async {
            if fetch_state {
                Some(state::fetch().await)
            } else {
                None
            }
        });
        if let Some(res) = fresh_state {
            state_checked = Some(Instant::now());
            match res {
                Ok(Some(s)) => state = Some(Arc::new(s)),
                Ok(None) => {}
                Err(e) => eprintln!("[screener] state: {e:#}"),
            }
        }

        let update = match snap {
            Ok(rows) => {
                version = version.wrapping_add(1);
                let t = Arc::new(Table::build(version, rows, refs.clone(), state.clone()));
                let update = ScreenerUpdate {
                    version,
                    updated_ms: t.updated_ms,
                    total: t.rows.len() as u32,
                    state_asof: t.state_asof().map(|d| d.to_string()),
                    error: None,
                };
                *inner.table.write().expect("screener table lock") = Some(t);
                update
            }
            Err(e) => {
                let t = inner.table.read().expect("screener table lock").clone();
                ScreenerUpdate {
                    version,
                    updated_ms: t.as_ref().and_then(|t| t.updated_ms),
                    total: t.as_ref().map_or(0, |t| t.rows.len() as u32),
                    state_asof: t.as_ref().and_then(|t| t.state_asof()).map(|d| d.to_string()),
                    error: Some(format!("{e:#}")),
                }
            }
        };
        let _ = update.emit(&app);
        tokio::time::sleep(POLL_INTERVAL.saturating_sub(started.elapsed())).await;
    }
}

#[derive(Serialize, Deserialize)]
struct RefsCache {
    day: NaiveDate,
    tickers: Vec<RefTicker>,
}

fn refs_cache_path() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("opentrader")
        .join("screener_refs.json")
}

/// The saved reference list and its day, when it is today's.
fn read_refs_cache() -> Option<(NaiveDate, Vec<RefTicker>)> {
    let c: RefsCache = serde_json::from_slice(&std::fs::read(refs_cache_path()).ok()?).ok()?;
    let today = clock::ny_date_ms(chrono::Utc::now().timestamp_millis() as f64)?;
    (c.day == today).then_some((c.day, c.tickers))
}

fn write_refs_cache(day: Option<NaiveDate>, list: &[RefTicker]) {
    let Some(day) = day else { return };
    let path = refs_cache_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&RefsCache { day, tickers: list.to_vec() }) {
        let _ = std::fs::write(path, bytes);
    }
}
