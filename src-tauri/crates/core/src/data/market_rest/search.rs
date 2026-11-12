//! Symbol search: the day's symbol catalog (`catalog`), else (no catalog
//! could be loaded) a ticker-prefix match on the gateway.
use super::{catalog, get_json};
use crate::data::ticker_case;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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

/// Typeahead over the active listings. With the day's catalog loaded the
/// search is local: ticker prefix first, then company names holding the query
/// at the start of a word (see `catalog::Catalog::search`). Only when it could
/// not be loaded is the gateway asked for a ticker prefix. An optional `type_filter` (a security type,
/// "stock", "etf"…) keeps one type.
pub async fn search_tickers(
    query: &str,
    type_filter: Option<&str>,
) -> Result<Vec<SymbolSearchResult>> {
    // Economic series: their own catalog, after the listings (type "economic" alone).
    let economic = matches!(type_filter, None | Some("") | Some("economic"));
    if type_filter == Some("economic") {
        return Ok(super::economics::search(query));
    }
    let mut out = listings(query, type_filter).await?;
    if economic {
        out.extend(super::economics::search(query));
    }
    Ok(out)
}

/// Searches that fell back to the gateway, counted to drop the superseded ones.
static GATEWAY_SEARCHES: AtomicU64 = AtomicU64::new(0);
/// Typing pause before a gateway search: the dialog searches on every
/// keystroke, which only the local catalog answers for free.
const GATEWAY_PAUSE: Duration = Duration::from_millis(250);

async fn listings(query: &str, type_filter: Option<&str>) -> Result<Vec<SymbolSearchResult>> {
    // The catalog holds every listing of the day: no match there is the answer.
    if let Some(c) = catalog::loaded().await {
        return Ok(c.search(query, type_filter));
    }
    let my = GATEWAY_SEARCHES.fetch_add(1, Ordering::Relaxed) + 1;
    tokio::time::sleep(GATEWAY_PAUSE).await;
    if GATEWAY_SEARCHES.load(Ordering::Relaxed) != my {
        // A newer keystroke's search replaces this one (the dialog keeps the latest only).
        return Ok(Vec::new());
    }
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
