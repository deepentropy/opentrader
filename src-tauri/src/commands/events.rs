/*
 * Chart event commands (Events tab: Dividends / Splits / Latest news), the
 * fundamentals and the filings. The bodies are shared with the web server
 * (`opentrader_core::commands`).
 */
use crate::data::provider::Provider;
use crate::data::types::{DividendEvent, FilingList, FilingQuery, FilingText, Fundamentals, NewsItem, SplitEvent};
use opentrader_core::commands as core;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn get_dividends(provider: State<'_, Provider>, symbol: String) -> Result<Vec<DividendEvent>, String> {
    Ok(core::dividends(&provider, &symbol).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_splits(provider: State<'_, Provider>, symbol: String) -> Result<Vec<SplitEvent>, String> {
    Ok(core::splits(&provider, &symbol).await?)
}

/// Newest headlines for `symbol` (Events → Latest news lollipop).
#[tauri::command]
#[specta::specta]
pub async fn get_latest_news(provider: State<'_, Provider>, symbol: String, limit: u32) -> Result<Vec<NewsItem>, String> {
    Ok(core::latest_news(&provider, &symbol, limit).await)
}

/// Financial statement items and earnings releases of the company behind
/// `symbol` (Fundamentals metrics, Events → Earnings).
#[tauri::command]
#[specta::specta]
pub async fn get_fundamentals(provider: State<'_, Provider>, symbol: String) -> Result<Fundamentals, String> {
    Ok(core::fundamentals(&provider, &symbol).await?)
}

/// A page of the filings of the company behind `symbol`, newest first (the
/// coding agents' `list_filings`).
#[tauri::command]
#[specta::specta]
pub async fn get_filings(provider: State<'_, Provider>, symbol: String, query: FilingQuery) -> Result<FilingList, String> {
    Ok(core::filings(&provider, &symbol, &query).await?)
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
    Ok(core::read_filing(&provider, &symbol, &accn, section.as_deref(), offset).await?)
}
