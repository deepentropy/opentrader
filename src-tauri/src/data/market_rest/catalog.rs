//! Symbol catalog: every active listing (exchanges + OTC), built by the
//! gateway once per New York day and downloaded by the app at start (then
//! checked hourly) so a search does not cost a request per keystroke.
//!
//! The answer is kept on disk with its ETag (`symbol_catalog/`): the next
//! start reads it at once and only asks the gateway when the copy is from an
//! earlier New York day (an unchanged copy answers 304).
use super::{http, rest_cache_root, SymbolSearchResult};
use crate::data::gateway::{self, MARKET};
use crate::data::{ticker_case, trading_calendar};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

/// Folder under the cache root ("Clear cache" deletes it).
pub(super) const CACHE_DIR: &str = "symbol_catalog";
const FILE: &str = "symbols.json";
const ETAG_FILE: &str = "etag";
/// Check for a new day's catalog this often.
const CHECK_EVERY: Duration = Duration::from_secs(3600);
/// Retry after a failed download (or a catalog the gateway is still building).
const RETRY_AFTER: Duration = Duration::from_secs(120);
/// Rows answered for one query (ranked and cut again by the dialog).
const LIMIT: usize = 1000;

/// The gateway's file: one column per field, rows in ticker order.
#[derive(Deserialize)]
struct File {
    date: String,
    ticker: Vec<String>,
    name: Vec<Option<String>>,
    #[serde(rename = "type")]
    kind: Vec<Option<String>>,
    exchange: Vec<Option<String>>,
    market: Vec<Option<String>>,
}

struct Row {
    /// App name of the ticker ("BAC/PB").
    ticker: String,
    name: Option<String>,
    /// Lower-case name, words separated by single spaces (see `normalize`).
    key: String,
    kind: Option<String>,
    exchange: Option<String>,
    market: Option<String>,
}

pub(super) struct Catalog {
    /// New York date the gateway built it for (YYYY-MM-DD).
    date: String,
    rows: Vec<Row>,
}

static CATALOG: OnceLock<RwLock<Option<Arc<Catalog>>>> = OnceLock::new();

fn slot() -> &'static RwLock<Option<Arc<Catalog>>> {
    CATALOG.get_or_init(|| RwLock::new(None))
}

pub(super) fn current() -> Option<Arc<Catalog>> {
    slot().read().ok()?.clone()
}

fn dir() -> PathBuf {
    rest_cache_root().join(CACHE_DIR)
}

/// Lower case, every run of non-alphanumeric characters but `&`, `'` and `.`
/// as one space: "Apple Inc." → "apple inc.", "Bank  of America" → "bank of
/// america".
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || matches!(c, '&' | '\'' | '.') {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.truncate(out.trim_end().len());
    out
}

impl Catalog {
    fn parse(bytes: &[u8]) -> Option<Catalog> {
        let f: File = serde_json::from_slice(bytes).ok()?;
        let n = f.ticker.len();
        if [f.name.len(), f.kind.len(), f.exchange.len(), f.market.len()].iter().any(|&l| l != n) {
            return None;
        }
        let rows = f
            .ticker
            .into_iter()
            .zip(f.name)
            .zip(f.kind)
            .zip(f.exchange)
            .zip(f.market)
            .filter(|((((t, _), _), _), _)| !t.is_empty())
            .map(|((((t, name), kind), exchange), market)| Row {
                ticker: ticker_case::to_app(&t),
                key: name.as_deref().map(normalize).unwrap_or_default(),
                name,
                kind,
                exchange,
                market,
            })
            .collect();
        Some(Catalog { date: f.date, rows })
    }

    /// Ticker prefix matches first (ticker order), then names holding the
    /// query at the start of one of their words: "apple" finds Apple Inc. but
    /// not Pineapple, "bank of" finds Bank of America. Names that start with
    /// the query come before the others. `type_filter` keeps one security
    /// type ("stock", "etf"…).
    pub(super) fn search(&self, query: &str, type_filter: Option<&str>) -> Vec<SymbolSearchResult> {
        let ticker_q = query.trim().to_uppercase();
        let ticker_q = ticker_q.trim_end_matches('/');
        let name_q = normalize(query);
        let kind_ok = |r: &Row| type_filter.is_none_or(|t| t.is_empty() || r.kind.as_deref() == Some(t));
        let mut out: Vec<&Row> = Vec::new();
        if !ticker_q.is_empty() {
            out.extend(self.rows.iter().filter(|r| kind_ok(r) && r.ticker.starts_with(ticker_q)).take(LIMIT));
        }
        if !name_q.is_empty() && out.len() < LIMIT {
            let mut first = Vec::new();
            let mut later = Vec::new();
            for r in &self.rows {
                if !kind_ok(r) || r.ticker.starts_with(ticker_q) && !ticker_q.is_empty() {
                    continue;
                }
                match word_start(&r.key, &name_q) {
                    Some(0) => first.push(r),
                    Some(_) => later.push(r),
                    None => {}
                }
            }
            let room = LIMIT - out.len();
            out.extend(first.into_iter().chain(later).take(room));
        }
        out.into_iter()
            .map(|r| SymbolSearchResult {
                ticker: r.ticker.clone(),
                name: r.name.clone(),
                market: r.market.clone(),
                locale: Some("us".into()),
                exchange: r.exchange.clone(),
                r#type: r.kind.clone(),
            })
            .collect()
    }
}

/// Byte offset of the first place `q` starts a word of `key`.
fn word_start(key: &str, q: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = key[from..].find(q).map(|i| i + from) {
        if i == 0 || key[..i].ends_with(' ') {
            return Some(i);
        }
        from = i + key[i..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

fn install(c: Catalog) {
    if let Ok(mut s) = slot().write() {
        *s = Some(Arc::new(c));
    }
}

/// Read the disk copy, then keep the catalog current in the background.
pub fn init() {
    tauri::async_runtime::spawn(async {
        if let Ok(bytes) = tokio::fs::read(dir().join(FILE)).await {
            if let Some(c) = Catalog::parse(&bytes) {
                install(c);
            }
        }
        loop {
            let wait = match refresh().await {
                Ok(()) => CHECK_EVERY,
                Err(e) => {
                    eprintln!("[catalog] {e}");
                    RETRY_AFTER
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

/// Download the catalog when the loaded one is not today's (New York).
async fn refresh() -> Result<(), String> {
    let today = trading_calendar::ny_today().format("%Y-%m-%d").to_string();
    let loaded = current();
    if loaded.as_ref().is_some_and(|c| c.date == today) {
        return Ok(());
    }
    let token = gateway::token().ok_or(gateway::NO_TOKEN)?;
    let etag = match loaded {
        Some(_) => tokio::fs::read_to_string(dir().join(ETAG_FILE)).await.ok(),
        None => None,
    };
    let mut req = http().get(format!("{MARKET}/catalog")).bearer_auth(token);
    if let Some(etag) = etag.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {}", e.without_url()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        // The gateway has not built today's file yet: keep the copy.
        return Ok(());
    }
    if !status.is_success() {
        return Err(format!("answer {status}"));
    }
    let etag = resp.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let bytes = resp.bytes().await.map_err(|e| format!("read failed: {}", e.without_url()))?;
    let c = Catalog::parse(&bytes).ok_or("unreadable catalog")?;
    let _ = tokio::fs::create_dir_all(dir()).await;
    let _ = tokio::fs::write(dir().join(FILE), &bytes).await;
    match etag {
        Some(e) => {
            let _ = tokio::fs::write(dir().join(ETAG_FILE), e).await;
        }
        None => {
            let _ = tokio::fs::remove_file(dir().join(ETAG_FILE)).await;
        }
    }
    install(c);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        let json = serde_json::json!({
            "version": 1, "date": "2026-10-16", "count": 7,
            "ticker": ["AAPL", "APLE", "BAC", "BACpB", "MSFT", "PNPL", "SBIN"],
            "name": ["Apple Inc.", "Apple Hospitality REIT, Inc.", "Bank of America Corporation",
                     "Bank of America Corp Pfd B", "Microsoft Corporation", "Maui Land & Pineapple", "State Bank of India"],
            "type": ["stock", "stock", "stock", "preferred", "stock", "stock", "stock"],
            "exchange": ["XNAS", "XNYS", "XNYS", "XNYS", "XNAS", null, null],
            "market": ["stocks", "stocks", "stocks", "stocks", "stocks", "otc", "otc"],
            "currency": ["USD", "USD", "USD", "USD", "USD", "USD", "USD"],
        });
        Catalog::parse(json.to_string().as_bytes()).unwrap()
    }

    fn tickers(r: Vec<SymbolSearchResult>) -> Vec<String> {
        r.into_iter().map(|r| r.ticker).collect()
    }

    #[test]
    fn ticker_prefix_then_name_word_start() {
        let c = catalog();
        assert_eq!(tickers(c.search("apple", None)), ["AAPL", "APLE"]);
        assert_eq!(tickers(c.search("pine", None)), ["PNPL"]);
        assert_eq!(tickers(c.search("bank of", None)), ["BAC", "BAC/PB", "SBIN"]);
        assert_eq!(tickers(c.search("ba", None)), ["BAC", "BAC/PB", "SBIN"]);
        assert_eq!(tickers(c.search("ms", None)), ["MSFT"]);
        assert_eq!(tickers(c.search("micro", None)), ["MSFT"]);
        assert!(c.search("zzz", None).is_empty());
    }

    #[test]
    fn app_ticker_names_and_type_filter() {
        let c = catalog();
        assert_eq!(tickers(c.search("BAC/", None)), ["BAC", "BAC/PB"]);
        assert_eq!(tickers(c.search("bac/p", None)), ["BAC/PB"]);
        assert_eq!(tickers(c.search("bank", Some("preferred"))), ["BAC/PB"]);
        assert_eq!(tickers(c.search("bank", Some(""))).len(), 3);
    }

    #[test]
    fn normalize_and_word_start() {
        assert_eq!(normalize("  Bank  of, America "), "bank of america");
        assert_eq!(word_start("maui land & pineapple", "apple"), None);
        assert_eq!(word_start("apple hospitality", "apple"), Some(0));
        assert_eq!(word_start("state bank of india", "bank of"), Some(6));
    }

    #[test]
    fn rejects_ragged_columns() {
        assert!(Catalog::parse(br#"{"date":"d","ticker":["A"],"name":[],"type":[],"exchange":[],"market":[]}"#).is_none());
    }
}
