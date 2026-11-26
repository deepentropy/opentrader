/*
 * Daily screener state — the history-derived values the gateway builds once
 * per day for every ticker (contract v1: deepentropy/gateway#1).
 *
 * `GET <gateway>/screener/v1/state` returns, for the last closed session D,
 * one column per state key: indicator values at the close of D plus the
 * small carry-over each live value needs (see `fields.rs`). The app joins it
 * with the live snapshot, so a history filter such as `close > EMA200` costs
 * one multiply-add per ticker instead of a history download.
 *
 * Until the gateway serves the endpoint (404), the state is `None` and every
 * state field reads as null ("—" in the table).
 */
use crate::data::gateway::{self, BASE, NO_TOKEN};
use crate::screener::progress::{self, Download};
use anyhow::{anyhow, Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

/// Contract version the app reads. A file with another version is ignored.
pub const STATE_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
pub struct StateFile {
    pub version: u32,
    /// New York date of the last close the values include (D).
    pub asof: NaiveDate,
    pub tickers: Vec<String>,
    /// Numeric columns, one value per ticker (null = not enough history).
    #[serde(default)]
    pub num: HashMap<String, Vec<Option<f64>>>,
    /// Text columns (sector, industry), one value per ticker.
    #[serde(default)]
    pub text: HashMap<String, Vec<Option<String>>>,
}

impl StateFile {
    fn check(&self) -> Result<()> {
        if self.version != STATE_VERSION {
            return Err(anyhow!("screener state version {} (app reads {STATE_VERSION})", self.version));
        }
        let n = self.tickers.len();
        for (k, col) in &self.num {
            if col.len() != n {
                return Err(anyhow!("screener state column {k}: {} values for {n} tickers", col.len()));
            }
        }
        for (k, col) in &self.text {
            if col.len() != n {
                return Err(anyhow!("screener state column {k}: {} values for {n} tickers", col.len()));
            }
        }
        Ok(())
    }

    /// Ticker -> row index.
    pub fn index(&self) -> HashMap<&str, usize> {
        self.tickers.iter().enumerate().map(|(i, t)| (t.as_str(), i)).collect()
    }

    pub fn num(&self, key: &str, i: usize) -> Option<f64> {
        self.num.get(key)?.get(i).copied().flatten().filter(|v| v.is_finite())
    }

    pub fn text(&self, key: &str, i: usize) -> Option<&str> {
        self.text.get(key)?.get(i)?.as_deref()
    }
}

fn cache_path() -> PathBuf {
    crate::data::cache_root().join("screener_state.json")
}

/// The session of the state on disk, read from the start of the file (`{"version":1,"asof":"…"`) without parsing
/// its tens of megabytes.
pub fn cached_asof() -> Option<NaiveDate> {
    let mut head = [0u8; 128];
    let n = std::fs::File::open(cache_path()).ok()?.read(&mut head).ok()?;
    asof_of(&head[..n])
}

fn asof_of(head: &[u8]) -> Option<NaiveDate> {
    let text = std::str::from_utf8(head).ok()?;
    let at = text.find("\"asof\"")? + 6;
    let rest = text[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    NaiveDate::parse_from_str(rest.get(..10)?, "%Y-%m-%d").ok()
}

/// The state saved by the last successful fetch, if readable.
pub fn read_cache() -> Option<StateFile> {
    let bytes = std::fs::read(cache_path()).ok()?;
    let s: StateFile = serde_json::from_slice(&bytes).ok()?;
    s.check().ok()?;
    Some(s)
}

/// A client that leaves the body compressed: the bytes read then match the size the answer tells, for the
/// download progress.
fn raw_http() -> reqwest::Client {
    static CLIENT: crate::net::SharedClient = crate::net::SharedClient::new(|b| b.no_gzip().user_agent(gateway::user_agent()));
    CLIENT.get()
}

/// One state download at a time: the background prefetch and an opened panel would otherwise both download it.
static FETCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A state of session `expected` (or newer): the copy on disk when it already is (another download just wrote it),
/// else a download. `Ok(None)` when the gateway has nothing newer than `have` (the session of the state held).
pub async fn fetch_unless_cached(d: Option<&Download>, have: Option<NaiveDate>, expected: Option<NaiveDate>) -> Result<Option<StateFile>> {
    let _one = FETCHING.lock().await;
    let on_disk = cached_asof();
    if on_disk.is_some() && on_disk >= expected && on_disk > have {
        if let Some(s) = tokio::task::spawn_blocking(read_cache).await.ok().flatten() {
            return Ok(Some(s));
        }
    }
    fetch(d, have.max(on_disk)).await
}

/// Fetch the state from the gateway, counting its bytes on `d`. `Ok(None)` when the gateway does not
/// serve it (404) or serves the session `have` already held (304). The raw body is cached on disk for the next
/// start.
pub async fn fetch(d: Option<&Download>, have: Option<NaiveDate>) -> Result<Option<StateFile>> {
    let token = gateway::data_token().await.context(NO_TOKEN)?;
    let url = format!("{BASE}/screener/v1/state");
    let mut req = raw_http().get(&url).bearer_auth(token).header(reqwest::header::ACCEPT_ENCODING, "gzip");
    // The gateway tags the state with its session: the same session again is answered without a body.
    if let Some(day) = have {
        req = req.header(reqwest::header::IF_NONE_MATCH, format!("\"{day}\""));
    }
    let resp = req.send().await.context("screener state request")?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!("screener state {status}"));
    }
    if let Some(d) = d {
        d.set_total(resp.content_length());
    }
    let gzipped = resp.headers().get(reqwest::header::CONTENT_ENCODING).is_some_and(|v| v == "gzip");
    let body = progress::read_body(resp, d, "screener state").await?;
    // Tens of megabytes to unpack, parse and write: off the async threads.
    let s = tokio::task::spawn_blocking(move || read_answer(body, gzipped)).await.context("screener state: read task")??;
    Ok(Some(s))
}

/// The state of an answer's body, also kept on disk for the next start.
fn read_answer(body: Vec<u8>, gzipped: bool) -> Result<StateFile> {
    let bytes = if gzipped {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&body[..]).read_to_end(&mut out).context("screener state: gunzip")?;
        out
    } else {
        body
    };
    let s: StateFile = serde_json::from_slice(&bytes).context("screener state: parse json")?;
    s.check()?;
    let _ = crate::files::write_atomic(&cache_path(), &bytes);
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asof_from_the_file_head() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 25);
        assert_eq!(asof_of(br#"{"version":1,"asof":"2026-11-25","next":"2026-11-27","tickers":["A""#), d);
        assert_eq!(asof_of(br#"{ "version": 1, "asof" : "2026-11-25" }"#), d);
        // A head cut inside the date, or none: no session.
        assert_eq!(asof_of(br#"{"version":1,"asof":"2026-11"#), None);
        assert_eq!(asof_of(b""), None);
    }
}
