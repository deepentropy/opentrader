//! Symbol search: a ticker-prefix range over the reference universe.
use super::http;
use crate::data::gateway::{self, BASE, NO_TOKEN};
use crate::data::ticker_case;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

// ── Symbol search (/v3/reference/tickers?search=…) ───────────────────────

/// One typeahead result from Massive's reference-tickers search. The frontend
/// (`liveResultsToRows`) turns these into the symbol-search dialog rows.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub ticker: String,
    pub name: Option<String>,
    /// "stocks" | "crypto" | "fx" | "indices" | "otc"
    pub market: Option<String>,
    /// "us" | "global"
    pub locale: Option<String>,
    pub primary_exchange: Option<String>,
    /// Massive security type ("CS", "ETF", "ADRC", …).
    pub r#type: Option<String>,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<SearchRow>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct SearchRow {
    ticker: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    market: Option<String>,
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    primary_exchange: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// Typeahead over Massive's reference universe. Matches on the **ticker only**
/// (a prefix range), never the company name: `search=` fuzzy-matches both and
/// can't disable the name side, so it pulls in noise like "Maui Land & Pineapple"
/// for a query of "apple". A `[gte, lte]` ticker range gives a pure prefix match:
/// the upper bound is the query padded with 'z's — 'z' sorts at/above every char
/// Massive allows in a ticker (A–Z, a–z, 0–9, '.', ':', '-' all sort ≤ 'z'), so
/// the range captures exactly the tickers starting with the prefix. ('~' would
/// sort higher but Massive rejects it as an invalid ticker character.) An optional
/// `type_filter` constrains to a security type.
pub async fn search_tickers(
    query: &str,
    type_filter: Option<&str>,
) -> Result<Vec<SymbolSearchResult>> {
    let token = gateway::token().context(NO_TOKEN)?;
    // Massive sorts the prefix range alphabetically, so a low cap truncates good
    // matches before the frontend can re-rank them (e.g. "MU" has 43 tickers —
    // MUR/MUX sort past position 20). Request Massive's max; the cap only adds
    // rows when a prefix genuinely has many (narrow prefixes still return few),
    // and `liveResultsToRows` ranks then slices to a display-sized list.
    let limit = "1000";
    // The query is an app name (upper case, a share-class marker written
    // "/P"): the range runs on the source's spelling ("BAC/P" → "BACp"). A
    // slash still waiting for its letter is dropped. The 'z' padding sorts
    // at/above every ticker character, lower-case markers included, and its
    // length comfortably exceeds any real ticker's tail.
    let prefix = ticker_case::to_source(query.trim().to_uppercase().trim_end_matches('/'));
    let prefix_end = format!("{prefix}zzzzzz");
    let mut params: Vec<(&str, &str)> = vec![
        ("ticker.gte", prefix.as_str()),
        ("ticker.lte", prefix_end.as_str()),
        ("active", "true"),
        ("limit", limit),
        ("apiKey", token),
    ];
    // Massive constrains the result set server-side when a type is given.
    let type_filter = type_filter.filter(|t| !t.is_empty());
    if let Some(t) = type_filter {
        params.push(("type", t));
    }
    let resp = http()
        .get(format!("{BASE}/v3/reference/tickers"))
        .query(&params)
        .send()
        .await
        .context("massive search request")?;
    let http_status = resp.status();
    let body: SearchResponse = resp.json().await.context("massive search: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive search {http_status}: {}",
            body.error.unwrap_or_default()
        ));
    }
    // Rows carry the app's name of a ticker ("BACpB" → "BAC/PB").
    Ok(body
        .results
        .into_iter()
        .map(|r| SymbolSearchResult {
            ticker: ticker_case::to_app(&r.ticker),
            name: r.name,
            market: r.market,
            locale: r.locale,
            primary_exchange: r.primary_exchange,
            r#type: r.kind,
        })
        .collect())
}
