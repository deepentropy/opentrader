/*
 * Imported bar series (`LOCAL:<NAME>` symbols), kept in the app data folder
 * (`<app data>/local-series/`); see `opentrader_core::local_series`.
 */
use opentrader_core::local_series::{self, FolderFile, LocalSeries};
use tauri::Manager as _;

fn series_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("local-series"))
}

/// The imported series, by name.
#[tauri::command]
#[specta::specta]
pub fn local_series_list(app: tauri::AppHandle) -> Result<Vec<LocalSeries>, String> {
    Ok(local_series::list(&series_dir(&app)?)?)
}

/// Store an imported series (replacing one of the same name); `rows` = time,
/// open, high, low, close, volume per bar.
#[tauri::command]
#[specta::specta]
pub async fn local_series_save(app: tauri::AppHandle, meta: LocalSeries, rows: Vec<f64>) -> Result<(), String> {
    let dir = series_dir(&app)?;
    let saved = tauri::async_runtime::spawn_blocking(move || local_series::save(&dir, &meta, &rows)).await;
    Ok(saved.map_err(|e| e.to_string())??)
}

/// The bars of an imported series, six values each.
#[tauri::command]
#[specta::specta]
pub async fn local_series_read(app: tauri::AppHandle, name: String) -> Result<Vec<f64>, String> {
    let dir = series_dir(&app)?;
    let bars = tauri::async_runtime::spawn_blocking(move || local_series::read(&dir, &name)).await;
    Ok(bars.map_err(|e| e.to_string())??)
}

#[tauri::command]
#[specta::specta]
pub fn local_series_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    Ok(local_series::delete(&series_dir(&app)?, &name)?)
}

#[tauri::command]
#[specta::specta]
pub fn local_series_rename(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    Ok(local_series::rename(&series_dir(&app)?, &from, &to)?)
}

/// Settings > Local data (#267): the folder picker of the system; none when
/// the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn local_folder_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("Folder of CSV files").blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    match picked {
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

/// The bar and symbol_info files at the top of a folder, with their size and
/// modification time (the directory only: no file is read).
#[tauri::command]
#[specta::specta]
pub async fn local_folder_scan(folder: String) -> Result<Vec<FolderFile>, String> {
    let files = tauri::async_runtime::spawn_blocking(move || local_series::scan_folder(std::path::Path::new(&folder))).await;
    Ok(files.map_err(|e| e.to_string())??)
}

/// The text of one file of a folder (`file` is a name the scan listed).
#[tauri::command]
#[specta::specta]
pub async fn local_folder_read(folder: String, file: String) -> Result<String, String> {
    let text = tauri::async_runtime::spawn_blocking(move || local_series::read_folder_file(std::path::Path::new(&folder), &file)).await;
    Ok(text.map_err(|e| e.to_string())??)
}
