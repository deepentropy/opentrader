/*
 * The commands the desktop app and the web server both answer, written once.
 * The desktop wraps each in a Tauri command (src-tauri/src/commands/), the
 * server routes `POST /api/invoke/<name>` to it (crates/server/src/invoke.rs)
 * with the argument structs of `args`, named as the bindings send them.
 *
 * `SERVED` lists those names: the desktop tests check each is a registered
 * command, the server tests that it routes exactly these.
 */
use crate::data::market_rest::economics;
use crate::data::provider::capabilities::ProviderCapabilities;
use crate::data::provider::{entitlements, Provider};
use crate::data::session::SymbolSession;
use crate::data::symbol::SymbolRef;
use crate::data::types::{
    DividendEvent, FilingList, FilingQuery, FilingText, Fundamentals, NewsItem, Snapshot, SplitEvent, SubscribeMsg,
    SymbolSearchResult, TickerInfo, WsHandle,
};
use crate::error::{Error, Result};
use crate::screener::fields::{self, FieldInfo};
use crate::screener::progress::ScreenerProgress;
use crate::screener::scan::{self, ScanRequest, ScanResult};
use crate::screener::Screener;

/// The commands the web server answers (the desktop answers them too).
pub const SERVED: &[&str] = &[
    "get_daily_history",
    "get_minute_history",
    "get_second_history",
    "get_second_history_tail",
    "get_aggregates_before",
    "get_daily_history_before",
    "clear_cache",
    "set_chart_subscription",
    "set_watchlist_subscription",
    "get_ticker_info",
    "get_symbol_session",
    "get_ticker_snapshot",
    "search_tickers",
    "search_economic",
    "economic_sources",
    "get_dividends",
    "get_splits",
    "get_latest_news",
    "get_fundamentals",
    "get_filings",
    "read_filing",
    "get_data_provider",
    "get_provider_capabilities",
    "get_funding_status",
    "screener_open",
    "screener_close",
    "screener_scan",
    "screener_fields",
    "screener_custom_fields",
    "screener_values",
    "screener_progress",
];

/// The arguments of the served commands as the bindings send them (camelCase).
pub mod args {
    use super::{FilingQuery, ScanRequest};
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Symbol {
        pub symbol: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Daily {
        pub symbol: String,
        pub days: u32,
        pub adjusted: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Minute {
        pub symbol: String,
        pub days: u32,
        pub interval_min: u32,
        pub adjusted: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Second {
        pub symbol: String,
        pub mult: u32,
        pub days: u32,
        pub adjusted: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SecondTail {
        pub symbol: String,
        pub mult: u32,
        pub since_sec: f64,
        pub adjusted: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AggregatesBefore {
        pub symbol: String,
        pub timespan: String,
        pub mult: u32,
        pub before_sec: f64,
        pub span_days: u32,
        pub adjusted: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DailyBefore {
        pub symbol: String,
        pub before_sec: f64,
        pub span_days: u32,
        pub adjusted: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ChartSubscription {
        pub pane: String,
        pub symbol: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WatchlistSubscription {
        pub symbols: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Search {
        pub query: String,
        pub type_filter: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct EconomicSearch {
        pub query: String,
        pub source: Option<String>,
        pub category: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct News {
        pub symbol: String,
        pub limit: u32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Filings {
        pub symbol: String,
        #[serde(default)]
        pub query: FilingQuery,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ReadFiling {
        pub symbol: String,
        pub accn: String,
        #[serde(default)]
        pub section: Option<String>,
        #[serde(default)]
        pub offset: Option<u32>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Owner {
        pub owner: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Scan {
        pub req: ScanRequest,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CustomFields {
        pub ids: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Field {
        pub field: String,
    }
}

// ── Live subscriptions ──

/// "ECONOMICS:<ID>": an economic series (no live data).
fn is_economic_symbol(symbol: &str) -> bool {
    symbol.split_once(':').is_some_and(|(ex, _)| economics::is_economic(ex))
}

/// The symbol a chart streams: upper case, none for an economic series.
pub fn live_symbol(symbol: Option<String>) -> Option<String> {
    symbol.map(|s| s.to_uppercase()).filter(|s| !is_economic_symbol(s))
}

/// The symbols a watchlist streams (see [`live_symbol`]).
pub fn live_symbols(symbols: Vec<String>) -> Vec<String> {
    symbols.into_iter().filter_map(|s| live_symbol(Some(s))).collect()
}

/// A chart's subscription owner: "<view>:<pane>", so multi-pane layouts and
/// other windows (or browser tabs) each hold their own charted symbol; the
/// live task unions them.
pub fn chart_owner(view: &str, pane: &str) -> String {
    format!("{view}:{pane}")
}

/// Hand a subscription change to the live-data task.
pub async fn subscribe(live: &WsHandle, msg: SubscribeMsg) -> Result<()> {
    live.tx.send(msg).await.map_err(|e| Error::upstream(format!("realtime task dropped: {e}")))
}

// ── Reference ──

pub async fn ticker_info(provider: &Provider, symbol: &str) -> Result<TickerInfo> {
    Ok(provider.ticker_info(&SymbolRef::parse(symbol)).await?)
}

pub async fn symbol_session(provider: &Provider, symbol: &str) -> Result<SymbolSession> {
    Ok(provider.symbol_session(&SymbolRef::parse(symbol)).await?)
}

pub async fn ticker_snapshot(provider: &Provider, symbol: &str) -> Result<Snapshot> {
    Ok(provider.ticker_snapshot(&SymbolRef::parse(symbol)).await?)
}

pub async fn search_tickers(provider: &Provider, query: &str, type_filter: Option<&str>) -> Result<Vec<SymbolSearchResult>> {
    Ok(provider.search(query.trim(), type_filter).await?)
}

pub fn search_economic(query: &str, source: Option<&str>, category: Option<&str>) -> Vec<SymbolSearchResult> {
    economics::search_filtered(query.trim(), &economics::Filter { source, category })
}

pub fn economic_sources() -> Vec<String> {
    economics::sources()
}

// ── Chart events ──

pub async fn dividends(provider: &Provider, symbol: &str) -> Result<Vec<DividendEvent>> {
    Ok(provider.dividends(&SymbolRef::parse(symbol)).await?)
}

pub async fn splits(provider: &Provider, symbol: &str) -> Result<Vec<SplitEvent>> {
    Ok(provider.splits(&SymbolRef::parse(symbol)).await?)
}

/// Markers are decorative: a failed lookup is an empty list.
pub async fn latest_news(provider: &Provider, symbol: &str, limit: u32) -> Vec<NewsItem> {
    provider.latest_news(&SymbolRef::parse(symbol), limit.clamp(1, 50)).await
}

pub async fn fundamentals(provider: &Provider, symbol: &str) -> Result<Fundamentals> {
    Ok((*provider.fundamentals(&SymbolRef::parse(symbol)).await?).clone())
}

pub async fn filings(provider: &Provider, symbol: &str, query: &FilingQuery) -> Result<FilingList> {
    Ok(provider.filings(&SymbolRef::parse(symbol), query).await?)
}

pub async fn read_filing(provider: &Provider, symbol: &str, accn: &str, section: Option<&str>, offset: Option<u32>) -> Result<FilingText> {
    Ok(provider.filing_text(&SymbolRef::parse(symbol), accn, section, offset.unwrap_or(0)).await?)
}

// ── Provider ──

pub fn data_provider(provider: &Provider) -> String {
    provider.name().to_string()
}

pub fn provider_capabilities(provider: &Provider) -> ProviderCapabilities {
    entitlements::full_capabilities(provider)
}

// ── Screener ──

pub fn screener_scan(screener: &Screener, req: &ScanRequest) -> Result<ScanResult> {
    scan::run(&screener.table(), req)
}

pub fn screener_fields(screener: &Screener) -> Vec<FieldInfo> {
    fields::catalog(&screener.table())
}

pub fn screener_values(screener: &Screener, field: &str) -> Result<Vec<String>> {
    fields::text_values(&screener.table(), field)
}

pub fn screener_progress(screener: &Screener) -> ScreenerProgress {
    screener.progress()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn economic_series_and_case_are_handled_before_the_live_task() {
        assert_eq!(live_symbol(Some("nasdaq:aapl".into())).as_deref(), Some("NASDAQ:AAPL"));
        assert_eq!(live_symbol(Some("ECONOMICS:UNRATE".into())), None);
        assert_eq!(live_symbols(vec!["spy".into(), "ECONOMICS:GDP".into()]), vec!["SPY".to_string()]);
        assert_eq!(chart_owner("main", "0"), "main:0");
    }

    #[test]
    fn served_names_are_unique() {
        let mut names = SERVED.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), SERVED.len());
    }
}
