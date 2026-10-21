/*
 * `POST /api/invoke/<command>` — the desktop commands the web version needs,
 * with the arguments named as the bindings send them (camelCase). Commands of
 * the desktop shell (windows, updater, files, the alert engine) and the
 * webhook relay are not served: the web frontend has its own backing for them.
 */
use crate::clients::{valid_id, Subs, CLIENT_HEADER};
use crate::Shared;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use std::net::SocketAddr;
use crate::limits;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use opentrader_core::data::market_rest::economics;
use opentrader_core::data::provider::entitlements;
use opentrader_core::data::symbol::SymbolRef;
use opentrader_core::data::types::SubscribeMsg;
use opentrader_core::screener::{fields, scan};
use opentrader_core::{funding, history};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Panes one client may chart at once (the largest layout has 16).
const MAX_PANES: usize = 16;
/// Watchlist symbols one client may stream.
const MAX_WATCHLIST: usize = 500;

/// A failed call: its status and the error string the command returns.
struct Fail(StatusCode, String);

impl From<String> for Fail {
    fn from(e: String) -> Self {
        Fail(StatusCode::UNPROCESSABLE_ENTITY, e)
    }
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

type Answer = Result<serde_json::Value, Fail>;

fn ok<T: Serialize>(v: T) -> Answer {
    serde_json::to_value(v).map_err(|e| Fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

fn args<T: DeserializeOwned>(body: &Bytes) -> Result<T, Fail> {
    let body: &[u8] = if body.is_empty() { b"{}" } else { body };
    serde_json::from_slice(body).map_err(|e| Fail(StatusCode::BAD_REQUEST, format!("arguments: {e}")))
}

/// The calling client and its subscriptions; it must hold the events WebSocket.
fn connected_client(state: &Shared, headers: &HeaderMap) -> Result<(String, Arc<Mutex<Subs>>), Fail> {
    let client = client_of(headers)?;
    let subs = state
        .clients
        .connected(&client)
        .ok_or_else(|| Fail(StatusCode::CONFLICT, "open the events connection first".into()))?;
    Ok((client, subs))
}

fn client_of(headers: &HeaderMap) -> Result<String, Fail> {
    headers
        .get(CLIENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|id| valid_id(id))
        .map(str::to_string)
        .ok_or_else(|| Fail(StatusCode::BAD_REQUEST, format!("missing or invalid {CLIENT_HEADER} header")))
}

/// The symbols streamed for all visitors together stay under the cap
/// (OPENTRADER_MAX_LIVE_SYMBOLS): `adding` for this client (replacing its
/// chart `pane`, or its whole watchlist when `pane` is None).
fn live_room(state: &Shared, client: &str, subs: &Arc<Mutex<Subs>>, adding: &[String], pane: Option<&str>) -> Result<(), Fail> {
    let max = state.limits.max_live_symbols;
    if max == 0 {
        return Ok(());
    }
    let mut all = state.clients.live_symbols(client);
    {
        let s = subs.lock().unwrap();
        for (p, sym) in &s.charts {
            if pane != Some(p.as_str()) {
                all.insert(sym.clone());
            }
        }
        if pane.is_some() {
            all.extend(s.watchlist.iter().cloned());
        }
    }
    let before = all.len();
    all.extend(adding.iter().cloned());
    if all.len() > max && all.len() > before {
        return Err(Fail(StatusCode::SERVICE_UNAVAILABLE, "live data limit reached: no live updates for this symbol now".into()));
    }
    Ok(())
}

/// "ECONOMICS:<ID>": an economic series (no live data).
fn is_economic_symbol(symbol: &str) -> bool {
    symbol.split_once(':').is_some_and(|(ex, _)| economics::is_economic(ex))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Symbol {
    symbol: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Daily {
    symbol: String,
    days: u32,
    adjusted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Minute {
    symbol: String,
    days: u32,
    interval_min: u32,
    adjusted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Second {
    symbol: String,
    mult: u32,
    days: u32,
    adjusted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecondTail {
    symbol: String,
    mult: u32,
    since_sec: f64,
    adjusted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AggregatesBefore {
    symbol: String,
    timespan: String,
    mult: u32,
    before_sec: f64,
    span_days: u32,
    adjusted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DailyBefore {
    symbol: String,
    before_sec: f64,
    span_days: u32,
    adjusted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartSub {
    pane: String,
    symbol: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchSub {
    symbols: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    query: String,
    type_filter: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EconomicSearch {
    query: String,
    source: Option<String>,
    category: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct News {
    symbol: String,
    limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    owner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scan {
    req: scan::ScanRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Field {
    field: String,
}

pub async fn handle(
    State(state): State<Shared>,
    Path(command): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Calls per visitor IP (limits.rs).
    if let Some(ip) = limits::client_ip(&headers, Some(peer)) {
        if !state.limits.allow(ip) {
            return Fail(StatusCode::TOO_MANY_REQUESTS, "too many requests, try again in a moment".into()).into_response();
        }
    }
    match dispatch(&state, &command, &headers, &body).await {
        Ok(v) => Json(v).into_response(),
        Err(f) => f.into_response(),
    }
}

async fn dispatch(state: &Shared, command: &str, headers: &HeaderMap, body: &Bytes) -> Answer {
    let provider = &state.provider;
    match command {
        // ── History ──
        "get_daily_history" => {
            let a: Daily = args(body)?;
            ok(history::get_daily_history(provider, a.symbol, a.days, a.adjusted).await?)
        }
        "get_minute_history" => {
            let a: Minute = args(body)?;
            ok(history::get_minute_history(provider, a.symbol, a.days, a.interval_min, a.adjusted).await?)
        }
        "get_second_history" => {
            let a: Second = args(body)?;
            ok(history::get_second_history(provider, a.symbol, a.mult, a.days, a.adjusted).await?)
        }
        "get_second_history_tail" => {
            let a: SecondTail = args(body)?;
            ok(history::get_second_history_tail(provider, a.symbol, a.mult, a.since_sec, a.adjusted).await?)
        }
        "get_aggregates_before" => {
            let a: AggregatesBefore = args(body)?;
            ok(history::get_aggregates_before(provider, a.symbol, a.timespan, a.mult, a.before_sec, a.span_days, a.adjusted)
                .await?)
        }
        "get_daily_history_before" => {
            let a: DailyBefore = args(body)?;
            ok(history::get_daily_history_before(provider, a.symbol, a.before_sec, a.span_days, a.adjusted).await?)
        }
        // The cache is shared by every visitor: a visitor's "Clear cache" leaves it.
        "clear_cache" => ok(()),

        // ── Live subscriptions (owner = client, as the window label on desktop) ──
        "set_chart_subscription" => {
            let (client, subs) = connected_client(state, headers)?;
            let a: ChartSub = args(body)?;
            let symbol = a.symbol.map(|s| s.to_uppercase()).filter(|s| !is_economic_symbol(s));
            if let Some(s) = &symbol {
                live_room(state, &client, &subs, std::slice::from_ref(s), Some(&a.pane))?;
            }
            {
                let mut subs = subs.lock().unwrap();
                match &symbol {
                    Some(s) => {
                        if !subs.charts.contains_key(&a.pane) && subs.charts.len() >= MAX_PANES {
                            return Err(Fail(StatusCode::TOO_MANY_REQUESTS, "too many charts".into()));
                        }
                        subs.charts.insert(a.pane.clone(), s.clone());
                    }
                    None => {
                        subs.charts.remove(&a.pane);
                    }
                }
            }
            let owner = format!("{client}:{}", a.pane);
            send(state, SubscribeMsg::SetChart { owner, symbol }).await
        }
        "set_watchlist_subscription" => {
            let (client, subs) = connected_client(state, headers)?;
            let a: WatchSub = args(body)?;
            let symbols: Vec<String> =
                a.symbols.into_iter().map(|s| s.to_uppercase()).filter(|s| !is_economic_symbol(s)).collect();
            if symbols.len() > MAX_WATCHLIST {
                return Err(Fail(StatusCode::TOO_MANY_REQUESTS, "too many watchlist symbols".into()));
            }
            live_room(state, &client, &subs, &symbols, None)?;
            subs.lock().unwrap().watchlist = symbols.iter().cloned().collect();
            send(state, SubscribeMsg::SetWatchlist { owner: client, symbols }).await
        }

        // ── Reference ──
        "get_ticker_info" => {
            let a: Symbol = args(body)?;
            ok(provider.ticker_info(&SymbolRef::parse(&a.symbol)).await.map_err(|e| e.to_string())?)
        }
        "get_symbol_session" => {
            let a: Symbol = args(body)?;
            ok(provider.symbol_session(&SymbolRef::parse(&a.symbol)).await.map_err(|e| e.to_string())?)
        }
        "get_ticker_snapshot" => {
            let a: Symbol = args(body)?;
            ok(provider.ticker_snapshot(&SymbolRef::parse(&a.symbol)).await.map_err(|e| e.to_string())?)
        }
        "search_tickers" => {
            let a: Search = args(body)?;
            ok(provider.search(a.query.trim(), a.type_filter.as_deref()).await.map_err(|e| e.to_string())?)
        }
        "search_economic" => {
            let a: EconomicSearch = args(body)?;
            let filter = economics::Filter { source: a.source.as_deref(), category: a.category.as_deref() };
            ok(economics::search_filtered(a.query.trim(), &filter))
        }
        "economic_sources" => ok(economics::sources()),

        // ── Chart events ──
        "get_dividends" => {
            let a: Symbol = args(body)?;
            ok(provider.dividends(&SymbolRef::parse(&a.symbol)).await.map_err(|e| e.to_string())?)
        }
        "get_splits" => {
            let a: Symbol = args(body)?;
            ok(provider.splits(&SymbolRef::parse(&a.symbol)).await.map_err(|e| e.to_string())?)
        }
        "get_latest_news" => {
            let a: News = args(body)?;
            ok(provider.latest_news(&SymbolRef::parse(&a.symbol), a.limit.clamp(1, 50)).await)
        }
        "get_fundamentals" => {
            let a: Symbol = args(body)?;
            let f = provider.fundamentals(&SymbolRef::parse(&a.symbol)).await.map_err(|e| e.to_string())?;
            ok(&*f)
        }

        // ── Provider ──
        "get_data_provider" => ok(provider.name()),
        "get_provider_capabilities" => ok(entitlements::full_capabilities(provider)),
        "get_funding_status" => ok(funding::get_funding_status().await?),

        // ── Screener (owners prefixed with the client, so tabs stay apart) ──
        "screener_open" => {
            let (client, subs) = connected_client(state, headers)?;
            let a: Owner = args(body)?;
            let owner = format!("{client}/{}", a.owner);
            subs.lock().unwrap().screener_owners.insert(owner.clone());
            ok(state.screener.open(state.host.clone(), owner))
        }
        "screener_close" => {
            let client = client_of(headers)?;
            let a: Owner = args(body)?;
            let owner = format!("{client}/{}", a.owner);
            if let Some(subs) = state.clients.connected(&client) {
                subs.lock().unwrap().screener_owners.remove(&owner);
            }
            state.screener.close(&owner);
            ok(())
        }
        "screener_scan" => {
            let a: Scan = args(body)?;
            ok(scan::run(&state.screener.table(), &a.req)?)
        }
        "screener_fields" => ok(fields::catalog(&state.screener.table())),
        "screener_values" => {
            let a: Field = args(body)?;
            ok(fields::text_values(&state.screener.table(), &a.field)?)
        }

        _ => Err(Fail(StatusCode::NOT_FOUND, format!("unknown command: {command}"))),
    }
}

async fn send(state: &Shared, msg: SubscribeMsg) -> Answer {
    state.live.tx.send(msg).await.map_err(|e| format!("realtime task dropped: {e}"))?;
    ok(())
}
