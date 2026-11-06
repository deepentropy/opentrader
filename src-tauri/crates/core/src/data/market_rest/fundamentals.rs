//! Company fundamentals: the quarterly / annual financial statement items,
//! the earnings releases, the profile, the dated filing events and the
//! projected next earnings date of a company (`fundamentals/<T>`). One answer per
//! company, kept in memory for `TTL` (the gateway refreshes its copy every
//! few hours).
use super::get_json;
use crate::data::gateway::ApiError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(3 * 3600);

/// Statement items per fiscal period, ascending by period end.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FundamentalPeriods {
    /// Period end (YYYY-MM-DD).
    #[serde(default)]
    pub end: Vec<String>,
    /// Fiscal year of the period.
    #[serde(default)]
    pub fy: Vec<Option<i32>>,
    /// Fiscal period: "Q1"…"Q4", "FY".
    #[serde(default)]
    pub fp: Vec<Option<String>>,
    /// Day the period's results became public (YYYY-MM-DD).
    #[serde(default)]
    pub date: Vec<String>,
    /// Item key → value per period (null: not reported).
    #[serde(default)]
    pub items: BTreeMap<String, Vec<Option<f64>>>,
}

/// One earnings release.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EarningsEvent {
    /// Release date (YYYY-MM-DD).
    pub date: String,
    /// "bmo" (before the regular session), "amc" (after it), or null.
    #[serde(default)]
    pub time: Option<String>,
    /// False when the period had no results announcement (dated by its report).
    #[serde(default)]
    pub released: bool,
    /// Fiscal period end (YYYY-MM-DD).
    pub end: String,
    #[serde(default)]
    pub fy: Option<i32>,
    #[serde(default)]
    pub fp: Option<String>,
    /// Diluted earnings per share of the quarter.
    #[serde(default)]
    pub eps: Option<f64>,
    #[serde(default)]
    pub revenue: Option<f64>,
}

/// Headquarters of the company.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Headquarters {
    #[serde(default)]
    pub city: Option<String>,
    /// US state or territory code ("CA"); a foreign region when known.
    #[serde(default)]
    pub region: Option<String>,
    /// "United States", or the country name.
    #[serde(default)]
    pub country: Option<String>,
}

/// One listed security of the company.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub ticker: String,
    #[serde(default)]
    pub exchange: Option<String>,
}

/// A former company name and when it was used (YYYY-MM-DD).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FormerName {
    pub name: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// What the company declares about itself in its filings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CompanyProfile {
    /// Standard industrial classification code ("3571").
    #[serde(default)]
    pub sic: Option<String>,
    /// Name of the industry code ("Electronic Computers").
    #[serde(default)]
    pub industry: Option<String>,
    /// Broad sector ("Technology", "Life Sciences", "Finance"…).
    #[serde(default)]
    pub sector: Option<String>,
    /// "large_accelerated", "accelerated", "non_accelerated" or null.
    #[serde(default)]
    pub filer_category: Option<String>,
    #[serde(default)]
    pub smaller_reporting: bool,
    #[serde(default)]
    pub emerging_growth: bool,
    /// State ("DE") or country of incorporation.
    #[serde(default)]
    pub incorporation: Option<String>,
    #[serde(default)]
    pub headquarters: Option<Headquarters>,
    #[serde(default)]
    pub listings: Vec<Listing>,
    #[serde(default)]
    pub former_names: Vec<FormerName>,
}

/// A dated filing event: an item of a current report, an offering, an
/// ownership stake, a late filing… (the gateway's `events`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilingEvent {
    /// New York day the filing became public (YYYY-MM-DD).
    pub date: String,
    /// "bmo" (before the regular session), "amc" (after it), or null.
    #[serde(default)]
    pub time: Option<String>,
    /// "executive_change", "restatement", "offering", "activist_stake"…
    #[serde(rename = "type")]
    pub kind: String,
    /// An amendment of an earlier filing.
    #[serde(default)]
    pub amended: bool,
}

/// The next results release, projected from the same quarter a year before.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NextEarnings {
    /// Projected release date (YYYY-MM-DD).
    pub date: String,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub fy: Option<i32>,
    #[serde(default)]
    pub fp: Option<String>,
    /// Always true: a projection, not an announced date.
    #[serde(default = "yes")]
    pub estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Fundamentals {
    pub ticker: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Reporting currency ("USD").
    #[serde(default = "usd")]
    pub currency: String,
    /// Fiscal year end, "MMDD".
    #[serde(default)]
    pub fiscal_year_end: Option<String>,
    #[serde(default)]
    pub quarterly: FundamentalPeriods,
    #[serde(default)]
    pub annual: FundamentalPeriods,
    #[serde(default)]
    pub earnings: Vec<EarningsEvent>,
    #[serde(default)]
    pub profile: CompanyProfile,
    /// Filing events, ascending by date.
    #[serde(default)]
    pub events: Vec<FilingEvent>,
    #[serde(default)]
    pub next_earnings: Option<NextEarnings>,
}

fn usd() -> String {
    "USD".into()
}

fn yes() -> bool {
    true
}

fn memo() -> &'static Mutex<HashMap<String, (Instant, Arc<Fundamentals>)>> {
    static MEMO: OnceLock<Mutex<HashMap<String, (Instant, Arc<Fundamentals>)>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The fundamentals of `ticker` (the source's spelling). An error when the
/// company has none (`NOT_FOUND`) or the gateway could not answer.
pub async fn fetch_fundamentals(ticker: &str) -> Result<Arc<Fundamentals>, ApiError> {
    let key = ticker.to_uppercase();
    if let Some((at, f)) = memo().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        if at.elapsed() < TTL {
            return Ok(f.clone());
        }
    }
    let f: Fundamentals = get_json("fundamentals", &format!("fundamentals/{}", super::seg(&key)), &[]).await?;
    let f = Arc::new(f);
    memo().lock().unwrap_or_else(|e| e.into_inner()).insert(key, (Instant::now(), f.clone()));
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_gateway_answer() {
        let f: Fundamentals = serde_json::from_value(serde_json::json!({
            "ticker": "TEST", "name": "Test Corp", "currency": "USD", "fiscalYearEnd": "1231",
            "quarterly": { "end": ["2025-03-31"], "fy": [2025], "fp": ["Q1"], "date": ["2025-04-24"],
                           "items": { "revenue": [10.0], "netIncome": [null] } },
            "annual": { "end": [], "fy": [], "fp": [], "date": [], "items": {} },
            "earnings": [{ "date": "2025-04-24", "time": "amc", "released": true, "end": "2025-03-31",
                           "fy": 2025, "fp": "Q1", "eps": 0.1, "revenue": 10.0 }]
        }))
        .unwrap();
        assert_eq!(f.quarterly.items["revenue"], vec![Some(10.0)]);
        assert_eq!(f.quarterly.items["netIncome"], vec![None]);
        assert_eq!(f.earnings[0].time.as_deref(), Some("amc"));
        assert_eq!(f.fiscal_year_end.as_deref(), Some("1231"));
        // An answer without the newer fields still reads.
        assert!(f.events.is_empty() && f.next_earnings.is_none() && f.profile.sic.is_none());
    }

    #[test]
    fn reads_profile_events_and_next_earnings() {
        let f: Fundamentals = serde_json::from_value(serde_json::json!({
            "ticker": "TEST",
            "profile": { "sic": "3571", "industry": "Electronic Computers", "sector": "Technology",
                         "filerCategory": "non_accelerated", "smallerReporting": true, "emergingGrowth": false,
                         "incorporation": "DE", "headquarters": { "city": "AUSTIN", "region": "TX", "country": "United States" },
                         "listings": [{ "ticker": "TEST", "exchange": "Nasdaq" }],
                         "formerNames": [{ "name": "Test Acquisition Corp", "from": "2021-01-15", "to": "2022-05-02" }] },
            "events": [{ "date": "2026-03-02", "time": "amc", "type": "restatement", "amended": false }],
            "nextEarnings": { "date": "2026-04-23", "time": null, "fy": 2026, "fp": "Q1", "estimated": true }
        }))
        .unwrap();
        assert_eq!(f.profile.filer_category.as_deref(), Some("non_accelerated"));
        assert!(f.profile.smaller_reporting);
        assert_eq!(f.profile.headquarters.as_ref().and_then(|h| h.region.as_deref()), Some("TX"));
        assert_eq!(f.profile.former_names[0].from.as_deref(), Some("2021-01-15"));
        assert_eq!(f.events[0].kind, "restatement");
        let n = f.next_earnings.unwrap();
        assert_eq!((n.date.as_str(), n.fp.as_deref(), n.estimated), ("2026-04-23", Some("Q1"), true));
    }
}
