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
use crate::data::massive_rest::http;
use anyhow::{anyhow, Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("opentrader")
        .join("screener_state.json")
}

/// The state saved by the last successful fetch, if readable.
pub fn read_cache() -> Option<StateFile> {
    let bytes = std::fs::read(cache_path()).ok()?;
    let s: StateFile = serde_json::from_slice(&bytes).ok()?;
    s.check().ok()?;
    Some(s)
}

/// Fetch the state from the gateway. `Ok(None)` when the gateway does not
/// serve it (404). The raw body is cached on disk for the next start.
pub async fn fetch() -> Result<Option<StateFile>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!("{BASE}/screener/v1/state?apiKey={token}");
    let resp = http().get(&url).send().await.context("screener state request")?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!("screener state {status}"));
    }
    let bytes = resp.bytes().await.context("screener state body")?;
    let s: StateFile = serde_json::from_slice(&bytes).context("screener state: parse json")?;
    s.check()?;
    let path = cache_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, &bytes);
    Ok(Some(s))
}
