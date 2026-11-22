/*
 * A data plugin's symbol events (#382, `data.events` in plugins/PROTOCOL.md): the dividends, splits and earnings the
 * chart marks along its bottom (Chart settings > Events), for the symbols the app's own data doesn't know. A bonus
 * issue comes as a split. Kinds the chart has no marker for are dropped, so a plugin may send more than it shows.
 *
 * A symbol's events are kept a while: every chart, compared symbol and script that reads them asks the same list. A
 * plugin that changed them says so (`data.eventsChanged`); they are dropped and the windows ask again.
 */
use super::data::{self, Route};
use super::Plugins;
use chrono::NaiveDate;
use opentrader_core::plugins::hub::PluginError;
use opentrader_core::sync::LockExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

const TIMEOUT: Duration = Duration::from_secs(30);
/// A kept list answers for this long; then the plugin is asked again.
const FRESH: Duration = Duration::from_secs(3600);
/// Lists kept at most (the one read longest ago goes first).
const KEPT: usize = 256;
/// Events of one symbol at most.
const MAX_EVENTS: usize = 5000;
const UNKNOWN_METHOD: i64 = -32601;
const UNKNOWN_SYMBOL: i64 = -32004;

#[derive(Default)]
pub struct PluginEvents {
    /// Symbol → its events, and when they were read.
    kept: Mutex<HashMap<String, (Instant, Arc<Vec<SymbolEvent>>)>>,
    /// The plugins that don't answer `data.events` (until they connect again).
    unsupported: Mutex<HashSet<String>>,
}

/// One event of a symbol, a calendar date in its exchange's time zone as 00:00 UTC of that date (UNIX s).
#[derive(Clone, Debug, PartialEq, serde::Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolEvent {
    /// "dividend", "split" or "earnings".
    pub kind: String,
    /// Ex-dividend date, split date, earnings release date.
    pub date: f64,
    /// Dividend: cash per share; its payment date.
    pub amount: Option<f64>,
    pub pay_date: Option<f64>,
    /// Split: shares before → after (a 1:1 bonus is 1 → 2).
    pub from: Option<f64>,
    pub to: Option<f64>,
    /// Earnings: fiscal period ("Q1", "FY") and year, period end, release before the open ("bmo") or after the close
    /// ("amc"), reported EPS and revenue, and their currency.
    pub fiscal_period: Option<String>,
    pub fiscal_year: Option<i32>,
    pub period_end: Option<f64>,
    pub session: Option<String>,
    pub eps: Option<f64>,
    pub revenue: Option<f64>,
    pub currency: Option<String>,
}

/// A plugin changed some of its symbols' events (`symbols`), or all those of its `exchanges` (`symbols` null): the
/// windows ask `plugin_events` again for the charts that show them.
#[derive(Clone, serde::Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct PluginEventsChanged {
    pub exchanges: Vec<String>,
    pub symbols: Option<Vec<String>>,
}

fn state(app: &AppHandle) -> &PluginEvents {
    &app.state::<Plugins>().inner().events
}

/// "YYYY-MM-DD" as 00:00 UTC of that date (UNIX s).
fn day(v: Option<&Value>) -> Option<f64> {
    let d = NaiveDate::parse_from_str(v?.as_str()?.trim(), "%Y-%m-%d").ok()?;
    Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp() as f64)
}

fn number(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite())
}

fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.chars().take(max).collect())
}

/// The events a plugin sent: the kinds the chart shows, with a valid date, oldest first.
pub fn parse(v: &Value) -> Vec<SymbolEvent> {
    let rows = v.get("events").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let mut out: Vec<SymbolEvent> = rows
        .iter()
        .filter_map(|r| {
            let kind = r.get("type").and_then(Value::as_str)?;
            let date = day(r.get("date"))?;
            let mut e = SymbolEvent {
                kind: kind.to_string(),
                date,
                amount: None,
                pay_date: None,
                from: None,
                to: None,
                fiscal_period: None,
                fiscal_year: None,
                period_end: None,
                session: None,
                eps: None,
                revenue: None,
                currency: None,
            };
            match kind {
                "dividend" => {
                    e.amount = Some(number(r.get("amount")).filter(|a| *a >= 0.0)?);
                    e.pay_date = day(r.get("payDate"));
                }
                "split" => {
                    let positive = |k: &str| number(r.get(k)).filter(|n| *n > 0.0);
                    e.from = Some(positive("from")?);
                    e.to = Some(positive("to")?);
                }
                "earnings" => {
                    e.fiscal_period = text(r.get("fiscalPeriod"), 8);
                    e.fiscal_year = r.get("fiscalYear").and_then(Value::as_i64).and_then(|y| i32::try_from(y).ok()).filter(|y| (1900..=9999).contains(y));
                    e.period_end = day(r.get("periodEnd"));
                    e.session = text(r.get("session"), 3).filter(|s| s == "bmo" || s == "amc");
                    e.eps = number(r.get("eps"));
                    e.revenue = number(r.get("revenue"));
                    e.currency = text(r.get("currency"), 8);
                }
                // Not a kind the chart shows.
                _ => return None,
            }
            Some(e)
        })
        .take(MAX_EVENTS)
        .collect();
    out.sort_by(|a, b| a.date.total_cmp(&b.date));
    out
}

async fn read(app: &AppHandle, r: &Route) -> Result<Vec<SymbolEvent>, String> {
    if state(app).unsupported.locked().contains(&r.plugin) {
        return Ok(Vec::new());
    }
    let hub = app.state::<Plugins>().hub.clone();
    match hub.request(&r.plugin, "data.events", json!({ "ticker": r.ticker }), TIMEOUT).await {
        Ok(v) => Ok(parse(&v)),
        // A plugin without events, or a symbol it doesn't know: none.
        Err(PluginError::Rpc { code: UNKNOWN_METHOD, .. }) => {
            state(app).unsupported.locked().insert(r.plugin.clone());
            Ok(Vec::new())
        }
        Err(PluginError::Rpc { code: UNKNOWN_SYMBOL, .. }) => Ok(Vec::new()),
        Err(e) => Err(data::error_text(e)),
    }
}

/// The dividends, splits and earnings of a data plugin's symbol, oldest first (Events tab). Empty when the symbol is
/// not a plugin's or its plugin has none.
#[tauri::command]
#[specta::specta]
pub async fn plugin_events(app: AppHandle, symbol: String) -> Result<Vec<SymbolEvent>, String> {
    let Some(r) = data::route(&app, &symbol) else { return Ok(Vec::new()) };
    if let Some((at, list)) = state(&app).kept.locked().get_mut(&r.symbol) {
        if at.elapsed() < FRESH {
            return Ok(list.as_ref().clone());
        }
    }
    let list = Arc::new(read(&app, &r).await?);
    let mut kept = state(&app).kept.locked();
    if kept.len() >= KEPT {
        if let Some(oldest) = kept.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
            kept.remove(&oldest);
        }
    }
    kept.insert(r.symbol.clone(), (Instant::now(), list.clone()));
    Ok(list.as_ref().clone())
}

/// `data.eventsChanged`: `{"tickers":[…]}` names the symbols whose events changed; without it, all of them did.
pub fn on_changed(app: &AppHandle, plugin: &str, params: Value) {
    let exchanges = data::exchanges_of(app, plugin);
    if exchanges.is_empty() {
        return;
    }
    let symbols: Option<Vec<String>> = params
        .get("tickers")
        .and_then(Value::as_array)
        .map(|t| t.iter().filter_map(Value::as_str).filter_map(|t| data::symbol_of_plugin(app, plugin, t)).collect());
    forget(app, plugin, symbols.as_deref());
    let _ = PluginEventsChanged { exchanges, symbols }.emit(app);
}

/// Drop a plugin's kept events: those of `symbols`, or all of them (it connected again, maybe as a new version).
pub fn forget(app: &AppHandle, plugin: &str, symbols: Option<&[String]>) {
    let s = state(app);
    match symbols {
        Some(list) => s.kept.locked().retain(|sym, _| !list.contains(sym)),
        None => {
            let prefixes: Vec<String> = data::exchanges_of(app, plugin).into_iter().map(|e| format!("{e}:")).collect();
            s.kept.locked().retain(|sym, _| !prefixes.iter().any(|p| sym.starts_with(p)));
            s.unsupported.locked().remove(plugin);
        }
    }
}

/// Settings > Service > "Clear cache".
pub fn clear(app: &AppHandle) {
    state(app).kept.locked().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_kinds_the_chart_shows() {
        let v = json!({ "events": [
            { "type": "split", "date": "2024-10-28", "from": 1, "to": 2 },
            { "type": "dividend", "date": "2024-08-19", "amount": 10, "payDate": "2024-09-06" },
            { "type": "earnings", "date": "2025-01-16", "fiscalPeriod": "Q3", "fiscalYear": 2025, "periodEnd": "2024-12-31",
              "session": "amc", "eps": 13.7, "revenue": 2.4e12, "currency": "INR" },
            { "type": "rights", "date": "2024-05-01" },
            { "type": "dividend", "date": "28/10/2024", "amount": 1 },
            { "type": "dividend", "date": "2024-01-02" },
            { "type": "split", "date": "2024-01-03", "from": 0, "to": 2 },
            { "type": "earnings", "date": "2024-10-14", "session": "noon", "fiscalYear": 20250 }
        ]});
        let e = parse(&v);
        assert_eq!(e.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["dividend", "earnings", "split", "earnings"]);
        assert_eq!(e[0].date, 1_724_025_600.0);
        assert_eq!((e[0].amount, e[0].pay_date), (Some(10.0), Some(1_725_580_800.0)));
        assert_eq!((e[2].from, e[2].to), (Some(1.0), Some(2.0)));
        let q3 = &e[3];
        assert_eq!((q3.fiscal_period.as_deref(), q3.fiscal_year, q3.session.as_deref()), (Some("Q3"), Some(2025), Some("amc")));
        assert_eq!((q3.eps, q3.revenue, q3.currency.as_deref()), (Some(13.7), Some(2.4e12), Some("INR")));
        // Unknown session and an impossible year are left out, the release stays.
        assert_eq!((e[1].session.as_deref(), e[1].fiscal_year), (None, None));
    }

    #[test]
    fn no_events_field_is_none() {
        assert!(parse(&json!({})).is_empty());
        assert!(parse(&json!([])).is_empty());
    }
}
