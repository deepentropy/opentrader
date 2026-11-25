/*
 * Data plugins (#314): the symbols of an enabled data plugin, `<exchange>:<ticker>` with the exchange its manifest
 * names, are served by the plugin instead of the app's own data. The history, symbol and search commands ask `route`
 * first, so the window's datafeed stays as it is: the same commands, the same bars, the same live events.
 *
 * A plugin that serves several exchanges (`exchanges`, #331: one account's market segments) is asked with whole
 * symbols (`NSE:RELIANCE`) instead of bare tickers: the same ticker may trade on several of them.
 *
 * The plugin answers `data.symbolInfo` (description, sessions, tick size, the intervals it serves), `data.bars` and
 * `data.search`; it pushes `data.quote` for the symbols of `data.subscribe`, which become the `chart-aggregate` and
 * `trade-tick` events the gateway's live task sends. Bars are not kept on disk: the plugin's source owns its history.
 * A symbol's recent bars are kept in memory a while (`recent`): the chart, the Details panel, its quote, replay and
 * alerts ask the same history, and each ask costs the plugin's source requests (#347).
 *
 * A plugin may also send ready-made watchlists of its symbols (`data.watchlists`, #381): the index members, the
 * contracts of the month. They are kept here and offered in the Watchlists dialog under the plugin's name.
 * Its scripts too (`data.scripts`, #402): OakScript studies and strategies with their source, listed in the Indicators
 * dialog under the plugin's name and run like the user's own.
 */
use super::Plugins;
use crate::data::calendar::SessionCalendar;
use crate::data::session::{Subsession, SymbolSession};
use crate::data::types::{Candle, ChartAggregate, Snapshot, SymbolSearchResult, TickerInfo, TradeTick};
use opentrader_core::host::HostRef;
use opentrader_core::plugins::hub::{HubEvent, PluginError};
use opentrader_core::sync::LockExt;
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

const BARS_TIMEOUT: Duration = Duration::from_secs(60);
const INFO_TIMEOUT: Duration = Duration::from_secs(15);
/// Bars asked at most in one request.
const MAX_BARS: u64 = 50_000;
/// The error code of a plugin that doesn't know a symbol (an expired contract, a renamed ticker).
const UNKNOWN_SYMBOL: i64 = -32004;
/// The error code of a plugin whose source is busy (rate limited): the window asks again later, waiting longer each time.
const BUSY: i64 = -32005;
/// A kept series answers without asking the plugin for this long; then only its newest bars are asked again.
const RECENT_FRESH: Duration = Duration::from_secs(10);
/// Series kept at most (the one read longest ago goes first).
const RECENT_KEPT: usize = 32;
/// How long a scroll-back page is kept, and how many at most.
const PAGE_KEPT_FOR: Duration = Duration::from_secs(600);
const PAGES_KEPT: usize = 64;

/// What the plugin says of a symbol (`data.symbolInfo`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    #[serde(default)]
    pub description: String,
    /// `syminfo.type`: forex, crypto, stock, index, futures, cfd, fund, bond…
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub currency: Option<String>,
    pub timezone: String,
    /// Regular session, in the datafeed session grammar ("24x7", "0930-1600", "1700-1700:23456").
    pub session: String,
    /// The whole traded day when it is wider than `session`.
    #[serde(default)]
    pub extended: Option<String>,
    #[serde(default)]
    pub holidays: String,
    pub pricescale: u32,
    #[serde(default = "one")]
    pub minmov: u32,
    /// The resolutions served: "1", "5", "60" (minutes), "1D", "1W", "1M", "15S" (seconds).
    #[serde(default)]
    pub intervals: Vec<String>,
    /// "HHMM" in `timezone` where intraday bars of every size start their clock grid, when they ignore the session
    /// opens (a broker terminal: 5-minute bars at 01:00 when trading opens at 01:01).
    #[serde(default)]
    pub bar_origin: Option<String>,
    /// Money one unit makes per price point: a future counted in contracts gives its multiplier.
    #[serde(default)]
    pub point_value: Option<f64>,
    /// How far back, in calendar days, the source serves each family of bars: the app asks nothing older.
    #[serde(default)]
    pub history: HistoryDepth,
    /// The symbol's extra series (#383): `<SYMBOL>_<NAME>` symbols served by the plugin, as the open interest of a
    /// future is `<SYMBOL>_OI`. Their own info is this one's.
    #[serde(default)]
    pub series: Vec<SeriesDecl>,
    /// Values of the instrument shown with it (#383): circuit limits, price bands. `[{"name":…, "value":…}]`.
    #[serde(default)]
    pub fields: Vec<Value>,
    /// The plugin's ticker the symbol trades as: a continuous future's contract. None: its own.
    #[serde(default)]
    pub trade_ticker: Option<String>,
}

/// An extra series of a symbol (`series` of `data.symbolInfo`): its name alone (`"OI"`), or with what differs from
/// the symbol's own info.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum SeriesDecl {
    Name(String),
    Full {
        name: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        intervals: Option<Vec<String>>,
        #[serde(default)]
        pricescale: Option<u32>,
    },
}

impl SeriesDecl {
    fn name(&self) -> &str {
        match self {
            SeriesDecl::Name(n) | SeriesDecl::Full { name: n, .. } => n.trim(),
        }
    }
}

/// The description of a series named alone: open interest is the one the reference names.
fn series_description(name: &str) -> String {
    if name.eq_ignore_ascii_case("OI") { "Open Interest".into() } else { name.to_string() }
}

/// The base symbol and the series name of `<SYMBOL>_<NAME>` (a name of letters and digits).
fn split_series(r: &Route) -> Option<(Route, String)> {
    let (base_ticker, name) = r.ticker.rsplit_once('_')?;
    let (base_symbol, _) = r.symbol.rsplit_once('_')?;
    let ok = !base_ticker.is_empty() && !base_ticker.ends_with(':') && (1..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| (Route { plugin: r.plugin.clone(), symbol: base_symbol.to_string(), ticker: base_ticker.to_string() }, name.to_string()))
}

/// The info of `base`'s series `name` when `base` lists it: the same sessions, time zone, currency and tick (the
/// reference's open interest symbols keep their future's), the series' own description, intervals and scale.
fn series_info(base: &Info, base_ticker: &str, name: &str) -> Option<Info> {
    let decl = base.series.iter().find(|s| s.name().eq_ignore_ascii_case(name))?;
    let bare = base_ticker.rsplit_once(':').map_or(base_ticker, |(_, t)| t);
    let (description, intervals, pricescale) = match decl {
        SeriesDecl::Name(n) => (series_description(n.trim()), None, None),
        SeriesDecl::Full { name, description, intervals, pricescale } => (
            description.clone().filter(|d| !d.trim().is_empty()).unwrap_or_else(|| series_description(name.trim())),
            intervals.clone().filter(|i| !i.is_empty()),
            pricescale.filter(|p| *p > 0),
        ),
    };
    Some(Info {
        description: format!("{bare} {description}"),
        intervals: intervals.unwrap_or_else(|| base.intervals.iter().filter(|i| !i.eq_ignore_ascii_case("1T")).cloned().collect()),
        pricescale: pricescale.unwrap_or(base.pricescale),
        minmov: if pricescale.is_some() { 1 } else { base.minmov },
        point_value: None,
        series: Vec::new(),
        fields: Vec::new(),
        ..base.clone()
    })
}

/// Calendar days of history per family of bars (`history` of `data.symbolInfo`); none = as far as the asks go.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct HistoryDepth {
    #[serde(default)]
    pub second: Option<f64>,
    #[serde(default)]
    pub minute: Option<f64>,
    #[serde(default)]
    pub day: Option<f64>,
}

impl HistoryDepth {
    /// The depth of a unit's bars (weeks and months are built from days).
    fn of(&self, unit: &str) -> Option<f64> {
        match unit {
            "second" => self.second,
            "minute" => self.minute,
            _ => self.day,
        }
        .filter(|d| d.is_finite() && *d > 0.0)
    }
}

fn one() -> u32 {
    1
}

#[derive(Default)]
struct Subscriptions {
    charts: HashMap<String, String>,
    watchlists: HashMap<String, Vec<String>>,
}

/// A symbol's series of one bar size: the symbol, the unit and the multiplier.
type RecentKey = (String, String, u32);
/// A scroll-back page: the series' key, the time it ends before and its trading days.
type PageKey = (String, String, u32, i64, u32);

/// The last `days` trading days of a symbol's bars, as read at `at` (and completed since by newer bars).
struct Recent {
    days: u32,
    at: Instant,
    bars: Arc<Vec<Candle>>,
}

#[derive(Default)]
pub struct PluginData {
    /// Exchange → the enabled data plugin that serves it.
    exchanges: Mutex<HashMap<String, String>>,
    /// The plugins asked with whole symbols (they serve several exchanges).
    whole: Mutex<HashSet<String>>,
    /// The exchanges of installed data plugins that serve no data now (off, or their chart data switched off).
    idle: Mutex<HashSet<String>>,
    infos: Mutex<HashMap<String, Arc<Info>>>,
    /// The symbols a plugin said it doesn't know (`UNKNOWN_SYMBOL`): not asked again, nor streamed, until it connects
    /// again. A watchlist of expired contracts would otherwise ask for each of them at every look.
    unknown: Mutex<HashSet<String>>,
    subs: Mutex<Subscriptions>,
    /// The tickers each plugin was last asked to stream.
    streaming: Mutex<HashMap<String, BTreeSet<String>>>,
    recent: Mutex<HashMap<RecentKey, Recent>>,
    /// One read of a series at a time: the asks that come meanwhile wait for it and are answered from it.
    reading: Mutex<HashMap<RecentKey, Arc<tokio::sync::Mutex<()>>>>,
    pages: Mutex<HashMap<PageKey, (Instant, Arc<Vec<Candle>>)>>,
    /// Each symbol's last quote time (UNIX seconds, the feed's clock).
    quoted: Mutex<HashMap<String, f64>>,
    /// Chart pane → the plugin symbol it shows on a tick interval (#376).
    tick_charts: Mutex<HashMap<String, String>>,
    /// The tickers each plugin was last asked to stream ticks of.
    tick_streaming: Mutex<HashMap<String, BTreeSet<String>>>,
    /// Each data plugin's watchlists, as it last sent them (kept while it reconnects).
    watchlists: Mutex<BTreeMap<String, Vec<PluginWatchlist>>>,
    /// Each data plugin's scripts, as it last sent them (kept while it reconnects).
    scripts: Mutex<BTreeMap<String, Vec<PluginScript>>>,
}

/// A plugin symbol: the plugin, the full symbol and its ticker.
#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    pub plugin: String,
    pub symbol: String,
    pub ticker: String,
}

fn state(app: &AppHandle) -> &PluginData {
    &app.state::<Plugins>().inner().data
}

/// The data plugin serving `symbol`, if any.
pub fn route(app: &AppHandle, symbol: &str) -> Option<Route> {
    let s = state(app);
    route_in(&s.exchanges.locked(), &s.whole.locked(), symbol)
}

fn route_in(exchanges: &HashMap<String, String>, whole: &HashSet<String>, symbol: &str) -> Option<Route> {
    let (exchange, ticker) = symbol.trim().split_once(':')?;
    let exchange = exchange.to_ascii_uppercase();
    let plugin = exchanges.get(&exchange).cloned()?;
    let symbol = format!("{exchange}:{ticker}");
    let ticker = if whole.contains(&plugin) { symbol.clone() } else { ticker.to_string() };
    Some(Route { plugin, symbol, ticker })
}

/// The symbol of a ticker a plugin names (a quote, a search row): its exchange's for a one-exchange plugin, the
/// whole symbol it gives for one of several exchanges (when that exchange is the plugin's).
fn symbol_of(exchanges: &HashMap<String, String>, whole: &HashSet<String>, plugin: &str, ticker: &str) -> Option<String> {
    if whole.contains(plugin) {
        let (exchange, t) = ticker.split_once(':')?;
        let exchange = exchange.to_ascii_uppercase();
        return (exchanges.get(&exchange).map(String::as_str) == Some(plugin) && !t.is_empty()).then(|| format!("{exchange}:{t}"));
    }
    exchanges.iter().find(|(_, p)| *p == plugin).map(|(e, _)| format!("{e}:{ticker}"))
}

/// A symbol of an installed data plugin that serves no data now: unknown, not asked of the app's own source, which
/// can't know it (a broker's `MT5:AMZN.US-24` was asked of the gateway in a loop). The window asks again when the
/// plugins change.
pub fn refuse_idle(app: &AppHandle, symbol: &str) -> Result<(), String> {
    match idle_in(&state(app).idle.locked(), symbol) {
        true => Err(unknown_symbol(&symbol.trim().to_ascii_uppercase())),
        false => Ok(()),
    }
}

fn idle_in(idle: &HashSet<String>, symbol: &str) -> bool {
    symbol.trim().split_once(':').is_some_and(|(exchange, _)| idle.contains(&exchange.to_ascii_uppercase()))
}

/// The enabled data plugins' exchanges (from `plugins::apply`), those of them asked with whole symbols, and the
/// exchanges of the installed data plugins that serve none now.
pub fn set_exchanges(app: &AppHandle, map: HashMap<String, String>, whole: HashSet<String>, idle: HashSet<String>) {
    let s = state(app);
    *s.idle.locked() = idle.into_iter().filter(|e| !map.contains_key(e)).collect();
    *s.exchanges.locked() = map;
    *s.whole.locked() = whole;
    s.infos.locked().clear();
    s.unknown.locked().clear();
    s.recent.locked().clear();
    s.pages.locked().clear();
    // The lists of a plugin that no longer serves data go with it.
    let serving: HashSet<String> = s.exchanges.locked().values().cloned().collect();
    let gone = {
        let mut lists = s.watchlists.locked();
        let before = lists.len();
        lists.retain(|p, _| serving.contains(p));
        lists.len() != before
    };
    if gone {
        let _ = PluginWatchlistsChanged.emit(app);
    }
    let gone = {
        let mut scripts = s.scripts.locked();
        let before = scripts.len();
        scripts.retain(|p, _| serving.contains(p));
        scripts.len() != before
    };
    if gone {
        let _ = PluginScriptsChanged.emit(app);
    }
}

/// Settings > Service > "Clear cache": the plugins' series kept in memory.
pub fn clear_recent(app: &AppHandle) {
    state(app).recent.locked().clear();
    state(app).pages.locked().clear();
    super::events::clear(app);
}

/// The exchanges a data plugin serves.
pub fn exchanges_of(app: &AppHandle, plugin: &str) -> Vec<String> {
    let mut out: Vec<String> = state(app).exchanges.locked().iter().filter(|(_, p)| *p == plugin).map(|(e, _)| e.clone()).collect();
    out.sort();
    out
}

/// The symbol of a ticker a plugin names in a message.
pub fn symbol_of_plugin(app: &AppHandle, plugin: &str, ticker: &str) -> Option<String> {
    let s = state(app);
    symbol_of(&s.exchanges.locked(), &s.whole.locked(), plugin, ticker)
}

pub fn init(app: &AppHandle) {
    let mut events = app.state::<Plugins>().hub.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(HubEvent::Disconnected { plugin }) => {
                    forget(&app, &plugin);
                    super::events::forget(&app, &plugin, None);
                    state(&app).streaming.locked().remove(&plugin);
                    state(&app).tick_streaming.locked().remove(&plugin);
                }
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.quote" => on_quote(&app, &plugin, params),
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.tick" => on_ticks(&app, &plugin, params),
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.watchlists" => on_watchlists(&app, &plugin, params),
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.scripts" => on_scripts(&app, &plugin, params),
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.eventsChanged" => super::events::on_changed(&app, &plugin, params),
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.symbolInfoChanged" => on_info_changed(&app, &plugin, params),
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
    });
}

/// A plugin connected (`plugins::init`, after its settings went out): it streams what is subscribed.
pub fn connected(app: &AppHandle, plugin: &str) {
    forget(app, plugin);
    super::events::forget(app, plugin, None);
    state(app).streaming.locked().remove(plugin);
    state(app).tick_streaming.locked().remove(plugin);
    push_subscriptions(app);
    push_tick_subscriptions(app);
}

/// Drop the plugin's cached symbol infos (it connected again, maybe as a new version).
fn forget(app: &AppHandle, plugin: &str) {
    let s = state(app);
    let exchanges: Vec<String> = s.exchanges.locked().iter().filter(|(_, p)| *p == plugin).map(|(e, _)| format!("{e}:")).collect();
    s.infos.locked().retain(|sym, _| !exchanges.iter().any(|e| sym.starts_with(e)));
    s.unknown.locked().retain(|sym| !exchanges.iter().any(|e| sym.starts_with(e)));
    s.recent.locked().retain(|(sym, _, _), _| !exchanges.iter().any(|e| sym.starts_with(e)));
    s.pages.locked().retain(|(sym, ..), _| !exchanges.iter().any(|e| sym.starts_with(e)));
    super::fields::forget(app, &exchanges);
}

/// A plugin reloaded its reference data (`data.symbolInfoChanged`, #400): `{"tickers":[…]}` names the symbols whose
/// info changed; without it, all of them did. Their infos and "unknown symbol" answers are dropped, then the windows
/// forget theirs and ask again.
fn on_info_changed(app: &AppHandle, plugin: &str, params: Value) {
    let exchanges = exchanges_of(app, plugin);
    if exchanges.is_empty() {
        return;
    }
    let mut symbols: Option<Vec<String>> = params
        .get("tickers")
        .and_then(Value::as_array)
        .map(|t| t.iter().filter_map(Value::as_str).filter_map(|t| symbol_of_plugin(app, plugin, t)).collect());
    let prefixes: Vec<String> = exchanges.iter().map(|e| format!("{e}:")).collect();
    let s = state(app);
    s.infos.locked().retain(|sym, _| {
        let changed = info_changed(sym, &prefixes, symbols.as_deref());
        // The windows forget the extra series of a symbol named too.
        if let Some(list) = symbols.as_mut().filter(|l| changed && !l.contains(sym)) {
            list.push(sym.clone());
        }
        !changed
    });
    s.unknown.locked().retain(|sym| !info_changed(sym, &prefixes, symbols.as_deref()));
    // A symbol unknown until now is streamed again.
    push_subscriptions(app);
    let _ = PluginSymbolInfoChanged { exchanges, symbols }.emit(app);
}

/// Whether `symbol`'s info changed: it is one of `symbols` or an extra series of one (`NFO:NIFTY26NOVFUT_OI`), or,
/// without a list, it is of the plugin's exchanges (`prefixes`, `"NSE:"`).
fn info_changed(symbol: &str, prefixes: &[String], symbols: Option<&[String]>) -> bool {
    match symbols {
        Some(list) => list.iter().any(|s| symbol == s || symbol.strip_prefix(s.as_str()).is_some_and(|rest| rest.starts_with('_'))),
        None => prefixes.iter().any(|p| symbol.starts_with(p)),
    }
}

/// A plugin changed the info of some of its symbols (`symbols`), or of all those of its `exchanges` (`symbols` null):
/// the windows forget what they kept of them and ask again.
#[derive(Clone, serde::Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct PluginSymbolInfoChanged {
    pub exchanges: Vec<String>,
    pub symbols: Option<Vec<String>>,
}

/// The error of a symbol its plugin doesn't know: final, like the gateway's (the window doesn't retry it).
fn unknown_symbol(symbol: &str) -> String {
    format!("{symbol}: unknown symbol (NOT_FOUND)")
}

/// A plugin's error as the window reads it: a busy source, or a plugin not connected yet (its program still starting
/// with the app, #371), is a failure of the moment, asked again (data/connection.ts).
pub(super) fn error_text(e: PluginError) -> String {
    match e {
        PluginError::Rpc { code: BUSY, message } => format!("{message} (RATE_LIMITED)"),
        e @ PluginError::NotConnected(_) => format!("{e} (PLUGIN_OFFLINE)"),
        e => e.to_string(),
    }
}

async fn ask(app: &AppHandle, r: &Route, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let hub = app.state::<Plugins>().hub.clone();
    hub.request(&r.plugin, method, params, timeout).await.map_err(error_text)
}

pub async fn info(app: &AppHandle, r: &Route) -> Result<Arc<Info>, String> {
    if let Some(i) = state(app).infos.locked().get(&r.symbol) {
        return Ok(i.clone());
    }
    if state(app).unknown.locked().contains(&r.symbol) {
        return Err(unknown_symbol(&r.symbol));
    }
    // An extra series its symbol lists (`NFO:NIFTY26NOVFUT_OI`): its info is the symbol's, the plugin serves its bars.
    if let Some((base, name)) = split_series(r) {
        if let Ok(b) = Box::pin(info(app, &base)).await {
            if let Some(i) = series_info(&b, &base.ticker, &name) {
                let i = Arc::new(i);
                state(app).infos.locked().insert(r.symbol.clone(), i.clone());
                return Ok(i);
            }
        }
    }
    let hub = app.state::<Plugins>().hub.clone();
    let v = match hub.request(&r.plugin, "data.symbolInfo", json!({ "ticker": r.ticker }), INFO_TIMEOUT).await {
        Ok(v) => v,
        Err(PluginError::Rpc { code: UNKNOWN_SYMBOL, .. }) => {
            state(app).unknown.locked().insert(r.symbol.clone());
            // Streamed no more.
            push_subscriptions(app);
            return Err(unknown_symbol(&r.symbol));
        }
        Err(e) => return Err(error_text(e)),
    };
    let info: Info = serde_json::from_value(v).map_err(|e| format!("{}: bad symbol info ({e})", r.symbol))?;
    if info.pricescale == 0 {
        return Err(format!("{}: bad symbol info (pricescale 0)", r.symbol));
    }
    if info.bar_origin.as_deref().is_some_and(|o| origin_minutes(o).is_none()) {
        return Err(format!("{}: bad symbol info (barOrigin is not HHMM)", r.symbol));
    }
    let info = Arc::new(info);
    state(app).infos.locked().insert(r.symbol.clone(), info.clone());
    Ok(info)
}

pub async fn session(app: &AppHandle, r: &Route) -> Result<SymbolSession, String> {
    Ok(symbol_session(&*info(app, r).await?))
}

fn symbol_session(i: &Info) -> SymbolSession {
    let mut subsessions = vec![Subsession::new("regular", "Regular Trading Hours", &i.session)];
    if let Some(ext) = i.extended.as_ref().filter(|e| **e != i.session) {
        subsessions.push(Subsession::new("extended", "Extended Trading Hours", ext));
    }
    SymbolSession {
        timezone: i.timezone.clone(),
        session: i.session.clone(),
        subsessions,
        holidays: i.holidays.clone(),
        corrections: String::new(),
        pricescale: i.pricescale,
        minmov: i.minmov.max(1),
        variable_tick_size: String::new(),
        intervals: i.intervals.clone(),
        bar_origin: i.bar_origin.as_deref().and_then(origin_minutes),
        point_value: i.point_value.filter(|v| v.is_finite() && *v > 0.0),
    }
}

/// The trading calendar of a plugin symbol: its days, holidays and hours size the windows asked of the plugin.
async fn calendar(app: &AppHandle, r: &Route) -> Result<SessionCalendar, String> {
    Ok(SessionCalendar::new(&symbol_session(&*info(app, r).await?)))
}

/// Minutes after midnight of an "HHMM" time of day.
fn origin_minutes(hhmm: &str) -> Option<u32> {
    if hhmm.len() != 4 || !hhmm.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m) = (hhmm[..2].parse::<u32>().ok()?, hhmm[2..].parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

pub async fn ticker_info(app: &AppHandle, r: &Route) -> Result<TickerInfo, String> {
    let i = info(app, r).await?;
    let exchange = r.symbol.split(':').next().unwrap_or_default().to_string();
    Ok(TickerInfo {
        ticker: r.ticker.clone(),
        name: Some(i.description.clone()).filter(|d| !d.is_empty()),
        exchange: Some(exchange),
        industry: None,
        sector: None,
        currency: i.currency.clone(),
        description: None,
        homepage_url: None,
        total_employees: None,
        market_cap: None,
        figi: None,
        symbol_type: Some(i.kind.clone()).filter(|k| !k.is_empty()),
        security_type: Some(i.kind.clone()).filter(|k| !k.is_empty()),
        icon_url: None,
    })
}

/// A resolution the plugin serves, and the bucket it is rebuilt to (seconds, 0 = as served).
fn pick(intervals: &[String], unit: &str, mult: u32) -> Option<(String, u64)> {
    let served = |n: u32| {
        let name = match unit {
            "second" => format!("{n}S"),
            "minute" => n.to_string(),
            _ => "1D".to_string(),
        };
        intervals.iter().any(|i| i.eq_ignore_ascii_case(&name)).then_some(name)
    };
    if unit == "day" {
        return served(1).map(|n| (n, 0));
    }
    if let Some(n) = served(mult) {
        return Some((n, 0));
    }
    // The largest served size that divides it, rebuilt on the clock grid.
    let step = if unit == "second" { 1 } else { 60 };
    (1..mult).rev().filter(|d| mult % d == 0).find_map(|d| served(d)).map(|n| (n, mult as u64 * step))
}

fn parse_bars(v: &Value) -> Result<Vec<Candle>, String> {
    let rows = v.get("bars").and_then(Value::as_array).ok_or("The plugin answered no bars")?;
    let mut bars: Vec<Candle> = rows
        .iter()
        .filter_map(|r| {
            let a = r.as_array()?;
            let n = |i: usize| a.get(i).and_then(Value::as_f64);
            let c = Candle { time: n(0)?, open: n(1)?, high: n(2)?, low: n(3)?, close: n(4)?, volume: n(5).unwrap_or(0.0) };
            [c.time, c.open, c.high, c.low, c.close].iter().all(|x| x.is_finite()).then_some(c)
        })
        .collect();
    bars.sort_by(|a, b| a.time.total_cmp(&b.time));
    bars.dedup_by(|b, a| a.time == b.time);
    Ok(bars)
}

/// Bars of `bucket` seconds from smaller ones (clock grid).
fn rebuild(bars: Vec<Candle>, bucket: u64) -> Vec<Candle> {
    let mut out: Vec<Candle> = Vec::new();
    for b in bars {
        let t = (b.time as u64 / bucket * bucket) as f64;
        match out.last_mut() {
            Some(last) if last.time == t => {
                last.high = last.high.max(b.high);
                last.low = last.low.min(b.low);
                last.close = b.close;
                last.volume += b.volume;
            }
            _ => out.push(Candle { time: t, ..b }),
        }
    }
    out
}

/// Bars of `unit` ("second", "minute", "day") × `mult` in [`from`, `to`] (UNIX seconds), at most `count` of them,
/// the newest ones.
pub async fn bars(app: &AppHandle, r: &Route, unit: &str, mult: u32, from: f64, to: f64, count: u64) -> Result<Vec<Candle>, String> {
    let i = info(app, r).await?;
    let Some((resolution, bucket)) = pick(&i.intervals, unit, mult.max(1)) else {
        return Ok(Vec::new());
    };
    let ask_count = if bucket > 0 { count.saturating_mul(bucket / base_seconds(&resolution).max(1)) } else { count };
    // Older than the source's history: nothing to ask (a scroll-back past it ends there).
    let Some((from, ask_count)) = reachable(i.history.of(unit), from, to, ask_count, base_seconds(&resolution), now()) else {
        return Ok(Vec::new());
    };
    let params = json!({
        "ticker": r.ticker, "resolution": resolution,
        "from": from.max(0.0).floor(), "to": to.floor(), "countBack": ask_count.clamp(1, MAX_BARS),
    });
    let v = ask(app, r, "data.bars", params, BARS_TIMEOUT).await?;
    let mut bars = parse_bars(&v)?;
    bars.retain(|b| b.time >= from && b.time <= to);
    Ok(if bucket > 0 { rebuild(bars, bucket) } else { bars })
}

/// The part of [`from`, `to`] a source `depth` calendar days deep reaches, and at most as many bars of `bar_secs` as
/// fit in it; None when it reaches none of it.
fn reachable(depth: Option<f64>, from: f64, to: f64, count: u64, bar_secs: u64, now: f64) -> Option<(f64, u64)> {
    let from = depth.map_or(from, |d| from.max(now - d * 86_400.0));
    if to < from {
        return None;
    }
    let fit = ((to - from) / bar_secs.max(1) as f64).floor() as u64 + 1;
    Some((from, count.min(fit)))
}

fn base_seconds(resolution: &str) -> u64 {
    let r = resolution.to_ascii_uppercase();
    if let Some(s) = r.strip_suffix('S') {
        s.parse().unwrap_or(1)
    } else if r.ends_with('D') || r.ends_with('W') || r.ends_with('M') {
        86_400
    } else {
        r.parse::<u64>().unwrap_or(1) * 60
    }
}

fn now() -> f64 {
    chrono::Utc::now().timestamp() as f64
}

/// Bars of `unit` × `mult` in one trading day at most: its traded hours, and one more for a bar its open or close cuts
/// (bars on a clock grid of their own).
fn per_day(cal: &SessionCalendar, unit: &str, mult: u32) -> u64 {
    if unit == "day" {
        return 1;
    }
    let bar = bar_seconds(unit, mult);
    (cal.day_minutes() as u64 * 60).div_ceil(bar).saturating_add(1).min(86_400u64.div_ceil(bar))
}

/// From the start of trading day `first` to the end of `last`: its start (UNIX seconds) and the bars it holds at most.
fn window(cal: &SessionCalendar, unit: &str, mult: u32, first: NaiveDate, last: NaiveDate) -> (f64, u64) {
    let days = cal.trading_days_in_range(first, last).len().max(1) as u64;
    (cal.day_start(first) as f64, per_day(cal, unit, mult) * days)
}

/// Seconds of one bar of `unit` × `mult`.
fn bar_seconds(unit: &str, mult: u32) -> u64 {
    match unit {
        "second" => mult.max(1) as u64,
        "minute" => mult.max(1) as u64 * 60,
        _ => 86_400,
    }
}

/// The last `days` trading days of `unit` bars. A series read a moment ago answers at once; an older one asks only
/// the bars from its last one on; one read over fewer days, or none, asks the whole window. The asks of a series that
/// come while it is read wait for it.
pub async fn recent(app: &AppHandle, r: &Route, unit: &str, mult: u32, days: u32) -> Result<Vec<Candle>, String> {
    let key: RecentKey = (r.symbol.clone(), unit.to_string(), mult.max(1));
    let gate = state(app).reading.locked().entry(key.clone()).or_default().clone();
    let read = {
        let _turn = gate.lock().await;
        read_recent(app, r, &key, unit, mult, days).await
    };
    drop(gate);
    let mut reading = state(app).reading.locked();
    if reading.get(&key).is_some_and(|g| Arc::strong_count(g) == 1) {
        reading.remove(&key);
    }
    read
}

async fn read_recent(app: &AppHandle, r: &Route, key: &RecentKey, unit: &str, mult: u32, days: u32) -> Result<Vec<Candle>, String> {
    let to = now();
    // As the app's own history: the last `days` trading days before today, and today's bars.
    let cal = calendar(app, r).await?;
    let today = cal.window_end();
    let first = cal.last_trading_days(days.max(1) as usize).first().copied().unwrap_or(today);
    let (from, count) = window(&cal, unit, mult, first, today);
    let kept = state(app).recent.locked().get(key).filter(|k| k.days >= days && !k.bars.is_empty()).map(|k| (k.at, k.days, k.bars.clone()));
    let series = match kept {
        Some((at, _, series)) if at.elapsed() < RECENT_FRESH => series,
        Some((_, kept_days, series)) => {
            let last = series[series.len() - 1].time;
            let newer_count = ((to - last) / bar_seconds(unit, mult) as f64).ceil().max(0.0) as u64 + 1;
            let newer = bars(app, r, unit, mult, last, to, newer_count).await?;
            keep(app, key, kept_days, with_newer(&series, newer))
        }
        None => keep(app, key, days, bars(app, r, unit, mult, from, to, count).await?),
    };
    Ok(window_of(&series, from, count))
}

fn keep(app: &AppHandle, key: &RecentKey, days: u32, bars: Vec<Candle>) -> Arc<Vec<Candle>> {
    let bars = Arc::new(bars);
    let mut recent = state(app).recent.locked();
    recent.insert(key.clone(), Recent { days, at: Instant::now(), bars: bars.clone() });
    if recent.len() > RECENT_KEPT {
        if let Some(oldest) = recent.iter().min_by_key(|(_, k)| k.at).map(|(key, _)| key.clone()) {
            recent.remove(&oldest);
        }
    }
    bars
}

/// A series completed by the bars read since: they replace the ones from their first time on (the last bar moved).
fn with_newer(bars: &[Candle], newer: Vec<Candle>) -> Vec<Candle> {
    let Some(first) = newer.first().map(|b| b.time) else {
        return bars.to_vec();
    };
    let mut out: Vec<Candle> = bars.iter().filter(|b| b.time < first).cloned().collect();
    out.extend(newer);
    out
}

/// The newest `count` bars of a series from `from` on.
fn window_of(bars: &[Candle], from: f64, count: u64) -> Vec<Candle> {
    let start = bars.partition_point(|b| b.time < from).max(bars.len().saturating_sub(count as usize));
    bars[start..].to_vec()
}

/// Bars strictly before `before_sec`, over `span_days` trading days. Pages are past bars: one read a while ago answers
/// the same page again (a chart loaded again asks the page it asked before).
pub async fn before(app: &AppHandle, r: &Route, unit: &str, mult: u32, before_sec: f64, span_days: u32) -> Result<Vec<Candle>, String> {
    let key: PageKey = (r.symbol.clone(), unit.to_string(), mult.max(1), before_sec as i64, span_days);
    let kept = state(app).pages.locked().get(&key).filter(|(at, _)| at.elapsed() < PAGE_KEPT_FOR).map(|(_, bars)| bars.clone());
    if let Some(bars) = kept {
        return Ok(bars.to_vec());
    }
    let to = before_sec - 1.0;
    let cal = calendar(app, r).await?;
    let Some(last) = cal.date_of(to as i64) else {
        return Ok(Vec::new());
    };
    // The day of an intraday page's end is mostly after it (the chart's oldest bar opened it): one day more.
    let n = span_days.max(1) as usize + usize::from(unit != "day");
    let first = cal.trading_days_before(last, n).first().copied().unwrap_or(last);
    let (from, count) = window(&cal, unit, mult, first, last);
    let page = bars(app, r, unit, mult, from, to, count).await?;
    let mut pages = state(app).pages.locked();
    pages.retain(|_, (at, _)| at.elapsed() < PAGE_KEPT_FOR);
    if pages.len() >= PAGES_KEPT {
        if let Some(oldest) = pages.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| key.clone()) {
            pages.remove(&oldest);
        }
    }
    pages.insert(key, (Instant::now(), Arc::new(page.clone())));
    Ok(page)
}

/// The quote panel's numbers, from the last two daily bars.
pub async fn snapshot(app: &AppHandle, r: &Route) -> Result<Snapshot, String> {
    let daily = recent(app, r, "day", 1, 10).await?;
    let last = daily.last().ok_or_else(|| format!("{}: no bars", r.symbol))?;
    let prev = daily.len().checked_sub(2).map(|i| daily[i].close).unwrap_or(last.open);
    let change = last.close - prev;
    Ok(Snapshot {
        ticker: r.ticker.clone(),
        last: last.close,
        change,
        change_percent: if prev != 0.0 { change / prev * 100.0 } else { 0.0 },
        day_high: last.high,
        day_low: last.low,
        day_volume: last.volume,
        ext_change_percent: None,
        source: "live".into(),
        // The feed's time, as its quotes: the details panel compares them (#356).
        updated_ms: state(app).quoted.locked().get(&r.symbol).copied().unwrap_or_else(now) * 1000.0,
    })
}

#[derive(Deserialize)]
struct FoundSymbol {
    ticker: String,
    #[serde(default)]
    description: String,
    #[serde(default, rename = "type")]
    kind: String,
}

/// The connected data plugins' symbols matching `query`, as search rows (`exchange` = the symbol's).
pub async fn search(app: &AppHandle, query: &str) -> Vec<SymbolSearchResult> {
    // "MT5:EUR" asks the plugin of that exchange for "EUR" (and no other plugin).
    let (only, query) = match query.split_once(':') {
        Some((ex, rest)) => (Some(ex.trim().to_ascii_uppercase()), rest.trim()),
        None => (None, query),
    };
    let (exchanges, whole) = {
        let s = state(app);
        let exchanges = s.exchanges.locked().clone();
        let whole = s.whole.locked().clone();
        (exchanges, whole)
    };
    // Each plugin once, even when it serves several exchanges.
    let plugins: BTreeSet<String> =
        exchanges.iter().filter(|(e, _)| only.as_ref().is_none_or(|o| o == *e)).map(|(_, p)| p.clone()).collect();
    let hub = app.state::<Plugins>().hub.clone();
    let asks = plugins.into_iter().filter(|p| hub.connected(p).is_some()).map(|plugin| {
        let hub = hub.clone();
        let query = query.to_string();
        let (exchanges, whole, only) = (exchanges.clone(), whole.clone(), only.clone());
        async move {
            let v = hub.request(&plugin, "data.search", json!({ "query": query }), INFO_TIMEOUT).await.ok()?;
            let found: Vec<FoundSymbol> = serde_json::from_value(v.get("symbols")?.clone()).ok()?;
            Some(found_rows(&exchanges, &whole, &plugin, only.as_deref(), found))
        }
    });
    futures_util::future::join_all(asks).await.into_iter().flatten().flatten().collect()
}

/// A plugin's search answer as rows: the symbols of its exchanges (of `only`, when the query names one), 50 at most.
fn found_rows(
    exchanges: &HashMap<String, String>,
    whole: &HashSet<String>,
    plugin: &str,
    only: Option<&str>,
    found: Vec<FoundSymbol>,
) -> Vec<SymbolSearchResult> {
    found
        .into_iter()
        .filter_map(|f| {
            let symbol = symbol_of(exchanges, whole, plugin, &f.ticker)?;
            let (exchange, ticker) = symbol.split_once(':')?;
            if only.is_some_and(|o| o != exchange) {
                return None;
            }
            Some(SymbolSearchResult {
                ticker: ticker.to_string(),
                name: Some(f.description).filter(|d| !d.is_empty()),
                market: Some(market_of(&f.kind).to_string()),
                locale: None,
                exchange: Some(exchange.to_string()),
                // The plugin's own type: the row's label (cfd, forex, fund…).
                r#type: Some(f.kind.clone()).filter(|k| !k.is_empty()),
            })
        })
        .take(50)
        .collect()
}

/// The search tab of a symbol type.
/// The search tab of a plugin's symbol type (the frontend's market buckets). A type the protocol doesn't list is no
/// stock: shown under All only (#385). No type at all, as plugins sent before types: a stock.
fn market_of(kind: &str) -> &'static str {
    match kind {
        "" | "stock" | "fund" | "bond" => "stocks",
        "forex" => "fx",
        "crypto" => "crypto",
        "index" => "indices",
        "futures" | "cfd" | "commodity" => "futures",
        "option" => "options",
        _ => "other",
    }
}

/// A chart pane shows `symbol` now (None: another symbol, or none). Returns whether a plugin serves it. The symbol is
/// kept either way: a plugin that serves it later streams it then (#409).
pub fn set_chart(app: &AppHandle, owner: &str, symbol: Option<&str>) -> bool {
    {
        let mut subs = state(app).subs.locked();
        match symbol {
            Some(s) => subs.charts.insert(owner.to_string(), s.to_string()),
            None => subs.charts.remove(owner),
        };
    }
    push_subscriptions(app);
    symbol.is_some_and(|s| route(app, s).is_some())
}

/// A window's watchlist symbols (all kept, as a chart's); returns the ones no plugin serves.
pub fn set_watchlist(app: &AppHandle, owner: &str, symbols: Vec<String>) -> Vec<String> {
    state(app).subs.locked().watchlists.insert(owner.to_string(), symbols.clone());
    push_subscriptions(app);
    symbols.into_iter().filter(|s| route(app, s).is_none()).collect()
}

/// A closed window's subscriptions.
pub fn drop_owner(app: &AppHandle, owner: &str) {
    {
        let mut subs = state(app).subs.locked();
        let prefix = format!("{owner}:");
        subs.charts.retain(|k, _| k != owner && !k.starts_with(&prefix));
        subs.watchlists.remove(owner);
    }
    {
        let prefix = format!("{owner}:");
        state(app).tick_charts.locked().retain(|k, _| k != owner && !k.starts_with(&prefix));
    }
    push_subscriptions(app);
    push_tick_subscriptions(app);
}

/// Tell each plugin the whole set of its tickers to stream, when it changed (`data.subscribe`).
fn push_subscriptions(app: &AppHandle) {
    let s = state(app);
    let wanted: Vec<String> = {
        let subs = s.subs.locked();
        subs.charts.values().cloned().chain(subs.watchlists.values().flatten().cloned()).collect()
    };
    let mut per_plugin: HashMap<String, BTreeSet<String>> = HashMap::new();
    for p in s.exchanges.locked().values() {
        per_plugin.entry(p.clone()).or_default();
    }
    let unknown = s.unknown.locked().clone();
    for sym in wanted {
        if let Some(r) = route(app, &sym).filter(|r| !unknown.contains(&r.symbol)) {
            per_plugin.entry(r.plugin).or_default().insert(r.ticker);
        }
    }
    let hub = app.state::<Plugins>().hub.clone();
    for (plugin, tickers) in per_plugin {
        if hub.connected(&plugin).is_none() || s.streaming.locked().get(&plugin) == Some(&tickers) {
            continue;
        }
        if hub.notify(&plugin, "data.subscribe", json!({ "tickers": tickers })).is_ok() {
            s.streaming.locked().insert(plugin, tickers);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Quote {
    ticker: String,
    /// None in a quote of fields alone (#383).
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    prev_close: Option<f64>,
    /// The forming minute bar, [time, open, high, low, close, volume].
    #[serde(default)]
    minute: Option<[f64; 6]>,
    /// The forming daily bar.
    #[serde(default)]
    day: Option<[f64; 6]>,
    /// UNIX seconds of the quote.
    #[serde(default)]
    time: Option<f64>,
    /// Instrument values that changed (#383): `[{"name":…, "value":…}]`.
    #[serde(default)]
    fields: Vec<Value>,
}

fn candle(a: [f64; 6]) -> Candle {
    Candle { time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] }
}

/// A plugin's live quote becomes the events the chart, the watchlist and the alerts read.
fn on_quote(app: &AppHandle, plugin: &str, params: Value) {
    let Ok(q) = serde_json::from_value::<Quote>(params) else { return };
    let symbol = {
        let s = state(app);
        symbol_of(&s.exchanges.locked(), &s.whole.locked(), plugin, &q.ticker)
    };
    let Some(symbol) = symbol else { return };
    if !q.fields.is_empty() {
        super::fields::on_quote(app, &symbol, &q.fields);
    }
    let Some(price) = q.price.filter(|p| p.is_finite()) else { return };
    let minute = q.minute.map(candle);
    let time = q.time.unwrap_or_else(now);
    state(app).quoted.locked().insert(symbol.clone(), time);
    if let Some(m) = &minute {
        let day = q.day.map(|d| Candle { time, ..candle(d) });
        let _ = ChartAggregate { symbol: symbol.clone(), time: m.time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume, day }
            .emit(app);
    }
    let prev = q.prev_close.filter(|p| *p != 0.0);
    let _ = TradeTick {
        symbol: symbol.clone(),
        price: price,
        change: prev.map(|p| price - p),
        change_percent: prev.map(|p| (price - p) / p * 100.0),
        ext_change_percent: None,
        volume: q.day.map(|d| d[5]),
        source: Some("live".into()),
        trade_price: Some(price),
        trade_time: minute.as_ref().map(|m| m.time),
        trade_high: minute.as_ref().map(|m| m.high),
        trade_low: minute.as_ref().map(|m| m.low),
        day_high: q.day.map(|d| d[2]),
        day_low: q.day.map(|d| d[3]),
    }
    .emit(app);
    // The desktop alert engine reads the quotes the host gets.
    if let Some(host) = app.try_state::<HostRef>() {
        host.on_quote(&symbol, price, minute.as_ref());
    }
}

// ── Ticks (#376) ─────────────────────────────────────────────────────────────

/// Ticks asked at most in one request.
const MAX_TICKS: u32 = 100_000;

/// One trade or quote of a symbol: tick charts build their bars from these.
#[derive(Clone, Debug, PartialEq, serde::Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    /// UNIX milliseconds.
    pub time_ms: f64,
    pub price: f64,
    pub volume: f64,
}

/// The live ticks of a charted plugin symbol (`data.tick`), in the order they came.
#[derive(Clone, serde::Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct PluginTicks {
    pub symbol: String,
    pub ticks: Vec<Tick>,
}

/// `[[timeMs, price, volume], …]` as a plugin sends them: valid rows only, oldest first. Rows out of order are sorted;
/// ticks of the same millisecond keep their order.
fn parse_ticks(v: &Value) -> Vec<Tick> {
    let mut ticks: Vec<Tick> = v
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let a = r.as_array()?;
                    let n = |i: usize| a.get(i).and_then(Value::as_f64);
                    let t = Tick { time_ms: n(0)?, price: n(1)?, volume: n(2).unwrap_or(0.0) };
                    (t.time_ms.is_finite() && t.price.is_finite() && t.price > 0.0 && t.volume.is_finite()).then_some(t)
                })
                .collect()
        })
        .unwrap_or_default();
    ticks.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    ticks
}

/// Whether a plugin symbol has ticks: its plugin lists "1T" in its intervals.
fn serves_ticks(i: &Info) -> bool {
    i.intervals.iter().any(|s| s.trim().eq_ignore_ascii_case("1T"))
}

/// The newest `count` ticks of a plugin symbol before `before_ms` (none: up to now), oldest first; with `from_ms`, the
/// first `count` ticks from then on (Bar Replay, #377). Empty when the symbol is not a plugin's or its plugin has no
/// ticks.
#[tauri::command]
#[specta::specta]
pub async fn plugin_ticks(app: AppHandle, symbol: String, before_ms: Option<f64>, from_ms: Option<f64>, count: u32) -> Result<Vec<Tick>, String> {
    let Some(r) = route(&app, &symbol) else { return Ok(Vec::new()) };
    let i = info(&app, &r).await?;
    if !serves_ticks(&i) {
        return Ok(Vec::new());
    }
    let to = before_ms.unwrap_or_else(|| (now() * 1000.0).ceil() + 1.0);
    let count = count.clamp(1, MAX_TICKS);
    let mut params = json!({ "ticker": r.ticker, "to": to.floor(), "countBack": count });
    if let Some(from) = from_ms {
        params["from"] = json!(from.floor());
    }
    let v = ask(&app, &r, "data.ticks", params, BARS_TIMEOUT).await?;
    let mut ticks = parse_ticks(v.get("ticks").unwrap_or(&Value::Null));
    ticks.retain(|t| t.time_ms < to && from_ms.is_none_or(|f| t.time_ms >= f.floor()));
    if from_ms.is_some() {
        ticks.truncate(count as usize);
    }
    Ok(ticks)
}

/// A chart pane shows `symbol` on a tick interval (None: no tick chart): its plugin streams its ticks (`data.tick`).
#[tauri::command]
#[specta::specta]
pub fn plugin_watch_ticks(app: AppHandle, window: tauri::Window, pane: String, symbol: Option<String>) {
    let owner = opentrader_core::commands::chart_owner(window.label(), &pane);
    {
        let mut charts = state(&app).tick_charts.locked();
        match symbol {
            Some(s) => charts.insert(owner, s),
            None => charts.remove(&owner),
        };
    }
    push_tick_subscriptions(&app);
}

/// Tell each plugin the whole set of its tickers whose ticks a chart shows, when it changed (`data.watchTicks`).
fn push_tick_subscriptions(app: &AppHandle) {
    let s = state(app);
    let wanted: Vec<String> = s.tick_charts.locked().values().cloned().collect();
    let mut per_plugin: HashMap<String, BTreeSet<String>> = HashMap::new();
    for p in s.exchanges.locked().values() {
        per_plugin.entry(p.clone()).or_default();
    }
    for sym in wanted {
        if let Some(r) = route(app, &sym) {
            per_plugin.entry(r.plugin).or_default().insert(r.ticker);
        }
    }
    let hub = app.state::<Plugins>().hub.clone();
    for (plugin, tickers) in per_plugin {
        if hub.connected(&plugin).is_none() || s.tick_streaming.locked().get(&plugin) == Some(&tickers) {
            continue;
        }
        if hub.notify(&plugin, "data.watchTicks", json!({ "tickers": tickers })).is_ok() {
            s.tick_streaming.locked().insert(plugin, tickers);
        }
    }
}

/// A plugin's live ticks for the charts of a tick interval.
fn on_ticks(app: &AppHandle, plugin: &str, params: Value) {
    let Some(ticker) = params.get("ticker").and_then(Value::as_str) else { return };
    let symbol = {
        let s = state(app);
        symbol_of(&s.exchanges.locked(), &s.whole.locked(), plugin, ticker)
    };
    let Some(symbol) = symbol else { return };
    let ticks = parse_ticks(params.get("ticks").unwrap_or(&Value::Null));
    if !ticks.is_empty() {
        let _ = PluginTicks { symbol, ticks }.emit(app);
    }
}

// ── Watchlists (#381) ────────────────────────────────────────────────────────

/// Lists a plugin may send, and items (symbols and section headers) in one list: as many as an uploaded list file.
const MAX_LISTS: usize = 100;
const MAX_LIST_ITEMS: usize = 1000;

/// A ready-made watchlist of a data plugin: its symbols with no section first, then its sections.
#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginWatchlist {
    /// The plugin's own id of the list: the same list sent again replaces it.
    pub id: String,
    pub name: String,
    pub symbols: Vec<String>,
    pub sections: Vec<PluginWatchlistSection>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginWatchlistSection {
    pub name: String,
    pub symbols: Vec<String>,
}

/// The watchlists of one data plugin.
#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginWatchlists {
    pub plugin: String,
    pub plugin_name: String,
    pub lists: Vec<PluginWatchlist>,
}

/// A plugin sent its watchlists, or a plugin's went away: read `plugin_watchlists` again.
#[derive(Clone, serde::Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct PluginWatchlistsChanged;

#[derive(Deserialize)]
struct SentList {
    #[serde(default)]
    id: Value,
    #[serde(default)]
    name: Value,
    #[serde(default)]
    symbols: Vec<Value>,
    #[serde(default)]
    sections: Vec<SentSection>,
}

#[derive(Deserialize)]
struct SentSection {
    #[serde(default)]
    name: Value,
    #[serde(default)]
    symbols: Vec<Value>,
}

/// A symbol of a plugin's list as the app names it: one of the plugin's own exchanges only. A one-exchange plugin may
/// give bare tickers.
fn own_symbol(exchanges: &HashMap<String, String>, whole: &HashSet<String>, plugin: &str, s: &str) -> Option<String> {
    let s = s.trim();
    match s.split_once(':') {
        Some((exchange, ticker)) => {
            let exchange = exchange.trim().to_ascii_uppercase();
            let ticker = ticker.trim();
            (exchanges.get(&exchange).map(String::as_str) == Some(plugin) && !ticker.is_empty()).then(|| format!("{exchange}:{ticker}"))
        }
        None if s.is_empty() || whole.contains(plugin) => None,
        None => symbol_of(exchanges, whole, plugin, s),
    }
}

/// `{"watchlists":[{id, name, symbols, sections:[{name, symbols}]}]}` as the app keeps it: lists with an id, each
/// symbol once in its list, section names upper-cased and unique (as the app's), at most `MAX_LISTS` lists of
/// `MAX_LIST_ITEMS` items.
fn parse_watchlists(exchanges: &HashMap<String, String>, whole: &HashSet<String>, plugin: &str, params: &Value) -> Vec<PluginWatchlist> {
    let sent: Vec<SentList> = params.get("watchlists").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let text = |v: &Value| v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for l in sent {
        let Some(id) = text(&l.id).filter(|id| id.chars().count() <= 64 && ids.insert(id.clone())) else { continue };
        let name: String = text(&l.name).unwrap_or_else(|| id.clone()).chars().take(100).collect();
        let mut seen = HashSet::new();
        let mut items = 0usize;
        let mut take = |symbols: &[Value], items: &mut usize| -> Vec<String> {
            let mut kept = Vec::new();
            for s in symbols.iter().filter_map(Value::as_str) {
                if *items >= MAX_LIST_ITEMS {
                    break;
                }
                if let Some(sym) = own_symbol(exchanges, whole, plugin, s).filter(|sym| seen.insert(sym.clone())) {
                    kept.push(sym);
                    *items += 1;
                }
            }
            kept
        };
        let symbols = take(&l.symbols, &mut items);
        let mut sections: Vec<PluginWatchlistSection> = Vec::new();
        for sec in l.sections {
            if items >= MAX_LIST_ITEMS {
                break;
            }
            let base = text(&sec.name).unwrap_or_else(|| "SECTION".into()).to_uppercase();
            let mut name = base.clone();
            let mut n = 2;
            while sections.iter().any(|s| s.name == name) {
                name = format!("{base} {n}");
                n += 1;
            }
            items += 1;
            let symbols = take(&sec.symbols, &mut items);
            sections.push(PluginWatchlistSection { name, symbols });
        }
        out.push(PluginWatchlist { id, name, symbols, sections });
        if out.len() >= MAX_LISTS {
            break;
        }
    }
    out
}

/// A data plugin's whole set of watchlists (`data.watchlists`): it replaces the one it sent before. An empty set is
/// kept too: the lists it held are gone.
fn on_watchlists(app: &AppHandle, plugin: &str, params: Value) {
    let s = state(app);
    let lists = parse_watchlists(&s.exchanges.locked(), &s.whole.locked(), plugin, &params);
    let changed = {
        let mut all = s.watchlists.locked();
        all.get(plugin) != Some(&lists) && {
            all.insert(plugin.to_string(), lists);
            true
        }
    };
    if changed {
        let _ = PluginWatchlistsChanged.emit(app);
    }
}

/// The data plugins' watchlists, by plugin name.
#[tauri::command]
#[specta::specta]
pub fn plugin_watchlists(app: AppHandle) -> Vec<PluginWatchlists> {
    let all = state(&app).watchlists.locked().clone();
    let mut out: Vec<PluginWatchlists> = all
        .into_iter()
        .map(|(plugin, lists)| {
            let plugin_name = super::installed_manifest(&app, &plugin).map(|m| m.name).unwrap_or_else(|| plugin.clone());
            PluginWatchlists { plugin, plugin_name, lists }
        })
        .collect();
    out.sort_by_key(|p| p.plugin_name.to_lowercase());
    out
}

// ── Scripts (#402) ───────────────────────────────────────────────────────────

/// Scripts a plugin may send, and the size of one script's source (bytes).
const MAX_SCRIPTS: usize = 50;
const MAX_SCRIPT_BYTES: usize = 512 * 1024;

/// An OakScript study or strategy of a data plugin, with its source.
#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginScript {
    /// The plugin's own id of the script (letters, digits, `.`, `_`, `-`): the same script sent again replaces it.
    pub id: String,
    pub name: String,
    /// "indicator" or "strategy" as the plugin says; none: read from the source.
    pub kind: Option<String>,
    pub source: String,
}

/// The scripts of one data plugin.
#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginScripts {
    pub plugin: String,
    pub plugin_name: String,
    pub scripts: Vec<PluginScript>,
}

/// A plugin sent its scripts, or a plugin's went away: read `plugin_scripts` again.
#[derive(Clone, serde::Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct PluginScriptsChanged;

/// `{"scripts":[{id, name, kind, source}]}` as the app keeps it: scripts with an id it can put in a study's id, each id
/// once, a source of at most `MAX_SCRIPT_BYTES`, at most `MAX_SCRIPTS` scripts.
fn parse_scripts(params: &Value) -> Vec<PluginScript> {
    let sent = params.get("scripts").and_then(Value::as_array).cloned().unwrap_or_default();
    let text = |v: Option<&Value>| v.and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for s in &sent {
        let Some(id) = text(s.get("id")).filter(|id| {
            id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) && !ids.contains(id)
        }) else {
            continue;
        };
        let Some(source) = s.get("source").and_then(Value::as_str).filter(|src| !src.trim().is_empty() && src.len() <= MAX_SCRIPT_BYTES) else { continue };
        ids.insert(id.clone());
        let name: String = text(s.get("name")).unwrap_or_else(|| id.clone()).chars().take(100).collect();
        let kind = text(s.get("kind")).filter(|k| k == "indicator" || k == "strategy");
        out.push(PluginScript { id, name, kind, source: source.to_string() });
        if out.len() >= MAX_SCRIPTS {
            break;
        }
    }
    out
}

/// A data plugin's whole set of scripts (`data.scripts`): it replaces the one it sent before. An empty set is kept too:
/// the scripts it held are gone. A plugin that serves no data is not heard.
fn on_scripts(app: &AppHandle, plugin: &str, params: Value) {
    let s = state(app);
    if !s.exchanges.locked().values().any(|p| p == plugin) {
        return;
    }
    let scripts = parse_scripts(&params);
    let changed = {
        let mut all = s.scripts.locked();
        all.get(plugin) != Some(&scripts) && {
            all.insert(plugin.to_string(), scripts);
            true
        }
    };
    if changed {
        let _ = PluginScriptsChanged.emit(app);
    }
}

/// The data plugins' scripts, by plugin name.
#[tauri::command]
#[specta::specta]
pub fn plugin_scripts(app: AppHandle) -> Vec<PluginScripts> {
    let all = state(&app).scripts.locked().clone();
    let mut out: Vec<PluginScripts> = all
        .into_iter()
        .map(|(plugin, scripts)| {
            let plugin_name = super::installed_manifest(&app, &plugin).map(|m| m.name).unwrap_or_else(|| plugin.clone());
            PluginScripts { plugin, plugin_name, scripts }
        })
        .collect();
    out.sort_by_key(|p| p.plugin_name.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_a_plugins_scripts_with_usable_ids() {
        use serde_json::json;
        let big = "x".repeat(super::MAX_SCRIPT_BYTES + 1);
        let scripts = super::parse_scripts(&json!({ "scripts": [
            { "id": "pivot-study", "name": " Pivot ", "kind": "indicator", "source": "indicator(\"P\")" },
            { "id": "pivot-study", "name": "Again", "source": "x" },
            { "id": "a b", "name": "Space", "source": "x" },
            { "id": "a#2", "name": "Hash", "source": "x" },
            { "id": "flow", "kind": "other", "source": "strategy(\"F\")" },
            { "id": "empty", "source": "  " },
            { "id": "big", "source": big },
            { "name": "No id", "source": "x" }
        ] }));
        assert_eq!(scripts.len(), 2);
        assert_eq!((scripts[0].id.as_str(), scripts[0].name.as_str(), scripts[0].kind.as_deref()), ("pivot-study", "Pivot", Some("indicator")));
        assert_eq!((scripts[1].id.as_str(), scripts[1].name.as_str(), scripts[1].kind.as_deref()), ("flow", "flow", None));
        assert!(super::parse_scripts(&json!({ "scripts": "no" })).is_empty());
    }

    #[test]
    fn info_changed_covers_the_named_symbols_and_their_series_or_the_plugins_exchanges() {
        let prefixes = ["NSE:".to_string(), "NFO:".to_string()];
        let list = ["NFO:NIFTY26NOVFUT".to_string()];
        let changed = |s: &str, l: Option<&[String]>| super::info_changed(s, &prefixes, l);
        assert!(changed("NFO:NIFTY26NOVFUT", Some(&list)));
        assert!(changed("NFO:NIFTY26NOVFUT_OI", Some(&list)));
        assert!(!changed("NFO:NIFTY26NOVFUT2", Some(&list)));
        assert!(!changed("NSE:RELIANCE", Some(&list)));
        assert!(changed("NSE:RELIANCE", None));
        assert!(!changed("NASDAQ:AAPL", None));
    }

    #[test]
    fn parses_ticks_in_time_order() {
        let v = serde_json::json!([[2000.0, 1.5, 1.0], [1000.0, 1.4], [1500.0, -1.0, 1.0], ["x", 1.0, 1.0], [1000.0, 1.45, 2.0]]);
        let t = super::parse_ticks(&v);
        assert_eq!(t.iter().map(|t| (t.time_ms, t.price, t.volume)).collect::<Vec<_>>(), vec![(1000.0, 1.4, 0.0), (1000.0, 1.45, 2.0), (2000.0, 1.5, 1.0)]);
    }

    use super::*;

    #[test]
    fn a_symbol_type_picks_its_search_tab() {
        assert_eq!(market_of("option"), "options");
        assert_eq!(market_of("cfd"), "futures");
        assert_eq!(market_of("fund"), "stocks");
        assert_eq!(market_of(""), "stocks");
        // Not a stock: listed under All only (#385).
        assert_eq!(market_of("sgb"), "other");
    }

    #[test]
    fn an_extra_series_takes_its_symbols_info() {
        let (ex, whole) = maps();
        let r = route_in(&ex, &whole, "NFO:NIFTY26NOVFUT_OI").unwrap();
        let (base, name) = split_series(&r).unwrap();
        assert_eq!((base.symbol.as_str(), base.ticker.as_str(), name.as_str()), ("NFO:NIFTY26NOVFUT", "NFO:NIFTY26NOVFUT", "OI"));
        assert!(split_series(&route_in(&ex, &whole, "NFO:_OI").unwrap()).is_none());
        assert!(split_series(&route_in(&ex, &whole, "NFO:A_B-C").unwrap()).is_none());
        let base: Info = serde_json::from_value(json!({
            "description": "NIFTY NOV FUT", "type": "futures", "currency": "INR", "timezone": "Asia/Kolkata", "session": "0915-1530",
            "pricescale": 20, "minmov": 1, "intervals": ["1", "5", "1D", "1T"], "pointValue": 65,
            "series": ["OI", {"name": "UC", "description": "Upper circuit", "intervals": ["1D"], "pricescale": 100}],
            "fields": [{"name": "Upper circuit", "value": 1}],
        }))
        .unwrap();
        let oi = series_info(&base, "NFO:NIFTY26NOVFUT", "oi").unwrap();
        assert_eq!(oi.description, "NIFTY26NOVFUT Open Interest");
        assert_eq!((oi.kind.as_str(), oi.timezone.as_str(), oi.currency.as_deref(), oi.pricescale), ("futures", "Asia/Kolkata", Some("INR"), 20));
        // Ticks are the symbol's own; the series has no point value, nor series or fields of its own.
        assert_eq!(oi.intervals, iv(&["1", "5", "1D"]));
        assert!(oi.point_value.is_none() && oi.series.is_empty() && oi.fields.is_empty());
        let uc = series_info(&base, "NFO:NIFTY26NOVFUT", "UC").unwrap();
        assert_eq!((uc.description.as_str(), uc.intervals.clone(), uc.pricescale), ("NIFTY26NOVFUT Upper circuit", iv(&["1D"]), 100));
        assert!(series_info(&base, "NFO:NIFTY26NOVFUT", "VOLX").is_none());
    }

    #[test]
    fn bar_origin_is_a_time_of_day() {
        assert_eq!(origin_minutes("1700"), Some(1020));
        assert_eq!(origin_minutes("0000"), Some(0));
        assert_eq!(origin_minutes("2400"), None);
        assert_eq!(origin_minutes("17:00"), None);
        assert_eq!(origin_minutes("930"), None);
    }

    fn iv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn picks_a_served_interval_or_a_divisor() {
        let served = iv(&["1", "5", "15", "60", "1D"]);
        assert_eq!(pick(&served, "minute", 5), Some(("5".into(), 0)));
        assert_eq!(pick(&served, "minute", 45), Some(("15".into(), 2700)));
        assert_eq!(pick(&served, "minute", 7), Some(("1".into(), 420)));
        assert_eq!(pick(&served, "day", 1), Some(("1D".into(), 0)));
        assert_eq!(pick(&served, "second", 5), None);
        assert_eq!(pick(&iv(&["1S"]), "second", 10), Some(("1S".into(), 10)));
        // Hours only (#332): the chart asks the served size itself and builds 2 and 4 hours from it; nothing under it.
        let hours = iv(&["60", "1D"]);
        assert_eq!(pick(&hours, "minute", 60), Some(("60".into(), 0)));
        assert_eq!(pick(&hours, "minute", 240), Some(("60".into(), 14_400)));
        assert_eq!(pick(&hours, "minute", 30), None);
    }

    #[test]
    fn rebuilds_bars_on_the_clock_grid() {
        let b = |t: f64, o: f64, h: f64, l: f64, c: f64| Candle { time: t, open: o, high: h, low: l, close: c, volume: 1.0 };
        let out = rebuild(vec![b(0.0, 1.0, 2.0, 0.5, 1.5), b(60.0, 1.5, 3.0, 1.0, 2.0), b(120.0, 2.0, 2.5, 1.8, 2.2)], 120);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].open, out[0].high, out[0].low, out[0].close, out[0].volume), (1.0, 3.0, 0.5, 2.0, 2.0));
        assert_eq!(out[1].time, 120.0);
    }

    fn maps() -> (HashMap<String, String>, HashSet<String>) {
        let ex: HashMap<String, String> =
            [("MT5", "mt5"), ("NSE", "algo"), ("BSE", "algo"), ("NFO", "algo")].iter().map(|(e, p)| (e.to_string(), p.to_string())).collect();
        (ex, HashSet::from(["algo".to_string()]))
    }

    #[test]
    fn an_idle_plugins_symbols_are_its_own() {
        let idle = HashSet::from(["MT5".to_string()]);
        assert!(idle_in(&idle, "mt5:AMZN.US-24"));
        assert!(!idle_in(&idle, "NASDAQ:AMZN"));
        assert!(!idle_in(&idle, "AMZN"));
    }

    #[test]
    fn routes_several_exchanges_with_whole_symbols() {
        let (ex, whole) = maps();
        let r = route_in(&ex, &whole, "nse:RELIANCE").unwrap();
        assert_eq!((r.plugin.as_str(), r.symbol.as_str(), r.ticker.as_str()), ("algo", "NSE:RELIANCE", "NSE:RELIANCE"));
        assert_eq!(route_in(&ex, &whole, "BSE:RELIANCE").unwrap().ticker, "BSE:RELIANCE");
        // A one-exchange plugin keeps bare tickers; an exchange no plugin serves stays the app's.
        assert_eq!(route_in(&ex, &whole, "MT5:EURUSD").unwrap().ticker, "EURUSD");
        assert!(route_in(&ex, &whole, "NASDAQ:AAPL").is_none());
    }

    #[test]
    fn names_quotes_and_search_rows_by_their_exchange() {
        let (ex, whole) = maps();
        assert_eq!(symbol_of(&ex, &whole, "algo", "BSE:RELIANCE").as_deref(), Some("BSE:RELIANCE"));
        assert_eq!(symbol_of(&ex, &whole, "algo", "RELIANCE"), None);
        assert_eq!(symbol_of(&ex, &whole, "algo", "MT5:EURUSD"), None);
        assert_eq!(symbol_of(&ex, &whole, "mt5", "EURUSD").as_deref(), Some("MT5:EURUSD"));
        let found = |t: &str| FoundSymbol { ticker: t.into(), description: String::new(), kind: "stock".into() };
        let rows = found_rows(&ex, &whole, "algo", None, vec![found("NSE:RELIANCE"), found("BSE:RELIANCE"), found("X:Y")]);
        assert_eq!(rows.iter().map(|r| format!("{}:{}", r.exchange.as_deref().unwrap(), r.ticker)).collect::<Vec<_>>(), vec!["NSE:RELIANCE", "BSE:RELIANCE"]);
        let only = found_rows(&ex, &whole, "algo", Some("BSE"), vec![found("NSE:RELIANCE"), found("BSE:RELIANCE")]);
        assert_eq!(only.len(), 1);
    }

    #[test]
    fn asks_only_what_the_source_history_reaches() {
        let day = 86_400.0;
        let now = 1000.0 * day;
        // 30 years asked of a source a year deep: the last year, a year of daily bars at most.
        assert_eq!(reachable(Some(365.0), now - 10_000.0 * day, now, 7560, 86_400, now), Some((now - 365.0 * day, 366)));
        // A scroll-back page older than it: nothing to ask.
        assert_eq!(reachable(Some(365.0), now - 500.0 * day, now - 400.0 * day, 100, 86_400, now), None);
        // No depth: the window as asked, the count kept when it fits.
        assert_eq!(reachable(None, now - 10.0 * day, now, 2880, 300, now), Some((now - 10.0 * day, 2880)));
        let depth = HistoryDepth { second: None, minute: Some(30.0), day: Some(0.0) };
        assert_eq!((depth.of("minute"), depth.of("day"), depth.of("second")), (Some(30.0), None, None));
    }

    fn cal(tz: &str, session: &str, extended: Option<&str>, holidays: &str) -> SessionCalendar {
        let i: Info = serde_json::from_value(json!({
            "timezone": tz, "session": session, "extended": extended, "holidays": holidays, "pricescale": 100,
        }))
        .unwrap();
        SessionCalendar::new(&symbol_session(&i))
    }

    #[test]
    fn sizes_windows_by_the_trading_sessions() {
        let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day).unwrap();
        // NSE (#363): 375 minutes a day, a holiday on Friday 20/11/2026: Monday 16 to Monday 23 is 5 trading days.
        let nse = cal("Asia/Kolkata", "0915-1530", None, "20261120");
        assert_eq!(per_day(&nse, "minute", 1), 376);
        assert_eq!(per_day(&nse, "minute", 5), 76);
        assert_eq!(per_day(&nse, "second", 15), 1501);
        assert_eq!(per_day(&nse, "day", 1), 1);
        let (from, count) = window(&nse, "minute", 1, d(2026, 11, 16), d(2026, 11, 23));
        assert_eq!((from as i64, count), (d(2026, 11, 16).and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() - 19_800, 376 * 5));
        // Extended hours count; around the clock keeps whole days.
        assert_eq!(per_day(&cal("America/New_York", "0930-1600", Some("0400-2000"), ""), "minute", 1), 961);
        let crypto = cal("UTC", "24x7", None, "");
        assert_eq!(per_day(&crypto, "minute", 1), 1440);
        assert_eq!(per_day(&crypto, "minute", 7), 206);
        assert_eq!(window(&crypto, "day", 1, d(2026, 11, 1), d(2026, 11, 30)).1, 30);
    }

    fn c(t: f64, close: f64) -> Candle {
        Candle { time: t, open: close, high: close, low: close, close, volume: 1.0 }
    }

    #[test]
    fn completes_a_kept_series_with_the_newer_bars() {
        let kept = vec![c(1.0, 1.0), c(2.0, 2.0), c(3.0, 3.0)];
        // The last bar moved and a new one opened.
        let out = with_newer(&kept, vec![c(3.0, 3.5), c(4.0, 4.0)]);
        assert_eq!(out.iter().map(|b| (b.time, b.close)).collect::<Vec<_>>(), vec![(1.0, 1.0), (2.0, 2.0), (3.0, 3.5), (4.0, 4.0)]);
        assert_eq!(with_newer(&kept, Vec::new()).len(), 3);
    }

    #[test]
    fn answers_a_shorter_window_from_a_kept_series() {
        let kept: Vec<Candle> = (1..=10).map(|t| c(t as f64, t as f64)).collect();
        assert_eq!(window_of(&kept, 7.0, 100).iter().map(|b| b.time).collect::<Vec<_>>(), vec![7.0, 8.0, 9.0, 10.0]);
        assert_eq!(window_of(&kept, 0.0, 2).iter().map(|b| b.time).collect::<Vec<_>>(), vec![9.0, 10.0]);
    }

    #[test]
    fn a_busy_source_is_asked_again() {
        assert_eq!(error_text(PluginError::Rpc { code: BUSY, message: "Too many requests".into() }), "Too many requests (RATE_LIMITED)");
        assert_eq!(error_text(PluginError::Rpc { code: -32000, message: "No data".into() }), "No data");
    }

    #[test]
    fn a_plugin_not_connected_yet_is_asked_again() {
        assert_eq!(error_text(PluginError::NotConnected("feed".into())), "The plugin feed is not connected (PLUGIN_OFFLINE)");
        assert_eq!(error_text(PluginError::Timeout), "The plugin did not answer in time");
    }

    #[test]
    fn parses_bars_sorted_and_without_duplicates() {
        let v = json!({ "bars": [[120, 1, 2, 0.5, 1.5, 10], [60, 1, 1, 1, 1], [120, 9, 9, 9, 9, 9], ["x"]] });
        let bars = parse_bars(&v).unwrap();
        assert_eq!(bars.iter().map(|b| b.time).collect::<Vec<_>>(), vec![60.0, 120.0]);
        assert_eq!(bars[0].volume, 0.0);
    }

    #[test]
    fn keeps_a_plugins_watchlists_to_its_own_symbols() {
        let (ex, whole) = maps();
        let params = json!({ "watchlists": [
            { "id": "nifty", "name": " NIFTY 50 ", "symbols": ["NSE:RELIANCE", "nse:TCS", "NASDAQ:AAPL", "RELIANCE", "NSE:RELIANCE"],
              "sections": [{ "name": "banks", "symbols": ["NSE:HDFCBANK", "NSE:TCS"] }, { "name": "Banks", "symbols": ["BSE:SBIN"] }, { "symbols": [] }] },
            { "id": "nifty", "name": "Twice" },
            { "name": "No id" },
            { "id": "fut", "symbols": ["NFO:NIFTY26NOVFUT"] },
        ]});
        let lists = parse_watchlists(&ex, &whole, "algo", &params);
        assert_eq!(lists.len(), 2);
        assert_eq!((lists[0].id.as_str(), lists[0].name.as_str()), ("nifty", "NIFTY 50"));
        assert_eq!(lists[0].symbols, vec!["NSE:RELIANCE", "NSE:TCS"]);
        let sections: Vec<(&str, Vec<&str>)> =
            lists[0].sections.iter().map(|s| (s.name.as_str(), s.symbols.iter().map(String::as_str).collect())).collect();
        assert_eq!(sections, vec![("BANKS", vec!["NSE:HDFCBANK"]), ("BANKS 2", vec!["BSE:SBIN"]), ("SECTION", vec![])]);
        // No name: the id.
        assert_eq!(lists[1].name, "fut");
        // A one-exchange plugin may give bare tickers.
        let mt5 = parse_watchlists(&ex, &whole, "mt5", &json!({ "watchlists": [{ "id": "fx", "name": "FX", "symbols": ["EURUSD", "MT5:GBPUSD", "NSE:TCS"] }] }));
        assert_eq!(mt5[0].symbols, vec!["MT5:EURUSD", "MT5:GBPUSD"]);
    }

    #[test]
    fn caps_the_items_of_a_plugin_watchlist() {
        let (ex, whole) = maps();
        let many: Vec<String> = (0..1500).map(|i| format!("NSE:S{i}")).collect();
        let params = json!({ "watchlists": [{ "id": "all", "name": "All", "symbols": many, "sections": [{ "name": "MORE", "symbols": ["NSE:X"] }] }] });
        let lists = parse_watchlists(&ex, &whole, "algo", &params);
        assert_eq!(lists[0].symbols.len(), MAX_LIST_ITEMS);
        assert!(lists[0].sections.is_empty());
        assert!(parse_watchlists(&ex, &whole, "algo", &json!({ "watchlists": "no" })).is_empty());
    }
}
