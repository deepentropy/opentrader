//! Disk cache of the aggregate bars: one file per closed session, the
//! no-trade sentinels, the legacy roots and "Clear cache".
use super::corporate_actions::{DIVIDENDS, SPLITS};
use super::prior_close::PRIOR_CLOSES;
use super::reference::{LISTING_DATES, TICKER_CHANGES};
use super::Candle;
use crate::data::trading_calendar;
use chrono::NaiveDate;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;

// ── REST-aggregate disk cache (closed sessions only) ─────────────────────
//
// The REST aggregate path (minute fast path + second bars + scroll-back) was
// the one market-data route with no caching: every intraday/second symbol or
// interval switch re-hit Massive. We now persist *closed* sessions per
// (ticker, timespan, mult, date) under `<cache_dir>/opentrader/rest_aggs/…`
// and only ever re-fetch the live tail.
//
// Glitch-safety rests on one rule: a session strictly before today's (UTC) date
// is immutable, so it is cached indefinitely; today's session is mutable
// (forming bars, late/corrected prints) and is ALWAYS fetched fresh, never
// persisted. The cached (days < today) and live (days >= today) segments are
// stitched on a half-open day boundary, so no bar is duplicated or dropped.
//
// Split-adjustment is handled by folding the ticker's latest executed-split
// date into the cache namespace (see `split_epoch`): `adjusted=true` rescales
// ALL historical bars when a split executes, so a fresh split changes the epoch
// and transparently invalidates every prior cached session.
//
// A ticker's pre-split epoch directory is reclaimed by `prune_stale_epochs` the
// next time its splits are resolved (once per ticker per day).
//
// No-trade sessions (sparse/illiquid tickers, halts) are persisted as empty
// sentinel files so they count as cache hits rather than forcing a full-range
// refetch every load (see `persist_closed_days`).
//
// Known limitation (fast-follow — see the feasibility assessment):
//  • Truncation: a cold range exceeding Massive's 50k base-unit cap drops its
//    oldest days (sort=desc keeps the most recent), which therefore never cache
//    — and their no-trade days can't be sentineled (can't prove they're empty
//    rather than dropped), so a truncated range stays on the cold path.

/// Cache root folder. `rest_aggs` (before 29/09/2026) detected truncation
/// from `resultsCount`, so the days cut from a truncated multi-minute range
/// were cached as empty no-trade days and the cut oldest day as a full day:
/// scroll-back and time sync stopped there ("history exhausted"). It also
/// keyed days by UTC date (see `bar_date`); `rest_aggs_v2` (dev builds of
/// 29-30/09/2026) still did. The new root drops those files; the old roots
/// are deleted once per run.
pub(super) const REST_CACHE_DIR: &str = "rest_aggs_v3";
const LEGACY_REST_CACHE_DIRS: &[&str] = &["rest_aggs", "rest_aggs_v2"];

pub(crate) fn rest_cache_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("opentrader")
}

/// Market-data folders under the cache root that "Clear cache" deletes: the
/// REST aggregate cache, its legacy roots, the older per-day caches and the
/// daily archive files. The
/// root itself is never deleted (on Windows it is also the install folder).
const CLEARABLE_CACHE_DIRS: &[&str] =
    &[REST_CACHE_DIR, "rest_aggs", "rest_aggs_v2", "day_aggs", "day_ticker", "minute_aggs", crate::data::daily_archive::CACHE_DIR];

/// Settings > Service > "Clear cache": delete the market-data disk cache and
/// forget the in-memory splits, dividends and prior-close memos. Bars are
/// fetched again on the next load.
pub async fn clear_market_data_cache() -> Result<(), String> {
    let root = rest_cache_root();
    for dir in CLEARABLE_CACHE_DIRS {
        let path = root.join(dir);
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(&path).await.map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    if let Some(m) = SPLITS.get() {
        m.lock().await.clear();
    }
    if let Some(m) = DIVIDENDS.get() {
        m.lock().await.clear();
    }
    if let Some(m) = LISTING_DATES.get() {
        m.lock().await.clear();
    }
    if let Some(m) = TICKER_CHANGES.get() {
        m.lock().await.clear();
    }
    if let Some(m) = PRIOR_CLOSES.get() {
        *m.lock().await = None;
    }
    Ok(())
}

/// Delete the legacy cache roots in the background, once per process.
pub(super) fn remove_legacy_cache_once() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        tokio::spawn(async {
            for dir in LEGACY_REST_CACHE_DIRS {
                let _ = tokio::fs::remove_dir_all(rest_cache_root().join(dir)).await;
            }
        });
    });
}

fn rest_cache_path(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    date: NaiveDate,
) -> PathBuf {
    rest_cache_root()
        .join(REST_CACHE_DIR)
        .join(ticker.to_uppercase())
        .join(epoch)
        .join(format!("{timespan}{mult}"))
        .join(format!("{}.json", date.format("%Y-%m-%d")))
}

pub(super) async fn read_day_cache(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    date: NaiveDate,
) -> Option<Vec<Candle>> {
    let path = rest_cache_path(ticker, epoch, timespan, mult, date);
    let bytes = tokio::fs::read(&path).await.ok()?;
    serde_json::from_slice::<Vec<Candle>>(&bytes).ok()
}

async fn write_day_cache(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    date: NaiveDate,
    bars: &[Candle],
) {
    let path = rest_cache_path(ticker, epoch, timespan, mult, date);
    if let Ok(json) = serde_json::to_vec(bars) {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&path, &json).await;
    }
}

/// Session (New York) date of a bar (its bucket start is unix seconds): the
/// cache key of a day. The UTC date split a winter session (its 19:00-20:00
/// post-market is 00:00-01:00 UTC next day), so a range ending on day D wrote a
/// "D+1" file holding only those bars, which could replace D+1's full file.
fn bar_date(bar: &Candle) -> Option<NaiveDate> {
    trading_calendar::ny_date(bar.time as i64)
}

/// Persist each *closed* day's slice of an oldest-first ranged response. Bars
/// are sorted ascending, so same-date bars are contiguous; days dated today or
/// later are skipped (the live tail is never cached).
#[allow(clippy::too_many_arguments)]
pub(super) async fn persist_closed_days(
    ticker: &str,
    epoch: &str,
    timespan: &str,
    mult: u32,
    bars: &[Candle],
    from: NaiveDate,
    to: NaiveDate,
    truncated: bool,
    today: NaiveDate,
) {
    // Write each closed day that has bars. A truncated response cuts its
    // oldest returned day part way (only the newest minutes of it came back),
    // so that day is not written: caching it would serve the partial day as
    // complete.
    let partial = if truncated { bars.first().and_then(bar_date) } else { None };
    let mut i = 0;
    while i < bars.len() {
        let Some(d) = bar_date(&bars[i]) else {
            i += 1;
            continue;
        };
        let mut j = i + 1;
        while j < bars.len() && bar_date(&bars[j]) == Some(d) {
            j += 1;
        }
        if d < today && Some(d) != partial {
            write_day_cache(ticker, epoch, timespan, mult, d, &bars[i..j]).await;
        }
        i = j;
    }

    // Sentinel the genuinely no-trade closed days so they read as cache hits
    // instead of forcing a full-range refetch every load.
    for d in empty_sentinel_days(bars, from, to, truncated, today) {
        write_day_cache(ticker, epoch, timespan, mult, d, &[]).await;
    }
}

/// Closed trading days in `[from, to]` that returned no bars and can be safely
/// cached as empty sentinels. The floor is the lowest date provably inside the
/// response: `from` when the response wasn't truncated, else the oldest returned
/// bar — truncation drops the OLDEST days (Massive sorts desc), so earlier
/// no-bar days are ambiguous (dropped vs no-trade) and are left unpersisted. An
/// empty response anchors nothing, so it yields no sentinels. Pure (no I/O).
pub(super) fn empty_sentinel_days(
    bars: &[Candle],
    from: NaiveDate,
    to: NaiveDate,
    truncated: bool,
    today: NaiveDate,
) -> Vec<NaiveDate> {
    let present: HashSet<NaiveDate> = bars.iter().filter_map(bar_date).collect();
    let Some(oldest) = present.iter().min().copied() else {
        return Vec::new();
    };
    let floor = if truncated { oldest } else { from };
    trading_calendar::trading_days_in_range(floor, to)
        .into_iter()
        .filter(|&d| d < today && !present.contains(&d))
        .collect()
}
