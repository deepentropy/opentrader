/*
 * Download progress of what the screener's first complete table waits on (the market snapshot, the ticker list,
 * the daily state, the closes), for the panel's loading wheel. Each download counts the bytes it reads against its
 * size when the answer tells it; the list is emptied once a complete table is out, so the shown share only grows
 * while the panel waits.
 */
use anyhow::{Context, Result};
use crate::sync::LockExt;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// One download: bytes read so far and its size (0 = not known).
pub struct Download {
    what: &'static str,
    received: AtomicU64,
    total: AtomicU64,
    done: AtomicBool,
}

impl Download {
    pub fn set_total(&self, bytes: Option<u64>) {
        if let Some(n) = bytes.filter(|n| *n > 0) {
            self.total.store(n, Ordering::Relaxed);
        }
    }

    pub fn add(&self, bytes: u64) {
        self.received.fetch_add(bytes, Ordering::Relaxed);
    }

    /// Read in full, or no longer needed (it lost a race): it counts as complete from now on.
    pub fn finish(&self) {
        let r = self.received.load(Ordering::Relaxed);
        let t = self.total.load(Ordering::Relaxed);
        self.total.store(t.max(r), Ordering::Relaxed);
        self.received.store(t.max(r), Ordering::Relaxed);
        self.done.store(true, Ordering::Relaxed);
    }
}

/// The downloads since the last complete table.
#[derive(Default)]
pub struct Downloads(Mutex<Vec<Arc<Download>>>);

impl Downloads {
    pub fn start(&self, what: &'static str) -> Arc<Download> {
        let d = Arc::new(Download {
            what,
            received: AtomicU64::new(0),
            total: AtomicU64::new(0),
            done: AtomicBool::new(false),
        });
        self.0.locked().push(d.clone());
        d
    }

    pub fn clear(&self) {
        self.0.locked().clear();
    }

    pub fn progress(&self) -> ScreenerProgress {
        let list = self.0.locked();
        let mut received = 0u64;
        let mut total = Some(0u64);
        let mut active = Vec::new();
        for d in list.iter() {
            received += d.received.load(Ordering::Relaxed);
            let t = d.total.load(Ordering::Relaxed);
            total = total.and_then(|sum| (t > 0).then_some(sum + t));
            if !d.done.load(Ordering::Relaxed) && !active.contains(&d.what) {
                active.push(d.what);
            }
        }
        ScreenerProgress {
            received_bytes: received as f64,
            total_bytes: total.filter(|t| *t > 0).map(|t| t as f64),
            downloading: active.into_iter().map(String::from).collect(),
        }
    }
}

/// What the loading wheel shows.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerProgress {
    pub received_bytes: f64,
    /// The sum of the sizes, when every download tells its size.
    pub total_bytes: Option<f64>,
    /// The downloads still running: "market", "tickers", "state", "closes" (the panel names them).
    pub downloading: Vec<String>,
}

/// Read a body chunk by chunk, counting its bytes on `d` (when given).
pub async fn read_body(mut resp: reqwest::Response, d: Option<&Download>, what: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(resp.content_length().unwrap_or(0) as usize);
    while let Some(chunk) = resp.chunk().await.with_context(|| format!("{what} body"))? {
        if let Some(d) = d {
            d.add(chunk.len() as u64);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_known_only_when_every_size_is() {
        let list = Downloads::default();
        let a = list.start("state");
        a.set_total(Some(100));
        a.add(40);
        let p = list.progress();
        assert_eq!((p.received_bytes, p.total_bytes, p.downloading.clone()), (40.0, Some(100.0), vec!["state".to_string()]));
        let b = list.start("tickers");
        b.add(10);
        assert_eq!(list.progress().total_bytes, None);
        // A finished download of unknown size counts what it read.
        b.finish();
        let p = list.progress();
        assert_eq!((p.received_bytes, p.total_bytes, p.downloading), (50.0, Some(110.0), vec!["state".to_string()]));
        list.clear();
        assert_eq!(list.progress().total_bytes, None);
    }
}
