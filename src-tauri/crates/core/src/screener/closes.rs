/*
 * Closes file and the moving averages / RSI of the lengths the daily state
 * does not hold (the screener's "Custom" lengths, #201).
 *
 * `GET <gateway>/screener/v1/closes` (built each night with the state, same
 * tickers in the same order, same split adjustment): gzip of a JSON header
 * line {version, asof, sessions, tickers}, then the closes of the last
 * sessions as little-endian float32, ticker by ticker, oldest first, NaN
 * where the ticker has no bar. Fetched only while a screen uses a custom
 * length, cached on disk with its ETag (the `asof`).
 *
 * From it, per ticker and length n, the values the state would hold at the
 * close of D with their carry-over for the live step (`fields.rs`):
 *  - EMA<n>: Pine `ta.ema` seeded with the SMA of its first n closes;
 *  - SMA<n> and SMA<n>|next (the sum of the last n-1 closes);
 *  - RSI<n>, RSI<n>|gain, RSI<n>|loss: Wilder RMA seeded with the SMA of the
 *    first n changes.
 * The EMA and the RSI start at the first session of the file (two years):
 * close to the state's five-year values for lengths up to a few hundred.
 */
use crate::data::gateway::{self, BASE, NO_TOKEN};
use crate::data::market_rest::http;
use crate::screener::state::StateFile;
use anyhow::{anyhow, Context, Result};
use chrono::NaiveDate;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

pub const CLOSES_VERSION: u32 = 1;
/// Longest custom length.
pub const MAX_LENGTH: u32 = 500;

#[derive(Deserialize)]
struct Header {
    version: u32,
    asof: NaiveDate,
    sessions: Vec<String>,
    tickers: Vec<String>,
}

pub struct Closes {
    pub asof: NaiveDate,
    pub tickers: Vec<String>,
    pub sessions: usize,
    /// Ticker-major: `data[t * sessions + s]`.
    pub data: Vec<f32>,
}

impl Closes {
    /// Parse the gzip-compressed file.
    pub fn parse(gz: &[u8]) -> Result<Closes> {
        let mut raw = Vec::new();
        flate2::read::GzDecoder::new(gz).read_to_end(&mut raw).context("closes: gunzip")?;
        let nl = raw.iter().position(|b| *b == b'\n').ok_or_else(|| anyhow!("closes: no header line"))?;
        let h: Header = serde_json::from_slice(&raw[..nl]).context("closes: header")?;
        if h.version != CLOSES_VERSION {
            return Err(anyhow!("closes version {} (app reads {CLOSES_VERSION})", h.version));
        }
        let body = &raw[nl + 1..];
        let n = h.tickers.len() * h.sessions.len();
        if body.len() != n * 4 {
            return Err(anyhow!("closes: {} bytes for {n} values", body.len()));
        }
        let data = body.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        Ok(Closes { asof: h.asof, sessions: h.sessions.len(), tickers: h.tickers, data })
    }

    fn row(&self, t: usize) -> &[f32] {
        &self.data[t * self.sessions..(t + 1) * self.sessions]
    }
}

fn cache_path() -> PathBuf {
    crate::data::cache_root().join("screener_closes.bin.gz")
}

/// The closes saved by the last fetch, if readable.
pub fn read_cache() -> Option<Closes> {
    Closes::parse(&std::fs::read(cache_path()).ok()?).ok()
}

/// Fetch the closes from the gateway, counting their bytes on `d`; `Ok(None)` when it serves none (404). Cached on
/// disk.
pub async fn fetch(d: Option<&crate::screener::progress::Download>) -> Result<Option<Closes>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let resp = http().get(format!("{BASE}/screener/v1/closes")).bearer_auth(token).send().await.context("screener closes request")?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!("screener closes {status}"));
    }
    if let Some(d) = d {
        d.set_total(resp.content_length());
    }
    let bytes = crate::screener::progress::read_body(resp, d, "screener closes").await?;
    // Unpacking and parsing the whole market's closes: off the async threads.
    let c = tokio::task::spawn_blocking(move || -> Result<Closes> {
        let c = Closes::parse(&bytes)?;
        let _ = crate::files::write_atomic(&cache_path(), &bytes);
        Ok(c)
    })
    .await
    .context("screener closes: read task")??;
    Ok(Some(c))
}

/// A custom field id: its kind and length ("EMA137" → ("EMA", 137)), for lengths 1..=MAX_LENGTH.
pub fn custom_id(id: &str) -> Option<(&'static str, u32)> {
    for kind in ["EMA", "SMA", "RSI"] {
        if let Some(rest) = id.strip_prefix(kind) {
            if rest.is_empty() || rest.starts_with('0') || !rest.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u32 = rest.parse().ok()?;
            return (1..=MAX_LENGTH).contains(&n).then_some((kind, n));
        }
    }
    None
}

/// The closes of one ticker from its first bar on (a gap inside is skipped, as a missing session).
fn series(row: &[f32]) -> Vec<f64> {
    row.iter().filter(|v| v.is_finite()).map(|v| *v as f64).collect()
}

/// EMA at the last close, seeded with the SMA of the first n closes.
pub fn ema(c: &[f64], n: usize) -> Option<f64> {
    if n == 0 || c.len() < n {
        return None;
    }
    let mut e = c[..n].iter().sum::<f64>() / n as f64;
    let a = 2.0 / (n as f64 + 1.0);
    for v in &c[n..] {
        e += a * (v - e);
    }
    Some(e)
}

/// SMA of the last n closes, and the sum of the last n-1 (the live step's carry).
pub fn sma(c: &[f64], n: usize) -> Option<(f64, f64)> {
    if n == 0 || c.len() < n {
        return None;
    }
    let last = &c[c.len() - n..];
    let sum: f64 = last.iter().sum();
    Some((sum / n as f64, sum - last[0]))
}

/// Wilder RSI at the last close with its average gain and loss.
pub fn rsi(c: &[f64], n: usize) -> Option<(f64, f64, f64)> {
    if n == 0 || c.len() < n + 1 {
        return None;
    }
    let (mut g, mut l) = (0.0, 0.0);
    for w in c[..=n].windows(2) {
        let d = w[1] - w[0];
        g += d.max(0.0);
        l += (-d).max(0.0);
    }
    let nf = n as f64;
    let (mut g, mut l) = (g / nf, l / nf);
    for w in c[n..].windows(2) {
        let d = w[1] - w[0];
        g = (g * (nf - 1.0) + d.max(0.0)) / nf;
        l = (l * (nf - 1.0) + (-d).max(0.0)) / nf;
    }
    let r = if l == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + g / l) };
    Some((r, g, l))
}

/// The state with the columns of the custom ids added (the ids the state already holds are left as they are). The
/// closes must be of the state's session; tickers are matched by name.
pub fn with_custom(state: &StateFile, closes: &Closes, ids: &[String]) -> StateFile {
    let mut out = StateFile { version: state.version, asof: state.asof, tickers: state.tickers.clone(), num: state.num.clone(), text: state.text.clone() };
    if closes.asof != state.asof {
        return out;
    }
    let at: HashMap<&str, usize> = closes.tickers.iter().enumerate().map(|(i, t)| (t.as_str(), i)).collect();
    let rows: Vec<Option<Vec<f64>>> = state.tickers.iter().map(|t| at.get(t.as_str()).map(|&i| series(closes.row(i)))).collect();
    for id in ids {
        let Some((kind, n)) = custom_id(id) else { continue };
        if out.num.contains_key(id) {
            continue;
        }
        let n = n as usize;
        match kind {
            "EMA" => {
                out.num.insert(id.clone(), rows.iter().map(|r| r.as_deref().and_then(|c| ema(c, n))).collect());
            }
            "SMA" => {
                let v: Vec<Option<(f64, f64)>> = rows.iter().map(|r| r.as_deref().and_then(|c| sma(c, n))).collect();
                out.num.insert(id.clone(), v.iter().map(|x| x.map(|x| x.0)).collect());
                out.num.insert(format!("{id}|next"), v.iter().map(|x| x.map(|x| x.1)).collect());
            }
            _ => {
                let v: Vec<Option<(f64, f64, f64)>> = rows.iter().map(|r| r.as_deref().and_then(|c| rsi(c, n))).collect();
                out.num.insert(id.clone(), v.iter().map(|x| x.map(|x| x.0)).collect());
                out.num.insert(format!("{id}|gain"), v.iter().map(|x| x.map(|x| x.1)).collect());
                out.num.insert(format!("{id}|loss"), v.iter().map(|x| x.map(|x| x.2)).collect());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file(asof: &str, tickers: &[&str], sessions: usize, values: &[f32]) -> Vec<u8> {
        let head = serde_json::json!({ "version": 1, "asof": asof, "sessions": (0..sessions).map(|i| format!("d{i}")).collect::<Vec<_>>(), "tickers": tickers });
        let mut raw = serde_json::to_vec(&head).unwrap();
        raw.push(b'\n');
        for v in values {
            raw.extend_from_slice(&v.to_le_bytes());
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&raw).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn parses_and_checks_the_file() {
        let c = Closes::parse(&file("2026-11-02", &["AAA", "BBB"], 3, &[1.0, 2.0, 3.0, f32::NAN, 5.0, 6.0])).unwrap();
        assert_eq!((c.tickers.len(), c.sessions), (2, 3));
        assert_eq!(series(c.row(1)), vec![5.0, 6.0]);
        assert!(Closes::parse(&file("2026-11-02", &["AAA"], 3, &[1.0])).is_err());
    }

    #[test]
    fn custom_ids() {
        assert_eq!(custom_id("EMA137"), Some(("EMA", 137)));
        assert_eq!(custom_id("RSI2"), Some(("RSI", 2)));
        assert_eq!(custom_id("SMA0"), None);
        assert_eq!(custom_id("SMA007"), None);
        assert_eq!(custom_id("EMA501"), None);
        assert_eq!(custom_id("EMA"), None);
        assert_eq!(custom_id("ATR14"), None);
    }

    #[test]
    fn pine_seeded_values() {
        let c: Vec<f64> = (1..=10).map(|x| x as f64).collect();
        // SMA of the first 3 = 2, then 2 + 0.5 * (4 - 2) = 3, ... the EMA of a ramp lags it by 1.
        assert_eq!(ema(&c, 3), Some(9.0));
        assert_eq!(sma(&c, 4), Some((8.5, 27.0)));
        let (r, g, l) = rsi(&c, 3).unwrap();
        assert_eq!((r, g, l), (100.0, 1.0, 0.0));
        let zig = [10.0, 11.0, 10.0, 11.0, 10.0];
        let (r, _, _) = rsi(&zig, 2).unwrap();
        assert!((r - 37.5).abs() < 1e-9, "{r}");
        assert_eq!(ema(&c, 11), None);
    }

    #[test]
    fn adds_the_custom_columns_of_the_same_session() {
        let closes = Closes::parse(&file("2026-11-02", &["BBB", "AAA"], 4, &[10.0, 11.0, 12.0, 13.0, 1.0, 2.0, 3.0, 4.0])).unwrap();
        let state = StateFile {
            version: 1,
            asof: NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
            tickers: vec!["AAA".into(), "BBB".into(), "CCC".into()],
            num: HashMap::new(),
            text: HashMap::new(),
        };
        let s = with_custom(&state, &closes, &["SMA3".into(), "nope".into()]);
        assert_eq!(s.num["SMA3"], vec![Some(3.0), Some(12.0), None]);
        assert_eq!(s.num["SMA3|next"], vec![Some(7.0), Some(25.0), None]);
        assert!(!s.num.contains_key("nope"));
        let old = StateFile { asof: NaiveDate::from_ymd_opt(2026, 10, 30).unwrap(), ..state };
        assert!(with_custom(&old, &closes, &["SMA3".into()]).num.is_empty());
    }
}
