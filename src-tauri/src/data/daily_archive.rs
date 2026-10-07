/*
 * Daily price archive — the daily bars older than the live history window.
 *
 * The aggregates endpoint serves a rolling window of daily history. The
 * gateway keeps the sessions before it as one file per ticker:
 *
 *   GET /history/v1/daily/<TICKER>      (app token, gzip, ETag)
 *   {"version":1,"ticker":"AAPL","t":[ms…],"o":[…],"h":[…],"l":[…],"c":[…],"v":[…],"n":[…]}
 *
 * Columnar, sessions ascending, `t` = the `t` of a daily aggregate bar (bar
 * start, UNIX milliseconds). 404 = no archive for the ticker.
 *
 * The file is UNADJUSTED and a stored bar never changes, so it is cached on
 * disk as served and split-adjusted on every read: a split executed after the
 * download changes the returned bars without a new download. The file itself
 * changes only when the archive is extended (about once a month), so it is
 * revalidated with its ETag at most once per day.
 */
use crate::data::gateway::{self, BASE, NO_TOKEN};
use crate::data::massive_rest::{self, http, Candle, DayMemo, Split};
use crate::data::trading_calendar;
use anyhow::{anyhow, Context, Result};
use chrono::NaiveDate;
use reqwest::header::{AUTHORIZATION, ETAG, IF_NONE_MATCH};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

/// Cache folder under the market-data cache root ("Clear cache" deletes it).
pub const CACHE_DIR: &str = "daily_archive_v1";

/// One ticker's archive, as served (unadjusted).
#[derive(Clone, Serialize, Deserialize)]
struct Archive {
    t: Vec<i64>,
    o: Vec<f64>,
    h: Vec<f64>,
    l: Vec<f64>,
    c: Vec<f64>,
    v: Vec<f64>,
}

impl Archive {
    fn is_consistent(&self) -> bool {
        let n = self.t.len();
        [self.o.len(), self.h.len(), self.l.len(), self.c.len(), self.v.len()].iter().all(|&len| len == n)
    }
}

/// The disk copy: the served bars with the ETag they came with.
#[derive(Serialize, Deserialize)]
struct CachedFile {
    etag: Option<String>,
    bars: Archive,
}

/// Per-ticker memo of the archive (`None` = the gateway has none), stamped with
/// the day it was validated.
static ARCHIVES: DayMemo<String, Option<Archive>> = OnceLock::new();

/// Forget the in-memory archives ("Clear cache").
pub async fn clear_memo() {
    if let Some(m) = ARCHIVES.get() {
        m.lock().await.clear();
    }
}

/// Tickers are case-sensitive and the cache folder may not be: a lower-case
/// letter is written as `_` + its upper case ("BACpB" → "BAC_PB").
fn cache_path(ticker: &str) -> PathBuf {
    let mut name = String::with_capacity(ticker.len() + 4);
    for ch in ticker.chars() {
        if ch.is_ascii_lowercase() {
            name.push('_');
            name.push(ch.to_ascii_uppercase());
        } else if ch.is_ascii_alphanumeric() || ch == '.' {
            name.push(ch);
        } else {
            name.push('-');
        }
    }
    massive_rest::rest_cache_root().join(CACHE_DIR).join(format!("{name}.json"))
}

async fn read_disk(ticker: &str) -> Option<CachedFile> {
    let bytes = tokio::fs::read(cache_path(ticker)).await.ok()?;
    let file: CachedFile = serde_json::from_slice(&bytes).ok()?;
    file.bars.is_consistent().then_some(file)
}

async fn write_disk(ticker: &str, file: &CachedFile) {
    let path = cache_path(ticker);
    if let Ok(json) = serde_json::to_vec(file) {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&path, &json).await;
    }
}

/// The archive of `ticker`, from the memo, else revalidated against the
/// gateway (a 304 keeps the disk copy). `Ok(None)` when the gateway has no
/// archive for it. A failed request falls back to the disk copy when there is
/// one and is not memoised, so the next load asks again.
async fn load(ticker: &str) -> Result<Arc<Option<Archive>>> {
    let memo = ARCHIVES.get_or_init(|| Mutex::new(HashMap::new()));
    let today = trading_calendar::ny_today();
    if let Some((as_of, archive)) = memo.lock().await.get(ticker) {
        if *as_of == today {
            return Ok(archive.clone());
        }
    }
    let token = gateway::token().context(NO_TOKEN)?;
    let disk = read_disk(ticker).await;

    let mut req = http()
        .get(format!("{BASE}/history/v1/daily/{ticker}"))
        .header(AUTHORIZATION, format!("Bearer {token}"));
    if let Some(etag) = disk.as_ref().and_then(|f| f.etag.as_deref()) {
        req = req.header(IF_NONE_MATCH, etag);
    }
    let fetched: Result<Option<Archive>> = async {
        let resp = req.send().await.context("daily archive request failed")?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(None),
            StatusCode::NOT_MODIFIED => disk
                .as_ref()
                .map(|f| Some(f.bars.clone()))
                .ok_or_else(|| anyhow!("daily archive: 304 without a cached file")),
            status if status.is_success() => {
                let etag = resp.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
                let bars: Archive = resp.json().await.context("daily archive: parse response json")?;
                if !bars.is_consistent() {
                    return Err(anyhow!("daily archive: columns of different lengths"));
                }
                let file = CachedFile { etag, bars };
                write_disk(ticker, &file).await;
                Ok(Some(file.bars))
            }
            status => Err(anyhow!("daily archive {status}")),
        }
    }
    .await;

    match fetched {
        Ok(archive) => {
            let archive = Arc::new(archive);
            memo.lock().await.insert(ticker.to_string(), (today, archive.clone()));
            Ok(archive)
        }
        Err(e) => match disk {
            Some(file) => {
                eprintln!("[daily_archive] {ticker}: {e:#}; serving the cached file");
                Ok(Arc::new(Some(file.bars)))
            }
            None => Err(e),
        },
    }
}

/// Price factor of a bar of session `date`: the product of
/// `split_from / split_to` over every split executed after it. Prices are
/// multiplied by it and volume divided, which is the scale of the adjusted
/// aggregate bars.
fn split_factor(splits: &[Split], date: NaiveDate) -> f64 {
    splits
        .iter()
        .filter(|s| s.execution_date > date && s.from > 0.0 && s.to > 0.0)
        .map(|s| s.from / s.to)
        .product()
}

/// Archive bars as candles (oldest first), split-adjusted when `splits` is
/// given. Pure (no I/O).
fn to_candles(archive: &Archive, splits: Option<&[Split]>) -> Vec<Candle> {
    (0..archive.t.len())
        .map(|i| {
            let time = archive.t[i] / 1000;
            let factor = match (splits, trading_calendar::ny_date(time)) {
                (Some(splits), Some(date)) => split_factor(splits, date),
                _ => 1.0,
            };
            Candle {
                time: time as f64,
                open: archive.o[i] * factor,
                high: archive.h[i] * factor,
                low: archive.l[i] * factor,
                close: archive.c[i] * factor,
                volume: archive.v[i] / factor,
            }
        })
        .collect()
}

/// Every archived daily bar of `ticker`, oldest first: split-adjusted when
/// `adjusted`, as stored otherwise. Empty when the gateway has no archive for
/// the ticker. An error when the archive or (for adjusted bars) the split list
/// could not be read, so the caller never joins bars on the wrong scale.
pub async fn daily_bars(ticker: &str, adjusted: bool) -> Result<Vec<Candle>> {
    let archive = load(ticker).await?;
    let Some(archive) = archive.as_ref() else {
        return Ok(Vec::new());
    };
    if !adjusted {
        return Ok(to_candles(archive, None));
    }
    let splits = massive_rest::fetch_splits_cached(ticker)
        .await
        .ok_or_else(|| anyhow!("daily archive: no split list for {ticker}"))?;
    Ok(to_candles(archive, Some(&splits)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn split(y: i32, m: u32, d: u32, from: f64, to: f64) -> Split {
        Split { execution_date: date(y, m, d), from, to }
    }

    /// AAPL: 2:1 on 28/02/2005, 7:1 on 09/06/2014, 4:1 on 31/08/2020 (and older
    /// splits, which no archived bar precedes).
    fn aapl_splits() -> Vec<Split> {
        vec![
            split(2020, 8, 31, 1.0, 4.0),
            split(2014, 6, 9, 1.0, 7.0),
            split(2005, 2, 28, 1.0, 2.0),
            split(2000, 6, 21, 1.0, 2.0),
        ]
    }

    #[test]
    fn factor_counts_only_later_splits() {
        let splits = aapl_splits();
        assert!((split_factor(&splits, date(2003, 9, 10)) - 1.0 / 56.0).abs() < 1e-12);
        // The execution day itself already trades on the new scale.
        assert!((split_factor(&splits, date(2005, 2, 28)) - 1.0 / 28.0).abs() < 1e-12);
        assert!((split_factor(&splits, date(2005, 2, 25)) - 1.0 / 56.0).abs() < 1e-12);
        assert!((split_factor(&splits, date(2020, 8, 28)) - 0.25).abs() < 1e-12);
        assert_eq!(split_factor(&splits, date(2020, 8, 31)), 1.0);
        assert_eq!(split_factor(&[], date(2003, 9, 10)), 1.0);
    }

    #[test]
    fn first_archived_bar_is_scaled_like_the_adjusted_series() {
        // 10/09/2003 (midnight New York = 04:00 UTC): close 22.18, volume 3,957,751.
        let archive = Archive {
            t: vec![1_063_166_400_000],
            o: vec![22.25],
            h: vec![22.79],
            l: vec![22.1],
            c: vec![22.18],
            v: vec![3_957_751.0],
        };
        let adjusted = to_candles(&archive, Some(&aapl_splits()));
        assert_eq!(adjusted[0].time, 1_063_166_400.0);
        assert!((adjusted[0].close - 0.3961).abs() < 5e-5);
        assert_eq!(adjusted[0].volume.round(), 221_634_056.0);
        let raw = to_candles(&archive, None);
        assert_eq!((raw[0].close, raw[0].volume), (22.18, 3_957_751.0));
    }

    #[test]
    fn reverse_split_raises_older_prices() {
        // 1:10 reverse split: 10 old shares become 1.
        let splits = vec![split(2024, 5, 1, 10.0, 1.0)];
        assert_eq!(split_factor(&splits, date(2024, 4, 30)), 10.0);
    }

    #[test]
    fn cache_file_names_keep_case_apart() {
        let name = |t: &str| cache_path(t).file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name("AAPL"), "AAPL.json");
        assert_eq!(name("BACpB"), "BAC_PB.json");
        assert_eq!(name("BRK.A"), "BRK.A.json");
        assert_ne!(name("BACpB"), name("BACPB"));
    }
}
