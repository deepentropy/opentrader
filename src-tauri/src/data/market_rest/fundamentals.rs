//! Company fundamentals: the quarterly / annual financial statement items and
//! the earnings releases of a company (`fundamentals/<T>`). One answer per
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
}

fn usd() -> String {
    "USD".into()
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
    }
}
