/*
 * Ticker reference + snapshot commands — back the WatchlistDetail panel and
 * the symbol search. The bodies are shared with the web server
 * (`opentrader_core::commands`); the returned shapes are vendor-neutral.
 */
use crate::data::provider::Provider;
use crate::data::session::SymbolSession;
use crate::data::types::{Snapshot, SymbolSearchResult, TickerInfo};
use opentrader_core::commands as core;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_ticker_info(provider: State<'_, Provider>, symbol: String) -> Result<TickerInfo, String> {
    Ok(core::ticker_info(&provider, &symbol).await?)
}

/// Trading sessions of a symbol (time zone, regular / extended hours,
/// holidays) — read before its first bars, so every session-dependent view
/// follows the symbol's own market.
#[tauri::command]
#[specta::specta]
pub async fn get_symbol_session(provider: State<'_, Provider>, symbol: String) -> Result<SymbolSession, String> {
    Ok(core::symbol_session(&provider, &symbol).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_ticker_snapshot(provider: State<'_, Provider>, symbol: String) -> Result<Snapshot, String> {
    Ok(core::ticker_snapshot(&provider, &symbol).await?)
}

/// Symbol-search typeahead over the provider's reference universe. `type_filter`
/// is an optional security type (e.g. "etf") from the dialog's Type chip.
#[tauri::command]
#[specta::specta]
pub async fn search_tickers(
    provider: State<'_, Provider>,
    query: String,
    type_filter: Option<String>,
) -> Result<Vec<SymbolSearchResult>, String> {
    Ok(core::search_tickers(&provider, &query, type_filter.as_deref()).await?)
}

/// Economy tab of the symbol search: the series matching `query` (the most
/// popular for an empty query) within a source agency and / or a category.
#[tauri::command]
#[specta::specta]
pub async fn search_economic(
    query: String,
    source: Option<String>,
    category: Option<String>,
) -> Result<Vec<SymbolSearchResult>, String> {
    Ok(core::search_economic(&query, source.as_deref(), category.as_deref()))
}

/// The source agencies of the economic series catalog, most series first.
#[tauri::command]
#[specta::specta]
pub async fn economic_sources() -> Result<Vec<String>, String> {
    Ok(core::economic_sources())
}
