//! Snapshot entries and their shaping (last, change, extended-hours move),
//! and the single-ticker snapshot of the detail header.
use super::http;
use super::prior_close::prior_session_closes;
use crate::data::gateway::{self, BASE, NO_TOKEN};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

// ── Snapshot (/v2/snapshot) ──────────────────────────────────────────────

/// Live(ish) snapshot for the detail header. `source` is "live" when the
/// current session has volume, else "prev" (we fall back to the prior
/// day's bar so the range/last don't read as zero when the market's shut).
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub ticker: String,
    pub last: f64,
    pub change: f64,
    pub change_percent: f64,
    pub day_high: f64,
    pub day_low: f64,
    pub day_volume: f64,
    /// Pre/post-market move vs the regular close — the "Ext" column. `None`
    /// when there's no extended-hours trade (e.g. mid-session).
    pub ext_change_percent: Option<f64>,
    pub source: String,
    pub updated_ns: f64,
}

// One per-ticker entry from either the single (`{ "ticker": … }`) or the bulk
// (`{ "tickers": [ … ] }`) snapshot endpoint — same shape, so one struct and
// one shaping function serve both.
#[derive(Deserialize)]
pub(super) struct SnapEntry {
    #[serde(default)]
    pub(super) ticker: String,
    #[serde(default, rename = "todaysChange")]
    pub(super) todays_change: f64,
    #[serde(default, rename = "todaysChangePerc")]
    pub(super) todays_change_perc: f64,
    #[serde(default)]
    pub(super) updated: f64,
    #[serde(default)]
    pub(super) day: Option<SnapBar>,
    #[serde(default, rename = "prevDay")]
    pub(super) prev_day: Option<SnapBar>,
    #[serde(default)]
    pub(super) min: Option<MinBar>,
}

#[derive(Deserialize)]
struct SnapResponse {
    ticker: Option<SnapEntry>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct SnapBar {
    #[serde(default)]
    pub(super) o: f64,
    #[serde(default)]
    pub(super) h: f64,
    #[serde(default)]
    pub(super) l: f64,
    #[serde(default)]
    pub(super) c: f64,
    #[serde(default)]
    pub(super) v: f64,
}

#[derive(Deserialize)]
pub(super) struct MultiSnapResponse {
    #[serde(default)]
    pub(super) tickers: Vec<SnapEntry>,
    #[serde(default)]
    pub(super) status: String,
    #[serde(default)]
    pub(super) error: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct MinBar {
    #[serde(default)]
    pub(super) o: f64,
    #[serde(default)]
    pub(super) h: f64,
    #[serde(default)]
    pub(super) l: f64,
    #[serde(default)]
    pub(super) c: f64,
    #[serde(default)]
    pub(super) v: f64,
    /// Minute start, UNIX **milliseconds**.
    #[serde(default)]
    pub(super) t: i64,
}

/// The values the right rail shows for one ticker, distilled from a snapshot.
pub(super) struct Shaped {
    pub(super) last: f64,
    pub(super) change: f64,
    pub(super) change_percent: f64,
    pub(super) ext_change_percent: Option<f64>,
    pub(super) day_high: f64,
    pub(super) day_low: f64,
    pub(super) day_volume: f64,
    pub(super) source: &'static str,
}

/// Normalise one snapshot entry exactly as the reference mock's
/// `shapeSnapshotTicker` does — this is the logic that makes pre-market read
/// correctly:
///   • `last` is the **regular-session** close (today's once it has traded,
///     else the prior session's) — NOT the latest pre/post-market trade.
///   • The day change is close-vs-prior-close: Massive's `todaysChange*` while
///     the session is live; for a closed/not-yet-open session, the completed
///     session's close vs the session-*before* it (`prior_close`), falling back
///     to the session's own open→close when no baseline is available.
///   • `ext_change_percent` is the pre/post-market move: the latest trade
///     (`min.c`, which includes extended hours) vs that regular close, shown
///     in the "Ext" column.
pub(super) fn shape_snapshot(t: &SnapEntry, prior_close: Option<f64>) -> Option<Shaped> {
    let prev = t.prev_day.as_ref();
    // Today's regular session, but only once it has actually traded.
    let live = t.day.as_ref().filter(|d| d.c > 0.0);
    let src = live.or(prev)?;

    let (change, change_percent) = if live.is_some() {
        // Regular hours — Massive's todaysChange* is already close-vs-prev-close.
        (t.todays_change, t.todays_change_perc)
    } else if let Some(pc) = prior_close.filter(|p| *p > 0.0) {
        // Closed / pre-open — completed session's close vs the prior session's.
        (src.c - pc, (src.c - pc) / pc * 100.0)
    } else {
        // No baseline recoverable — the session's own open→close.
        let pct = if src.o > 0.0 { (src.c - src.o) / src.o * 100.0 } else { 0.0 };
        (src.c - src.o, pct)
    };

    // Extended-hours move: latest trade (incl. pre/post) vs the regular close.
    let ext_change_percent = {
        let min_close = t.min.as_ref().map(|m| m.c).unwrap_or(0.0);
        let ext_base = src.c;
        (min_close > 0.0 && ext_base > 0.0).then(|| (min_close - ext_base) / ext_base * 100.0)
    };

    Some(Shaped {
        last: src.c,
        change,
        change_percent,
        ext_change_percent,
        day_high: src.h,
        day_low: src.l,
        day_volume: src.v,
        source: if live.is_some() { "live" } else { "prev" },
    })
}

/// True when this entry's regular session hasn't traded yet (so the day %
/// change must be measured against the prior-session baseline, not `prevDay`).
pub(super) fn is_closed(t: &SnapEntry) -> bool {
    t.day.as_ref().map(|d| d.c > 0.0) != Some(true)
}

pub async fn fetch_ticker_snapshot(ticker: &str) -> Result<Snapshot> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!(
        "{BASE}/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}?apiKey={token}"
    );
    let resp = http().get(&url).send().await.context("massive snapshot request")?;
    let http_status = resp.status();
    let body: SnapResponse = resp.json().await.context("massive snapshot: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive snapshot {http_status}: {}",
            body.error.unwrap_or_default()
        ));
    }
    let t = body
        .ticker
        .ok_or_else(|| anyhow!("massive snapshot: no ticker for {ticker}"))?;
    let prior_close = if is_closed(&t) {
        prior_session_closes(token).await.get(ticker).copied()
    } else {
        None
    };
    let s = shape_snapshot(&t, prior_close)
        .ok_or_else(|| anyhow!("massive snapshot: neither day nor prevDay for {ticker}"))?;
    Ok(Snapshot {
        ticker: ticker.to_string(),
        last: s.last,
        change: s.change,
        change_percent: s.change_percent,
        day_high: s.day_high,
        day_low: s.day_low,
        day_volume: s.day_volume,
        ext_change_percent: s.ext_change_percent,
        source: s.source.to_string(),
        updated_ns: t.updated,
    })
}
