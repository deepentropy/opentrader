/*
 * Drawing images (Image tool), kept in the app data folder
 * (`<app data>/drawing-images/<content hash>.<ext>`); see
 * `opentrader_core::images`.
 */
use opentrader_core::images;
use tauri::Manager as _;

fn images_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("drawing-images"))
}

/// Store an image (base64 bytes) and return its file name; the same bytes
/// always give the same name, so re-adding an image does not duplicate it.
#[tauri::command]
#[specta::specta]
pub fn save_drawing_image(app: tauri::AppHandle, data_base64: String, ext: String) -> Result<String, String> {
    images::save_drawing_image(&images_dir(&app)?, &data_base64, &ext)
}

/// Read a stored drawing image back as base64.
#[tauri::command]
#[specta::specta]
pub fn read_drawing_image(app: tauri::AppHandle, name: String) -> Result<String, String> {
    images::read_drawing_image(&images_dir(&app)?, &name)
}
