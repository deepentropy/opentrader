/*
 * `POST /api/invoke/<command>` — the desktop commands the web version needs,
 * with the arguments named as the bindings send them (camelCase). Their bodies
 * and argument structs are the core's (`opentrader_core::commands`), shared
 * with the desktop app; what is left here is the web part: the client of a
 * call, its limits, and the HTTP status of an error. Commands of the desktop
 * shell (windows, updater, files, the alert engine) and the webhook relay are
 * not served: the web frontend has its own backing for them.
 */
use crate::clients::{valid_id, Subs, CLIENT_HEADER};
use crate::limits;
use crate::Shared;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use opentrader_core::commands::{self as core, args};
use opentrader_core::data::types::SubscribeMsg;
use opentrader_core::error::Error;
use opentrader_core::sync::LockExt;
use opentrader_core::history;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

/// Panes one client may chart at once (the largest layout has 16).
const MAX_PANES: usize = 16;
/// Watchlist symbols one client may stream.
const MAX_WATCHLIST: usize = 500;

/// A failed call: its status and the error string the command returns.
struct Fail(StatusCode, String);

/// The status of each kind of core error.
impl From<Error> for Fail {
    fn from(e: Error) -> Self {
        let status = match &e {
            Error::NotFound(_) => StatusCode::NOT_FOUND,
            Error::InvalidInput(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Error::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Error::Upstream(_) => StatusCode::BAD_GATEWAY,
            Error::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Fail(status, e.to_string())
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
        let s = subs.locked();
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

/// One route per served command: `ROUTES` names them (checked against
/// `core::SERVED` in the tests) and `dispatch` calls the function of that name.
macro_rules! routes {
    ($($name:ident),* $(,)?) => {
        #[cfg(test)]
        const ROUTES: &[&str] = &[$(stringify!($name)),*];

        async fn dispatch(state: &Shared, command: &str, headers: &HeaderMap, body: &Bytes) -> Answer {
            match command {
                $(stringify!($name) => $name(state, headers, body).await,)*
                _ => Err(Fail(StatusCode::NOT_FOUND, format!("unknown command: {command}"))),
            }
        }
    };
}

routes!(
    get_daily_history,
    get_minute_history,
    get_second_history,
    get_second_history_tail,
    get_aggregates_before,
    get_daily_history_before,
    clear_cache,
    set_chart_subscription,
    set_watchlist_subscription,
    get_ticker_info,
    get_symbol_session,
    get_ticker_snapshot,
    search_tickers,
    search_economic,
    economic_sources,
    get_dividends,
    get_splits,
    get_latest_news,
    get_fundamentals,
    get_filings,
    read_filing,
    get_data_provider,
    get_provider_capabilities,
    screener_open,
    screener_close,
    screener_scan,
    screener_fields,
    screener_custom_fields,
    screener_values,
    screener_progress,
);

// ── History ──

async fn get_daily_history(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Daily = args(body)?;
    ok(history::get_daily_history(&state.provider, a.symbol, a.days, a.adjusted).await?)
}

async fn get_minute_history(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Minute = args(body)?;
    ok(history::get_minute_history(&state.provider, a.symbol, a.days, a.interval_min, a.adjusted).await?)
}

async fn get_second_history(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Second = args(body)?;
    ok(history::get_second_history(&state.provider, a.symbol, a.mult, a.days, a.adjusted).await?)
}

async fn get_second_history_tail(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::SecondTail = args(body)?;
    ok(history::get_second_history_tail(&state.provider, a.symbol, a.mult, a.since_sec, a.adjusted).await?)
}

async fn get_aggregates_before(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::AggregatesBefore = args(body)?;
    ok(history::get_aggregates_before(&state.provider, a.symbol, a.timespan, a.mult, a.before_sec, a.span_days, a.adjusted).await?)
}

async fn get_daily_history_before(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::DailyBefore = args(body)?;
    ok(history::get_daily_history_before(&state.provider, a.symbol, a.before_sec, a.span_days, a.adjusted).await?)
}

/// The cache is shared by every visitor: a visitor's "Clear cache" leaves it.
async fn clear_cache(_: &Shared, _: &HeaderMap, _: &Bytes) -> Answer {
    ok(())
}

// ── Live subscriptions (owner = client, as the window label on desktop) ──

async fn set_chart_subscription(state: &Shared, headers: &HeaderMap, body: &Bytes) -> Answer {
    let (client, subs) = connected_client(state, headers)?;
    let a: args::ChartSubscription = args(body)?;
    let symbol = core::live_symbol(a.symbol);
    if let Some(s) = &symbol {
        live_room(state, &client, &subs, std::slice::from_ref(s), Some(&a.pane))?;
    }
    {
        let mut subs = subs.locked();
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
    let owner = core::chart_owner(&client, &a.pane);
    ok(core::subscribe(&state.live, SubscribeMsg::SetChart { owner, symbol }).await?)
}

async fn set_watchlist_subscription(state: &Shared, headers: &HeaderMap, body: &Bytes) -> Answer {
    let (client, subs) = connected_client(state, headers)?;
    let a: args::WatchlistSubscription = args(body)?;
    let symbols = core::live_symbols(a.symbols);
    if symbols.len() > MAX_WATCHLIST {
        return Err(Fail(StatusCode::TOO_MANY_REQUESTS, "too many watchlist symbols".into()));
    }
    live_room(state, &client, &subs, &symbols, None)?;
    subs.locked().watchlist = symbols.iter().cloned().collect();
    ok(core::subscribe(&state.live, SubscribeMsg::SetWatchlist { owner: client, symbols }).await?)
}

// ── Reference ──

async fn get_ticker_info(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Symbol = args(body)?;
    ok(core::ticker_info(&state.provider, &a.symbol).await?)
}

async fn get_symbol_session(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Symbol = args(body)?;
    ok(core::symbol_session(&state.provider, &a.symbol).await?)
}

async fn get_ticker_snapshot(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Symbol = args(body)?;
    ok(core::ticker_snapshot(&state.provider, &a.symbol).await?)
}

async fn search_tickers(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Search = args(body)?;
    ok(core::search_tickers(&state.provider, &a.query, a.type_filter.as_deref()).await?)
}

async fn search_economic(_: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::EconomicSearch = args(body)?;
    ok(core::search_economic(&a.query, a.source.as_deref(), a.category.as_deref()))
}

async fn economic_sources(_: &Shared, _: &HeaderMap, _: &Bytes) -> Answer {
    ok(core::economic_sources())
}

// ── Chart events ──

async fn get_dividends(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Symbol = args(body)?;
    ok(core::dividends(&state.provider, &a.symbol).await?)
}

async fn get_splits(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Symbol = args(body)?;
    ok(core::splits(&state.provider, &a.symbol).await?)
}

async fn get_latest_news(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::News = args(body)?;
    ok(core::latest_news(&state.provider, &a.symbol, a.limit).await)
}

async fn get_fundamentals(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Symbol = args(body)?;
    ok(core::fundamentals(&state.provider, &a.symbol).await?)
}

async fn get_filings(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Filings = args(body)?;
    ok(core::filings(&state.provider, &a.symbol, &a.query).await?)
}

async fn read_filing(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::ReadFiling = args(body)?;
    ok(core::read_filing(&state.provider, &a.symbol, &a.accn, a.section.as_deref(), a.offset).await?)
}

// ── Provider ──

async fn get_data_provider(state: &Shared, _: &HeaderMap, _: &Bytes) -> Answer {
    ok(core::data_provider(&state.provider))
}

async fn get_provider_capabilities(state: &Shared, _: &HeaderMap, _: &Bytes) -> Answer {
    ok(core::provider_capabilities(&state.provider))
}

// ── Screener (owners prefixed with the client, so tabs stay apart) ──

async fn screener_open(state: &Shared, headers: &HeaderMap, body: &Bytes) -> Answer {
    let (client, subs) = connected_client(state, headers)?;
    let a: args::Owner = args(body)?;
    let owner = format!("{client}/{}", a.owner);
    subs.locked().screener_owners.insert(owner.clone());
    ok(state.screener.open(state.host.clone(), owner))
}

async fn screener_close(state: &Shared, headers: &HeaderMap, body: &Bytes) -> Answer {
    let client = client_of(headers)?;
    let a: args::Owner = args(body)?;
    let owner = format!("{client}/{}", a.owner);
    if let Some(subs) = state.clients.connected(&client) {
        subs.locked().screener_owners.remove(&owner);
    }
    state.screener.close(&owner);
    ok(())
}

async fn screener_scan(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Scan = args(body)?;
    ok(core::screener_scan(&state.screener, &a.req)?)
}

async fn screener_fields(state: &Shared, _: &HeaderMap, _: &Bytes) -> Answer {
    ok(core::screener_fields(&state.screener))
}

async fn screener_custom_fields(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::CustomFields = args(body)?;
    ok(state.screener.request_custom(a.ids))
}

async fn screener_values(state: &Shared, _: &HeaderMap, body: &Bytes) -> Answer {
    let a: args::Field = args(body)?;
    ok(core::screener_values(&state.screener, &a.field)?)
}

async fn screener_progress(state: &Shared, _: &HeaderMap, _: &Bytes) -> Answer {
    ok(core::screener_progress(&state.screener))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The server routes exactly the commands the core shares with the desktop
    /// app (whose tests check each is a registered desktop command).
    #[test]
    fn routes_are_the_served_commands() {
        let mut routes = ROUTES.to_vec();
        let mut served = core::SERVED.to_vec();
        routes.sort_unstable();
        served.sort_unstable();
        assert_eq!(routes, served);
    }

    #[test]
    fn error_kinds_pick_the_status() {
        assert_eq!(Fail::from(Error::not_found("x")).0, StatusCode::NOT_FOUND);
        assert_eq!(Fail::from(Error::invalid("x")).0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(Fail::from(Error::RateLimited("x".into())).0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(Fail::from(Error::upstream("x")).0, StatusCode::BAD_GATEWAY);
        assert_eq!(Fail::from(Error::io("x")).1, "x");
    }
}
