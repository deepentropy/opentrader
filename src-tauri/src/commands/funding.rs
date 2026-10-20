/*
 * Funding status — this month's running cost of OpenTrader and how much of it
 * donations cover (see `opentrader_core::funding`). Shown in Settings > About.
 */
use opentrader_core::funding::{self, FundingStatus};

/// `None` when the gateway has no cost set for this month (404).
#[tauri::command]
#[specta::specta]
pub async fn get_funding_status() -> Result<Option<FundingStatus>, String> {
    funding::get_funding_status().await
}
