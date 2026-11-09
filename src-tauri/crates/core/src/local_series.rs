/*
 * Imported bar series ("LOCAL:<NAME>" symbols, #266): bars the user loaded
 * from a CSV file, kept in a folder of the host (the desktop app:
 * `<app data>/local-series/`). Each series is two files: `<NAME>.json` (its
 * description, time zone, bar size…) and `<NAME>.bin` (the bars as
 * little-endian f64 rows: time, open, high, low, close, volume). The window
 * parses the file and serves the bars; this module only stores them.
 */
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Values per bar row: time, open, high, low, close, volume.
const ROW: usize = 6;
/// At most 5 million bars per series (about 240 MB on disk).
const MAX_BARS: usize = 5_000_000;

/// What the app knows of an imported series besides its bars.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSeries {
    /// Ticker part of the symbol: `^[A-Z0-9._-]{1,42}$`.
    pub name: String,
    pub description: String,
    /// IANA zone of the bars' days and of times written without an offset.
    pub timezone: String,
    /// Bar size of the file, as an interval id ("1D", "5", "1S"…).
    pub base: String,
    /// Price grid: 10^decimals.
    pub pricescale: u32,
    /// The file has a volume column.
    pub has_volume: bool,
    /// Bar count and first / last bar time (UNIX seconds).
    pub bars: u32,
    pub first: f64,
    pub last: f64,
    /// When it was imported (UNIX ms).
    pub imported: f64,
    /// The file of a synced folder it comes from (#267); none for a series
    /// imported by hand, which folder syncs leave alone.
    #[serde(default)]
    pub source: Option<LocalSource>,
}

/// The file a series was read from, as it was then: a sync reads the file
/// again only when its size or modification time changed.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSource {
    /// The folder, as the user picked it.
    pub folder: String,
    /// The file's name in it.
    pub file: String,
    /// Modification time (UNIX ms) and size in bytes.
    pub mtime: f64,
    pub size: f64,
}

/// A file of a synced folder: its name, modification time (UNIX ms) and size.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderFile {
    pub file: String,
    pub mtime: f64,
    pub size: f64,
}

/// Files a folder sync reads: bars (.csv, .tsv) and Pine Seeds symbol_info (.json).
fn folder_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".csv", ".tsv", ".json"].iter().any(|ext| lower.len() > ext.len() && lower.ends_with(ext))
}

/// The bar and symbol_info files at the top of a folder (not its subfolders),
/// by name. Only the directory is read, not the files.
pub fn scan_folder(folder: &Path) -> Result<Vec<FolderFile>, String> {
    let entries = std::fs::read_dir(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !folder_file(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_millis() as f64);
        out.push(FolderFile { file: name, mtime, size: meta.len() as f64 });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

/// The text of one file [`scan_folder`] lists (a bare file name: no path).
/// Bytes that are not UTF-8 are replaced; a byte order mark is dropped.
pub fn read_folder_file(folder: &Path, file: &str) -> Result<String, String> {
    if file.contains(['/', '\\']) || !folder_file(file) {
        return Err(format!("not a file of the folder: {file}"));
    }
    let bytes = std::fs::read(folder.join(file)).map_err(|e| format!("{file}: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Ticker names a series may take (they are also its file names).
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 42
        && name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

fn check_name(name: &str) -> Result<(), String> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(format!("invalid series name: {name} (A-Z, 0-9, '.', '_' or '-', at most 42)"))
    }
}

/// The stored series, by name.
pub fn list(dir: &Path) -> Result<Vec<LocalSeries>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A file another program left there, or one cut short: skipped.
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(meta) = serde_json::from_str::<LocalSeries>(&text) else { continue };
        if valid_name(&meta.name) && dir.join(format!("{}.bin", meta.name)).exists() {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Store a series (replacing one of the same name). `rows` holds the bars as
/// [`ROW`] values each, time-ascending.
pub fn save(dir: &Path, meta: &LocalSeries, rows: &[f64]) -> Result<(), String> {
    check_name(&meta.name)?;
    if rows.len() % ROW != 0 {
        return Err("bars must have 6 values each".into());
    }
    if rows.len() / ROW > MAX_BARS {
        return Err(format!("more than {MAX_BARS} bars"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(rows.len() * 8);
    for v in rows {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    // Bars first, description last: a series is listed only once both exist.
    std::fs::write(dir.join(format!("{}.bin", meta.name)), bytes).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", meta.name)), json).map_err(|e| e.to_string())
}

/// The bars of a series, [`ROW`] values each.
pub fn read(dir: &Path, name: &str) -> Result<Vec<f64>, String> {
    check_name(name)?;
    let bytes = std::fs::read(dir.join(format!("{name}.bin"))).map_err(|e| e.to_string())?;
    if bytes.len() % (ROW * 8) != 0 {
        return Err(format!("the bars of {name} are damaged"));
    }
    Ok(bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect())
}

/// Remove a series (no error when it is already gone).
pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    check_name(name)?;
    for ext in ["json", "bin"] {
        match std::fs::remove_file(dir.join(format!("{name}.{ext}"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Give a series another name (an error when that name is taken).
pub fn rename(dir: &Path, from: &str, to: &str) -> Result<(), String> {
    check_name(from)?;
    check_name(to)?;
    if from == to {
        return Ok(());
    }
    if dir.join(format!("{to}.json")).exists() {
        return Err(format!("a series named {to} exists"));
    }
    let text = std::fs::read_to_string(dir.join(format!("{from}.json"))).map_err(|e| e.to_string())?;
    let mut meta: LocalSeries = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    meta.name = to.to_string();
    std::fs::rename(dir.join(format!("{from}.bin")), dir.join(format!("{to}.bin"))).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{to}.json")), json).map_err(|e| e.to_string())?;
    std::fs::remove_file(dir.join(format!("{from}.json"))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str) -> LocalSeries {
        LocalSeries {
            name: name.into(),
            description: "Test".into(),
            timezone: "Etc/UTC".into(),
            base: "1D".into(),
            pricescale: 100,
            has_volume: true,
            bars: 2,
            first: 86400.0,
            last: 172800.0,
            imported: 0.0,
            source: None,
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ot-local-series-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn names() {
        assert!(valid_name("BTC_DEV-1.A"));
        assert!(!valid_name("btc"));
        assert!(!valid_name("../X"));
        assert!(!valid_name(""));
        assert!(!valid_name(&"A".repeat(43)));
    }

    #[test]
    fn save_list_read_rename_delete() {
        let dir = temp_dir("roundtrip");
        assert!(list(&dir).unwrap().is_empty());
        let rows = [86400.0, 1.0, 2.0, 0.5, 1.5, 10.0, 172800.0, 1.5, 2.5, 1.0, 2.0, 0.0];
        save(&dir, &meta("ABC"), &rows).unwrap();
        assert_eq!(list(&dir).unwrap(), vec![meta("ABC")]);
        assert_eq!(read(&dir, "ABC").unwrap(), rows);
        save(&dir, &meta("ZZZ"), &rows).unwrap();
        assert!(rename(&dir, "ABC", "ZZZ").is_err());
        rename(&dir, "ABC", "DEF").unwrap();
        let names: Vec<String> = list(&dir).unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names, ["DEF", "ZZZ"]);
        assert_eq!(read(&dir, "DEF").unwrap(), rows);
        delete(&dir, "DEF").unwrap();
        delete(&dir, "DEF").unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(save(&dir, &meta("BAD"), &rows[..5]).is_err());
        assert!(read(&dir, "../ZZZ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn older_description_reads_without_source() {
        let text = r#"{"name":"A","description":"","timezone":"Etc/UTC","base":"1D","pricescale":100,"hasVolume":false,"bars":1,"first":0,"last":0,"imported":0}"#;
        assert_eq!(serde_json::from_str::<LocalSeries>(text).unwrap().source, None);
    }

    #[test]
    fn folder_scan_and_read() {
        let dir = temp_dir("folder");
        std::fs::create_dir_all(dir.join("sub.csv")).unwrap();
        std::fs::write(dir.join("b.csv"), "\u{feff}time,close\n1,2\n").unwrap();
        std::fs::write(dir.join("a.TSV"), "x").unwrap();
        std::fs::write(dir.join("symbol_info.json"), "{}").unwrap();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        let files: Vec<String> = scan_folder(&dir).unwrap().into_iter().map(|f| f.file).collect();
        assert_eq!(files, ["a.TSV", "b.csv", "symbol_info.json"]);
        assert_eq!(read_folder_file(&dir, "b.csv").unwrap(), "time,close\n1,2\n");
        assert!(read_folder_file(&dir, "README.md").is_err());
        assert!(read_folder_file(&dir, "../b.csv").is_err());
        assert!(scan_folder(&dir.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
