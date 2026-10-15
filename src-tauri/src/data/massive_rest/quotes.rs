//! Bulk snapshot of the subscribed tickers: the quotes of the live poller.
use super::prior_close::prior_session_closes;
use super::snapshot::{is_closed, shape_snapshot, MultiSnapResponse};
use super::{http, Candle};
use crate::data::gateway::{self, BASE, NO_TOKEN};
use anyhow::{anyhow, Context, Result};

// ── Bulk snapshot (/v2/snapshot … ?tickers=) ─────────────────────────────
//
// One HTTP call returns the delayed snapshot for many tickers at once —
// the REST-polling substitute for the WebSocket live feed (the Stocks
// Starter plan has no WebSocket entitlement; see massive_poll.rs).

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
    let token = gateway::token().context(NO_TOKEN)?;
    let joined = tickers.join(",");
    let url = format!(
        "{BASE}/v2/snapshot/locale/us/markets/stocks/tickers\
         ?tickers={joined}&apiKey={token}"
    );
    let resp = http().get(&url).send()
        .await
        .context("massive bulk snapshot request")?;
    let http_status = resp.status();
    let body: MultiSnapResponse = resp
        .json()
        .await
        .context("massive bulk snapshot: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive bulk snapshot {http_status}: {}",
            body.error.unwrap_or_else(|| body.status.clone())
        ));
    }

    // Any not-yet-open session needs the prior-session close baseline; resolve
    // the whole-market map once (memoised) and share it across those tickers.
    let prior = if body.tickers.iter().any(is_closed) {
        Some(prior_session_closes(token).await)
    } else {
        None
    };

    Ok(body
        .tickers
        .iter()
        .filter_map(|t| {
            let prior_close = if is_closed(t) {
                prior.as_ref().and_then(|m| m.get(&t.ticker).copied())
            } else {
                None
            };
            let s = shape_snapshot(t, prior_close)?;
            // `min.t == 0` means the snapshot carried no minute bar (market
            // closed) — leave the chart untouched rather than emit a 1970 bar.
            let minute = t.min.as_ref().filter(|m| m.t > 0).map(|m| Candle {
                time: (m.t / 1000) as f64,
                open: m.o,
                high: m.h,
                low: m.l,
                close: m.c,
                volume: m.v,
            });
            // Today's session bar, only once it has traded (`c > 0`); a closed
            // or pre-open snapshot leaves the chart's daily bar untouched.
            let day = t.day.as_ref().filter(|d| d.c > 0.0).map(|d| Candle {
                time: (t.updated / 1e9).floor(),
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
