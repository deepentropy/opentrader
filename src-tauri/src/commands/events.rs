/*
 * Chart event commands (Events tab: Dividends / Splits / Latest news), the
 * fundamentals and the filings. The bodies are shared with the web server
 * (`opentrader_core::commands`).
 */
use crate::data::provider::Provider;
use crate::data::types::{DividendEvent, FilingList, FilingQuery, FilingText, Fundamentals, NewsItem, RevenueBreakdown, SplitEvent};
use crate::plugins::data as plugin;
use opentrader_core::commands as core;
use tauri::{AppHandle, State};

/// A data plugin's symbol has no events, fundamentals or filings: they come
/// from the gateway, which doesn't know the plugin's symbols (#355).
fn from_plugin(app: &AppHandle, symbol: &str) -> bool {
    plugin::route(app, symbol).is_some()
}

fn not_from_plugin(what: &str) -> String {
    format!("{what} are not available for a data plugin's symbol")
}

#[tauri::command]
#[specta::specta]
pub async fn get_dividends(app: AppHandle, provider: State<'_, Provider>, symbol: String) -> Result<Vec<DividendEvent>, String> {
    if from_plugin(&app, &symbol) {
        return Ok(Vec::new());
    }
    Ok(core::dividends(&provider, &symbol).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_splits(app: AppHandle, provider: State<'_, Provider>, symbol: String) -> Result<Vec<SplitEvent>, String> {
    if from_plugin(&app, &symbol) {
        return Ok(Vec::new());
    }
    Ok(core::splits(&provider, &symbol).await?)
}

/// Newest headlines for `symbol` (Events → Latest news lollipop).
#[tauri::command]
#[specta::specta]
pub async fn get_latest_news(app: AppHandle, provider: State<'_, Provider>, symbol: String, limit: u32) -> Result<Vec<NewsItem>, String> {
    if from_plugin(&app, &symbol) {
        return Ok(Vec::new());
    }
    Ok(core::latest_news(&provider, &symbol, limit).await)
}

/// Financial statement items and earnings releases of the company behind
/// `symbol` (Fundamentals metrics, Events → Earnings).
#[tauri::command]
#[specta::specta]
pub async fn get_fundamentals(app: AppHandle, provider: State<'_, Provider>, symbol: String) -> Result<Fundamentals, String> {
    if from_plugin(&app, &symbol) {
        return Err(not_from_plugin("fundamentals"));
    }
    Ok(core::fundamentals(&provider, &symbol).await?)
}

/// A page of the filings of the company behind `symbol`, newest first (the
/// coding agents' `list_filings`).
#[tauri::command]
#[specta::specta]
pub async fn get_filings(app: AppHandle, provider: State<'_, Provider>, symbol: String, query: FilingQuery) -> Result<FilingList, String> {
    if from_plugin(&app, &symbol) {
        return Err(not_from_plugin("filings"));
    }
    Ok(core::filings(&provider, &symbol, &query).await?)
}

/// The contents of filing `accn` of the company behind `symbol` (no
/// `section`), or a page of one section's text from `offset` (`read_filing`).
#[tauri::command]
#[specta::specta]
pub async fn read_filing(
    app: AppHandle,
    provider: State<'_, Provider>,
    symbol: String,
    accn: String,
    section: Option<String>,
    offset: Option<u32>,
) -> Result<FilingText, String> {
    if from_plugin(&app, &symbol) {
        return Err(not_from_plugin("filings"));
    }
    Ok(core::read_filing(&provider, &symbol, &accn, section.as_deref(), offset).await?)
}

/// Revenue by segment, product line, country or region and major customer of
/// the company behind `symbol`, per filing (`get_revenue_breakdown`).
#[tauri::command]
#[specta::specta]
pub async fn get_revenue_breakdown(app: AppHandle, provider: State<'_, Provider>, symbol: String) -> Result<RevenueBreakdown, String> {
    if from_plugin(&app, &symbol) {
        return Err(not_from_plugin("revenue breakdowns"));
    }
    Ok(core::revenue_breakdown(&provider, &symbol).await?)
}
