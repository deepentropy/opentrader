/*
 * Provider capabilities — what the active data provider can serve, reported to
 * the frontend instead of hardcoded there. Modelled on a datafeed `onReady`
 * configuration plus the `data_status` / `delay` fields of the symbol info.
 *
 * Two halves with different costs:
 *   • the static part (`ProviderCapabilities` minus `entitlements`) is what the
 *     provider CODE can serve — returned at once, no I/O;
 *   • `Entitlements` is what the API KEY / plan allows — probed over the
 *     network in the background (see `entitlements.rs`), cached on disk, and
 *     pushed to the frontend with the `provider-capabilities` event.
 *
 * Dates are `YYYY-MM-DD` strings and times RFC 3339 strings: specta cannot
 * export 64-bit integers, and strings keep the cache file readable.
 */
use serde::{Deserialize, Serialize};
use tauri_specta::Event;

/// Everything the frontend needs to know about the active provider. Also the
/// payload of the `provider-capabilities` event, emitted whenever the
/// entitlements change (probe finished).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    /// Matches `DataProvider::name()`.
    pub name: String,
    pub resolutions: ResolutionCaps,
    /// Max base units one history request returns (Massive: 50 000).
    pub max_bars_per_request: u32,
    /// The provider lists dividends, so prices can be adjusted for them
    /// (bottom-bar ADJ).
    pub adjusted_toggle: bool,
    /// Bars include pre/post-market (bottom-bar RTH/ETH).
    pub extended_hours: bool,
    pub reference: ReferenceCaps,
    /// `None` until the first probe settles, or when the build has no credential.
    pub entitlements: Option<Entitlements>,
}

/// Native bar multipliers the provider is wired for. The frontend's interval
/// picker and `getBars` only accept intervals built from these.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionCaps {
    /// Second multipliers (1S, 5S, …).
    pub seconds: Vec<u32>,
    /// Minute multipliers (1, 5, …, 240).
    pub minutes: Vec<u32>,
    /// Daily bars.
    pub daily: bool,
    /// 1W / 1M are aggregated on the client from the daily series.
    pub weekly_monthly_from_daily: bool,
}

/// Reference features the provider implements.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCaps {
    pub search: bool,
    /// Symbol search accepts a security-type filter.
    pub search_type_filter: bool,
    pub snapshot: bool,
    pub dividends: bool,
    pub splits: bool,
    pub news: bool,
    pub icons: bool,
}

/// Symbol `data_status` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DataStatus {
    Streaming,
    DelayedStreaming,
    Endofday,
    /// The provider reported a status we have no mapping for.
    Unknown,
}

/// What the credential / plan allows, measured by the provider's probe.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Entitlements {
    pub data_status: DataStatus,
    /// The provider's own status word, kept for diagnosis (Massive: "DELAYED").
    pub raw_status: String,
    /// Data delay in seconds (Massive delayed plans: 900).
    pub delay_sec: u32,
    pub history_floor: HistoryFloor,
    /// Live-stream channels the key may subscribe to. `None` until the stream
    /// probe finishes, or when it failed.
    pub stream: Option<StreamCaps>,
    /// When the history probe ran (RFC 3339, UTC).
    pub checked_at: String,
}

/// Oldest available bar date per bar family (`YYYY-MM-DD`, UTC); `None` when
/// the probe returned no bar for that family.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFloor {
    pub second: Option<String>,
    pub minute: Option<String>,
    pub day: Option<String>,
}

/// Live-stream channels the key is entitled to.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamCaps {
    pub minute_bars: bool,
    pub second_bars: bool,
    pub trades: bool,
    pub quotes: bool,
}

/// Result of a provider's history probe (the REST half of `Entitlements`).
#[derive(Debug, Clone)]
pub struct HistoryProbe {
    pub data_status: DataStatus,
    pub raw_status: String,
    pub delay_sec: u32,
    pub floor: HistoryFloor,
}

/// Bar family, for `history_floor` lookups.
#[derive(Debug, Clone, Copy)]
pub enum BarFamily {
    Second,
    Minute,
    Day,
}

impl HistoryFloor {
    pub fn get(&self, family: BarFamily) -> Option<chrono::NaiveDate> {
        let s = match family {
            BarFamily::Second => &self.second,
            BarFamily::Minute => &self.minute,
            BarFamily::Day => &self.day,
        };
        s.as_deref()
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_parses_per_family() {
        let f = HistoryFloor {
            second: None,
            minute: Some("2016-09-29".into()),
            day: Some("bad".into()),
        };
        assert_eq!(f.get(BarFamily::Second), None);
        assert_eq!(
            f.get(BarFamily::Minute),
            chrono::NaiveDate::from_ymd_opt(2016, 9, 29)
        );
        assert_eq!(f.get(BarFamily::Day), None);
    }

    /// The statuses serialize as "streaming" / "delayed_streaming" /
    /// "endofday".
    #[test]
    fn data_status_uses_tv_names() {
        let s = serde_json::to_string(&[DataStatus::DelayedStreaming, DataStatus::Endofday]).unwrap();
        assert_eq!(s, r#"["delayed_streaming","endofday"]"#);
    }
}
