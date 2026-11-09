/*
 * Alert engine: the rules the backend evaluates.
 *
 * A window hands over the rules whose condition needs nothing but the price:
 * the price against a fixed value or against a drawing whose levels the
 * window has already worked out (`EngineRule`). Indicator and anchored-VWAP
 * rules stay in the window (src/data/alert-engine.ts), which holds the
 * libraries that compute them.
 *
 * What this adds to the window's evaluation:
 *  - every quote the live task receives is evaluated, whichever windows are
 *    open; one window (the "leader") receives the fires and delivers them;
 *  - the minute bar that comes with a quote gives the latest trade and the
 *    high and low reached since the previous quote, so a level crossed and
 *    left again between two quotes still fires; a rule on regular hours
 *    reads the regular-session last, a rule on extended hours the latest
 *    trade (pre- and post-market included);
 *  - drawing levels are given per bar of the rule's interval and session
 *    (`EngineGrid`), not per calendar time, and the same bars give the
 *    once-per-bar buckets; a quote outside the rule's session is not read
 *    (its bars do not move then);
 *  - at start, the minute bars since the previous run are replayed and what
 *    would have fired is sent as offline fires (logged and posted to the
 *    rule's webhook, not announced).
 *
 * The evaluation itself (`Rule`, `RuleState`, `Engine`) is pure
 * (`opentrader_core::alerts::engine`); this file feeds it and emits its fires.
 */
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::Candle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

use opentrader_core::alerts::engine::{Engine, EngineGrid, EngineRule, Fire};
use opentrader_core::files;
use opentrader_core::sync::LockExt;

const FILE: &str = "alert-engine.json";
const SAVE_EVERY: Duration = Duration::from_secs(30);

// ── Tauri part ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct EngineFile {
    symbols: HashMap<String, f64>,
}

pub struct AlertEngine {
    engine: Mutex<Engine>,
    /// Label of the window that delivers the fires and runs the window part.
    leader: Mutex<Option<String>>,
    path: Option<PathBuf>,
    saved: Mutex<Instant>,
}

/// A rule fired. Every window receives it; the one named `window` delivers
/// it (log, sound, notification, webhook).
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AlertFired {
    pub window: String,
    pub rule_id: String,
    pub price: f64,
    /// UNIX seconds.
    pub time: f64,
    pub bar_time: Option<f64>,
    /// Found by the replay of the bars missed while the app was not running.
    pub offline: bool,
}

/// The window that runs the alerts changed (the previous one was closed).
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct AlertLeader {
    pub window: String,
}

/// What a window needs to compile its rules.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlertEngineInfo {
    /// Per symbol, the time (UNIX seconds) of the last quote evaluated by
    /// the previous run: the bars to cover start there.
    pub previous: HashMap<String, f64>,
}

fn now_sec() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// Create the engine with what the previous run saved. Call from `setup`.
pub fn init(app: &AppHandle) {
    let path = app.path().app_config_dir().ok().map(|d| d.join(FILE));
    // A missing or unreadable file: no previous run to replay from.
    let previous = path
        .as_deref()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice::<EngineFile>(&bytes).ok())
        .map(|f| f.symbols);
    app.manage(AlertEngine {
        engine: Mutex::new(Engine::with_previous(previous)),
        leader: Mutex::new(None),
        path,
        saved: Mutex::new(Instant::now()),
    });
}

fn write(path: &Path, file: &EngineFile) {
    if let Err(e) = files::save_json(path, file) {
        eprintln!("[alerts] write failed: {e}");
    }
}

impl AlertEngine {
    fn snapshot(&self) -> EngineFile {
        EngineFile { symbols: self.engine.locked().last.clone() }
    }

    /// Save now, on the calling thread (a window closing).
    fn save(&self) {
        *self.saved.locked() = Instant::now();
        if let Some(path) = &self.path {
            write(path, &self.snapshot());
        }
    }

    /// Save at most every `SAVE_EVERY`, the file written on a blocking thread:
    /// this is called from the live-data task, which only takes the snapshot.
    fn save_soon(&self) {
        {
            let mut saved = self.saved.locked();
            if saved.elapsed() < SAVE_EVERY {
                return;
            }
            *saved = Instant::now();
        }
        let Some(path) = self.path.clone() else { return };
        let file = self.snapshot();
        tauri::async_runtime::spawn_blocking(move || write(&path, &file));
    }

    fn emit(&self, app: &AppHandle, fires: Vec<Fire>, offline: bool) {
        if fires.is_empty() {
            return;
        }
        let Some(window) = self.leader.locked().clone() else { return };
        for f in fires {
            let _ = AlertFired { window: window.clone(), rule_id: f.rule_id, price: f.price, time: f.time, bar_time: f.bar_time, offline }.emit(app);
        }
    }
}

/// One quote from the live task: the regular-session last and the latest
/// minute bar (pre- and post-market included).
pub fn on_quote(app: &AppHandle, symbol: &str, last: f64, minute: Option<&Candle>) {
    let Some(state) = app.try_state::<AlertEngine>() else { return };
    // This runs inside the live-data task: a panic in the evaluation would end
    // it, and the quotes of every view with it. The quote is skipped instead
    // (the panic is printed by the hook); the engine lock recovers.
    let sampled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.engine.locked().sample(symbol, last, minute, now_sec())
    }));
    match sampled {
        Ok(fires) => state.emit(app, fires, false),
        Err(_) => eprintln!("[alerts] a {symbol} quote was not evaluated"),
    }
    state.save_soon();
}

/// A window was destroyed: save, and hand its role to another window.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AlertEngine>() else { return };
    state.save();
    let mut leader = state.leader.locked();
    if leader.as_deref() != Some(label) {
        return;
    }
    let mut others: Vec<String> = app.webview_windows().into_keys().filter(|l| l != label).collect();
    others.sort();
    *leader = others.into_iter().next();
    if let Some(window) = leader.clone() {
        let _ = AlertLeader { window }.emit(app);
    }
}

/// True when the calling window runs the alerts: the first one to ask, until
/// it is closed.
#[tauri::command]
#[specta::specta]
pub fn alert_engine_claim(app: AppHandle, window: tauri::Window, state: State<'_, AlertEngine>) -> bool {
    let mut leader = state.leader.locked();
    let gone = leader.as_ref().is_some_and(|l| app.get_webview_window(l).is_none());
    if leader.is_none() || gone {
        *leader = Some(window.label().to_string());
    }
    leader.as_deref() == Some(window.label())
}

#[tauri::command]
#[specta::specta]
pub fn alert_engine_info(state: State<'_, AlertEngine>) -> AlertEngineInfo {
    AlertEngineInfo { previous: state.engine.locked().previous.clone().unwrap_or_default() }
}

/// Replace the rules the backend evaluates (the leader window calls this on
/// every change). Rules seen for the first time get the bars missed since
/// the previous run replayed, in the background.
#[tauri::command]
#[specta::specta]
pub fn alert_engine_set(
    app: AppHandle,
    state: State<'_, AlertEngine>,
    provider: State<'_, Provider>,
    rules: Vec<EngineRule>,
    grids: Vec<EngineGrid>,
) {
    let jobs = state.engine.locked().set(rules, grids, now_sec());
    for job in jobs {
        let app = app.clone();
        let provider = provider.inner().clone();
        tauri::async_runtime::spawn(async move {
            let day = |t: f64| chrono::DateTime::from_timestamp(t as i64, 0).unwrap_or_default().date_naive();
            let (from, to) = (day(job.from - 86_400.0), day(now_sec() + 86_400.0));
            let bars = provider.minute_aggs(&SymbolRef::parse(&job.symbol), 1, from, to, true).await;
            if let Err(e) = &bars {
                eprintln!("[alerts] replay of {} failed: {e:#}", job.symbol);
            }
            let Some(state) = app.try_state::<AlertEngine>() else { return };
            let fires = state.engine.locked().finish_replay(&job, bars.as_deref().ok());
            state.emit(&app, fires, true);
        });
    }
}
