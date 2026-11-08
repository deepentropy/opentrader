/*
 * Imported bar series (`LOCAL:<NAME>` symbols), kept in the app data folder
 * (`<app data>/local-series/`); see `opentrader_core::local_series`.
 */
use opentrader_core::local_series::{self, LocalSeries};
use tauri::Manager as _;

fn series_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("local-series"))
}

/// The imported series, by name.
#[tauri::command]
#[specta::specta]
pub fn local_series_list(app: tauri::AppHandle) -> Result<Vec<LocalSeries>, String> {
    local_series::list(&series_dir(&app)?)
}

/// Store an imported series (replacing one of the same name); `rows` = time,
/// open, high, low, close, volume per bar.
#[tauri::command]
#[specta::specta]
pub async fn local_series_save(app: tauri::AppHandle, meta: LocalSeries, rows: Vec<f64>) -> Result<(), String> {
    let dir = series_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || local_series::save(&dir, &meta, &rows))
        .await
        .map_err(|e| e.to_string())?
}

/// The bars of an imported series, six values each.
#[tauri::command]
#[specta::specta]
pub async fn local_series_read(app: tauri::AppHandle, name: String) -> Result<Vec<f64>, String> {
    let dir = series_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || local_series::read(&dir, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub fn local_series_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    local_series::delete(&series_dir(&app)?, &name)
}

#[tauri::command]
#[specta::specta]
pub fn local_series_rename(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    local_series::rename(&series_dir(&app)?, &from, &to)
}
