/*
 * Ticker reference + snapshot commands — back the WatchlistDetail panel. All
 * lookups route through the injected `DataProvider`; the returned shapes
 * (`TickerInfo`, `Snapshot`, `SymbolSearchResult`) are vendor-neutral.
 */
use crate::data::provider::Provider;
use crate::data::session::SymbolSession;
use crate::data::symbol::SymbolRef;
use crate::data::types::{Snapshot, SymbolSearchResult, TickerInfo};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_ticker_info(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<TickerInfo, String> {
    provider
        .ticker_info(&SymbolRef::parse(&symbol))
        .await
        .map_err(|e| e.to_string())
}

/// Trading sessions of a symbol (time zone, regular / extended hours,
/// holidays) — read before its first bars, so every session-dependent view
/// follows the symbol's own market.
#[tauri::command]
#[specta::specta]
pub async fn get_symbol_session(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<SymbolSession, String> {
    provider
        .symbol_session(&SymbolRef::parse(&symbol))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_ticker_snapshot(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Snapshot, String> {
    provider
        .ticker_snapshot(&SymbolRef::parse(&symbol))
        .await
        .map_err(|e| e.to_string())
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
    provider
        .search(query.trim(), type_filter.as_deref())
        .await
        .map_err(|e| e.to_string())
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
    use crate::data::market_rest::economics;
    let filter = economics::Filter { source: source.as_deref(), category: category.as_deref() };
    Ok(economics::search_filtered(query.trim(), &filter))
}

/// The source agencies of the economic series catalog, most series first.
#[tauri::command]
#[specta::specta]
pub async fn economic_sources() -> Result<Vec<String>, String> {
    Ok(crate::data::market_rest::economics::sources())
}
