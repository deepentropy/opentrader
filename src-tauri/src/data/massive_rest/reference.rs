//! Reference data: company info, listing date, symbol history, branding
//! icons and the list of active tickers.
use super::{http, DayMemo};
use crate::data::gateway::{self, BASE, NO_TOKEN};
use anyhow::{anyhow, Context, Result};
use chrono::{NaiveDate, Utc};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

// ── Reference info (/v3/reference/tickers) ───────────────────────────────

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
    /// Massive branding icon (square), wrapped in the `ticker-icon` custom
    /// scheme so the webview can use it as an <img src> without ever seeing the
    /// gateway token — the backend re-attaches the token when it serves the bytes.
    pub icon_url: Option<String>,
}

#[derive(Deserialize)]
struct RefResponse {
    results: Option<RefResult>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct RefResult {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    primary_exchange: Option<String>,
    #[serde(default)]
    sic_description: Option<String>,
    #[serde(default)]
    currency_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage_url: Option<String>,
    #[serde(default)]
    total_employees: Option<f64>,
    #[serde(default)]
    market_cap: Option<f64>,
    #[serde(default)]
    composite_figi: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    list_date: Option<String>,
    #[serde(default)]
    branding: Option<RefBranding>,
}

#[derive(Deserialize)]
struct RefBranding {
    #[serde(default)]
    icon_url: Option<String>,
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
    let token = gateway::token()?;
    let url = format!("{BASE}/v3/reference/tickers/{ticker}?apiKey={token}");
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: RefResponse = resp.json().await.ok()?;
    let date = body
        .results
        .and_then(|r| r.list_date)
        .and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok());
    memo.lock().await.insert(ticker.to_string(), (today, Arc::new(date)));
    date
}

#[derive(Deserialize)]
struct EventsResponse {
    results: Option<EventsResult>,
}

#[derive(Deserialize)]
struct EventsResult {
    #[serde(default)]
    events: Vec<EventRow>,
}

#[derive(Deserialize)]
struct EventRow {
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    ticker_change: Option<EventTicker>,
}

#[derive(Deserialize)]
struct EventTicker {
    ticker: String,
}

/// Per-ticker, per-day memo of the symbol history.
pub(super) static TICKER_CHANGES: DayMemo<String, Vec<(NaiveDate, String)>> = OnceLock::new();

/// Symbols of the company now behind `ticker`, each with the date it took it
/// (newest first, the symbols in the source's spelling). Empty when the
/// reference data has no history for it; `None` on a lookup failure (not
/// memoised then).
pub async fn ticker_changes(ticker: &str) -> Option<Arc<Vec<(NaiveDate, String)>>> {
    let memo = TICKER_CHANGES.get_or_init(|| Mutex::new(HashMap::new()));
    let today = Utc::now().date_naive();
    if let Some((as_of, changes)) = memo.lock().await.get(ticker) {
        if *as_of == today {
            return Some(changes.clone());
        }
    }
    let token = gateway::token()?;
    let url = format!("{BASE}/vX/reference/tickers/{ticker}/events?types=ticker_change&apiKey={token}");
    let resp = http().get(&url).send().await.ok()?;
    let changes = if resp.status() == reqwest::StatusCode::NOT_FOUND {
        Vec::new()
    } else if resp.status().is_success() {
        let body: EventsResponse = resp.json().await.ok()?;
        let mut rows: Vec<(NaiveDate, String)> = body
            .results
            .map(|r| r.events)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| Some((NaiveDate::parse_from_str(e.date.as_deref()?, "%Y-%m-%d").ok()?, e.ticker_change?.ticker)))
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows
    } else {
        return None;
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
        "CS" | "PFD" => Some("stock"),
        "ETF" | "ETV" | "FUND" => Some("fund"),
        "ADRC" => Some("dr"),
        "WARRANT" => Some("warrant"),
        _ => None,
    }
}

pub async fn fetch_ticker_info(ticker: &str) -> Result<TickerInfo> {
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!(
        "{BASE}/v3/reference/tickers/{ticker}?apiKey={token}"
    );
    let resp = http().get(&url).send().await.context("massive reference request")?;
    let http_status = resp.status();
    let body: RefResponse = resp.json().await.context("massive reference: parse json")?;
    if !http_status.is_success() {
        return Err(anyhow!(
            "massive reference {http_status}: {}",
            body.error.unwrap_or_default()
        ));
    }
    let r = body
        .results
        .ok_or_else(|| anyhow!("massive reference: no results for {ticker}"))?;
    Ok(TickerInfo {
        ticker: ticker.to_string(),
        name: r.name,
        exchange: r.primary_exchange,
        // Massive has no clean sector field; sic_description is the closest
        // (an industry classification). Leave sector empty rather than guess.
        industry: r.sic_description,
        sector: None,
        currency: r.currency_name.map(|c| c.to_uppercase()),
        description: r.description,
        homepage_url: r.homepage_url,
        total_employees: r.total_employees,
        market_cap: r.market_cap,
        figi: r.composite_figi,
        symbol_type: r.kind.as_deref().and_then(script_symbol_type).map(str::to_string),
        icon_url: r
            .branding
            .and_then(|b| b.icon_url)
            .map(|u| icon_proxy_url(&u)),
    })
}

/// Wrap a bare branding URL (gateway host) in the `ticker-icon` custom scheme so
/// the gateway token never reaches the webview DOM. The scheme handler (see
/// `fetch_icon`) decodes the path, re-attaches the token, and streams the image back.
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

/// Serve a Massive branding icon for the `ticker-icon` scheme handler. `encoded`
/// is the percent-encoded bare URL taken from the request path; we decode it,
/// attach the gateway token server-side, and return the raw bytes plus the
/// upstream content-type. Restricted to the gateway host (the gateway rewrites
/// Massive's branding URLs to it) so the handler can't be coerced into an open
/// proxy that attaches the token to an arbitrary origin.
pub async fn fetch_icon(encoded: &str) -> Result<(Vec<u8>, String)> {
    let bare = percent_decode_str(encoded)
        .decode_utf8()
        .context("ticker-icon: path is not valid percent-encoded UTF-8")?;
    // With the trailing slash, so a look-alike host (`<gw>.evil.com`) fails.
    if !bare.starts_with(&format!("{BASE}/")) {
        return Err(anyhow!("ticker-icon: refusing non-gateway URL {bare}"));
    }
    let token = gateway::token().context(NO_TOKEN)?;
    let url = format!("{bare}?apiKey={token}");
    let resp = http().get(&url).send().await.context("ticker-icon: request")?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp.bytes().await.context("ticker-icon: read body")?;
    if !status.is_success() {
        return Err(anyhow!("ticker-icon: massive {status}"));
    }
    Ok((bytes.to_vec(), content_type))
}

// ── Reference ticker list (/v3/reference/tickers) ────────────────────────

/// One active US stock-market ticker from the reference list.
#[derive(Deserialize, Serialize, Clone)]
pub struct RefTicker {
    pub ticker: String,
    #[serde(default)]
    pub name: String,
    /// Massive type code: CS, PFD, ADRC, ETF, ETN, FUND, WARRANT, RIGHT, UNIT…
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub primary_exchange: String,
    #[serde(default)]
    pub currency_name: String,
}

#[derive(Deserialize)]
struct RefListResponse {
    #[serde(default)]
    results: Vec<RefTicker>,
    #[serde(default)]
    next_url: Option<String>,
}

/// Every active ticker of the US stocks market (~13 pages of 1000). `next_url`
/// comes back pointing at the gateway without the token, so it is re-added.
pub async fn fetch_reference_tickers() -> Result<Vec<RefTicker>> {
    let token = gateway::token().context(NO_TOKEN)?;
    let mut url = format!(
        "{BASE}/v3/reference/tickers?market=stocks&active=true&limit=1000&apiKey={token}"
    );
    let mut out = Vec::new();
    for _page in 0..40 {
        let resp = http().get(&url).send().await.context("massive reference tickers request")?;
        let http_status = resp.status();
        if !http_status.is_success() {
            return Err(anyhow!("massive reference tickers {http_status}"));
        }
        let body: RefListResponse =
            resp.json().await.context("massive reference tickers: parse json")?;
        out.extend(body.results.into_iter().map(|mut r| {
            r.currency_name = r.currency_name.to_uppercase();
            r
        }));
        match body.next_url {
            Some(next) if !next.is_empty() => url = format!("{next}&apiKey={token}"),
            _ => return Ok(out),
        }
    }
    Err(anyhow!("massive reference tickers: too many pages"))
}
