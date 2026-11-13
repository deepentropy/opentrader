/*
 * Plugin packages: a zip with `opentrader-plugin.json` at its root and the plugin's files. A package is *verified* when
 * its minisign signature checks against the app's release key: the catalog gives the signature with each package, a
 * file installed by hand may have it next to it (`<file>.sig`). An unverified package installs too, after the user
 * accepted the warning.
 */
use opentrader_core::plugins::manifest::{self, Manifest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The largest package accepted (a plugin is a small program; the largest file of a release stays far below).
const MAX_PACKAGE: u64 = 200 * 1024 * 1024;

/// One plugin of the catalog (`plugins/catalog.json` of the repository).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    pub provides: Vec<manifest::Capability>,
    pub api: u32,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    pub url: String,
    pub sha256: String,
    /// The package's minisign signature (base64, as `tauri signer sign` writes it).
    pub signature: String,
}

#[derive(Deserialize)]
struct Catalog {
    plugins: Vec<CatalogEntry>,
}

pub fn parse_catalog(bytes: &[u8]) -> Result<Vec<CatalogEntry>, String> {
    serde_json::from_slice::<Catalog>(bytes).map(|c| c.plugins).map_err(|e| format!("Plugin catalog: {e}"))
}

/// The manifest of a package (zip bytes), checked.
pub fn read_manifest(zip_bytes: &[u8]) -> Result<Manifest, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| format!("Not a plugin package: {e}"))?;
    let mut file = zip.by_name(manifest::FILE).map_err(|_| format!("Not a plugin package: no {} at its root", manifest::FILE))?;
    let mut bytes = Vec::new();
    file.by_ref().take(1024 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Manifest::parse(&bytes)
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The package file chosen by hand, and its signature when one lies next to it.
pub fn read_file(path: &Path) -> Result<(Vec<u8>, Option<String>), String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_PACKAGE {
        return Err("The file is too large for a plugin package".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut sig_path = path.as_os_str().to_owned();
    sig_path.push(".sig");
    let signature = std::fs::read_to_string(PathBuf::from(sig_path)).ok();
    Ok((bytes, signature))
}

/// Unpack the package into `dir` (replaced whole: an update leaves no file of the previous version). Unpacked next to
/// it first, so a broken package leaves the installed version as it was.
pub fn unpack(zip_bytes: &[u8], dir: &Path) -> Result<(), String> {
    let parent = dir.parent().ok_or("no plugins folder")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = dir.file_name().and_then(|n| n.to_str()).ok_or("bad plugin folder")?;
    let staging = parent.join(format!(".{name}.new"));
    let old = parent.join(format!(".{name}.old"));
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&old);
    // `extract` keeps every entry inside the folder (entries with `..` or absolute paths are refused).
    zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .and_then(|mut z| z.extract(&staging))
        .map_err(|e| format!("The package could not be unpacked: {e}"))?;
    if dir.exists() {
        std::fs::rename(dir, &old).map_err(|e| format!("The installed version is in use: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&staging, dir) {
        let _ = std::fs::rename(&old, dir);
        return Err(e.to_string());
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;

    /// A package with `files` (name, bytes); the manifest is the first.
    pub fn package(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut out);
            for (name, bytes) in files {
                z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                z.write_all(bytes).unwrap();
            }
            z.finish().unwrap();
        }
        out.into_inner()
    }

    pub fn manifest_json(id: &str, version: &str) -> String {
        serde_json::json!({
            "id": id, "name": "Test", "version": version, "api": 1, "provides": ["datafeed"], "exchange": "TST",
            "runtime": { "type": "external", "connectionFile": null }
        })
        .to_string()
    }

    #[test]
    fn reads_the_manifest_and_unpacks_over_the_previous_version() {
        let dir = std::env::temp_dir().join(format!("ot-plugin-test-{}", std::process::id())).join("tst");
        let v1 = package(&[(manifest::FILE, manifest_json("tst", "1.0.0").as_bytes()), ("old.txt", b"1")]);
        assert_eq!(read_manifest(&v1).unwrap().version, "1.0.0");
        unpack(&v1, &dir).unwrap();
        assert!(dir.join("old.txt").exists());
        let v2 = package(&[(manifest::FILE, manifest_json("tst", "2.0.0").as_bytes()), ("new.txt", b"2")]);
        unpack(&v2, &dir).unwrap();
        assert!(dir.join("new.txt").exists() && !dir.join("old.txt").exists());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn refuses_what_is_not_a_package() {
        assert!(read_manifest(b"not a zip").unwrap_err().contains("Not a plugin package"));
        let no_manifest = package(&[("readme.txt", b"x")]);
        assert!(read_manifest(&no_manifest).unwrap_err().contains("no opentrader-plugin.json"));
        let bad = package(&[(manifest::FILE, br#"{"id":"X"}"#)]);
        assert!(read_manifest(&bad).is_err());
    }
}
