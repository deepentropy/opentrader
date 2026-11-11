/*
 * Images kept as files of the host, named by their content: the drawing images
 * of the Image tool (`<app data>/drawing-images/`) and the chart snapshots of
 * symbol notes (`<app data>/note-images/`). A drawing or a note only stores the
 * file name, so the settings store and the cross-window sync never carry image
 * bytes.
 */
use crate::error::{Error, Result};
use base64::Engine as _;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Limits: JPG, PNG or WEBP, max 2 MB for a drawing image; a chart snapshot of
/// a large layout can be bigger.
const MAX_BYTES: usize = 2_000_000;
const MAX_NOTE_BYTES: usize = 10_000_000;
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
pub fn save_drawing_image(dir: &Path, data_base64: &str, ext: &str) -> Result<String> {
    save_image(dir, data_base64, ext, MAX_BYTES)
}

/// Store a note's chart snapshot, as `save_drawing_image`.
pub fn save_note_image(dir: &Path, data_base64: &str, ext: &str) -> Result<String> {
    save_image(dir, data_base64, ext, MAX_NOTE_BYTES)
}

fn save_image(dir: &Path, data_base64: &str, ext: &str, max: usize) -> Result<String> {
    let ext = ext.to_ascii_lowercase();
    if !EXTS.contains(&ext.as_str()) {
        return Err(Error::invalid(format!("unsupported image type: {ext}")));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| Error::invalid(e.to_string()))?;
    if bytes.len() > max {
        return Err(Error::invalid(format!("image is larger than {} MB", max / 1_000_000)));
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    let name = format!("{:016x}.{ext}", h.finish());
    std::fs::create_dir_all(dir)?;
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::write(&path, &bytes)?;
    }
    Ok(name)
}

/// Read a stored image back as base64.
pub fn read_image(dir: &Path, name: &str) -> Result<String> {
    if !valid_name(name) {
        return Err(Error::invalid(format!("invalid image name: {name}")));
    }
    let bytes = std::fs::read(dir.join(name))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Remove a stored image (no error when it is already gone).
pub fn delete_image(dir: &Path, name: &str) -> Result<()> {
    if !valid_name(name) {
        return Err(Error::invalid(format!("invalid image name: {name}")));
    }
    match std::fs::remove_file(dir.join(name)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn note_images_are_saved_by_content_read_and_deleted() {
        let dir = std::env::temp_dir().join(format!("ot-note-images-{}", std::process::id()));
        let data = base64::engine::general_purpose::STANDARD.encode(b"not really a png");
        let name = save_note_image(&dir, &data, "png").unwrap();
        assert!(valid_name(&name));
        assert_eq!(save_note_image(&dir, &data, "png").unwrap(), name);
        assert_eq!(read_image(&dir, &name).unwrap(), data);
        delete_image(&dir, &name).unwrap();
        assert!(read_image(&dir, &name).is_err());
        // Already gone: no error; a name this module did not give: refused.
        delete_image(&dir, &name).unwrap();
        assert!(delete_image(&dir, "../opentrader.json").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
