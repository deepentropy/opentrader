/*
 * Chart event commands (Events tab: Dividends / Splits / Latest news). Route through the
 * injected `DataProvider`; markers are decorative, so a failing endpoint yields
 * an empty list rather than an error.
 */
use crate::data::provider::Provider;
use crate::data::types::{DividendEvent, NewsItem, SplitEvent};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_dividends(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Vec<DividendEvent>, String> {
    Ok(provider.dividends(&symbol.to_uppercase()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn get_splits(
    provider: State<'_, Provider>,
    symbol: String,
) -> Result<Vec<SplitEvent>, String> {
    Ok(provider.splits(&symbol.to_uppercase()).await)
}

/// Newest headlines for `symbol` (Events → Latest news lollipop).
#[tauri::command]
#[specta::specta]
pub async fn get_latest_news(
    provider: State<'_, Provider>,
    symbol: String,
    limit: u32,
) -> Result<Vec<NewsItem>, String> {
    Ok(provider.latest_news(&symbol.to_uppercase(), limit.clamp(1, 50)).await)
}
