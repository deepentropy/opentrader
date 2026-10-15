//! Symbol search: a ticker-prefix match over the reference universe.
use super::get_json;
use crate::data::ticker_case;
use anyhow::Result;
use serde::{Deserialize, Serialize};

// ── Symbol search (`tickers?prefix=`) ────────────────────────────────────

/// One typeahead result of the ticker search. The frontend
/// (`liveResultsToRows`) turns these into the symbol-search dialog rows.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub ticker: String,
    pub name: Option<String>,
    /// "stocks" | "otc" | …
    pub market: Option<String>,
    /// "us" | "global"
    pub locale: Option<String>,
    /// Primary exchange (an ISO-10383 MIC, "XNAS").
    pub exchange: Option<String>,
    /// Security type: stock, preferred, adr, etf, etn, etv, fund, warrant,
    /// right, unit, index, bond, structured, other.
    pub r#type: Option<String>,
}

#[derive(Deserialize)]
struct SearchAnswer {
    #[serde(default)]
    tickers: Vec<SearchRow>,
}

#[derive(Deserialize)]
struct SearchRow {
    #[serde(default)]
    ticker: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    market: Option<String>,
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    exchange: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// Typeahead over the reference universe. Matches on the **ticker only** (a
/// prefix), never the company name: a name match pulls in noise like "Maui
/// Land & Pineapple" for a query of "apple". An optional `type_filter` (a
/// security type, "stock", "etf"…) constrains the result set server-side.
pub async fn search_tickers(
    query: &str,
    type_filter: Option<&str>,
) -> Result<Vec<SymbolSearchResult>> {
    // The prefix range is sorted alphabetically, so a low cap truncates good
    // matches before the frontend can re-rank them (e.g. "MU" has 43 tickers —
    // MUR/MUX sort past position 20). Ask the maximum; the cap only adds rows
    // when a prefix genuinely has many (narrow prefixes still return few), and
    // `liveResultsToRows` ranks then slices to a display-sized list.
    //
    // The query is an app name (upper case, a share-class marker written
    // "/P"): the prefix is the source's spelling ("BAC/P" → "BACp"). A slash
    // still waiting for its letter is dropped.
    let prefix = ticker_case::to_source(query.trim().to_uppercase().trim_end_matches('/'));
    let mut params: Vec<(&str, String)> = vec![("prefix", prefix), ("limit", "1000".into())];
    if let Some(t) = type_filter.filter(|t| !t.is_empty()) {
        params.push(("type", t.to_string()));
    }
    let answer: SearchAnswer = get_json("symbol search", "tickers", &params).await?;
    // Rows carry the app's name of a ticker ("BACpB" → "BAC/PB").
    Ok(answer
        .tickers
        .into_iter()
        .filter_map(|r| {
            Some(SymbolSearchResult {
                ticker: ticker_case::to_app(&r.ticker.filter(|t| !t.is_empty())?),
                name: r.name,
                market: r.market,
                locale: r.locale,
                exchange: r.exchange,
                r#type: r.kind,
            })
        })
        .collect())
}
