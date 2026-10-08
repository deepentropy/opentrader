/*
 * Stock screener engine.
 *
 * While at least one screener panel is open, a task keeps the full-market
 * snapshot current, joins it with the reference list and the daily state
 * file, and swaps the result in as one immutable `Table`. The snapshot comes
 * from the gateway's live feed (`live.rs`: one table, then its changes every
 * 10 s, shared by every app); while the feed is refused, silent, in error or
 * failing its polls for too long the task polls the REST snapshot every 10 s
 * instead and tries the feed again later. Scans (`scan.rs`) read the current table only, so filter / sort /
 * scroll never wait on the network. Each new table is announced with a
 * `ScreenerUpdate` event; the panel then re-runs its scan.
 */
pub mod clock;
pub mod fields;
pub mod live;
pub mod scan;
pub mod state;
pub mod table;

use crate::data::gateway;
use crate::data::massive_rest::{self, MarketRow, RefTicker};
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

/// REST snapshot poll cadence while a panel is open and the live feed is down.
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// Wait before connecting to the live feed again after it failed.
const FEED_RETRY: Duration = Duration::from_secs(60);
/// How often to ask the gateway for a newer state file while the one held is
/// older than the last closed session.
const STATE_RECHECK: Duration = Duration::from_secs(15 * 60);
/// Wait before asking again for a reference list that failed.
const REFS_RETRY: Duration = Duration::from_secs(5 * 60);

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
    /// Wakes the task when a panel closes, so it need not wait for the next
    /// feed message to see that none is left.
    closed: tokio::sync::Notify,
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

    /// Unregister a panel; the task stops (and leaves the live feed) when none is left.
    pub fn close(&self, owner: &str) {
        self.inner.owners.lock().expect("screener owners lock").remove(owner);
        self.inner.closed.notify_one();
    }
}

/// The live feed address: the gateway's, or the one given in
/// `OPENTRADER_SCREENER_FEED` (`off` = REST polling only).
fn feed_url() -> Option<String> {
    match std::env::var("OPENTRADER_SCREENER_FEED") {
        Ok(v) if v.eq_ignore_ascii_case("off") => None,
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => Some(gateway::SCREENER_LIVE_URL.to_string()),
    }
}

/// The reference list task's result, or never when none is running.
async fn refs_result(
    task: &mut Option<tauri::async_runtime::JoinHandle<Option<Vec<RefTicker>>>>,
) -> Option<Vec<RefTicker>> {
    match task.as_mut() {
        Some(t) => t.await.ok().flatten(),
        None => std::future::pending().await,
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
    let mut refs_failed: Option<Instant> = None;
    let mut state: Option<Arc<StateFile>> = state::read_cache().map(Arc::new);
    let mut state_checked: Option<Instant> = None;
    let feed_url = feed_url();
    let mut feed: Option<live::Feed> = None;
    // The feed holds a table not shown yet (just connected).
    let mut feed_fresh = false;
    let mut feed_retry: Option<Instant> = None;

    loop {
        let none_left = inner.owners.lock().expect("screener owners lock").is_empty();
        if none_left {
            // Leaving the feed lets the gateway stop polling when no app is left.
            if let Some(f) = feed.take() {
                f.close().await;
            }
            inner.running.store(false, Ordering::SeqCst);
            // A panel opened during the close: carry on unless its task started.
            let reopened = !inner.owners.lock().expect("screener owners lock").is_empty();
            if reopened && !inner.running.swap(true, Ordering::SeqCst) {
                continue;
            }
            return;
        }
        let started = Instant::now();
        let today = clock::ny_date_ms(chrono::Utc::now().timestamp_millis() as f64);

        // Reference list: once per New York day, in the background so the
        // first table does not wait for its ~13 pages. Its arrival ends the
        // wait below, so the table gains names and types at once.
        let refs_retry = refs_failed.map_or(true, |t: Instant| t.elapsed() >= REFS_RETRY);
        if refs_task.is_none() && refs_day != today && refs_retry {
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
        if stale && state_checked.map_or(true, |t| t.elapsed() >= STATE_RECHECK) {
            state_checked = Some(Instant::now());
            match state::fetch().await {
                Ok(Some(s)) => state = Some(Arc::new(s)),
                Ok(None) => {}
                Err(e) => eprintln!("[screener] state: {e:#}"),
            }
        }

        // Live feed: connect when there is none and its retry time has come.
        if feed.is_none() && feed_retry.map_or(true, |t| Instant::now() >= t) {
            if let Some(url) = feed_url.as_deref() {
                match live::Feed::connect(url).await {
                    Ok(f) => {
                        eprintln!("[screener] live feed connected ({} tickers)", f.table.len());
                        feed = Some(f);
                        feed_fresh = true;
                        feed_retry = None;
                    }
                    Err(e) => {
                        eprintln!("[screener] {e:#}; polling the snapshot instead");
                        feed_retry = Some(Instant::now() + FEED_RETRY);
                    }
                }
            }
        }

        // The snapshot rows: from the feed's table after its next message,
        // else from a REST poll.
        let via_feed = feed.is_some();
        let snap: anyhow::Result<Vec<MarketRow>> = if let Some(f) = feed.as_mut() {
            let mut lost = None;
            if !feed_fresh {
                tokio::select! {
                    res = f.next() => lost = res.err(),
                    _ = inner.closed.notified() => continue,
                    list = refs_result(&mut refs_task) => {
                        refs_task = None;
                        match list {
                            Some(list) => {
                                write_refs_cache(today, &list);
                                refs = Arc::new(list);
                                refs_day = today;
                            }
                            None => refs_failed = Some(Instant::now()),
                        }
                    }
                }
            }
            feed_fresh = false;
            match lost {
                None => massive_rest::shape_feed_snapshots(f.table.snapshots()).await,
                Some(e) => Err(e),
            }
        } else {
            massive_rest::fetch_market_snapshot().await
        };
        let snap = match snap {
            Err(e) if via_feed => {
                // The feed failed: poll the snapshot now, come back to the feed later.
                eprintln!("[screener] {e:#}; polling the snapshot instead");
                if let Some(f) = feed.take() {
                    f.close().await;
                }
                feed_retry = Some(Instant::now() + FEED_RETRY);
                continue;
            }
            other => other,
        };

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
        // With the feed, its next message is the wait.
        if via_feed {
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL.saturating_sub(started.elapsed())) => {}
            _ = inner.closed.notified() => {}
            list = refs_result(&mut refs_task) => {
                refs_task = None;
                match list {
                    Some(list) => {
                        write_refs_cache(today, &list);
                        refs = Arc::new(list);
                        refs_day = today;
                    }
                    None => refs_failed = Some(Instant::now()),
                }
            }
        }
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
    let tickers = c
        .tickers
        .into_iter()
        .map(|mut r| {
            r.currency_name = r.currency_name.to_uppercase();
            r
        })
        .collect();
    (c.day == today).then_some((c.day, tickers))
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
