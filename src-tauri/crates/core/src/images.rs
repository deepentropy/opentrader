/*
 * Drawing images (Image tool). The chosen file is kept in a folder of the host
 * (the desktop app: `<app data>/drawing-images/<content hash>.<ext>`), so the
 * drawing itself only stores the file name and the drawings store /
 * cross-window sync never carries image bytes.
 */
use base64::Engine as _;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Limits: JPG, PNG or WEBP, max 2 MB.
const MAX_BYTES: usize = 2_000_000;
const EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// Only names this module produced: `<16 hex>.<ext>` (no path separators).
fn valid_name(name: &str) -> bool {
    match name.split_once('.') {
        Some((stem, ext)) => stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit()) && EXTS.contains(&ext),
        None => false,
    }
}

/// Store an image (base64 bytes) and return its file name; the same bytes
/// always give the same name, so re-adding an image does not duplicate it.
pub fn save_drawing_image(dir: &Path, data_base64: &str, ext: &str) -> Result<String, String> {
    let ext = ext.to_ascii_lowercase();
    if !EXTS.contains(&ext.as_str()) {
        return Err(format!("unsupported image type: {ext}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("image is larger than 2 MB".into());
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    let name = format!("{:016x}.{ext}", h.finish());
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(name)
}

/// Read a stored drawing image back as base64.
pub fn read_drawing_image(dir: &Path, name: &str) -> Result<String, String> {
    if !valid_name(name) {
        return Err(format!("invalid image name: {name}"));
    }
    let bytes = std::fs::read(dir.join(name)).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
