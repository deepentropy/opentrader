/*
 * Stock screener engine.
 *
 * While at least one screener panel is open, a task keeps the full-market
 * snapshot current, joins it with the reference list and the daily state
 * file, and swaps the result in as one immutable `Table`. The snapshot comes
 * from the gateway's live feed (`live.rs`: one table, then its changes every
 * 10 s, shared by every app); while the feed is refused, silent, in error or
 * failing its polls for too long the task polls the REST snapshot every 10 s
 * instead and tries the feed again later. The first table comes from whichever answers first, the feed or the REST
 * snapshot. Scans (`scan.rs`) read the current table only, so filter / sort /
 * scroll never wait on the network. Each new table is announced with a
 * `ScreenerUpdate` event; the panel then re-runs its scan.
 */
pub mod clock;
pub mod closes;
pub mod fields;
pub mod live;
pub mod progress;
pub mod scan;
pub mod state;
pub mod table;

use crate::data::gateway;
use crate::data::market_rest::{self, MarketRow, RefTicker};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use state::StateFile;
use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use table::Table;
use tokio::task::JoinHandle;
use crate::host::{event, Event, HostRef};

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
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
#[serde(rename_all = "camelCase")]
pub struct ScreenerUpdate {
    pub version: u32,
    pub updated_ms: Option<f64>,
    pub total: u32,
    pub state_asof: Option<String>,
    /// See `Table::complete`: until then an empty scan is not "no symbols match".
    pub complete: bool,
    pub error: Option<String>,
}

event!(ScreenerUpdate, "screener-update");

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerStatus {
    pub version: u32,
    pub updated_ms: Option<f64>,
    pub total: u32,
    pub state_asof: Option<String>,
    pub complete: bool,
}

#[derive(Default)]
struct Inner {
    owners: Mutex<HashSet<String>>,
    table: RwLock<Option<Arc<Table>>>,
    running: AtomicBool,
    /// Wakes the task when a panel closes, so it need not wait for the next
    /// feed message to see that none is left.
    closed: tokio::sync::Notify,
    /// Custom lengths the screens asked for ("EMA137"): computed from the closes file into the state.
    custom: Mutex<BTreeSet<String>>,
    /// What the first complete table waits on, for the loading wheel.
    downloads: progress::Downloads,
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
            complete: t.complete,
        }
    }

    /// Register a panel; starts the poll task when it is the first one.
    pub fn open(&self, app: HostRef, owner: String) -> ScreenerStatus {
        let mut owners = self.inner.owners.lock().expect("screener owners lock");
        owners.insert(owner);
        if !self.inner.running.swap(true, Ordering::SeqCst) {
            let inner = self.inner.clone();
            crate::rt::spawn(async move { run(app, inner).await });
        }
        drop(owners);
        self.status()
    }

    /// Ask for custom lengths ("EMA137", "SMA150", "RSI21"); returns the ids accepted (lengths 1 to 500). Their
    /// columns join the table from its next update (the closes file is fetched first when needed).
    pub fn request_custom(&self, ids: Vec<String>) -> Vec<String> {
        let ok: Vec<String> = ids.into_iter().filter(|id| closes::custom_id(id).is_some()).collect();
        self.inner.custom.lock().expect("screener custom lock").extend(ok.iter().cloned());
        ok
    }

    /// Download progress of what the next complete table waits on.
    pub fn progress(&self) -> progress::ScreenerProgress {
        self.inner.downloads.progress()
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

/// A background download's result, or never when none is running.
async fn finished<T>(task: &mut Option<JoinHandle<Option<T>>>) -> Option<T> {
    match task.as_mut() {
        Some(t) => t.await.ok().flatten(),
        None => std::future::pending().await,
    }
}

/// A finished background download.
enum Arrived {
    Refs(Option<Vec<RefTicker>>),
    State(Option<StateFile>),
    Closes(Option<closes::Closes>),
}

/// The data joined with the snapshot. The reference list, the daily state and the closes file download in the
/// background, so the first table does not wait for them (the state file took from 0.4 s to over 2 minutes when the
/// gateway was slow, measured 03/11/2026); each one's arrival ends the current wait and the table gains it at once.
#[derive(Default)]
struct Sources {
    refs: Arc<Vec<RefTicker>>,
    refs_day: Option<NaiveDate>,
    refs_task: Option<JoinHandle<Option<Vec<RefTicker>>>>,
    refs_failed: Option<Instant>,
    state: Option<Arc<StateFile>>,
    state_task: Option<JoinHandle<Option<StateFile>>>,
    state_checked: Option<Instant>,
    // Custom lengths: the closes file (fetched while a screen uses one) and the state with their columns.
    closes: Option<Arc<closes::Closes>>,
    closes_task: Option<JoinHandle<Option<closes::Closes>>>,
    closes_checked: Option<Instant>,
    merged: Option<(NaiveDate, Vec<String>, Arc<StateFile>)>,
}

impl Sources {
    fn from_cache() -> Self {
        let mut s = Sources { state: state::read_cache().map(Arc::new), ..Default::default() };
        if let Some((day, list)) = read_refs_cache() {
            s.refs = Arc::new(list);
            s.refs_day = Some(day);
        }
        s
    }

    /// Start the downloads that are due: the reference list once per New York day, the daily state when missing
    /// or older than the last closed session, the closes of the state's session while custom lengths are asked for
    /// (both at most every STATE_RECHECK).
    fn start(&mut self, today: Option<NaiveDate>, wanted: &[String], downloads: &progress::Downloads) {
        let refs_retry = self.refs_failed.map_or(true, |t| t.elapsed() >= REFS_RETRY);
        if self.refs_task.is_none() && self.refs_day != today && refs_retry {
            // Counted only when the table waits on it: no list held yet.
            let d = self.refs.is_empty().then(|| downloads.start("tickers"));
            self.refs_task = Some(crate::rt::spawn(async move {
                let list = market_rest::fetch_reference_tickers_counted(d.as_deref()).await;
                if let Some(d) = d {
                    d.finish();
                }
                match list {
                    Ok(list) => Some(list),
                    Err(e) => {
                        eprintln!("[screener] reference tickers: {e:#}");
                        None
                    }
                }
            }));
        }
        let expected = clock::last_closed_session(chrono::Utc::now());
        let stale = self.state.as_ref().map(|s| s.asof) < expected;
        if stale && self.state_task.is_none() && self.state_checked.map_or(true, |t| t.elapsed() >= STATE_RECHECK) {
            self.state_checked = Some(Instant::now());
            let d = downloads.start("state");
            self.state_task = Some(crate::rt::spawn(async move {
                let s = state::fetch(Some(&d)).await;
                d.finish();
                s.unwrap_or_else(|e| {
                    eprintln!("[screener] state: {e:#}");
                    None
                })
            }));
        }
        let Some(asof) = self.state.as_ref().map(|s| s.asof) else { return };
        if wanted.is_empty() {
            return;
        }
        if self.closes.is_none() {
            self.closes = closes::read_cache().map(Arc::new);
        }
        let due = self.closes_checked.map_or(true, |t| t.elapsed() >= STATE_RECHECK);
        if self.closes.as_ref().map(|c| c.asof) != Some(asof) && self.closes_task.is_none() && due {
            self.closes_checked = Some(Instant::now());
            let d = downloads.start("closes");
            self.closes_task = Some(crate::rt::spawn(async move {
                let c = closes::fetch(Some(&d)).await;
                d.finish();
                c.unwrap_or_else(|e| {
                    eprintln!("[screener] closes: {e:#}");
                    None
                })
            }));
        }
    }

    /// The next download to finish, or never when none is running.
    async fn next(&mut self) -> Arrived {
        tokio::select! {
            r = finished(&mut self.refs_task) => {
                self.refs_task = None;
                Arrived::Refs(r)
            }
            s = finished(&mut self.state_task) => {
                self.state_task = None;
                Arrived::State(s)
            }
            c = finished(&mut self.closes_task) => {
                self.closes_task = None;
                Arrived::Closes(c)
            }
        }
    }

    fn apply(&mut self, arrived: Arrived, today: Option<NaiveDate>) {
        match arrived {
            Arrived::Refs(Some(list)) => {
                write_refs_cache(today, &list);
                self.refs = Arc::new(list);
                self.refs_day = today;
            }
            Arrived::Refs(None) => self.refs_failed = Some(Instant::now()),
            Arrived::State(s) => {
                if let Some(s) = s {
                    self.state = Some(Arc::new(s));
                }
            }
            Arrived::Closes(c) => {
                if let Some(c) = c {
                    self.closes = Some(Arc::new(c));
                }
            }
        }
    }

    /// No download the table waits on: the reference list while none is held, the state and the closes while they
    /// load (a state a session old joins as missing values).
    fn complete(&self) -> bool {
        (!self.refs.is_empty() || self.refs_task.is_none()) && self.state_task.is_none() && self.closes_task.is_none()
    }

    /// The state the table joins: with the custom lengths' columns once the closes of its session are in.
    fn table_state(&mut self, wanted: &[String]) -> Option<Arc<StateFile>> {
        let s = self.state.as_ref()?;
        match &self.closes {
            Some(c) if !wanted.is_empty() && c.asof == s.asof => {
                let fresh = self.merged.as_ref().map_or(false, |(d, ids, _)| *d == s.asof && ids == wanted);
                if !fresh {
                    self.merged = Some((s.asof, wanted.to_vec(), Arc::new(closes::with_custom(s, c, wanted))));
                }
                self.merged.as_ref().map(|(_, _, m)| m.clone())
            }
            _ => Some(s.clone()),
        }
    }
}

async fn run(app: HostRef, inner: Arc<Inner>) {
    let mut version = inner.table.read().expect("screener table lock").as_ref().map_or(0, |t| t.version);
    let mut src = Sources::from_cache();
    let feed_url = feed_url();
    let mut feed: Option<live::Feed> = None;
    // The feed holds a table not shown yet (just connected).
    let mut feed_fresh = false;
    let mut feed_retry: Option<Instant> = None;
    // While there is no table: the REST snapshot, racing the feed's connection.
    let mut first_rest: Option<JoinHandle<anyhow::Result<Vec<MarketRow>>>> = None;
    let mut first_rest_download: Option<Arc<progress::Download>> = None;

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
        let wanted: Vec<String> = inner.custom.lock().expect("screener custom lock").iter().cloned().collect();
        src.start(today, &wanted, &inner.downloads);

        // No table yet: the REST snapshot starts now and races the feed's connection. Either can take from 1 s to
        // over 25 s when the gateway is slow (measured 03/11/2026); the first to arrive fills the panel.
        let no_table = inner.table.read().expect("screener table lock").is_none();
        if no_table && feed.is_none() && first_rest.is_none() && feed_url.is_some() {
            let d = inner.downloads.start("market");
            first_rest_download = Some(d.clone());
            first_rest = Some(crate::rt::spawn(async move {
                let rows = market_rest::fetch_market_snapshot_counted(Some(&d)).await;
                d.finish();
                rows
            }));
        }

        // Live feed: connect when there is none and its retry time has come.
        let mut rest_rows: Option<anyhow::Result<Vec<MarketRow>>> = None;
        if feed.is_none() && feed_retry.map_or(true, |t| Instant::now() >= t) {
            if let Some(url) = feed_url.as_deref() {
                let connected = match first_rest.as_mut() {
                    Some(task) => tokio::select! {
                        res = live::Feed::connect(url) => Some(res),
                        rows = task => {
                            rest_rows = Some(rows.unwrap_or_else(|e| Err(anyhow::anyhow!(e))));
                            None
                        }
                    },
                    None => Some(live::Feed::connect(url).await),
                };
                if rest_rows.is_some() {
                    first_rest = None;
                }
                match connected {
                    Some(Ok(f)) => {
                        eprintln!("[screener] live feed connected ({} tickers)", f.table.len());
                        feed = Some(f);
                        feed_fresh = true;
                        feed_retry = None;
                        if let Some(t) = first_rest.take() {
                            t.abort();
                        }
                        // The feed brought the market data: its REST copy is no longer waited for.
                        if let Some(d) = first_rest_download.take() {
                            d.finish();
                        }
                    }
                    Some(Err(e)) => {
                        eprintln!("[screener] {e:#}; polling the snapshot instead");
                        feed_retry = Some(Instant::now() + FEED_RETRY);
                    }
                    // The REST snapshot came first: the feed connects on the next turn.
                    None => {}
                }
            }
        }

        // The snapshot rows: from the feed's table after its next message,
        // else from a REST poll.
        let via_feed = feed.is_some();
        let rest_won = matches!(rest_rows, Some(Ok(_)));
        let snap: anyhow::Result<Vec<MarketRow>> = if let Some(rows) = rest_rows {
            rows
        } else if let Some(f) = feed.as_mut() {
            let mut lost = None;
            if !feed_fresh {
                tokio::select! {
                    res = f.next() => lost = res.err(),
                    _ = inner.closed.notified() => continue,
                    arrived = src.next() => src.apply(arrived, today),
                }
            }
            feed_fresh = false;
            match lost {
                None => market_rest::shape_feed_snapshots(f.table.snapshots()).await,
                Some(e) => Err(e),
            }
        } else if let Some(task) = first_rest.take() {
            // The feed failed: the snapshot asked for at the start is on its way.
            task.await.unwrap_or_else(|e| Err(anyhow::anyhow!(e)))
        } else {
            market_rest::fetch_market_snapshot().await
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
                let mut t = Table::build(version, rows, src.refs.clone(), src.table_state(&wanted));
                t.complete = src.complete();
                let t = Arc::new(t);
                let update = ScreenerUpdate {
                    version,
                    updated_ms: t.updated_ms,
                    total: t.rows.len() as u32,
                    state_asof: t.state_asof().map(|d| d.to_string()),
                    complete: t.complete,
                    error: None,
                };
                if t.complete {
                    inner.downloads.clear();
                }
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
                    complete: t.as_ref().map_or(false, |t| t.complete),
                    error: Some(format!("{e:#}")),
                }
            }
        };
        let _ = update.emit(&app);
        // With the feed, its next message is the wait; after a first table from REST, the feed connects at once.
        if via_feed || rest_won {
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL.saturating_sub(started.elapsed())) => {}
            _ = inner.closed.notified() => {}
            arrived = src.next() => src.apply(arrived, today),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct RefsCache {
    day: NaiveDate,
    tickers: Vec<RefTicker>,
}

/// The saved reference list. `screener_refs.json` (before 15/10/2026) held
/// the upstream type codes and field names; it is deleted on the first read.
fn refs_cache_path() -> PathBuf {
    crate::data::cache_root().join("screener_refs_v2.json")
}

/// The saved reference list and its day. An older day's list serves until today's arrives: names and types rarely
/// change, and without them the first table matches no type or exchange filter.
fn read_refs_cache() -> Option<(NaiveDate, Vec<RefTicker>)> {
    if let Some(dir) = refs_cache_path().parent() {
        let _ = std::fs::remove_file(dir.join("screener_refs.json"));
    }
    let c: RefsCache = serde_json::from_slice(&std::fs::read(refs_cache_path()).ok()?).ok()?;
    let tickers = c
        .tickers
        .into_iter()
        .map(|mut r| {
            r.currency = r.currency.to_uppercase();
            r
        })
        .collect();
    Some((c.day, tickers))
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
