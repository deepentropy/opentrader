//! Bulk snapshot of the subscribed tickers: the quotes of the live poller.
use super::prior_close::prior_session_closes;
use super::snapshot::{is_closed, shape_snapshot, SnapshotList};
use super::{get_json, Candle};
use anyhow::Result;

// ── Bulk snapshot (`snapshot?tickers=`) ──────────────────────────────────
//
// One HTTP call returns the delayed snapshot for many tickers at once — the
// polled live feed of the watchlist and the chart's minute / day bars (see
// quote_poll.rs); it carries the session change and day bar, which the
// stream's bars and trades do not.

/// A single ticker's latest delayed values, distilled for the poller.
pub struct LiveTick {
    pub ticker: String,
    /// Regular-session close (today's once traded, else the prior session's) —
    /// the watchlist's "Last", also pre-market.
    pub last: f64,
    /// Absolute regular-session change (close vs prior close).
    pub change: f64,
    /// Percent regular-session change (close vs prior close).
    pub change_percent: f64,
    /// Pre/post-market move vs the regular close — the "Ext" column. `None`
    /// mid-session / when there's no extended-hours trade.
    pub ext_change_percent: Option<f64>,
    /// Regular-session volume (today's once traded, else the prior session's).
    pub volume: f64,
    /// "live" when today's regular session has traded, else "prev".
    pub source: String,
    /// Most recent minute bar, when the snapshot carries one — fed to the
    /// chart as a `ChartAggregate`. `None` outside market hours.
    pub minute: Option<Candle>,
    /// Today's full-session daily bar (`day` in the snapshot), once today has
    /// traded. Rides along on the `ChartAggregate` so the daily-family chart
    /// bar updates exactly (a warm daily history load skips today's forming
    /// bar). `time` is the snapshot's update stamp in UNIX seconds — the
    /// frontend re-buckets it to the daily-bar convention.
    pub day: Option<Candle>,
}

/// Fetch delayed snapshots for many tickers in a single request. Tickers
/// (the source's spelling) are comma-joined. Returns one `LiveTick` per ticker the
/// API knows about (unknown / halted tickers are simply omitted).
pub async fn fetch_snapshots(tickers: &[String]) -> Result<Vec<LiveTick>> {
    if tickers.is_empty() {
        return Ok(Vec::new());
    }
    let list: SnapshotList = get_json("quotes", "snapshot", &[("tickers", tickers.join(","))]).await?;
    let entries = list.entries();

    // Any not-yet-open session needs the prior-session close baseline; resolve
    // the whole-market map once (memoised) and share it across those tickers.
    let prior = if entries.iter().any(is_closed) {
        Some(prior_session_closes().await)
    } else {
        None
    };

    Ok(entries
        .iter()
        .filter_map(|t| {
            let prior_close = if is_closed(t) {
                prior.as_ref().and_then(|m| m.get(&t.ticker).copied())
            } else {
                None
            };
            let s = shape_snapshot(t, prior_close)?;
            // A minute bar without its start (null, or 0 before the session)
            // means none (market closed) — leave the chart untouched rather
            // than emit a 1970 bar.
            let minute = t.minute.as_ref().filter(|m| m.t > 0).map(|m| Candle {
                time: (m.t / 1000) as f64,
                open: m.bar.o,
                high: m.bar.h,
                low: m.bar.l,
                close: m.bar.c,
                volume: m.bar.v,
            });
            // Today's session bar, only once it has traded (`c > 0`); a closed
            // or pre-open snapshot leaves the chart's daily bar untouched.
            let day = t.day.as_ref().filter(|d| d.c > 0.0).map(|d| Candle {
                time: (t.updated_ms / 1e3).floor(),
                open: d.o,
                high: d.h,
                low: d.l,
                close: d.c,
                volume: d.v,
            });
            Some(LiveTick {
                ticker: t.ticker.clone(),
                last: s.last,
                change: s.change,
                change_percent: s.change_percent,
                ext_change_percent: s.ext_change_percent,
                volume: s.day_volume,
                source: s.source.to_string(),
                minute,
                day,
            })
        })
        .collect())
}
