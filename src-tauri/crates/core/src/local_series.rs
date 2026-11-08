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
}
