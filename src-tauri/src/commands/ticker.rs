/*
 * Ticker reference + snapshot commands — back the WatchlistDetail panel. All
 * lookups route through the injected `DataProvider`; the returned shapes
 * (`TickerInfo`, `Snapshot`, `SymbolSearchResult`) are vendor-neutral.
 */
use crate::data::provider::Provider;
use crate::data::types::{Snapshot, SymbolSearchResult, TickerInfo};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_ticker_info(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<TickerInfo, String> {
    provider
        .ticker_info(&symbol.to_uppercase())
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
        .ticker_snapshot(&symbol.to_uppercase())
        .await
        .map_err(|e| e.to_string())
}

/// Symbol-search typeahead over the provider's reference universe. `type_filter`
/// is an optional security type (e.g. "ETF") from the dialog's Type chip.
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
