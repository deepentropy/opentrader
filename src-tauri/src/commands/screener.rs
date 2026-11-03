/*
 * Screener commands. `screener_open` / `screener_close` start and stop the
 * market table per panel (owner = "<window label>:screener"); scans run
 * on the in-memory table (see `screener/`).
 */
use crate::screener::fields::{self, FieldInfo};
use crate::screener::scan::{self, ScanRequest, ScanResult};
use crate::screener::progress::ScreenerProgress;
use crate::screener::{Screener, ScreenerStatus};
use opentrader_core::host::HostRef;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn screener_open(
    host: State<'_, HostRef>,
    screener: State<'_, Screener>,
    owner: String,
) -> Result<ScreenerStatus, String> {
    Ok(screener.open(host.inner().clone(), owner))
}

#[tauri::command]
#[specta::specta]
pub async fn screener_close(screener: State<'_, Screener>, owner: String) -> Result<(), String> {
    screener.close(&owner);
    Ok(())
}

/// Filter, sort and page the current table (the reference app `/scan` grammar).
#[tauri::command]
#[specta::specta]
pub async fn screener_scan(
    screener: State<'_, Screener>,
    req: ScanRequest,
) -> Result<ScanResult, String> {
    let table = screener.table();
    scan::run(&table, &req)
}

/// Download progress of what the next complete table waits on (the loading wheel).
#[tauri::command]
#[specta::specta]
pub async fn screener_progress(screener: State<'_, Screener>) -> Result<ScreenerProgress, String> {
    Ok(screener.progress())
}

/// The field ids a scan accepts, and whether their source is loaded.
#[tauri::command]
#[specta::specta]
pub async fn screener_fields(screener: State<'_, Screener>) -> Result<Vec<FieldInfo>, String> {
    Ok(fields::catalog(&screener.table()))
}

/// Ask for custom moving-average / RSI lengths ("EMA137", "SMA150", "RSI21"): they join the field catalog and the
/// scans from the table's next update. Returns the ids accepted.
#[tauri::command]
#[specta::specta]
pub async fn screener_custom_fields(screener: State<'_, Screener>, ids: Vec<String>) -> Result<Vec<String>, String> {
    Ok(screener.request_custom(ids))
}

/// Distinct values of a text field (sector, industry, type, exchange) in the
/// current table, sorted: the options of the checkbox filters.
#[tauri::command]
#[specta::specta]
pub async fn screener_values(screener: State<'_, Screener>, field: String) -> Result<Vec<String>, String> {
    fields::text_values(&screener.table(), &field)
}
