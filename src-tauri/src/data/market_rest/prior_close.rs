//! Close of the session before the last completed one, for the whole
//! market at once: the baseline of a closed session's change.
use super::get_json;
use chrono::{Datelike, Duration as ChronoDuration, NaiveDate, Utc, Weekday};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

// ── Prior-session close (whole-market daily bars) ────────────────────────
//
// A *closed* session's daily % change is (close − prior-session close) /
// prior-session close, but the snapshot only carries the single most-recent
// `prev` bar. Rather than one bars call per ticker, pull the whole market for
// one date in a single `daily/<date>` call and reuse it across every ticker.

/// A `daily/<date>` answer: one entry per ticker in every array; empty arrays
/// on a day without a session.
#[derive(Deserialize)]
struct DailyAnswer {
    #[serde(default)]
    tickers: Vec<String>,
    #[serde(default)]
    c: Vec<Option<f64>>,
}

/// All US-stock closes for one calendar date → `{ ticker: close }`, or `None`
/// when the date had no session (weekend / holiday / not-yet-published) or
/// the lookup failed. A ticker without a close is left out.
async fn fetch_daily_closes(date: NaiveDate) -> Option<HashMap<String, f64>> {
    let answer: DailyAnswer = get_json("whole-market daily bars", &format!("daily/{date}"), &[("adjusted", "true".into())])
        .await
        .map_err(|e| eprintln!("[market_rest] {e}"))
        .ok()?;
    let closes: HashMap<String, f64> = answer
        .tickers
        .into_iter()
        .zip(answer.c)
        .filter_map(|(t, c)| Some((t, c?)))
        .collect();
    (!closes.is_empty()).then_some(closes)
}

/// Process-wide memo of the baseline close map, keyed by the day it was resolved
/// for. The `tokio::Mutex` held across the awaits also coalesces concurrent
/// callers onto a single resolution.
#[allow(clippy::type_complexity)]
pub(super) static PRIOR_CLOSES: OnceLock<Mutex<Option<(NaiveDate, Arc<HashMap<String, f64>>)>>> =
    OnceLock::new();

/// Closes of the session *before* the most recent completed one — the baseline
/// for a closed/pre-open session's daily % change. Walks back from yesterday
/// (skipping weekends) until two sessions return data; the second is the
/// baseline. Resolved at most once per calendar day.
pub(super) async fn prior_session_closes() -> Arc<HashMap<String, f64>> {
    let memo = PRIOR_CLOSES.get_or_init(|| Mutex::new(None));
    let today = Utc::now().date_naive();
    let mut guard = memo.lock().await;
    if let Some((as_of, closes)) = guard.as_ref() {
        if *as_of == today {
            return closes.clone();
        }
    }
    let mut found: Vec<HashMap<String, f64>> = Vec::new();
    let mut cursor = today - ChronoDuration::days(1);
    let mut steps = 0;
    while steps < 8 && found.len() < 2 {
        if !matches!(cursor.weekday(), Weekday::Sat | Weekday::Sun) {
            if let Some(c) = fetch_daily_closes(cursor).await {
                found.push(c);
            }
        }
        cursor -= ChronoDuration::days(1);
        steps += 1;
    }
    // found[0] = most recent completed session, found[1] = the baseline.
    let closes = Arc::new(found.into_iter().nth(1).unwrap_or_default());
    if !closes.is_empty() {
        *guard = Some((today, closes.clone()));
    }
    closes
}
