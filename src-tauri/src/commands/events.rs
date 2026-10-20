/*
 * Chart event commands (Events tab: Dividends / Splits / Latest news). Route through the
 * injected `DataProvider`; markers are decorative, so a failing endpoint yields
 * an empty list rather than an error.
 */
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::{DividendEvent, Fundamentals, NewsItem, SplitEvent};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_dividends(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Vec<DividendEvent>, String> {
    provider.dividends(&SymbolRef::parse(&symbol)).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_splits(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Vec<SplitEvent>, String> {
    provider.splits(&SymbolRef::parse(&symbol)).await.map_err(|e| e.to_string())
}

/// Newest headlines for `symbol` (Events → Latest news lollipop).
#[tauri::command]
#[specta::specta]
pub async fn get_latest_news(
    provider: State<'_, Provider>,
    symbol: String,
    limit: u32,
) -> Result<Vec<NewsItem>, String> {
    Ok(provider.latest_news(&SymbolRef::parse(&symbol), limit.clamp(1, 50)).await)
}

/// Financial statement items and earnings releases of the company behind
/// `symbol` (Fundamentals metrics, Events → Earnings).
#[tauri::command]
#[specta::specta]
pub async fn get_fundamentals(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Fundamentals, String> {
    provider
        .fundamentals(&SymbolRef::parse(&symbol))
        .await
        .map(|f| (*f).clone())
        .map_err(|e| e.to_string())
}
