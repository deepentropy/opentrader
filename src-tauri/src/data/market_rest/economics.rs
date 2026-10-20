//! Economic series: the gateway's catalog of US public statistics (downloaded
//! once, then checked hourly, kept on disk with its ETag like the symbol
//! catalog) and one series' observations (`economics/series/<ID>`).
//!
//! An economic series is the symbol `ECONOMICS:<ID>`: one value per
//! observation date (00:00 UTC), drawn as bars whose open, high, low and close
//! are that value.
use super::{get_json, http, rest_cache_root, SymbolSearchResult};
use crate::data::gateway::{self, ApiError, MARKET};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Exchange of the economic series symbols.
pub const EXCHANGE: &str = "ECONOMICS";
/// Folder under the cache root ("Clear cache" deletes it).
pub(super) const CACHE_DIR: &str = "economics_catalog";
const FILE: &str = "catalog.json";
const ETAG_FILE: &str = "etag";
const CHECK_EVERY: Duration = Duration::from_secs(3600);
const RETRY_AFTER: Duration = Duration::from_secs(120);
/// Rows answered for one query.
const LIMIT: usize = 300;
/// A series is fetched again after this long (the gateway keeps it 3 h).
const SERIES_TTL: Duration = Duration::from_secs(1800);

/// True for an economic series symbol ("ECONOMICS:UNRATE").
pub fn is_economic(exchange: &str) -> bool {
    exchange.eq_ignore_ascii_case(EXCHANGE)
}

/// Description of a series.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EconomicMeta {
    pub id: String,
    pub name: String,
    /// Frequency code: "D", "W", "BW", "M", "Q", "SA", "A".
    pub freq: String,
    pub units: String,
    pub units_short: String,
    /// "SA", "NSA", "SAAR"…
    pub seasonal: String,
    /// The agency that publishes it.
    pub source: String,
    /// Symbol search category ("GDP", "Labor", "Prices"…; empty when none).
    #[serde(default)]
    pub category: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    date: String,
    id: Vec<String>,
    name: Vec<String>,
    freq: Vec<String>,
    units: Vec<String>,
    units_short: Vec<String>,
    seasonal: Vec<String>,
    source: Vec<String>,
    /// Absent from a catalog built before categories.
    #[serde(default)]
    category: Vec<String>,
}

/// Symbol search filters of the Economy tab (None = all).
#[derive(Default)]
pub struct Filter<'a> {
    pub source: Option<&'a str>,
    pub category: Option<&'a str>,
}

impl Filter<'_> {
    fn keeps(&self, r: &EconomicMeta) -> bool {
        self.source.is_none_or(|s| r.source == s) && self.category.is_none_or(|c| r.category == c)
    }
}

struct Catalog {
    date: String,
    rows: Vec<EconomicMeta>,
    /// Lower-case names, for the word-start search.
    keys: Vec<String>,
    by_id: HashMap<String, usize>,
}

static CATALOG: OnceLock<RwLock<Option<Arc<Catalog>>>> = OnceLock::new();

fn slot() -> &'static RwLock<Option<Arc<Catalog>>> {
    CATALOG.get_or_init(|| RwLock::new(None))
}

fn current() -> Option<Arc<Catalog>> {
    slot().read().ok()?.clone()
}

fn dir() -> PathBuf {
    rest_cache_root().join(CACHE_DIR)
}

fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || matches!(c, '&' | '\'' | '.' | '%') {
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
        let n = f.id.len();
        if [f.name.len(), f.freq.len(), f.units.len(), f.units_short.len(), f.seasonal.len(), f.source.len()]
            .iter()
            .any(|&l| l != n)
            || !(f.category.is_empty() || f.category.len() == n)
        {
            return None;
        }
        let rows: Vec<EconomicMeta> = (0..n)
            .map(|i| EconomicMeta {
                id: f.id[i].clone(),
                name: f.name[i].clone(),
                freq: f.freq[i].clone(),
                units: f.units[i].clone(),
                units_short: f.units_short[i].clone(),
                seasonal: f.seasonal[i].clone(),
                source: f.source[i].clone(),
                category: f.category.get(i).cloned().unwrap_or_default(),
            })
            .collect();
        let keys = rows.iter().map(|r| normalize(&r.name)).collect();
        let by_id = rows.iter().enumerate().map(|(i, r)| (r.id.clone(), i)).collect();
        Some(Catalog { date: f.date, rows, keys, by_id })
    }

    /// Series ids starting with the query first (catalog order: most popular
    /// first), then names holding it at the start of a word.
    /// An empty query: the most popular series. Only the rows the filter keeps.
    fn search(&self, query: &str, filter: &Filter) -> Vec<&EconomicMeta> {
        let id_q = query.trim().to_uppercase();
        let name_q = normalize(query);
        let mut out: Vec<&EconomicMeta> = Vec::new();
        if id_q.is_empty() && name_q.is_empty() {
            return self.rows.iter().filter(|r| filter.keeps(r)).take(LIMIT).collect();
        }
        if !id_q.is_empty() {
            // Exact id first.
            if let Some(&i) = self.by_id.get(&id_q) {
                if filter.keeps(&self.rows[i]) {
                    out.push(&self.rows[i]);
                }
            }
            out.extend(self.rows.iter().filter(|r| r.id != id_q && r.id.starts_with(&id_q) && filter.keeps(r)).take(LIMIT));
        }
        if !name_q.is_empty() && out.len() < LIMIT {
            for (r, key) in self.rows.iter().zip(&self.keys) {
                if out.len() >= LIMIT {
                    break;
                }
                if (r.id.starts_with(&id_q) && !id_q.is_empty()) || !filter.keeps(r) {
                    continue;
                }
                if word_start(key, &name_q) {
                    out.push(r);
                }
            }
        }
        out
    }
}

fn word_start(key: &str, q: &str) -> bool {
    let mut from = 0;
    while let Some(i) = key[from..].find(q).map(|i| i + from) {
        if i == 0 || key[..i].ends_with(' ') {
            return true;
        }
        from = i + key[i..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Short name of a source agency, as symbol search rows show it ("BLS",
/// "FRB St. Louis"); the full name when it has no short one.
pub fn source_short(source: &str) -> String {
    let short = match source {
        "U.S. Bureau of Labor Statistics" => "BLS",
        "U.S. Census Bureau" => "USCB",
        "U.S. Bureau of Economic Analysis" => "BEA",
        "Board of Governors of the Federal Reserve System (US)" => "Federal Reserve",
        "U.S. Federal Housing Finance Agency" => "FHFA",
        "U.S. Energy Information Administration" => "UEIA",
        "Federal Deposit Insurance Corporation" => "FDIC",
        "U.S. Department of Labor" => "DOL",
        "U.S. Bureau of Transportation Statistics" => "BTS",
        "U.S. Employment and Training Administration" => "ETA",
        "U.S. Department of the Treasury"
        | "U.S. Department of the Treasury. Fiscal Service"
        | "U.S. Department of the Treasury. Internal Revenue Service" => "USDT",
        "U.S. Office of Management and Budget" => "OMB",
        "U.S. Congressional Budget Office" => "CBO",
        "U.S. Federal Highway Administration" => "FHWA",
        "Council of Economic Advisers (US)" => "CEA",
        _ => {
            return match source.strip_prefix("Federal Reserve Bank of ") {
                Some(city) => format!("FRB {city}"),
                None => source.to_string(),
            }
        }
    };
    short.to_string()
}

/// Multiplier of a series' unit ("Billions of Dollars" → 1e9); 1 for a unit
/// without a multiplier word.
pub fn unit_multiplier(units: &str) -> f64 {
    let first = units.split([' ', ',']).next().unwrap_or("");
    match first {
        "Thousands" => 1e3,
        "Millions" => 1e6,
        "Billions" => 1e9,
        "Trillions" => 1e12,
        _ => 1.0,
    }
}

/// The search rows of the series matching `query` (symbol search, Economy).
pub fn search(query: &str) -> Vec<SymbolSearchResult> {
    search_filtered(query, &Filter::default())
}

/// [`search`] within a source agency and / or a category.
pub fn search_filtered(query: &str, filter: &Filter) -> Vec<SymbolSearchResult> {
    let Some(c) = current() else { return Vec::new() };
    c.search(query, filter)
        .into_iter()
        .map(|r| SymbolSearchResult {
            ticker: r.id.clone(),
            name: Some(r.name.clone()),
            market: Some("economy".into()),
            locale: Some("us".into()),
            exchange: Some(source_short(&r.source)),
            r#type: Some("economic".into()),
        })
        .collect()
}

/// The source agencies of the catalog, most series first (the Sources filter).
pub fn sources() -> Vec<String> {
    let Some(c) = current() else { return Vec::new() };
    let mut count: HashMap<&str, usize> = HashMap::new();
    for r in &c.rows {
        *count.entry(r.source.as_str()).or_default() += 1;
    }
    let mut v: Vec<(&str, usize)> = count.into_iter().filter(|(s, _)| !s.is_empty()).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    v.into_iter().map(|(s, _)| s.to_string()).collect()
}

/// Description of a catalogued series (None when the catalog is not loaded or
/// does not hold it).
pub fn meta(id: &str) -> Option<EconomicMeta> {
    let c = current()?;
    c.by_id.get(&id.to_uppercase()).map(|&i| c.rows[i].clone())
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
                    eprintln!("[economics] {e}");
                    RETRY_AFTER
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

async fn refresh() -> Result<(), String> {
    let token = gateway::token().ok_or(gateway::NO_TOKEN)?;
    let etag = match current() {
        Some(_) => tokio::fs::read_to_string(dir().join(ETAG_FILE)).await.ok(),
        None => None,
    };
    let mut req = http().get(format!("{MARKET}/economics/catalog")).bearer_auth(token);
    if let Some(etag) = etag.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {}", e.without_url()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
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
    let _ = &c.date;
    install(c);
    Ok(())
}

/// One series: its description and observations (Unix seconds at 00:00 UTC,
/// value; missing values left out).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EconomicSeries {
    pub meta: EconomicMeta,
    pub time: Vec<f64>,
    pub value: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeriesAnswer {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    freq: String,
    #[serde(default)]
    units: String,
    #[serde(default)]
    units_short: String,
    #[serde(default)]
    seasonal: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    t: Vec<Option<f64>>,
    #[serde(default)]
    v: Vec<Option<f64>>,
}

fn series_memo() -> &'static Mutex<HashMap<String, (Instant, Arc<EconomicSeries>)>> {
    static MEMO: OnceLock<Mutex<HashMap<String, (Instant, Arc<EconomicSeries>)>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The observations of series `id`.
pub async fn fetch_series(id: &str) -> Result<Arc<EconomicSeries>, ApiError> {
    let key = id.to_uppercase();
    if let Some((at, s)) = series_memo().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        if at.elapsed() < SERIES_TTL {
            return Ok(s.clone());
        }
    }
    let a: SeriesAnswer = get_json("economic series", &format!("economics/series/{}", super::seg(&key)), &[]).await?;
    // Values in full units (a series in billions of dollars charts as dollars).
    let scale = unit_multiplier(&a.units);
    let mut time = Vec::with_capacity(a.t.len());
    let mut value = Vec::with_capacity(a.v.len());
    for (t, v) in a.t.iter().zip(&a.v) {
        if let (Some(t), Some(v)) = (t, v) {
            if t.is_finite() && v.is_finite() {
                time.push((t / 1000.0).floor());
                value.push(if scale == 1.0 { *v } else { (v * scale * 100.0).round() / 100.0 });
            }
        }
    }
    let s = Arc::new(EconomicSeries {
        meta: EconomicMeta {
            id: a.id,
            name: a.name,
            freq: a.freq,
            units: a.units,
            units_short: a.units_short,
            seasonal: a.seasonal,
            source: a.source,
            category: a.category,
        },
        time,
        value,
    });
    series_memo().lock().unwrap_or_else(|e| e.into_inner()).insert(key, (Instant::now(), s.clone()));
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_json() -> Vec<u8> {
        let json = serde_json::json!({
            "version": 1, "date": "2026-10-20", "count": 4,
            "id": ["UNRATE", "GDP", "UNRATENSA", "CPIAUCSL"],
            "name": ["Unemployment Rate", "Gross Domestic Product", "Unemployment Rate", "Consumer Price Index for All Urban Consumers: All Items"],
            "freq": ["M", "Q", "M", "M"], "units": ["Percent", "Billions of Dollars", "Percent", "Index 1982-1984=100"],
            "unitsShort": ["%", "Bil. of $", "%", "Index 1982-1984=100"], "seasonal": ["SA", "SAAR", "NSA", "SA"],
            "source": ["U.S. Bureau of Labor Statistics", "U.S. Bureau of Economic Analysis", "U.S. Bureau of Labor Statistics", "U.S. Bureau of Labor Statistics"],
            "start": ["1948-01-01", "1947-01-01", "1948-01-01", "1947-01-01"], "end": ["2026-09-01", "2026-04-01", "2026-09-01", "2026-09-01"],
        });
        json.to_string().into_bytes()
    }

    fn catalog() -> Catalog {
        Catalog::parse(&catalog_json()).unwrap()
    }

    #[test]
    fn exact_id_then_id_prefix_then_name_word_start() {
        let c = catalog();
        let ids = |q: &str| c.search(q, &Filter::default()).into_iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids("unrate"), ["UNRATE", "UNRATENSA"]);
        assert_eq!(ids("unemployment"), ["UNRATE", "UNRATENSA"]);
        assert_eq!(ids("gdp"), ["GDP"]);
        assert_eq!(ids("price index"), ["CPIAUCSL"]);
        assert!(ids("zzz").is_empty());
    }

    #[test]
    fn filters_by_source_and_category() {
        let mut json: serde_json::Value = serde_json::from_slice(&catalog_json()).unwrap();
        json["category"] = serde_json::json!(["Labor", "GDP", "Labor", "Prices"]);
        let c = Catalog::parse(json.to_string().as_bytes()).unwrap();
        let ids = |q: &str, f: Filter| c.search(q, &f).into_iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids("", Filter { source: None, category: Some("Labor") }), ["UNRATE", "UNRATENSA"]);
        assert_eq!(ids("", Filter { source: Some("U.S. Bureau of Economic Analysis"), category: None }), ["GDP"]);
        assert!(ids("unrate", Filter { source: None, category: Some("Prices") }).is_empty());
        // A catalog without categories still loads.
        assert_eq!(catalog().rows[0].category, "");
    }

    #[test]
    fn unit_multipliers() {
        assert_eq!(unit_multiplier("Billions of Dollars"), 1e9);
        assert_eq!(unit_multiplier("Thousands of Persons"), 1e3);
        assert_eq!(unit_multiplier("Millions of Chained 2017 Dollars"), 1e6);
        assert_eq!(unit_multiplier("Percent"), 1.0);
        assert_eq!(unit_multiplier("Index 1982-1984=100"), 1.0);
    }

    #[test]
    fn source_short_names() {
        assert_eq!(source_short("U.S. Bureau of Labor Statistics"), "BLS");
        assert_eq!(source_short("Board of Governors of the Federal Reserve System (US)"), "Federal Reserve");
        assert_eq!(source_short("Federal Reserve Bank of St. Louis"), "FRB St. Louis");
        assert_eq!(source_short("U.S. Department of Housing and Urban Development"), "U.S. Department of Housing and Urban Development");
    }

    #[test]
    fn rejects_ragged_columns() {
        assert!(Catalog::parse(br#"{"date":"d","id":["A"],"name":[],"freq":[],"units":[],"unitsShort":[],"seasonal":[],"source":[]}"#).is_none());
    }
}
