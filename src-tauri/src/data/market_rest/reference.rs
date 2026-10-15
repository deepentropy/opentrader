//! Reference data: company info, listing date, symbol history, logos and the
//! list of active tickers.
use super::{get_bytes, get_json, seg, DayMemo};
use crate::data::gateway::{ApiError, ErrorCode, BASE, MARKET};
use anyhow::{anyhow, Context, Result};
use chrono::{NaiveDate, Utc};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

// ── Ticker details (`tickers/<T>`) ───────────────────────────────────────

/// Company reference info for the WatchlistDetail panel. All optional —
/// the frontend renders an em-dash for any missing field.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TickerInfo {
    pub ticker: String,
    pub name: Option<String>,
    pub exchange: Option<String>,
    pub industry: Option<String>,
    pub sector: Option<String>,
    pub currency: Option<String>,
    pub description: Option<String>,
    pub homepage_url: Option<String>,
    pub total_employees: Option<f64>,
    pub market_cap: Option<f64>,
    pub figi: Option<String>,
    /// Symbol type as scripts read it (`syminfo.type`): "stock", "fund", "dr",
    /// "warrant"; None when the security type has no measured equivalent.
    pub symbol_type: Option<String>,
    /// Security type as served ("stock", "preferred", "etf", "adr", …), for the
    /// Symbol info dialog's Type ("Fund ETF").
    pub security_type: Option<String>,
    /// Ticker logo (square icon), wrapped in the `ticker-icon` custom scheme
    /// so the webview can use it as an <img src> without ever seeing the
    /// gateway token — the backend attaches the token when it serves the bytes.
    pub icon_url: Option<String>,
}

/// A `tickers/<T>` answer. Missing values are `null`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailsAnswer {
    #[serde(default)]
    name: Option<String>,
    /// Security type (`stock`, `preferred`, `adr`, `etf`, … `other`).
    #[serde(default, rename = "type")]
    kind: Option<String>,
    /// Primary exchange, an ISO-10383 MIC ("XNAS").
    #[serde(default)]
    exchange: Option<String>,
    #[serde(default)]
    currency: Option<String>,
    #[serde(default)]
    industry: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    employees: Option<f64>,
    #[serde(default)]
    market_cap: Option<f64>,
    #[serde(default)]
    figi: Option<String>,
    #[serde(default)]
    list_date: Option<String>,
    /// `<gateway>/market/v1/logos/<T>`, or null.
    #[serde(default)]
    logo: Option<String>,
}

async fn fetch_details(ticker: &str) -> Result<DetailsAnswer, ApiError> {
    get_json("ticker details", &format!("tickers/{}", seg(ticker)), &[]).await
}

/// Per-ticker, per-day memo of the listing date (`None` = the reference data
/// has none).
pub(super) static LISTING_DATES: DayMemo<String, Option<NaiveDate>> = OnceLock::new();

/// Date the current listing of `ticker` started, from its reference data.
/// `None` when unknown or on a lookup failure (not memoised then).
pub async fn listing_date(ticker: &str) -> Option<NaiveDate> {
    let memo = LISTING_DATES.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    if let Some((as_of, date)) = memo.lock().await.get(ticker) {
        if *as_of == today {
            return **date;
        }
    }
    let details = fetch_details(ticker).await.ok()?;
    let date = details
        .list_date
        .and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok());
    memo.lock().await.insert(ticker.to_string(), (today, Arc::new(date)));
    date
}

/// A `tickers/<T>/renames` answer (newest first).
#[derive(Deserialize)]
struct RenamesAnswer {
    #[serde(default)]
    renames: Vec<RenameRow>,
}

#[derive(Deserialize)]
struct RenameRow {
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    ticker: Option<String>,
}

/// Per-ticker, per-day memo of the symbol history.
pub(super) static TICKER_CHANGES: DayMemo<String, Vec<(NaiveDate, String)>> = OnceLock::new();

/// Symbols of the company now behind `ticker`, each with the date it took it
/// (newest first, the symbols in the source's spelling). Empty when the
/// reference data has no history for it (`NOT_FOUND`); `None` on a lookup
/// failure (not memoised then).
pub async fn ticker_changes(ticker: &str) -> Option<Arc<Vec<(NaiveDate, String)>>> {
    let memo = TICKER_CHANGES.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    if let Some((as_of, changes)) = memo.lock().await.get(ticker) {
        if *as_of == today {
            return Some(changes.clone());
        }
    }
    let answer: Result<RenamesAnswer, ApiError> =
        get_json("symbol history", &format!("tickers/{}/renames", seg(ticker)), &[]).await;
    let changes = match answer {
        Ok(a) => {
            // A step without its date or symbol cannot be placed: dropped.
            let mut rows: Vec<(NaiveDate, String)> = a
                .renames
                .into_iter()
                .filter_map(|e| Some((NaiveDate::parse_from_str(e.date.as_deref()?, "%Y-%m-%d").ok()?, e.ticker?)))
                .collect();
            rows.sort_by(|a, b| b.0.cmp(&a.0));
            rows
        }
        Err(e) if e.code == ErrorCode::NotFound => Vec::new(),
        Err(e) => {
            eprintln!("[market_rest] {e}");
            return None;
        }
    };
    let changes = Arc::new(changes);
    memo.lock().await.insert(ticker.to_string(), (today, changes.clone()));
    Some(changes)
}

/// Script symbol type (`syminfo.type`) of a security type, as the reference
/// app names the same securities: common and preferred shares are stocks;
/// ETFs, ETVs and closed-end funds are funds; ADRs are depositary
/// receipts. Units are left out: the reference names a SPAC unit a fund and a
/// partnership unit a stock.
fn script_symbol_type(kind: &str) -> Option<&'static str> {
    match kind {
        "stock" | "preferred" => Some("stock"),
        "etf" | "etv" | "fund" => Some("fund"),
        "adr" => Some("dr"),
        "warrant" => Some("warrant"),
        _ => None,
    }
}

pub async fn fetch_ticker_info(ticker: &str) -> Result<TickerInfo> {
    let r = fetch_details(ticker).await?;
    Ok(TickerInfo {
        ticker: ticker.to_string(),
        name: r.name,
        exchange: r.exchange,
        // No clean sector field: the industry classification is the closest.
        // Leave sector empty rather than guess.
        industry: r.industry,
        sector: None,
        currency: r.currency.map(|c| c.to_uppercase()),
        description: r.description,
        homepage_url: r.homepage,
        total_employees: r.employees,
        market_cap: r.market_cap,
        figi: r.figi,
        symbol_type: r.kind.as_deref().and_then(script_symbol_type).map(str::to_string),
        security_type: r.kind.clone(),
        icon_url: r.logo.map(|u| icon_proxy_url(&u)),
    })
}

/// Wrap a bare logo URL (gateway host) in the `ticker-icon` custom scheme so
/// the gateway token never reaches the webview DOM. The scheme handler (see
/// `fetch_icon`) decodes the path, attaches the token, and streams the image back.
///
/// Windows/Android serve custom schemes over `http://<scheme>.localhost`; every
/// other platform uses the real `<scheme>://` form. We build whichever matches
/// the host this backend runs on, so the frontend can use the value verbatim.
fn icon_proxy_url(bare_url: &str) -> String {
    let encoded = utf8_percent_encode(bare_url, NON_ALPHANUMERIC).to_string();
    if cfg!(windows) {
        format!("http://ticker-icon.localhost/{encoded}")
    } else {
        format!("ticker-icon://localhost/{encoded}")
    }
}

/// Serve a ticker logo for the `ticker-icon` scheme handler. `encoded` is the
/// percent-encoded bare URL taken from the request path; we decode it, ask the
/// gateway with the token, and return the raw bytes plus the content-type.
/// Restricted to the gateway's market API (logo URLs point there) so the
/// handler can't be coerced into an open proxy that attaches the token to an
/// arbitrary origin.
pub async fn fetch_icon(encoded: &str) -> Result<(Vec<u8>, String)> {
    let bare = percent_decode_str(encoded)
        .decode_utf8()
        .context("ticker-icon: path is not valid percent-encoded UTF-8")?;
    // With the trailing slash, so a look-alike host (`<gw>.evil.com`) fails.
    let Some(path) = bare.strip_prefix(&format!("{MARKET}/")) else {
        return Err(anyhow!("ticker-icon: refusing a URL outside the gateway ({BASE})"));
    };
    Ok(get_bytes("ticker logo", path).await?)
}

// ── Ticker list (`tickers`, paginated) ───────────────────────────────────

/// One active US stock-market ticker from the reference list.
#[derive(Deserialize, Serialize, Clone)]
pub struct RefTicker {
    pub ticker: String,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub name: String,
    /// Security type: stock, preferred, adr, etf, etn, etv, fund, warrant,
    /// right, unit, index, bond, structured, other.
    #[serde(default, rename = "type", deserialize_with = "null_as_empty")]
    pub kind: String,
    /// Primary exchange (MIC).
    #[serde(default, deserialize_with = "null_as_empty")]
    pub exchange: String,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub currency: String,
}

/// A missing text of the list reads empty (the screener shows no value).
fn null_as_empty<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct TickerPage {
    #[serde(default)]
    tickers: Vec<RefTicker>,
    /// Cursor of the next page; null on the last.
    #[serde(default)]
    next: Option<String>,
}

/// Every active ticker of the US stocks market (~13 pages of 1000): the first
/// page, then `cursor=<next>` alone until `next` is null.
pub async fn fetch_reference_tickers() -> Result<Vec<RefTicker>> {
    let mut query = vec![("limit", "1000".to_string())];
    let mut out = Vec::new();
    for _page in 0..40 {
        let page: TickerPage = get_json("ticker list", "tickers", &query).await?;
        out.extend(page.tickers.into_iter().filter(|r| !r.ticker.is_empty()).map(|mut r| {
            r.currency = r.currency.to_uppercase();
            r
        }));
        match page.next {
            Some(next) if !next.is_empty() => query = vec![("cursor", next)],
            _ => return Ok(out),
        }
    }
    Err(anyhow!("ticker list: too many pages"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_types_follow_the_security_type() {
        assert_eq!(script_symbol_type("stock"), Some("stock"));
        assert_eq!(script_symbol_type("preferred"), Some("stock"));
        assert_eq!(script_symbol_type("etv"), Some("fund"));
        assert_eq!(script_symbol_type("adr"), Some("dr"));
        assert_eq!(script_symbol_type("unit"), None);
        assert_eq!(script_symbol_type("other"), None);
    }

    #[test]
    fn list_rows_read_null_as_empty() {
        let page: TickerPage = serde_json::from_str(
            r#"{"tickers":[{"ticker":"A","name":null,"type":"stock","exchange":"XNYS","currency":"usd","market":"stocks","locale":"us","active":true}],"next":null}"#,
        )
        .unwrap();
        let r = &page.tickers[0];
        assert_eq!((r.name.as_str(), r.kind.as_str(), r.exchange.as_str()), ("", "stock", "XNYS"));
        assert!(page.next.is_none());
    }

    #[tokio::test]
    async fn icon_urls_outside_the_market_api_are_refused() {
        let enc = |u: &str| utf8_percent_encode(u, NON_ALPHANUMERIC).to_string();
        assert!(fetch_icon(&enc("https://example.com/logo.png")).await.is_err());
        assert!(fetch_icon(&enc(&format!("{BASE}.evil.com/market/v1/logos/AAPL"))).await.is_err());
        assert!(fetch_icon(&enc(&format!("{BASE}/history/v1/daily/AAPL"))).await.is_err());
    }
}
