/*
 * Chart event commands (Events tab: Dividends / Splits / Latest news). Route through the
 * injected `DataProvider`; markers are decorative, so a failing endpoint yields
 * an empty list rather than an error.
 */
use crate::data::provider::Provider;
use crate::data::symbol::SymbolRef;
use crate::data::types::{DividendEvent, FilingList, FilingQuery, FilingText, Fundamentals, NewsItem, SplitEvent};
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

/// A page of the filings of the company behind `symbol`, newest first (the
/// coding agents' `list_filings`).
#[tauri::command]
#[specta::specta]
pub async fn get_filings(
    provider: State<'_, Provider>,
    symbol: String,
    query: FilingQuery,
) -> Result<FilingList, String> {
    provider.filings(&SymbolRef::parse(&symbol), &query).await.map_err(|e| e.to_string())
}

/// The contents of filing `accn` of the company behind `symbol` (no
/// `section`), or a page of one section's text from `offset` (`read_filing`).
#[tauri::command]
#[specta::specta]
pub async fn read_filing(
    provider: State<'_, Provider>,
    symbol: String,
    accn: String,
    section: Option<String>,
    offset: Option<u32>,
) -> Result<FilingText, String> {
    provider
        .filing_text(&SymbolRef::parse(&symbol), &accn, section.as_deref(), offset.unwrap_or(0))
        .await
        .map_err(|e| e.to_string())
}
