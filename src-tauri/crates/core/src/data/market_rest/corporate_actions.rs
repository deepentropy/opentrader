//! Splits and dividends: the per-day memos, the chart event markers and
//! the split epoch the disk cache is namespaced by.
use super::cache::{rest_cache_root, REST_CACHE_DIR};
use super::{get_json, DayMemo, TICKER_MEMO_CAP};
use crate::data::gateway::ApiError;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
    /// When the corrections of the ticker's bars last changed, if it has any.
    #[serde(default)]
    corrected: Option<String>,
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

/// A ticker's executed splits (newest first), read as a slice, and the
/// revision of the corrections of its bars.
#[derive(Clone, Default)]
pub struct Splits {
    pub(super) list: Vec<Split>,
    /// The gateway fixes a few wrong daily highs and lows; the cached sessions
    /// of before a correction are no longer the served ones.
    pub(super) corrected: Option<String>,
}

impl std::ops::Deref for Splits {
    type Target = [Split];
    fn deref(&self) -> &[Split] {
        &self.list
    }
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

/// A dividend marker: ex-dividend date (UNIX seconds) + cash amount per share,
/// and the payment date (UNIX seconds) when known.
#[derive(Clone, Serialize, specta::Type)]
pub struct DividendEvent {
    pub date: f64,
    pub amount: f64,
    #[serde(rename = "payDate")]
    pub pay_date: Option<f64>,
}

/// Every already-executed split for `ticker`, newest-first, or the lookup
/// error (the cache callers then bypass the REST cache rather than risk stale bars).
async fn fetch_splits(ticker: &str, today: NaiveDate) -> Result<Splits, ApiError> {
    let answer: SplitsAnswer = get_json(
        "splits",
        "splits",
        &[("ticker", ticker.to_string()), ("until", today.to_string()), ("limit", "1000".into())],
    )
    .await
    .inspect_err(|e| eprintln!("[market_rest] {e}"))?;
    Ok(Splits {
        corrected: answer.corrected,
        list: answer
            .splits
            .into_iter()
            .filter_map(|r| {
                // A split without its date cannot be placed; a missing side
                // of the ratio reads 1.
                let date = NaiveDate::parse_from_str(r.date.as_deref()?, "%Y-%m-%d").ok()?;
                Some(Split { execution_date: date, from: r.from.unwrap_or(1.0), to: r.to.unwrap_or(1.0) })
            })
            .collect(),
    })
}

/// Per-ticker, per-day memo of the splits list. One small REST call resolved at
/// most once per ticker per calendar day; a transient failure simply retries on
/// the next fetch. Shared by the REST cache epoch and the S3 adjustment.
pub(super) static SPLITS: DayMemo<String, Splits> = DayMemo::new(TICKER_MEMO_CAP);

/// Memoised already-executed splits for `ticker` (newest-first), or `None` on a
/// lookup failure.
pub async fn fetch_splits_cached(ticker: &str) -> Option<Arc<Splits>> {
    splits_cached(ticker).await.ok()
}

/// Memoised already-executed splits for `ticker` (newest-first), or the lookup error.
async fn splits_cached(ticker: &str) -> Result<Arc<Splits>, ApiError> {
    let ticker = ticker.to_string();
    let today = crate::clock::utc().date_naive();
    if let Some(splits) = SPLITS.get(&ticker, |as_of| *as_of == today) {
        return Ok(splits);
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
    SPLITS.insert(ticker, today, splits.clone());
    Ok(splits)
}

/// Test hook: replace the memoised split list of `ticker` (a split that
/// executes after the archive file was cached).
#[cfg(test)]
pub(crate) async fn set_splits_for_test(ticker: &str, splits: Vec<Split>) {
    SPLITS.insert(ticker.to_string(), crate::clock::utc().date_naive(), Arc::new(Splits { list: splits, corrected: None }));
}

/// The executed splits of `ticker` (newest-first) for the chart markers and
/// the bar scaling, or the lookup error (the app asks again when the server
/// could not be reached). Reuses the per-day splits memo.
pub async fn split_events(ticker: &str) -> Result<Vec<SplitEvent>, ApiError> {
    let splits = splits_cached(ticker).await?;
    Ok(splits.iter().map(|s| SplitEvent { date: date_to_unix(s.execution_date), from: s.from, to: s.to }).collect())
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
    pay_date: Option<String>,
    #[serde(default)]
    amount: Option<f64>,
}

/// Per-ticker, per-day memo of dividend markers (mirrors the splits memo). One
/// small REST call resolved at most once per ticker per calendar day.
pub(super) static DIVIDENDS: DayMemo<String, Vec<DividendEvent>> = DayMemo::new(TICKER_MEMO_CAP);

/// Ex-dividend markers for `ticker` (newest-first); empty on any lookup failure.
pub async fn dividend_events(ticker: &str) -> Result<Vec<DividendEvent>, ApiError> {
    dividends_cached(ticker).await
}

/// The dividends of `ticker` (newest-first, amounts as declared), or the
/// lookup error (not memoised, so the next call asks again).
async fn dividends_cached(ticker: &str) -> Result<Vec<DividendEvent>, ApiError> {
    let ticker = ticker.to_string();
    let today = crate::clock::utc().date_naive();
    if let Some(evs) = DIVIDENDS.get(&ticker, |as_of| *as_of == today) {
        return Ok((*evs).clone());
    }
    let evs = Arc::new(fetch_dividends(&ticker, today).await?);
    DIVIDENDS.insert(ticker, today, evs.clone());
    Ok((*evs).clone())
}

async fn fetch_dividends(ticker: &str, today: NaiveDate) -> Result<Vec<DividendEvent>, ApiError> {
    let answer: DividendsAnswer = get_json(
        "dividends",
        "dividends",
        &[("ticker", ticker.to_string()), ("until", today.to_string()), ("limit", "1000".into())],
    )
    .await
    .inspect_err(|e| eprintln!("[market_rest] {e}"))?;
    Ok(
        answer
            .dividends
            .into_iter()
            .filter_map(|r| {
                // Without its ex-date or amount a dividend can neither be
                // marked nor adjusted for: dropped (it used to read 0).
                let date = NaiveDate::parse_from_str(r.ex_date.as_deref()?, "%Y-%m-%d").ok()?;
                let pay_date = r.pay_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).map(date_to_unix);
                Some(DividendEvent { date: date_to_unix(date), amount: r.amount?, pay_date })
            })
            .collect(),
    )
}

/// The cache epoch implied by a splits list (newest-first): the latest executed
/// split date, or `"none"` when the ticker has never split, and the revision
/// of the corrections of its bars when it has any.
pub(super) fn epoch_of(splits: &Splits) -> String {
    let split = splits
        .first()
        .map(|s| s.execution_date.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "none".to_string());
    match &splits.corrected {
        // A folder name: the digits of the time.
        Some(rev) => format!("{split}_c{}", rev.chars().filter(char::is_ascii_digit).collect::<String>()),
        None => split,
    }
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

/// Cache namespace for a ticker's current bars — the latest executed split
/// date, or `"none"`, and the revision of its corrections. Folding this into
/// the REST cache path means a fresh split or correction changes the namespace
/// and invalidates prior cached sessions.
/// `None` (lookup failed) → the caller bypasses the cache to avoid stale bars.
pub(super) async fn split_epoch(ticker: &str) -> Option<String> {
    let splits = fetch_splits_cached(ticker).await?;
    Some(epoch_of(&splits))
}
