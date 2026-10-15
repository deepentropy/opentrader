//! Close of the session before the last completed one, for the whole
//! market at once: the baseline of a closed session's change.
use super::http;
use crate::data::gateway::BASE;
use chrono::{Datelike, Duration as ChronoDuration, NaiveDate, Utc, Weekday};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

// ── Prior-session close (grouped daily) ──────────────────────────────────
//
// A *closed* session's daily % change is (close − prior-session close) /
// prior-session close, but the snapshot only carries the single most-recent
// `prevDay`. Rather than one daily-aggs call per ticker, pull the whole market
// for one date in a single grouped call and reuse it across every ticker.

#[derive(Deserialize)]
struct GroupedResponse {
    #[serde(default)]
    results: Vec<GroupedRow>,
}

#[derive(Deserialize)]
struct GroupedRow {
    #[serde(rename = "T")]
    t: String,
    #[serde(default)]
    c: f64,
}

/// All US-stock closes for one calendar date → `{ ticker: close }`, or `None`
/// when the date had no session (weekend / holiday / not-yet-published).
async fn fetch_grouped_closes(date: NaiveDate, token: &str) -> Option<HashMap<String, f64>> {
    let url = format!(
        "{BASE}/v2/aggs/grouped/locale/us/market/stocks/{date}\
         ?adjusted=true&apiKey={token}"
    );
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: GroupedResponse = resp.json().await.ok()?;
    if body.results.is_empty() {
        return None;
    }
    Some(body.results.into_iter().map(|r| (r.t, r.c)).collect())
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
pub(super) async fn prior_session_closes(token: &str) -> Arc<HashMap<String, f64>> {
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
            if let Some(c) = fetch_grouped_closes(cursor, token).await {
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
