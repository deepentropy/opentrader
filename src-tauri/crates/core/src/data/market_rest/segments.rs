//! A company's revenue breakdown as filed (`segments/<T>`): revenue and
//! profit per business segment, revenue per product line, per country or
//! region and per major customer, one report per (filing, fiscal period), for
//! the coding agents' `get_revenue_breakdown`. The gateway rebuilds the file
//! once a day, so an answer is kept an hour.
use super::get_json;
use crate::data::gateway::ApiError;
use crate::memo::Memo;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(60 * 60);
const MEMO_MAX: usize = 16;

/// The figure a group's role is read from, and how its members add up.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRole {
    /// The filed concept (`us-gaap:Revenues`, `ifrs-full:Revenue`, `custom:…`).
    pub concept: String,
    /// The consolidated value.
    #[serde(default)]
    pub total: Option<f64>,
    /// Members' sum / `total`; above 1 the members mix levels (subtotals,
    /// intersegment sales, a region and its countries).
    #[serde(default)]
    pub coverage: Option<f64>,
}

/// One segment, product line, country or region, or customer.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownMember {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub revenue: Option<f64>,
    /// Segments only.
    #[serde(default)]
    pub profit: Option<f64>,
    /// Customers only: the share of revenue as filed (0..1).
    #[serde(default)]
    pub revenue_share: Option<f64>,
}

/// The members of one breakdown, largest first.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownGroup {
    #[serde(default)]
    pub revenue: Option<BreakdownRole>,
    #[serde(default)]
    pub profit: Option<BreakdownRole>,
    #[serde(default)]
    pub revenue_share: Option<BreakdownRole>,
    pub members: Vec<BreakdownMember>,
}

/// The figures of one filing for one fiscal period.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownReport {
    /// The filing's id (as `list_filings` gives it).
    pub accession: String,
    pub form: String,
    /// When the filing became public (UTC).
    pub accepted: String,
    #[serde(default)]
    pub fy: Option<i32>,
    /// Q1-Q4 or FY.
    #[serde(default)]
    pub fp: Option<String>,
    /// Month end of the period.
    pub period_end: String,
    /// 3 or 12.
    pub months: u8,
    /// A Q4 computed as the year less the first nine months.
    pub derived: bool,
    pub currency: String,
    #[serde(default)]
    pub total_revenue: Option<f64>,
    #[serde(default)]
    pub segments: Option<BreakdownGroup>,
    #[serde(default)]
    pub products: Option<BreakdownGroup>,
    #[serde(default)]
    pub geography: Option<BreakdownGroup>,
    #[serde(default)]
    pub customers: Option<BreakdownGroup>,
}

/// Every report of a company, oldest first.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RevenueBreakdown {
    /// The ticker the figures are filed under (another share class may answer).
    pub ticker: String,
    pub reports: Vec<BreakdownReport>,
}

/// The revenue breakdown of `ticker` (the source's spelling).
pub async fn fetch_revenue_breakdown(ticker: &str) -> Result<RevenueBreakdown, ApiError> {
    static MEMO: Memo<String, Instant, RevenueBreakdown> = Memo::new(MEMO_MAX);
    if let Some(b) = MEMO.get(ticker, |at| at.elapsed() < TTL) {
        return Ok(b);
    }
    let b: RevenueBreakdown = get_json("revenue breakdown", &format!("segments/{}", super::seg(ticker)), &[]).await?;
    MEMO.insert(ticker.to_string(), Instant::now(), b.clone());
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_gateway_answer() {
        let b: RevenueBreakdown = serde_json::from_value(serde_json::json!({
            "version": 1, "ticker": "NVDA", "ciks": [1045810],
            "reports": [{
                "accession": "0001045810-26-000021", "form": "10-K", "accepted": "2026-02-25T21:30:00Z",
                "fy": 2026, "fp": "FY", "periodEnd": "2026-01-31", "months": 12, "derived": false,
                "currency": "USD", "totalRevenue": 215938000000u64,
                "segments": null,
                "products": { "revenue": { "concept": "us-gaap:Revenues", "total": 215938000000u64, "coverage": 1.0, "geoSummed": false },
                              "members": [{ "id": "DataCenter", "label": "Data Center", "revenue": 187000000000u64 }] },
                "geography": { "revenue": { "concept": "us-gaap:Revenues", "total": 215938000000u64, "coverage": 1.0, "geoSummed": false },
                               "members": [{ "id": "US", "label": "UNITED STATES", "revenue": 149617000000u64 }] },
                "customers": { "revenue": null, "revenueShare": { "concept": "us-gaap:ConcentrationRiskPercentage1", "total": null, "coverage": 0.13, "geoSummed": false },
                               "members": [{ "id": "CustomerOne", "label": "Customer One", "revenue": null, "revenueShare": 0.13 }] }
            }, {
                // A file published before geography and customers.
                "accession": "0001045810-25-000023", "form": "10-K", "accepted": "2025-02-26T21:30:00Z",
                "fy": 2025, "fp": "FY", "periodEnd": "2025-01-31", "months": 12, "derived": false,
                "currency": "USD", "totalRevenue": null,
                "segments": { "revenue": null, "profit": { "concept": "us-gaap:OperatingIncomeLoss", "total": 1.0, "coverage": 1.0, "geoSummed": false },
                              "members": [{ "id": "Compute", "label": "Compute", "revenue": null, "profit": 1.0 }] },
                "products": null
            }]
        }))
        .unwrap();
        let r = &b.reports[0];
        assert_eq!(r.geography.as_ref().unwrap().members[0].revenue, Some(149617000000.0));
        assert_eq!(r.customers.as_ref().unwrap().members[0].revenue_share, Some(0.13));
        assert!(b.reports[1].geography.is_none() && b.reports[1].customers.is_none());
    }
}
