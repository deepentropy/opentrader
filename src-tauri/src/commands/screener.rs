/*
 * Screener commands. `screener_open` / `screener_close` start and stop the
 * 10 s market poll per panel (owner = "<window label>:screener"); scans run
 * on the in-memory table (see `screener/`).
 */
use crate::screener::fields::{self, FieldInfo};
use crate::screener::scan::{self, ScanRequest, ScanResult};
use crate::screener::{Screener, ScreenerStatus};
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn screener_open(
    app: AppHandle,
    screener: State<'_, Screener>,
    owner: String,
) -> Result<ScreenerStatus, String> {
    Ok(screener.open(app, owner))
}

#[tauri::command]
#[specta::specta]
pub async fn screener_close(screener: State<'_, Screener>, owner: String) -> Result<(), String> {
    screener.close(&owner);
    Ok(())
}

/// Filter, sort and page the current table (TradingView `/scan` grammar).
#[tauri::command]
#[specta::specta]
pub async fn screener_scan(
    screener: State<'_, Screener>,
    req: ScanRequest,
) -> Result<ScanResult, String> {
    let table = screener.table();
    scan::run(&table, &req)
}

/// The field ids a scan accepts, and whether their source is loaded.
#[tauri::command]
#[specta::specta]
pub async fn screener_fields(screener: State<'_, Screener>) -> Result<Vec<FieldInfo>, String> {
    Ok(fields::catalog(&screener.table()))
}
