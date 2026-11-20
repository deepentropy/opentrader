/*
 * Exported files (#369): CSV, spreadsheets, pictures and scripts the window
 * saves. As the reference desktop app, a file goes straight into the
 * downloads folder of Settings > General under a name of its own
 * ("<name>_<5 hex>.<ext>"), or through the system's Save dialog when the
 * user asks for it each time or the folder is gone. The window keeps the
 * settings and shows the result; the browser download it used before saved
 * without a word, so users could not tell where the file went.
 */
use std::path::{Path, PathBuf};
use tauri::Manager as _;

/// Longest file name the reference allows (room for the folder in a Windows path).
const MAX_NAME: usize = 214;
/// Length of the random part of a saved name.
const UID_LENGTH: usize = 5;

/// `name` with a random part before its extension, cut to `MAX_NAME`.
fn suffixed_name(name: &str, uid: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    };
    let room = MAX_NAME.saturating_sub(UID_LENGTH + 2 + ext.len());
    let stem: String = stem.chars().take(room).collect();
    if ext.is_empty() { format!("{stem}_{uid}") } else { format!("{stem}_{uid}.{ext}") }
}

fn random_uid() -> String {
    let mut b = [0u8; 3];
    let _ = getrandom::fill(&mut b);
    hex(&b)[..UID_LENGTH].to_string()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A name of `folder` no file has yet.
fn unique_path(folder: &Path, name: &str) -> PathBuf {
    loop {
        let p = folder.join(suffixed_name(name, &random_uid()));
        if !p.exists() {
            return p;
        }
    }
}

/// The system download folder: the default of Settings > General > Downloads.
#[tauri::command]
#[specta::specta]
pub fn downloads_default_folder(app: tauri::AppHandle) -> Option<String> {
    app.path().download_dir().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Settings > General > Downloads "Change": the system folder picker; none
/// when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn downloads_folder_pick(app: tauri::AppHandle, current: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file();
        if let Some(c) = current.filter(|c| Path::new(c).is_dir()) {
            d = d.set_directory(c);
        }
        d.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked {
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

/// Save an exported file. `contents` is text, or base64 bytes when
/// `base64`. `folder`: the downloads folder to save into without asking;
/// none (or a folder that is gone) opens the Save dialog in `dialog_folder`,
/// with `kind` naming the file type of its filter. Gives the saved path;
/// none when the user cancels the dialog.
#[tauri::command]
#[specta::specta]
pub async fn export_file_save(
    app: tauri::AppHandle,
    name: String,
    contents: String,
    base64: bool,
    kind: String,
    folder: Option<String>,
    dialog_folder: Option<String>,
) -> Result<Option<String>, String> {
    use base64::Engine as _;
    use tauri_plugin_dialog::DialogExt as _;
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD.decode(contents).map_err(|e| e.to_string())?
    } else {
        contents.into_bytes()
    };
    let direct = folder.map(PathBuf::from).filter(|f| f.is_dir());
    let path = match direct {
        Some(f) => unique_path(&f, &name),
        None => {
            let start = dialog_folder.map(PathBuf::from).filter(|f| f.is_dir()).or_else(|| app.path().download_dir().ok());
            let ext = Path::new(&name).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                let mut d = app.dialog().file();
                d = match &start {
                    Some(s) => d.set_directory(s).set_file_name(unique_path(s, &name).file_name().unwrap_or_default().to_string_lossy()),
                    None => d.set_file_name(&name),
                };
                if !ext.is_empty() {
                    d = d.add_filter(&kind, &[ext.as_str()]);
                }
                d.add_filter("All Files", &["*"]).blocking_save_file()
            })
            .await
            .map_err(|e| e.to_string())?;
            match picked {
                Some(p) => p.into_path().map_err(|e| e.to_string())?,
                None => return Ok(None),
            }
        }
    };
    let write = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, bytes))
    };
    write.await.map_err(|e| e.to_string())?.map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// "Show in folder": the folder in the system's file manager.
#[tauri::command]
#[specta::specta]
pub fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt as _;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_goes_before_the_extension() {
        assert_eq!(suffixed_name("LOCAL_BIG30, 60.csv", "a1b2c"), "LOCAL_BIG30, 60_a1b2c.csv");
        assert_eq!(suffixed_name("logs", "a1b2c"), "logs_a1b2c");
        assert_eq!(suffixed_name(".csv", "a1b2c"), ".csv_a1b2c");
    }

    #[test]
    fn long_names_are_cut_to_the_limit() {
        let long = format!("{}.xlsx", "x".repeat(400));
        let n = suffixed_name(&long, "a1b2c");
        assert_eq!(n.chars().count(), MAX_NAME);
        assert!(n.ends_with("_a1b2c.xlsx"));
    }

    #[test]
    fn unique_path_skips_taken_names() {
        let dir = std::env::temp_dir().join(format!("ot-files-{}", random_uid()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "a.csv");
        std::fs::write(&a, "x").unwrap();
        assert_ne!(unique_path(&dir, "a.csv"), a);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
