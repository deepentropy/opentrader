/*
 * Images kept in the app data folder, named by their content
 * (`<content hash>.<ext>`): the drawing images of the Image tool
 * (`drawing-images/`) and the chart snapshots of symbol notes (`note-images/`);
 * see `opentrader_core::images`.
 */
use opentrader_core::images;
use tauri::Manager as _;

fn images_dir(app: &tauri::AppHandle, folder: &str) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(folder))
}

/// Store an image (base64 bytes) and return its file name; the same bytes
/// always give the same name, so re-adding an image does not duplicate it.
#[tauri::command]
#[specta::specta]
pub fn save_drawing_image(app: tauri::AppHandle, data_base64: String, ext: String) -> Result<String, String> {
    Ok(images::save_drawing_image(&images_dir(&app, "drawing-images")?, &data_base64, &ext)?)
}

/// Read a stored drawing image back as base64.
#[tauri::command]
#[specta::specta]
pub fn read_drawing_image(app: tauri::AppHandle, name: String) -> Result<String, String> {
    Ok(images::read_image(&images_dir(&app, "drawing-images")?, &name)?)
}

/// Store the chart snapshot of a note and return its file name.
#[tauri::command]
#[specta::specta]
pub fn save_note_image(app: tauri::AppHandle, data_base64: String, ext: String) -> Result<String, String> {
    Ok(images::save_note_image(&images_dir(&app, "note-images")?, &data_base64, &ext)?)
}

/// Read the chart snapshot of a note back as base64.
#[tauri::command]
#[specta::specta]
pub fn read_note_image(app: tauri::AppHandle, name: String) -> Result<String, String> {
    Ok(images::read_image(&images_dir(&app, "note-images")?, &name)?)
}

/// Remove the chart snapshot of a note (a removed or edited note).
#[tauri::command]
#[specta::specta]
pub fn delete_note_image(app: tauri::AppHandle, name: String) -> Result<(), String> {
    Ok(images::delete_image(&images_dir(&app, "note-images")?, &name)?)
}
