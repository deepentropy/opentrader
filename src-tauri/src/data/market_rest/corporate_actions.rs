//! Splits and dividends: the per-day memos, the chart event markers and
//! the split epoch the disk cache is namespaced by.
use super::cache::{rest_cache_root, REST_CACHE_DIR};
use super::{get_json, DayMemo};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

// ── Splits (REST cache invalidation) ─────────────────────────────────────
//
// The chart's REST bar requests use `adjusted=true`, so the gateway already
// returns split-adjusted prices — no on-read adjustment is needed. The one thing splits
// still drive is cache invalidation: `adjusted=true` rescales ALL historical
// bars when a split executes, so the latest executed-split date is folded into
// the cache namespace (`epoch_of`) and a fresh split transparently invalidates
// every prior cached session.

/// A `splits` answer (newest first).
#[derive(Deserialize)]
struct SplitsAnswer {
    #[serde(default)]
    splits: Vec<SplitRow>,
}

#[derive(Deserialize)]
struct SplitRow {
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    from: Option<f64>,
    #[serde(default)]
    to: Option<f64>,
}

/// One already-executed stock split. `execution_date` doubles as the cache epoch
/// (`epoch_of`); `from`/`to` give the ratio for the event marker label ("4:1").
#[derive(Clone)]
pub struct Split {
    pub execution_date: NaiveDate,
    pub from: f64,
    pub to: f64,
}

// ── Chart event markers (Events tab: Dividends / Splits) ────────────────────
/// Midnight-UTC UNIX seconds for a calendar date — the x-anchor for a marker.
fn date_to_unix(d: NaiveDate) -> f64 {
    d.and_hms_opt(0, 0, 0)
        .map(|dt| dt.and_utc().timestamp() as f64)
        .unwrap_or(0.0)
}

/// A split marker: execution date (UNIX seconds) + the ratio (to:from).
#[derive(Serialize, specta::Type)]
pub struct SplitEvent {
    pub date: f64,
    pub from: f64,
    pub to: f64,
}

/// A dividend marker: ex-dividend date (UNIX seconds) + cash amount per share.
#[derive(Clone, Serialize, specta::Type)]
pub struct DividendEvent {
    pub date: f64,
    pub amount: f64,
}

/// Every already-executed split for `ticker`, newest-first. `None` on any lookup
/// failure (the caller then bypasses the REST cache rather than risk stale bars).
async fn fetch_splits(ticker: &str, today: NaiveDate) -> Option<Vec<Split>> {
    let answer: SplitsAnswer = get_json(
        "splits",
        "splits",
        &[("ticker", ticker.to_string()), ("until", today.to_string()), ("limit", "1000".into())],
    )
    .await
    .map_err(|e| eprintln!("[market_rest] {e}"))
    .ok()?;
    Some(
        answer
            .splits
            .into_iter()
            .filter_map(|r| {
                // A split without its date cannot be placed; a missing side
                // of the ratio reads 1.
                let date = NaiveDate::parse_from_str(r.date.as_deref()?, "%Y-%m-%d").ok()?;
                Some(Split { execution_date: date, from: r.from.unwrap_or(1.0), to: r.to.unwrap_or(1.0) })
            })
            .collect(),
    )
}

/// Per-ticker, per-day memo of the splits list. One small REST call resolved at
/// most once per ticker per calendar day; a transient failure simply retries on
/// the next fetch. Shared by the REST cache epoch and the S3 adjustment.
pub(super) static SPLITS: DayMemo<String, Vec<Split>> = OnceLock::new();

/// Memoised already-executed splits for `ticker` (newest-first), or `None` on a
/// lookup failure.
pub async fn fetch_splits_cached(ticker: &str) -> Option<Arc<Vec<Split>>> {
    let ticker = ticker.to_string();
    let memo = SPLITS.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    {
        let guard = memo.lock().await;
        if let Some((as_of, splits)) = guard.get(&ticker) {
            if *as_of == today {
                return Some(splits.clone());
            }
        }
    }
    // Resolve without holding the lock (don't serialize unrelated tickers). A
    // concurrent duplicate lookup for the same ticker is harmless/idempotent.
    let splits = Arc::new(fetch_splits(&ticker, today).await?);
    // A fresh resolution is the once-per-ticker-per-day moment to reclaim any
    // stale epoch directories left behind by a past split. Fire-and-forget so
    // the cleanup never delays the data path.
    {
        let (t, epoch) = (ticker.clone(), epoch_of(&splits));
        tokio::spawn(async move { prune_stale_epochs(&t, &epoch).await });
    }
    memo.lock().await.insert(ticker, (today, splits.clone()));
    Some(splits)
}

/// Test hook: replace the memoised split list of `ticker` (a split that
/// executes after the archive file was cached).
#[cfg(test)]
pub(crate) async fn set_splits_for_test(ticker: &str, splits: Vec<Split>) {
    let memo = SPLITS.get_or_init(|| Mutex::new(HashMap::new()));
    memo.lock().await.insert(ticker.to_string(), (Utc::now().date_naive(), Arc::new(splits)));
}

/// The executed splits of `ticker` (newest-first), or `None` on a lookup
/// failure. Reuses the per-day splits memo.
pub async fn executed_splits(ticker: &str) -> Option<Vec<SplitEvent>> {
    let splits = fetch_splits_cached(ticker).await?;
    Some(splits.iter().map(|s| SplitEvent { date: date_to_unix(s.execution_date), from: s.from, to: s.to }).collect())
}

/// Split markers for the chart (newest-first); empty on a lookup failure.
pub async fn split_events(ticker: &str) -> Vec<SplitEvent> {
    executed_splits(ticker).await.unwrap_or_default()
}

/// A `dividends` answer (newest first).
#[derive(Deserialize)]
struct DividendsAnswer {
    #[serde(default)]
    dividends: Vec<DividendRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DividendRow {
    #[serde(default)]
    ex_date: Option<String>,
    #[serde(default)]
    amount: Option<f64>,
}

/// Per-ticker, per-day memo of dividend markers (mirrors the splits memo). One
/// small REST call resolved at most once per ticker per calendar day.
pub(super) static DIVIDENDS: DayMemo<String, Vec<DividendEvent>> = OnceLock::new();

/// Ex-dividend markers for `ticker` (newest-first); empty on any lookup failure.
pub async fn dividend_events(ticker: &str) -> Vec<DividendEvent> {
    paid_dividends(ticker).await.unwrap_or_default()
}

/// The dividends of `ticker` (newest-first, amounts as declared), or `None`
/// on a lookup failure (not memoised, so the next call asks again).
pub async fn paid_dividends(ticker: &str) -> Option<Vec<DividendEvent>> {
    let ticker = ticker.to_string();
    let memo = DIVIDENDS.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    {
        let guard = memo.lock().await;
        if let Some((as_of, evs)) = guard.get(&ticker) {
            if *as_of == today {
                return Some((**evs).clone());
            }
        }
    }
    let evs = Arc::new(fetch_dividends(&ticker, today).await?);
    memo.lock().await.insert(ticker, (today, evs.clone()));
    Some((*evs).clone())
}

async fn fetch_dividends(ticker: &str, today: NaiveDate) -> Option<Vec<DividendEvent>> {
    let answer: DividendsAnswer = get_json(
        "dividends",
        "dividends",
        &[("ticker", ticker.to_string()), ("until", today.to_string()), ("limit", "1000".into())],
    )
    .await
    .map_err(|e| eprintln!("[market_rest] {e}"))
    .ok()?;
    Some(
        answer
            .dividends
            .into_iter()
            .filter_map(|r| {
                // Without its ex-date or amount a dividend can neither be
                // marked nor adjusted for: dropped (it used to read 0).
                let date = NaiveDate::parse_from_str(r.ex_date.as_deref()?, "%Y-%m-%d").ok()?;
                Some(DividendEvent { date: date_to_unix(date), amount: r.amount? })
            })
            .collect(),
    )
}

/// The cache epoch implied by a splits list (newest-first): the latest executed
/// split date, or `"none"` when the ticker has never split.
pub(super) fn epoch_of(splits: &[Split]) -> String {
    splits
        .first()
        .map(|s| s.execution_date.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "none".to_string())
}

/// Remove stale split-epoch cache directories for a ticker, keeping only
/// `current_epoch`. After a split the prior epoch's sessions are never read
/// again (the namespace moved on), so this reclaims that bounded disk. A missing
/// directory or any per-entry failure is ignored — cleanup is best-effort.
async fn prune_stale_epochs(ticker: &str, current_epoch: &str) {
    let dir = rest_cache_root().join(REST_CACHE_DIR).join(ticker.to_uppercase());
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) != Some(current_epoch) {
            let _ = tokio::fs::remove_dir_all(&path).await;
        }
    }
}

/// Cache namespace for a ticker's current split-adjustment state — the latest
/// executed split date, or `"none"`. Folding this into the REST cache path means
/// a fresh split changes the namespace and invalidates prior cached sessions.
/// `None` (lookup failed) → the caller bypasses the cache to avoid stale bars.
pub(super) async fn split_epoch(ticker: &str) -> Option<String> {
    let splits = fetch_splits_cached(ticker).await?;
    Some(epoch_of(&splits))
}
