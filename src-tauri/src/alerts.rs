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
 *  - the minute bar that comes with a quote gives the high and low reached
 *    since the previous quote, so a level crossed and left again between two
 *    quotes still fires;
 *  - drawing levels are given per bar of the rule's interval (`EngineGrid`),
 *    not per calendar time, and the same bars give the once-per-bar buckets,
 *    so no session rule is needed here;
 *  - at start, the minute bars since the previous run are replayed and what
 *    would have fired is sent as offline fires (logged and posted to the
 *    rule's webhook, not announced).
 *
 * The evaluation itself (`Rule`, `RuleState`, `Engine`) is pure; the Tauri
 * part at the end feeds it and emits its fires.
 */
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::Candle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

const FILE: &str = "alert-engine.json";
/// Oldest time a replay goes back to.
const REPLAY_MAX: f64 = 30.0 * 86_400.0;
/// A gap shorter than this is not replayed: the next quote covers it.
const REPLAY_MIN_GAP: f64 = 120.0;
/// Most offline fires kept per rule (the latest ones).
const REPLAY_MAX_FIRES: usize = 50;
const SAVE_EVERY: Duration = Duration::from_secs(30);

/// One rule, compiled by the window.
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineRule {
    pub id: String,
    /// Full name, uppercased ("NASDAQ:AAPL").
    pub symbol: String,
    /// Changes whenever the condition or what it reads changes: the rule's
    /// evaluation memory is kept only while it stays the same.
    pub sig: String,
    /// crossing | crossing_up | crossing_down | greater | less | entering |
    /// exiting | inside | outside | hits_level
    pub op: String,
    /// What `values` hold: "level" [price], "band" [bound, bound], "position"
    /// [entry, stop, target], "time" [UNIX seconds].
    pub shape: String,
    /// only_once | once_per_bar | once_per_bar_close | every_time
    pub frequency: String,
    /// UNIX ms after which the rule no longer fires.
    pub expires_at: Option<f64>,
    /// UNIX ms the rule became active: a replay never starts before it.
    pub since: f64,
    /// Key of the bars of the rule's interval (`EngineGrid::key`).
    pub grid: String,
    /// Values that hold at any time.
    pub values: Vec<f64>,
    /// Values per bar of the grid (a sloped line, a drawing limited to its
    /// dates); an empty entry = no value on that bar. Replaces `values`.
    pub per_bar: Option<Vec<Vec<f64>>>,
    /// A band without value counts as "outside" (a rectangle outside its
    /// dates) instead of leaving the condition undecided.
    pub absent_is_outside: bool,
}

/// Bars of one symbol on one interval, ascending: (open, close) in UNIX
/// seconds, sessions included (the last bar of a session closes with it).
#[derive(Clone, Debug, Default, Deserialize, specta::Type)]
pub struct EngineGrid {
    pub key: String,
    pub bars: Vec<(f64, f64)>,
    /// Regular-session intervals (start, end) over the same dates: the
    /// quotes carry the regular-session price, so a replay reads only the
    /// bars inside them. Empty = every bar.
    pub regular: Vec<(f64, f64)>,
}

impl EngineGrid {
    /// Index of the bar containing `t`, else of the next one to open.
    fn bar_at(&self, t: f64) -> Option<usize> {
        let i = self.bars.partition_point(|b| b.1 <= t);
        (i < self.bars.len()).then_some(i)
    }
    fn in_regular(&self, t: f64) -> bool {
        self.regular.is_empty() || self.regular.iter().any(|iv| t >= iv.0 && t < iv.1)
    }
}

/// The price at one moment and the range it went through since the previous
/// sample (`lo` / `hi` include `price`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub price: f64,
    pub lo: f64,
    pub hi: f64,
    /// UNIX seconds.
    pub time: f64,
}

impl Sample {
    fn point(price: f64, time: f64) -> Self {
        Self { price, lo: price, hi: price, time }
    }
}

/// A rule's evaluation memory.
#[derive(Clone, Debug, Default)]
pub struct RuleState {
    /// Price minus level at the previous sample (crossings).
    prev_diff: Option<f64>,
    /// Inside the band at the previous sample (entering / exiting).
    prev_inside: Option<bool>,
    prev_price: Option<f64>,
    prev_time: Option<f64>,
    /// Bar of the last fire (once per bar, once per bar close).
    last_fired_bar: Option<f64>,
    /// Once per bar close: the forming bar and its latest sample.
    forming: Option<(f64, Sample)>,
    /// "Only once" has fired.
    done: bool,
    /// Its missed bars are being replayed: live quotes wait.
    replaying: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Fire {
    pub rule_id: String,
    pub price: f64,
    /// UNIX seconds of the sample that fired.
    pub time: f64,
    /// Open time of the bar it fired in, when the grid knows it.
    pub bar_time: Option<f64>,
}

impl EngineRule {
    fn values_at(&self, t: f64, grid: Option<&EngineGrid>) -> Option<&[f64]> {
        let v = match &self.per_bar {
            Some(per_bar) => per_bar.get(grid?.bar_at(t)?)?,
            None => &self.values,
        };
        (!v.is_empty()).then_some(v.as_slice())
    }

    /// The price the condition is met at for this sample, if it is. Updates
    /// the memory the next sample compares with.
    fn condition(&self, st: &mut RuleState, s: Sample, grid: Option<&EngineGrid>) -> Option<f64> {
        let vals = self.values_at(s.time, grid);
        match self.shape.as_str() {
            // Vertical line: the time reaches it.
            "time" => {
                let line = *vals?.first()?;
                let prev = st.prev_time.replace(s.time)?;
                (prev < line && s.time >= line).then_some(s.price)
            }
            // Position: a level lies on the way from the previous price.
            "position" => {
                let prev = st.prev_price.replace(s.price);
                let levels = vals?;
                let p0 = prev?;
                let (lo, hi) = (s.lo.min(p0), s.hi.max(p0));
                if lo == hi {
                    return None;
                }
                levels.iter().copied().find(|l| *l >= lo && *l <= hi && *l != p0)
            }
            "band" => {
                let band = vals.filter(|v| v.len() >= 2).map(|v| (v[0].min(v[1]), v[0].max(v[1])));
                match self.op.as_str() {
                    "greater" => {
                        let (_, upper) = band?;
                        (s.hi > upper).then_some(if s.price > upper { s.price } else { s.hi })
                    }
                    "less" => {
                        let (lower, _) = band?;
                        (s.lo < lower).then_some(if s.price < lower { s.price } else { s.lo })
                    }
                    op => {
                        if band.is_none() && !self.absent_is_outside {
                            return None;
                        }
                        let inside = band.is_some_and(|(l, u)| s.price >= l && s.price <= u);
                        let touched = band.is_some_and(|(l, u)| s.hi >= l && s.lo <= u);
                        let left = band.map_or(true, |(l, u)| s.hi > u || s.lo < l);
                        if op == "inside" {
                            return touched.then_some(s.price);
                        }
                        if op == "outside" {
                            return left.then_some(s.price);
                        }
                        let prev = st.prev_inside.replace(inside)?;
                        let met = match op {
                            "entering" => !prev && touched,
                            "exiting" => prev && left,
                            _ => false,
                        };
                        met.then_some(s.price)
                    }
                }
            }
            _ => {
                let level = *vals?.first()?;
                let above = || if s.price > level { s.price } else { s.hi };
                let below = || if s.price < level { s.price } else { s.lo };
                match self.op.as_str() {
                    "greater" => (s.hi > level).then(above),
                    "less" => (s.lo < level).then(below),
                    "crossing" | "crossing_up" | "crossing_down" => {
                        let prev = st.prev_diff.replace(s.price - level)?;
                        let up = prev <= 0.0 && s.hi > level;
                        let down = prev >= 0.0 && s.lo < level;
                        match self.op.as_str() {
                            "crossing_up" => up.then(above),
                            "crossing_down" => down.then(below),
                            _ if up => Some(above()),
                            _ if down => Some(below()),
                            _ => None,
                        }
                    }
                    _ => None,
                }
            }
        }
    }

    /// Evaluate one sample: the condition, then the trigger rule.
    fn step(&self, st: &mut RuleState, s: Sample, grid: Option<&EngineGrid>) -> Option<Fire> {
        if st.done || self.expires_at.is_some_and(|e| s.time * 1000.0 >= e) {
            return None;
        }
        let bar = grid.and_then(|g| g.bar_at(s.time).map(|i| g.bars[i].0));
        let fire = |price: f64, time: f64, bar_time: Option<f64>| Fire { rule_id: self.id.clone(), price, time, bar_time };
        match self.frequency.as_str() {
            // The bar that just closed is judged on its last sample, so a
            // crossing compares close with close.
            "once_per_bar_close" => {
                let bar = bar?;
                let (closed, last) = st.forming.replace((bar, s)).filter(|(b, _)| *b != bar)?;
                let price = self.condition(st, Sample::point(last.price, last.time), grid)?;
                if st.last_fired_bar == Some(closed) {
                    return None;
                }
                st.last_fired_bar = Some(closed);
                Some(fire(price, last.time, Some(closed)))
            }
            "once_per_bar" => {
                let price = self.condition(st, s, grid)?;
                let bar = bar?;
                if st.last_fired_bar == Some(bar) {
                    return None;
                }
                st.last_fired_bar = Some(bar);
                Some(fire(price, s.time, Some(bar)))
            }
            freq => {
                let price = self.condition(st, s, grid)?;
                st.done = freq == "only_once";
                Some(fire(price, s.time, bar))
            }
        }
    }
}

/// Run a rule over the minute bars after `from` (UNIX seconds): the state it
/// ends in and what fired (the latest `REPLAY_MAX_FIRES`). Each bar is read
/// as its open, then its close with the bar's range.
pub fn replay_rule(rule: &EngineRule, grid: Option<&EngineGrid>, bars: &[Candle], from: f64) -> (RuleState, Vec<Fire>) {
    let mut st = RuleState::default();
    let mut fires = Vec::new();
    for b in bars {
        if b.time <= from || !grid.map_or(true, |g| g.in_regular(b.time)) {
            continue;
        }
        let close = Sample { price: b.close, lo: b.low.min(b.close), hi: b.high.max(b.close), time: b.time };
        for s in [Sample::point(b.open, b.time), close] {
            fires.extend(rule.step(&mut st, s, grid));
        }
    }
    if fires.len() > REPLAY_MAX_FIRES {
        fires.drain(..fires.len() - REPLAY_MAX_FIRES);
    }
    (st, fires)
}

/// Bars to replay for the rules of one symbol.
pub struct ReplayJob {
    pub symbol: String,
    /// UNIX seconds: bars after it are replayed.
    pub from: f64,
    pub rules: Vec<(EngineRule, Option<EngineGrid>)>,
}

/// Minute bar last seen for a symbol: what is new in the next one.
struct SeenBar {
    time: f64,
    high: f64,
    low: f64,
}

#[derive(Default)]
pub struct Engine {
    rules: HashMap<String, (EngineRule, RuleState)>,
    grids: HashMap<String, EngineGrid>,
    seen: HashMap<String, SeenBar>,
    /// Time of each symbol's last sample, this run (saved for the next one).
    last: HashMap<String, f64>,
    /// The same map as the previous run left it; None on the very first run
    /// (nothing is replayed then).
    previous: Option<HashMap<String, f64>>,
}

impl Engine {
    /// Replace the rules. A rule whose `sig` is unchanged keeps its memory.
    /// Returns the replays to run for the rules seen for the first time.
    pub fn set(&mut self, rules: Vec<EngineRule>, grids: Vec<EngineGrid>, now: f64) -> Vec<ReplayJob> {
        self.grids = grids.into_iter().map(|g| (g.key.clone(), g)).collect();
        let mut old = std::mem::take(&mut self.rules);
        let mut jobs: HashMap<String, ReplayJob> = HashMap::new();
        for rule in rules {
            let kept = old.remove(&rule.id).filter(|(r, _)| r.sig == rule.sig).map(|(_, st)| st);
            let mut st = kept.clone().unwrap_or_default();
            if kept.is_none() {
                if let Some(from) = self.replay_from(&rule, now) {
                    st.replaying = true;
                    let job = jobs.entry(rule.symbol.clone()).or_insert_with(|| ReplayJob { symbol: rule.symbol.clone(), from, rules: Vec::new() });
                    job.from = job.from.min(from);
                    job.rules.push((rule.clone(), self.grids.get(&rule.grid).cloned()));
                }
            }
            self.rules.insert(rule.id.clone(), (rule, st));
        }
        jobs.into_values().collect()
    }

    /// Where a new rule's replay starts: the symbol's last sample of the
    /// previous run, not before the rule became active. None when there is
    /// nothing to replay.
    fn replay_from(&self, rule: &EngineRule, now: f64) -> Option<f64> {
        let previous = self.previous.as_ref()?;
        let since = rule.since / 1000.0;
        let from = previous.get(&rule.symbol).map_or(since, |t| t.max(since)).max(now - REPLAY_MAX);
        (now - from > REPLAY_MIN_GAP).then_some(from)
    }

    /// End a replay: each rule takes the state its bars left it in (None:
    /// the bars could not be read, the rules start from the next quote).
    pub fn finish_replay(&mut self, job: &ReplayJob, bars: Option<&[Candle]>) -> Vec<Fire> {
        let mut fires = Vec::new();
        for (rule, grid) in &job.rules {
            let Some((current, st)) = self.rules.get_mut(&rule.id) else { continue };
            if current.sig != rule.sig || !st.replaying {
                continue;
            }
            let from = job.from.max(rule.since / 1000.0);
            let (state, fired) = bars.map(|b| replay_rule(rule, grid.as_ref(), b, from)).unwrap_or_default();
            *st = state;
            fires.extend(fired);
        }
        fires
    }

    /// One quote of `symbol`: `price`, and the latest minute bar when it can
    /// be compared with that price (`bar`). Returns what fires.
    pub fn sample(&mut self, symbol: &str, price: f64, bar: Option<&Candle>, now: f64) -> Vec<Fire> {
        let (mut lo, mut hi) = (price, price);
        let mut time = now;
        match bar {
            Some(b) => {
                time = b.time.min(now);
                // What the bar adds since the previous quote: all of a new
                // bar, else a new high or low. Nothing on the first quote.
                if let Some(seen) = self.seen.get(symbol) {
                    if b.time > seen.time || b.high > seen.high {
                        hi = hi.max(b.high);
                    }
                    if b.time > seen.time || b.low < seen.low {
                        lo = lo.min(b.low);
                    }
                }
                self.seen.insert(symbol.to_string(), SeenBar { time: b.time, high: b.high, low: b.low });
            }
            None => {
                self.seen.remove(symbol);
            }
        }
        // The time never goes back (a quote without bar is stamped "now").
        let last = self.last.entry(symbol.to_string()).or_insert(time);
        time = time.max(*last);
        *last = time;
        let s = Sample { price, lo, hi, time };
        let grids = &self.grids;
        self.rules
            .values_mut()
            .filter(|(r, st)| r.symbol == symbol && !st.replaying)
            .filter_map(|(r, st)| r.step(st, s, grids.get(&r.grid)))
            .collect()
    }
}

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
    let previous = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<EngineFile>(&s).ok())
        .map(|f| f.symbols);
    app.manage(AlertEngine {
        engine: Mutex::new(Engine { previous, ..Engine::default() }),
        leader: Mutex::new(None),
        path,
        saved: Mutex::new(Instant::now()),
    });
}

impl AlertEngine {
    fn save(&self) {
        let Some(path) = &self.path else { return };
        let file = EngineFile { symbols: self.engine.lock().unwrap().last.clone() };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_string(&file) {
            Ok(json) => {
                if let Err(e) = std::fs::write(path, json) {
                    eprintln!("[alerts] write failed: {e}");
                }
            }
            Err(e) => eprintln!("[alerts] encode failed: {e}"),
        }
        *self.saved.lock().unwrap() = Instant::now();
    }

    fn emit(&self, app: &AppHandle, fires: Vec<Fire>, offline: bool) {
        if fires.is_empty() {
            return;
        }
        let Some(window) = self.leader.lock().unwrap().clone() else { return };
        for f in fires {
            let _ = AlertFired { window: window.clone(), rule_id: f.rule_id, price: f.price, time: f.time, bar_time: f.bar_time, offline }.emit(app);
        }
    }
}

/// One quote from the live task. `extended`: the latest trade is outside the
/// regular session, so the minute bar does not describe `price` (the
/// regular-session last).
pub fn on_quote(app: &AppHandle, symbol: &str, price: f64, extended: bool, minute: Option<&Candle>) {
    let Some(state) = app.try_state::<AlertEngine>() else { return };
    let bar = minute.filter(|b| !extended && b.low <= price && price <= b.high);
    let fires = state.engine.lock().unwrap().sample(symbol, price, bar, now_sec());
    state.emit(app, fires, false);
    if state.saved.lock().unwrap().elapsed() >= SAVE_EVERY {
        state.save();
    }
}

/// A window was destroyed: save, and hand its role to another window.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<AlertEngine>() else { return };
    state.save();
    let mut leader = state.leader.lock().unwrap();
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
    let mut leader = state.leader.lock().unwrap();
    let gone = leader.as_ref().is_some_and(|l| app.get_webview_window(l).is_none());
    if leader.is_none() || gone {
        *leader = Some(window.label().to_string());
    }
    leader.as_deref() == Some(window.label())
}

#[tauri::command]
#[specta::specta]
pub fn alert_engine_info(state: State<'_, AlertEngine>) -> AlertEngineInfo {
    AlertEngineInfo { previous: state.engine.lock().unwrap().previous.clone().unwrap_or_default() }
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
    let jobs = state.engine.lock().unwrap().set(rules, grids, now_sec());
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
            let fires = state.engine.lock().unwrap().finish_replay(&job, bars.as_deref().ok());
            state.emit(&app, fires, true);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(op: &str, shape: &str, frequency: &str, values: &[f64]) -> EngineRule {
        EngineRule {
            id: "r".into(),
            symbol: "X:A".into(),
            sig: "1".into(),
            op: op.into(),
            shape: shape.into(),
            frequency: frequency.into(),
            expires_at: None,
            since: 0.0,
            grid: "g".into(),
            values: values.to_vec(),
            per_bar: None,
            absent_is_outside: false,
        }
    }

    fn bar(time: f64, open: f64, high: f64, low: f64, close: f64) -> Candle {
        Candle { time, open, high, low, close, volume: 0.0 }
    }

    /// Five-minute bars from 0 to 1500 s.
    fn grid() -> EngineGrid {
        EngineGrid { key: "g".into(), bars: (0..5).map(|i| (i as f64 * 300.0, (i + 1) as f64 * 300.0)).collect(), regular: Vec::new() }
    }

    fn engine(rules: Vec<EngineRule>) -> Engine {
        let mut e = Engine::default();
        assert!(e.set(rules, vec![grid()], 0.0).is_empty());
        e
    }

    #[test]
    fn crossing_needs_a_previous_sample_and_fires_once() {
        let mut e = engine(vec![rule("crossing_up", "level", "every_time", &[100.0])]);
        assert!(e.sample("X:A", 99.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 101.0, None, 15.0).len(), 1);
        assert!(e.sample("X:A", 102.0, None, 20.0).is_empty());
        assert!(e.sample("X:B", 101.0, None, 20.0).is_empty());
    }

    #[test]
    fn a_spike_between_two_quotes_fires_from_the_bar_high() {
        let mut e = engine(vec![rule("crossing_up", "level", "every_time", &[100.0])]);
        assert!(e.sample("X:A", 99.0, Some(&bar(0.0, 99.0, 99.5, 98.5, 99.0)), 10.0).is_empty());
        // Same minute bar, new high above the level, price back under it.
        let fires = e.sample("X:A", 99.2, Some(&bar(0.0, 99.0, 100.4, 98.5, 99.2)), 15.0);
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].price, 100.4);
        // The same high is not read a second time.
        assert!(e.sample("X:A", 99.3, Some(&bar(0.0, 99.0, 100.4, 98.5, 99.3)), 20.0).is_empty());
        // A new bar counts whole.
        assert_eq!(e.sample("X:A", 99.4, Some(&bar(60.0, 99.3, 100.1, 99.3, 99.4)), 70.0).len(), 1);
    }

    #[test]
    fn the_first_bar_seen_gives_no_range() {
        let mut e = engine(vec![rule("greater", "level", "every_time", &[100.0])]);
        assert!(e.sample("X:A", 99.0, Some(&bar(0.0, 99.0, 101.0, 98.0, 99.0)), 10.0).is_empty());
    }

    #[test]
    fn once_per_bar_and_only_once() {
        let mut e = engine(vec![rule("greater", "level", "once_per_bar", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0)[0].bar_time, Some(0.0));
        assert!(e.sample("X:A", 102.0, None, 200.0).is_empty());
        assert_eq!(e.sample("X:A", 102.0, None, 310.0)[0].bar_time, Some(300.0));

        let mut e = engine(vec![rule("greater", "level", "only_once", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 102.0, None, 400.0).is_empty());
    }

    #[test]
    fn once_per_bar_close_compares_the_closes() {
        let mut e = engine(vec![rule("crossing_up", "level", "once_per_bar_close", &[100.0])]);
        assert!(e.sample("X:A", 99.0, None, 10.0).is_empty());
        // Above the level inside the bar, back under it at the close.
        assert!(e.sample("X:A", 101.0, None, 100.0).is_empty());
        assert!(e.sample("X:A", 99.5, None, 290.0).is_empty());
        // Bar 0 closed at 99.5 (first close: no fire). Bar 300 closes above.
        assert!(e.sample("X:A", 100.5, None, 310.0).is_empty());
        let fires = e.sample("X:A", 100.6, None, 610.0);
        assert_eq!(fires.len(), 1);
        assert_eq!((fires[0].price, fires[0].bar_time), (100.5, Some(300.0)));
    }

    #[test]
    fn band_conditions() {
        let mut e = engine(vec![rule("entering", "band", "every_time", &[110.0, 100.0])]);
        assert!(e.sample("X:A", 95.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 105.0, None, 15.0).len(), 1);
        assert!(e.sample("X:A", 106.0, None, 20.0).is_empty());

        let mut e = engine(vec![rule("exiting", "band", "every_time", &[100.0, 110.0])]);
        assert!(e.sample("X:A", 105.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 111.0, None, 15.0).len(), 1);

        // A rectangle outside its dates: the price is outside it.
        let mut r = rule("outside", "band", "every_time", &[]);
        r.absent_is_outside = true;
        assert_eq!(engine(vec![r]).sample("X:A", 105.0, None, 10.0).len(), 1);
        assert!(engine(vec![rule("outside", "band", "every_time", &[])]).sample("X:A", 105.0, None, 10.0).is_empty());
    }

    #[test]
    fn position_and_time() {
        let mut e = engine(vec![rule("hits_level", "position", "every_time", &[100.0, 95.0, 110.0])]);
        assert!(e.sample("X:A", 101.0, None, 10.0).is_empty());
        assert!(e.sample("X:A", 102.0, None, 15.0).is_empty());
        assert_eq!(e.sample("X:A", 99.0, None, 20.0)[0].price, 100.0);

        let mut e = engine(vec![rule("crossing", "time", "only_once", &[100.0])]);
        assert!(e.sample("X:A", 5.0, None, 90.0).is_empty());
        assert_eq!(e.sample("X:A", 5.0, None, 100.0).len(), 1);
    }

    #[test]
    fn per_bar_levels_follow_the_bars() {
        let mut r = rule("greater", "level", "every_time", &[]);
        r.per_bar = Some(vec![vec![100.0], vec![101.0], vec![], vec![103.0], vec![104.0]]);
        let mut e = engine(vec![r]);
        assert_eq!(e.sample("X:A", 100.5, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 100.5, None, 310.0).is_empty());
        // No value on the third bar, none after the last one.
        assert!(e.sample("X:A", 500.0, None, 610.0).is_empty());
        assert!(e.sample("X:A", 500.0, None, 1600.0).is_empty());
    }

    #[test]
    fn expiry_and_time_never_going_back() {
        let mut r = rule("greater", "level", "every_time", &[100.0]);
        r.expires_at = Some(50_000.0);
        let mut e = engine(vec![r]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 101.0, None, 60.0).is_empty());

        let mut e = engine(vec![rule("greater", "level", "once_per_bar", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 310.0).len(), 1);
        // A quote with an older bar stays in the bar already reached.
        assert!(e.sample("X:A", 101.0, Some(&bar(60.0, 101.0, 101.0, 101.0, 101.0)), 320.0).is_empty());
    }

    #[test]
    fn memory_is_kept_while_the_rule_is_unchanged() {
        let mut e = engine(vec![rule("crossing_up", "level", "every_time", &[100.0])]);
        e.sample("X:A", 99.0, None, 10.0);
        e.set(vec![rule("crossing_up", "level", "every_time", &[100.0])], vec![grid()], 12.0);
        assert_eq!(e.sample("X:A", 101.0, None, 15.0).len(), 1);
        // A changed rule starts again from its first sample.
        let mut changed = rule("crossing_down", "level", "every_time", &[100.0]);
        changed.sig = "2".into();
        e.set(vec![changed], vec![grid()], 16.0);
        assert!(e.sample("X:A", 99.0, None, 20.0).is_empty());
    }

    #[test]
    fn replay_of_the_missed_bars() {
        let bars = [bar(60.0, 99.0, 99.5, 98.0, 99.0), bar(120.0, 99.0, 100.5, 99.0, 99.4), bar(180.0, 99.4, 99.6, 99.0, 99.2)];
        let r = rule("crossing_up", "level", "every_time", &[100.0]);
        let (st, fires) = replay_rule(&r, Some(&grid()), &bars, 0.0);
        assert_eq!(fires.len(), 1);
        assert_eq!((fires[0].time, fires[0].price), (120.0, 100.5));
        assert_eq!(st.prev_diff, Some(99.2 - 100.0));
        // Bars at or before the start are not read; nor those outside the
        // regular session.
        assert!(replay_rule(&r, Some(&grid()), &bars, 120.0).1.is_empty());
        let closed = EngineGrid { regular: vec![(0.0, 100.0)], ..grid() };
        assert!(replay_rule(&r, Some(&closed), &bars, 0.0).1.is_empty());
    }

    #[test]
    fn replay_only_after_a_previous_run() {
        let now = 1_000_000.0;
        let mut e = Engine::default();
        assert!(e.set(vec![rule("greater", "level", "every_time", &[100.0])], vec![grid()], now).is_empty());

        let mut e = Engine { previous: Some(HashMap::from([("X:A".to_string(), now - 3600.0)])), ..Engine::default() };
        let jobs = e.set(vec![rule("greater", "level", "every_time", &[100.0])], vec![grid()], now);
        assert_eq!((jobs.len(), jobs[0].from), (1, now - 3600.0));
        // Quotes wait for the replay, which leaves the rule ready.
        assert!(e.sample("X:A", 101.0, None, now).is_empty());
        let fires = e.finish_replay(&jobs[0], Some(&[bar(now - 600.0, 101.0, 101.0, 101.0, 101.0)]));
        assert_eq!(fires.len(), 2);
        assert_eq!(e.sample("X:A", 101.0, None, now + 5.0).len(), 1);
        // The same rules again: nothing to replay.
        assert!(e.set(vec![rule("greater", "level", "every_time", &[100.0])], vec![grid()], now).is_empty());

        // A rule that became active a moment ago has missed nothing.
        let mut e = Engine { previous: Some(HashMap::from([("X:A".to_string(), now - 3600.0)])), ..Engine::default() };
        let mut fresh = rule("greater", "level", "every_time", &[100.0]);
        fresh.since = (now - 10.0) * 1000.0;
        assert!(e.set(vec![fresh], vec![grid()], now).is_empty());
    }
}
