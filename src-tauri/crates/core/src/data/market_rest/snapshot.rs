//! Snapshot entries and their shaping (last, change, extended-hours move),
//! and the single-ticker snapshot of the detail header.
use super::prior_close::prior_session_closes;
use super::{get_json, seg};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

// ── Snapshot (`snapshot/<T>`, `snapshot?tickers=`) ────────────────────────

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
    /// Snapshot update stamp, Unix ms (0 when the gateway has none).
    pub updated_ms: f64,
}

/// One snapshot as the gateway sends it, alone (`snapshot/<T>`) or in a list
/// (`snapshot?tickers=`). Missing values are `null`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireSnapshot {
    #[serde(default)]
    ticker: Option<String>,
    /// Unix ms.
    #[serde(default)]
    updated: Option<f64>,
    #[serde(default)]
    change: Option<f64>,
    #[serde(default)]
    change_pct: Option<f64>,
    #[serde(default)]
    day: Option<WireBar>,
    /// The previous session's bar.
    #[serde(default)]
    prev: Option<WireBar>,
    /// The latest minute bar (`t` = its start, Unix ms).
    #[serde(default)]
    minute: Option<WireBar>,
}

#[derive(Deserialize)]
struct WireBar {
    #[serde(default)]
    t: Option<f64>,
    #[serde(default)]
    o: Option<f64>,
    #[serde(default)]
    h: Option<f64>,
    #[serde(default)]
    l: Option<f64>,
    #[serde(default)]
    c: Option<f64>,
    #[serde(default)]
    v: Option<f64>,
}

impl WireBar {
    /// A missing value of a bar reads 0, which the shaping takes as "not
    /// traded" (the gateway also sends zeros for a session not started yet).
    fn bar(&self) -> SnapBar {
        let z = |v: Option<f64>| v.unwrap_or(0.0);
        SnapBar { o: z(self.o), h: z(self.h), l: z(self.l), c: z(self.c), v: z(self.v) }
    }
}

/// A list of snapshots (`snapshot?tickers=` / the whole market).
#[derive(Deserialize)]
pub(super) struct SnapshotList {
    #[serde(default)]
    tickers: Vec<WireSnapshot>,
}

impl SnapshotList {
    pub(super) fn entries(self) -> Vec<SnapEntry> {
        self.tickers.into_iter().filter_map(SnapEntry::from_wire).collect()
    }
}

/// One snapshot entry, ready for the shaping rules.
pub(super) struct SnapEntry {
    pub(super) ticker: String,
    /// Change of the session vs the previous close, and in percent; `None`
    /// when not sent.
    pub(super) change: Option<f64>,
    pub(super) change_pct: Option<f64>,
    /// Unix ms; 0 when not sent.
    pub(super) updated_ms: f64,
    pub(super) day: Option<SnapBar>,
    pub(super) prev: Option<SnapBar>,
    pub(super) minute: Option<MinBar>,
}

impl SnapEntry {
    /// A sent snapshot without its ticker cannot be placed: dropped.
    fn from_wire(w: WireSnapshot) -> Option<Self> {
        Some(SnapEntry {
            ticker: w.ticker.filter(|t| !t.is_empty())?,
            change: w.change,
            change_pct: w.change_pct,
            updated_ms: w.updated.unwrap_or(0.0),
            day: w.day.as_ref().map(WireBar::bar),
            prev: w.prev.as_ref().map(WireBar::bar),
            minute: w.minute.as_ref().map(|m| MinBar { bar: m.bar(), t: m.t.unwrap_or(0.0) as i64 }),
        })
    }
}

#[derive(Default)]
pub(super) struct SnapBar {
    pub(super) o: f64,
    pub(super) h: f64,
    pub(super) l: f64,
    pub(super) c: f64,
    pub(super) v: f64,
}

#[derive(Default)]
pub(super) struct MinBar {
    pub(super) bar: SnapBar,
    /// Minute start, Unix **milliseconds** (0 = no minute bar).
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
///   • The day change is close-vs-prior-close: the snapshot's `change` while
///     the session is live (from the previous close when not sent); for a
///     closed/not-yet-open session, the completed session's close vs the
///     session-*before* it (`prior_close`), falling back to the session's own
///     open→close when no baseline is available.
///   • `ext_change_percent` is the pre/post-market move: the latest trade
///     (the minute close, which includes extended hours) vs that regular
///     close, shown in the "Ext" column.
pub(super) fn shape_snapshot(t: &SnapEntry, prior_close: Option<f64>) -> Option<Shaped> {
    let prev = t.prev.as_ref();
    // Today's regular session, but only once it has actually traded.
    let live = t.day.as_ref().filter(|d| d.c > 0.0);
    let src = live.or(prev)?;

    let (change, change_percent) = if live.is_some() {
        // Regular hours — the snapshot's change is already close-vs-prev-close.
        let prev_close = prev.map(|p| p.c).filter(|c| *c > 0.0);
        match (t.change, t.change_pct, prev_close) {
            (Some(c), Some(p), _) => (c, p),
            (Some(c), None, Some(pc)) => (c, c / pc * 100.0),
            (None, _, Some(pc)) => (src.c - pc, (src.c - pc) / pc * 100.0),
            (c, _, None) => (c.unwrap_or(0.0), 0.0),
        }
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
        let min_close = t.minute.as_ref().map(|m| m.bar.c).unwrap_or(0.0);
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
/// change must be measured against the prior-session baseline, not `prev`).
pub(super) fn is_closed(t: &SnapEntry) -> bool {
    t.day.as_ref().map(|d| d.c > 0.0) != Some(true)
}

pub async fn fetch_ticker_snapshot(ticker: &str) -> Result<Snapshot> {
    let wire: WireSnapshot = get_json("snapshot", &format!("snapshot/{}", seg(ticker)), &[]).await?;
    let t = SnapEntry::from_wire(wire).ok_or_else(|| anyhow!("snapshot: no ticker for {ticker}"))?;
    let prior_close = if is_closed(&t) {
        prior_session_closes().await.get(ticker).copied()
    } else {
        None
    };
    let s = shape_snapshot(&t, prior_close)
        .ok_or_else(|| anyhow!("snapshot: neither a session nor a previous session for {ticker}"))?;
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
        updated_ms: t.updated_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> SnapEntry {
        SnapEntry::from_wire(serde_json::from_str(json).unwrap()).unwrap()
    }

    /// Pre-market as served (13/10/2026): `day` and `minute` all zeros —
    /// the previous session is shown, against the prior close.
    #[test]
    fn zero_session_reads_as_not_traded() {
        let t = entry(
            r#"{"ticker":"AAPL","updated":0,"change":0,"changePct":0,"day":{"o":0,"h":0,"l":0,"c":0,"v":0,"vw":0},
               "prev":{"o":344.605,"h":347.09,"l":341.72,"c":342.96,"v":50061053,"vw":343.99},"minute":{"t":0,"o":0,"h":0,"l":0,"c":0,"v":0,"vw":0}}"#,
        );
        assert!(is_closed(&t));
        let s = shape_snapshot(&t, Some(340.0)).unwrap();
        assert_eq!((s.last, s.source, s.ext_change_percent), (342.96, "prev", None));
        assert!((s.change - 2.96).abs() < 1e-9);
    }

    /// Missing values are null: a live session without `change` measures it
    /// from the previous close; null bars and minute are absent.
    #[test]
    fn nulls_fall_back() {
        let t = entry(
            r#"{"ticker":"X","updated":1792000000000,"change":null,"changePct":null,"day":{"o":10,"h":11,"l":9,"c":10.5,"v":100,"vw":null},
               "prev":{"o":9,"h":10,"l":8,"c":10,"v":50,"vw":null},"minute":null}"#,
        );
        let s = shape_snapshot(&t, None).unwrap();
        assert_eq!((s.source, s.change, s.change_percent, s.ext_change_percent), ("live", 0.5, 5.0, None));
        assert_eq!(t.updated_ms, 1_792_000_000_000.0);
        let t = entry(r#"{"ticker":"Y","updated":null,"change":null,"changePct":null,"day":null,"prev":null,"minute":null}"#);
        assert!(shape_snapshot(&t, None).is_none());
        assert!(SnapEntry::from_wire(serde_json::from_str(r#"{"ticker":null}"#).unwrap()).is_none());
    }
}
