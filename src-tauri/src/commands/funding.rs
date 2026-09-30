/*
 * Funding status — this month's running cost of OpenTrader and how much of it
 * donations cover, from the gateway (`GET <gateway>/funding/v1`, public, no
 * token; see `gateway/doc/README.md`). Shown in Settings > About.
 */
use crate::data::gateway::BASE;
use crate::data::massive_rest::http;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FundingLinks {
    pub github: String,
    pub bmc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FundingStatus {
    /// UTC month, `YYYY-MM`.
    pub month: String,
    pub currency: String,
    pub total: f64,
    pub raised: f64,
    pub remaining: f64,
    pub links: FundingLinks,
}

/// `None` when the gateway has no cost set for this month (404).
#[tauri::command]
#[specta::specta]
pub async fn get_funding_status() -> Result<Option<FundingStatus>, String> {
    let resp = http()
        .get(format!("{BASE}/funding/v1"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("funding request: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("funding {}", resp.status()));
    }
    resp.json::<FundingStatus>()
        .await
        .map(Some)
        .map_err(|e| format!("funding body: {e}"))
}
