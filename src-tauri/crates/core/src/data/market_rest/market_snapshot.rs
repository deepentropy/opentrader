//! Full-market snapshot for the screener, from the REST snapshot or the
//! live feed, shaped with the watchlist rules.
use super::get_raw;
use crate::screener::progress::{read_body, Download};
use super::prior_close::prior_session_closes;
use super::snapshot::{is_closed, shape_snapshot, MinBar, SnapBar, SnapEntry, SnapshotList};
use anyhow::{Context, Result};

// ── Full-market snapshot (`snapshot`, no ticker list) ────────────────────
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
    /// Pre-/post-market values and the 1h / 4h bar bases: from the live feed only.
    pub ext: ExtHours,
}

/// What the live feed keeps of the extended hours for one ticker (gateway columns `preOpen` … `h4Base`): the
/// pre-market (04:00-09:30 New York) and the post-market (the close to 20:00), each held after its session until
/// the next day trades, with the close its change is measured from; and the close of the previous regular 1h / 4h
/// bar (bars from 09:30). `None` when not known.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ExtHours {
    pub pre_open: Option<f64>,
    pub pre_high: Option<f64>,
    pub pre_low: Option<f64>,
    pub pre_close: Option<f64>,
    pub pre_volume: Option<f64>,
    /// The previous session's close.
    pub pre_base: Option<f64>,
    pub post_open: Option<f64>,
    pub post_high: Option<f64>,
    pub post_low: Option<f64>,
    pub post_close: Option<f64>,
    pub post_volume: Option<f64>,
    /// The day's regular close.
    pub post_base: Option<f64>,
    pub hour_base: Option<f64>,
    pub h4_base: Option<f64>,
}

impl ExtHours {
    /// Gateway column names, in the order of [`ExtHours::from_values`].
    pub const COLUMNS: [&'static str; 14] = [
        "preOpen", "preHigh", "preLow", "preClose", "preVolume", "preBase", "postOpen", "postHigh", "postLow",
        "postClose", "postVolume", "postBase", "hourBase", "h4Base",
    ];

    pub fn from_values(v: [Option<f64>; 14]) -> Self {
        ExtHours {
            pre_open: v[0],
            pre_high: v[1],
            pre_low: v[2],
            pre_close: v[3],
            pre_volume: v[4],
            pre_base: v[5],
            post_open: v[6],
            post_high: v[7],
            post_low: v[8],
            post_close: v[9],
            post_volume: v[10],
            post_base: v[11],
            hour_base: v[12],
            h4_base: v[13],
        }
    }
}

/// Fetch and shape the whole-market delayed snapshot.
pub async fn fetch_market_snapshot() -> Result<Vec<MarketRow>> {
    fetch_market_snapshot_counted(None).await
}

/// The same, counting its bytes on `d` against the size the gateway tells (`X-Body-Length`, before compression).
pub async fn fetch_market_snapshot_counted(d: Option<&Download>) -> Result<Vec<MarketRow>> {
    let resp = get_raw("market snapshot", "snapshot", &[]).await?;
    if let Some(d) = d {
        d.set_total(resp.headers().get("x-body-length").and_then(|v| v.to_str().ok()?.parse().ok()));
    }
    let body = read_body(resp, d, "market snapshot").await?;
    let list: SnapshotList = serde_json::from_slice(&body).context("market snapshot: unreadable answer")?;
    Ok(market_rows(&list.entries(), &[]).await)
}

/// Shape snapshot entries into screener rows (the rules of the REST path and
/// of the live feed). `ext`: each entry's extended-hours values, empty for the
/// REST snapshot.
async fn market_rows(entries: &[SnapEntry], ext: &[ExtHours]) -> Vec<MarketRow> {
    let prior = if entries.iter().any(is_closed) {
        Some(prior_session_closes().await)
    } else {
        None
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let closed = is_closed(t);
            let prior_close = if closed {
                prior.as_ref().and_then(|m| m.get(&t.ticker).copied())
            } else {
                None
            };
            let s = shape_snapshot(t, prior_close)?;
            let src = if closed { t.prev.as_ref() } else { t.day.as_ref() }?;
            let prev_close = if closed {
                prior_close
            } else {
                t.prev.as_ref().map(|p| p.c).filter(|c| *c > 0.0)
            };
            // The reference app's `change` is close vs previous close. The
            // snapshot's `change` follows the latest trade, post-market
            // included (29/09/2026: 16 of 73 symbols off after the close).
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
                updated_ms: t.updated_ms,
                ext: ext.get(i).copied().unwrap_or_default(),
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
    pub change: Option<f64>,
    pub day: Option<[f64; 5]>,
    pub prev: Option<[f64; 5]>,
    /// Close of the latest minute bar.
    pub minute_close: Option<f64>,
    pub ext: ExtHours,
}

/// Shape live-feed snapshots with the rules of [`fetch_market_snapshot`], so
/// a table built from the feed equals one built from the REST snapshot.
pub async fn shape_feed_snapshots(snapshots: Vec<FeedSnapshot>) -> Result<Vec<MarketRow>> {
    let bar = |b: [f64; 5]| SnapBar { o: b[0], h: b[1], l: b[2], c: b[3], v: b[4] };
    let ext: Vec<ExtHours> = snapshots.iter().map(|f| f.ext).collect();
    let entries: Vec<SnapEntry> = snapshots
        .into_iter()
        .map(|f| SnapEntry {
            ticker: f.ticker,
            // The feed does not carry the percentage: the shaping takes
            // change / previous close.
            change: f.change,
            change_pct: None,
            updated_ms: f.updated_ms,
            day: f.day.map(bar),
            prev: f.prev.map(bar),
            minute: f.minute_close.map(|c| MinBar { bar: SnapBar { c, ..SnapBar::default() }, t: 0 }),
        })
        .collect();
    Ok(market_rows(&entries, &ext).await)
}
