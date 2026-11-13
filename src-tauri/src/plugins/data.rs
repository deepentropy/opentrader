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
 */
use super::Plugins;
use crate::data::session::{Subsession, SymbolSession};
use crate::data::types::{Candle, ChartAggregate, Snapshot, SymbolSearchResult, TickerInfo, TradeTick};
use opentrader_core::host::HostRef;
use opentrader_core::plugins::hub::HubEvent;
use opentrader_core::sync::LockExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

const BARS_TIMEOUT: Duration = Duration::from_secs(60);
const INFO_TIMEOUT: Duration = Duration::from_secs(15);
/// Bars asked at most in one request.
const MAX_BARS: u64 = 50_000;

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
}

fn one() -> u32 {
    1
}

#[derive(Default)]
struct Subscriptions {
    charts: HashMap<String, String>,
    watchlists: HashMap<String, Vec<String>>,
}

#[derive(Default)]
pub struct PluginData {
    /// Exchange → the enabled data plugin that serves it.
    exchanges: Mutex<HashMap<String, String>>,
    /// The plugins asked with whole symbols (they serve several exchanges).
    whole: Mutex<HashSet<String>>,
    infos: Mutex<HashMap<String, Arc<Info>>>,
    subs: Mutex<Subscriptions>,
    /// The tickers each plugin was last asked to stream.
    streaming: Mutex<HashMap<String, BTreeSet<String>>>,
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

/// The enabled data plugins' exchanges (from `plugins::apply`), and those of them asked with whole symbols.
pub fn set_exchanges(app: &AppHandle, map: HashMap<String, String>, whole: HashSet<String>) {
    let s = state(app);
    *s.exchanges.locked() = map;
    *s.whole.locked() = whole;
    s.infos.locked().clear();
}

pub fn init(app: &AppHandle) {
    let mut events = app.state::<Plugins>().hub.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(HubEvent::Connected { plugin, .. }) => {
                    forget(&app, &plugin);
                    // A plugin that connects again streams what is subscribed.
                    state(&app).streaming.locked().remove(&plugin);
                    push_subscriptions(&app);
                }
                Ok(HubEvent::Disconnected { plugin }) => {
                    forget(&app, &plugin);
                    state(&app).streaming.locked().remove(&plugin);
                }
                Ok(HubEvent::Notification { plugin, method, params }) if method == "data.quote" => on_quote(&app, &plugin, params),
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
    });
}

/// Drop the plugin's cached symbol infos (it connected again, maybe as a new version).
fn forget(app: &AppHandle, plugin: &str) {
    let s = state(app);
    let exchanges: Vec<String> = s.exchanges.locked().iter().filter(|(_, p)| *p == plugin).map(|(e, _)| format!("{e}:")).collect();
    s.infos.locked().retain(|sym, _| !exchanges.iter().any(|e| sym.starts_with(e)));
}

async fn ask(app: &AppHandle, r: &Route, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let hub = app.state::<Plugins>().hub.clone();
    hub.request(&r.plugin, method, params, timeout).await.map_err(|e| e.to_string())
}

pub async fn info(app: &AppHandle, r: &Route) -> Result<Arc<Info>, String> {
    if let Some(i) = state(app).infos.locked().get(&r.symbol) {
        return Ok(i.clone());
    }
    let v = ask(app, r, "data.symbolInfo", json!({ "ticker": r.ticker }), INFO_TIMEOUT).await?;
    let info: Info = serde_json::from_value(v).map_err(|e| format!("{}: bad symbol info ({e})", r.symbol))?;
    if info.pricescale == 0 {
        return Err(format!("{}: bad symbol info (pricescale 0)", r.symbol));
    }
    let info = Arc::new(info);
    state(app).infos.locked().insert(r.symbol.clone(), info.clone());
    Ok(info)
}

pub async fn session(app: &AppHandle, r: &Route) -> Result<SymbolSession, String> {
    let i = info(app, r).await?;
    let mut subsessions = vec![Subsession::new("regular", "Regular Trading Hours", &i.session)];
    if let Some(ext) = i.extended.as_ref().filter(|e| **e != i.session) {
        subsessions.push(Subsession::new("extended", "Extended Trading Hours", ext));
    }
    Ok(SymbolSession {
        timezone: i.timezone.clone(),
        session: i.session.clone(),
        subsessions,
        holidays: i.holidays.clone(),
        corrections: String::new(),
        pricescale: i.pricescale,
        minmov: i.minmov.max(1),
        variable_tick_size: String::new(),
        intervals: i.intervals.clone(),
    })
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
    let params = json!({
        "ticker": r.ticker, "resolution": resolution,
        "from": from.max(0.0).floor(), "to": to.floor(), "countBack": ask_count.clamp(1, MAX_BARS),
    });
    let v = ask(app, r, "data.bars", params, BARS_TIMEOUT).await?;
    let mut bars = parse_bars(&v)?;
    bars.retain(|b| b.time >= from && b.time <= to);
    Ok(if bucket > 0 { rebuild(bars, bucket) } else { bars })
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

/// Calendar seconds that cover `days` trading days (weekends, a holiday).
fn span(days: u32) -> f64 {
    (days as f64 * 7.0 / 5.0 + 3.0) * 86_400.0
}

/// The last `days` trading days of `unit` bars.
pub async fn recent(app: &AppHandle, r: &Route, unit: &str, mult: u32, days: u32) -> Result<Vec<Candle>, String> {
    let to = now();
    let per_day = match unit {
        "second" => 86_400 / mult.max(1) as u64,
        "minute" => 1_440 / mult.max(1) as u64,
        _ => 1,
    };
    bars(app, r, unit, mult, to - span(days), to, per_day.max(1) * days as u64).await
}

/// Bars strictly before `before_sec`, over `span_days` trading days.
pub async fn before(app: &AppHandle, r: &Route, unit: &str, mult: u32, before_sec: f64, span_days: u32) -> Result<Vec<Candle>, String> {
    let to = before_sec - 1.0;
    let per_day = match unit {
        "second" => 86_400 / mult.max(1) as u64,
        "minute" => 1_440 / mult.max(1) as u64,
        _ => 1,
    };
    bars(app, r, unit, mult, to - span(span_days), to, per_day.max(1) * span_days as u64).await
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
        updated_ms: now() * 1000.0,
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
                r#type: None,
            })
        })
        .take(50)
        .collect()
}

/// The search tab of a symbol type.
fn market_of(kind: &str) -> &'static str {
    match kind {
        "forex" => "fx",
        "crypto" => "crypto",
        "index" => "indices",
        "futures" | "cfd" | "commodity" => "futures",
        _ => "stocks",
    }
}

/// A chart pane shows `symbol` now (None: another symbol, or none). Returns whether a plugin serves it.
pub fn set_chart(app: &AppHandle, owner: &str, symbol: Option<&str>) -> bool {
    let routed = symbol.and_then(|s| route(app, s));
    {
        let mut subs = state(app).subs.locked();
        match &routed {
            Some(r) => subs.charts.insert(owner.to_string(), r.symbol.clone()),
            None => subs.charts.remove(owner),
        };
    }
    push_subscriptions(app);
    routed.is_some()
}

/// A window's watchlist symbols; returns the ones no plugin serves.
pub fn set_watchlist(app: &AppHandle, owner: &str, symbols: Vec<String>) -> Vec<String> {
    let (mine, rest): (Vec<String>, Vec<String>) = symbols.into_iter().partition(|s| route(app, s).is_some());
    let mine: Vec<String> = mine.iter().filter_map(|s| route(app, s)).map(|r| r.symbol).collect();
    state(app).subs.locked().watchlists.insert(owner.to_string(), mine);
    push_subscriptions(app);
    rest
}

/// A closed window's subscriptions.
pub fn drop_owner(app: &AppHandle, owner: &str) {
    {
        let mut subs = state(app).subs.locked();
        let prefix = format!("{owner}:");
        subs.charts.retain(|k, _| k != owner && !k.starts_with(&prefix));
        subs.watchlists.remove(owner);
    }
    push_subscriptions(app);
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
    for sym in wanted {
        if let Some(r) = route(app, &sym) {
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
    price: f64,
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
}

fn candle(a: [f64; 6]) -> Candle {
    Candle { time: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] }
}

/// A plugin's live quote becomes the events the chart, the watchlist and the alerts read.
fn on_quote(app: &AppHandle, plugin: &str, params: Value) {
    let Ok(q) = serde_json::from_value::<Quote>(params) else { return };
    if !q.price.is_finite() {
        return;
    }
    let symbol = {
        let s = state(app);
        symbol_of(&s.exchanges.locked(), &s.whole.locked(), plugin, &q.ticker)
    };
    let Some(symbol) = symbol else { return };
    let minute = q.minute.map(candle);
    let time = q.time.unwrap_or_else(now);
    if let Some(m) = &minute {
        let day = q.day.map(|d| Candle { time, ..candle(d) });
        let _ = ChartAggregate { symbol: symbol.clone(), time: m.time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume, day }
            .emit(app);
    }
    let prev = q.prev_close.filter(|p| *p != 0.0);
    let _ = TradeTick {
        symbol: symbol.clone(),
        price: q.price,
        change: prev.map(|p| q.price - p),
        change_percent: prev.map(|p| (q.price - p) / p * 100.0),
        ext_change_percent: None,
        volume: q.day.map(|d| d[5]),
        source: Some("live".into()),
        trade_price: Some(q.price),
        trade_time: minute.as_ref().map(|m| m.time),
        trade_high: minute.as_ref().map(|m| m.high),
        trade_low: minute.as_ref().map(|m| m.low),
    }
    .emit(app);
    // The desktop alert engine reads the quotes the host gets.
    if let Some(host) = app.try_state::<HostRef>() {
        host.on_quote(&symbol, q.price, minute.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_bars_sorted_and_without_duplicates() {
        let v = json!({ "bars": [[120, 1, 2, 0.5, 1.5, 10], [60, 1, 1, 1, 1], [120, 9, 9, 9, 9, 9], ["x"]] });
        let bars = parse_bars(&v).unwrap();
        assert_eq!(bars.iter().map(|b| b.time).collect::<Vec<_>>(), vec![60.0, 120.0]);
        assert_eq!(bars[0].volume, 0.0);
    }
}
