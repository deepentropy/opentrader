/*
 * Small JSON files the app keeps (settings, window bounds, the alert engine's
 * last quotes). A save writes a temporary file next to the target and renames
 * it over, so a crash or a full disk mid-write leaves the previous file whole
 * instead of a truncated one that would read as defaults at the next start.
 */
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::Write as _;
use std::path::Path;

/// The file's value, or the default when it is missing or unreadable.
pub fn load_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Write `value` as indented JSON, atomically (see the top of this file).
pub fn save_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_atomic(path, &bytes)
}

/// Write `bytes` to `path` through a temporary file renamed over it; the
/// folder is created when missing.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // One temporary file per write: two writers of the same file (a debounced
    // save and a save on close) never write into each other's; the last
    // rename wins, with a whole file either way.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".{}-{n}.tmp", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    match written.and_then(|_| std::fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize, Default, PartialEq, Debug)]
    struct Settings {
        port: u16,
    }

    #[test]
    fn saves_over_the_previous_file_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("opentrader-files-test-{}", std::process::id()));
        let path = dir.join("nested").join("settings.json");
        assert_eq!(load_or_default::<Settings>(&path), Settings::default());
        save_json(&path, &Settings { port: 1 }).unwrap();
        save_json(&path, &Settings { port: 2 }).unwrap();
        assert_eq!(load_or_default::<Settings>(&path), Settings { port: 2 });
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("settings.json")], "no temporary file left");
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load_or_default::<Settings>(&path), Settings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
