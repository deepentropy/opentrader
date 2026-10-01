/*
 * Chart event commands (Events tab: Dividends / Splits / Latest news). Route through the
 * injected `DataProvider`; markers are decorative, so a failing endpoint yields
 * an empty list rather than an error.
 */
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::{DividendEvent, NewsItem, SplitEvent};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_dividends(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Vec<DividendEvent>, String> {
    Ok(provider.dividends(&SymbolRef::parse(&symbol)).await)
}

#[tauri::command]
#[specta::specta]
pub async fn get_splits(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Vec<SplitEvent>, String> {
    Ok(provider.splits(&SymbolRef::parse(&symbol)).await)
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
