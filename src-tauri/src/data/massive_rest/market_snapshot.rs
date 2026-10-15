//! Full-market snapshot for the screener, from the REST snapshot or the
//! live feed, shaped with the watchlist rules.
use super::http;
use super::prior_close::prior_session_closes;
use super::snapshot::{is_closed, shape_snapshot, MinBar, MultiSnapResponse, SnapBar, SnapEntry};
use crate::data::gateway::{self, BASE, NO_TOKEN};
use anyhow::{anyhow, Context, Result};

// ── Full-market snapshot (/v2/snapshot, no ticker list) ──────────────────
//
// The screener's live table: every US ticker in one call (13,256 tickers,
// 5.3 MB JSON, ~1.35 MB gzip, 1.2-2.1 s through the gateway, measured
// 29/09/2026). Shaped with the same rules as the watchlist (`shape_snapshot`)
// so both surfaces show the same last / change.

/// One ticker of the full-market snapshot, shaped for the screener.
pub struct MarketRow {
    pub ticker: String,
    /// Regular-session close (today's once traded, else the prior session's).
    pub last: f64,
    pub change: f64,
    pub change_percent: f64,
    /// The shown session's open / high / low / volume.
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub volume: f64,
    /// Close of the session before the shown one (the change baseline);
    /// `None` when no baseline is known.
    pub prev_close: Option<f64>,
    /// True when the shown session is today's (it has traded), false when the
    /// row shows the previous completed session (pre-open, closed day).
    pub live: bool,
    /// Snapshot update stamp, UNIX milliseconds.
    pub updated_ms: f64,
}

/// Fetch and shape the whole-market delayed snapshot.
pub async fn fetch_market_snapshot() -> Result<Vec<MarketRow>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!("{BASE}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey={token}");
    let resp = http().get(&url).send().await.context("massive market snapshot request")?;
    let http_status = resp.status();
    let body: MultiSnapResponse = resp.json().await.context("massive market snapshot: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive market snapshot {http_status}: {}",
            body.error.unwrap_or_else(|| body.status.clone())
        ));
    }
    Ok(market_rows(&body.tickers, token).await)
}

/// Shape snapshot entries into screener rows (the rules of the REST path and
/// of the live feed).
async fn market_rows(entries: &[SnapEntry], token: &str) -> Vec<MarketRow> {
    let prior = if entries.iter().any(is_closed) {
        Some(prior_session_closes(token).await)
    } else {
        None
    };
    entries
        .iter()
        .filter_map(|t| {
            let closed = is_closed(t);
            let prior_close = if closed {
                prior.as_ref().and_then(|m| m.get(&t.ticker).copied())
            } else {
                None
            };
            let s = shape_snapshot(t, prior_close)?;
            let src = if closed { t.prev_day.as_ref() } else { t.day.as_ref() }?;
            let prev_close = if closed {
                prior_close
            } else {
                t.prev_day.as_ref().map(|p| p.c).filter(|c| *c > 0.0)
            };
            // The reference app's `change` is close vs previous close. Massive's
            // todaysChange follows the latest trade, post-market included
            // (29/09/2026: 16 of 73 symbols off after the close).
            let (change, change_percent) = match prev_close {
                Some(pc) => (s.last - pc, (s.last / pc - 1.0) * 100.0),
                None => (s.change, s.change_percent),
            };
            Some(MarketRow {
                ticker: t.ticker.clone(),
                last: s.last,
                change,
                change_percent,
                open: src.o,
                high: src.h,
                low: src.l,
                volume: src.v,
                prev_close,
                live: !closed,
                updated_ms: t.updated / 1e6,
            })
        })
        .collect()
}

/// One ticker of the market snapshot as the screener live feed carries it:
/// the same fields as a REST snapshot entry, a missing one as `None`. Bars
/// are `[open, high, low, close, volume]`.
pub struct FeedSnapshot {
    pub ticker: String,
    /// Snapshot update stamp, UNIX milliseconds.
    pub updated_ms: f64,
    pub todays_change: Option<f64>,
    pub day: Option<[f64; 5]>,
    pub prev_day: Option<[f64; 5]>,
    /// Close of the latest minute bar.
    pub min_close: Option<f64>,
}

/// Shape live-feed snapshots with the rules of [`fetch_market_snapshot`], so
/// a table built from the feed equals one built from the REST snapshot.
pub async fn shape_feed_snapshots(snapshots: Vec<FeedSnapshot>) -> Result<Vec<MarketRow>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let bar = |b: [f64; 5]| SnapBar { o: b[0], h: b[1], l: b[2], c: b[3], v: b[4] };
    let entries: Vec<SnapEntry> = snapshots
        .into_iter()
        .map(|f| {
            let change = f.todays_change.unwrap_or(0.0);
            // The feed does not carry the percentage: change / previous close.
            let prev_close = f.prev_day.map_or(0.0, |p| p[3]);
            SnapEntry {
                ticker: f.ticker,
                todays_change: change,
                todays_change_perc: if prev_close > 0.0 { change / prev_close * 100.0 } else { 0.0 },
                updated: f.updated_ms * 1e6,
                day: f.day.map(bar),
                prev_day: f.prev_day.map(bar),
                min: f.min_close.map(|c| MinBar { c, ..MinBar::default() }),
            }
        })
        .collect();
    Ok(market_rows(&entries, token).await)
}
