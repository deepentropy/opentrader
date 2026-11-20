/*
 * Chart data from the broker (the `datafeed` capability, plugins/PROTOCOL.md "Data plugins"). The plugin's symbols
 * are `IBKR:<ticker>`:
 *   • US stocks and funds: the symbol, share classes with a dot ("BRK.B");
 *   • forex: the two currencies ("EURUSD");
 *   • futures: the contract's local symbol ("ESZ6").
 * A ticker is looked up once and its contract id kept in the plugin's data folder, so a chart opened again finds its
 * contract at once. Bars come from the broker's historical data, one request at a time: the broker holds a burst of
 * them for seconds each. Live quotes come from its market data (delayed where the account has no subscription).
 */
use crate::link::{BarTime, HistBar, HistError, HistQuery, HistSize, Link};
use crate::rpc::{RpcError, FAILED};
use chrono::{Datelike, NaiveDate, TimeZone};
use chrono_tz::Tz;
use ibapi::contracts::tick_types::TickType;
use ibapi::contracts::{Contract, ContractDetails, SecurityType};
use ibapi::market_data::realtime::TickTypes;
use ibapi::Error as IbError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;

pub const UNKNOWN_SYMBOL: i64 = -32004;
pub const BUSY: i64 = -32005;
/// How long a bars request waits for its turn before the app is told to ask again later.
const TURN_WAIT: Duration = Duration::from_secs(20);
const SEARCH_ROWS: usize = 50;
/// Front futures listed for an underlying a search finds.
const FUTURES_PER_ROOT: usize = 3;
/// The currencies a six-letter ticker may pair.
const CURRENCIES: &[&str] = &["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "HKD", "SGD", "MXN", "CNH", "ZAR", "PLN", "CZK", "HUF", "TRY", "ILS", "KRW"];
/// The primary exchanges of the US listings search keeps (others are the same company elsewhere, quoted in USD).
const US_EXCHANGES: &[&str] = &["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS", "IEX", "PINK", "NYSENAT", "MEMX", ""];
/// The sizes the plugin serves (others are built by the app).
pub const INTERVALS: &[&str] = &["1", "5", "15", "30", "60", "1D"];

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a ticker stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Stock,
    Fund,
    Forex,
    Futures,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Stock => "stock",
            Kind::Fund => "fund",
            Kind::Forex => "forex",
            Kind::Futures => "futures",
        }
    }
}

/// A looked-up ticker.
#[derive(Debug, Clone)]
pub struct Symbol {
    pub contract: Contract,
    pub kind: Kind,
    pub tz: Tz,
    pub info: Value,
}

pub struct DataFeed {
    symbols: Mutex<HashMap<String, Arc<Symbol>>>,
    /// Ticker → contract id, kept in `file`.
    saved: Mutex<HashMap<String, i32>>,
    file: Option<PathBuf>,
    turn: Semaphore,
}

impl DataFeed {
    /// `dir`: the plugin's data folder.
    pub fn new(dir: Option<PathBuf>) -> Self {
        let file = dir.map(|d| d.join("symbols.json"));
        let saved = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { symbols: Mutex::new(HashMap::new()), saved: Mutex::new(saved), file, turn: Semaphore::new(1) }
    }

    fn keep(&self, ticker: &str, s: Symbol) -> Arc<Symbol> {
        let s = Arc::new(s);
        lock(&self.symbols).insert(ticker.to_string(), s.clone());
        let mut saved = lock(&self.saved);
        if saved.get(ticker) != Some(&s.contract.contract_id) {
            saved.insert(ticker.to_string(), s.contract.contract_id);
            if let Some(f) = &self.file {
                let _ = std::fs::create_dir_all(f.parent().unwrap_or(f));
                let _ = std::fs::write(f, serde_json::to_vec(&*saved).unwrap_or_default());
            }
        }
        s
    }

    /// The contract and description of a ticker. Unknown: `UNKNOWN_SYMBOL`.
    pub async fn resolve(&self, link: &Link, ticker: &str) -> Result<Arc<Symbol>, RpcError> {
        if let Some(s) = lock(&self.symbols).get(ticker) {
            return Ok(s.clone());
        }
        let mut tries: Vec<Contract> = Vec::new();
        if let Some(id) = lock(&self.saved).get(ticker).copied() {
            tries.push(Contract { contract_id: id, ..Default::default() });
        }
        tries.extend(guesses(ticker));
        for query in tries {
            match link.contract_details(&query).await {
                Ok(list) => {
                    let found = list.iter().find(|d| data_ticker(&d.contract).as_deref() == Some(ticker)).or(list.first());
                    if let Some(d) = found {
                        return Ok(self.keep(ticker, describe(d)));
                    }
                }
                Err(IbError::Notice(n)) if n.code == 200 => {}
                Err(e) => return Err(RpcError::new(FAILED, format!("Looking up {ticker} failed: {e}"))),
            }
        }
        Err(RpcError::new(UNKNOWN_SYMBOL, format!("Interactive Brokers has no {ticker}")))
    }

    /// `data.search`: stocks and funds in USD, forex pairs, and the front futures of an underlying found.
    pub async fn search(&self, link: &Link, query: &str) -> Result<Value, RpcError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(json!({ "symbols": [] }));
        }
        let matches = link.matching_symbols(query).await.map_err(|e| RpcError::new(FAILED, e))?;
        let mut rows: Vec<Value> = Vec::new();
        let mut roots: Vec<Contract> = Vec::new();
        for m in &matches {
            let c = &m.contract;
            match c.security_type {
                SecurityType::Stock if c.currency.as_str() == "USD" && US_EXCHANGES.contains(&c.primary_exchange.as_str()) => {
                    if let Some(ticker) = data_ticker(c) {
                        rows.push(json!({ "ticker": ticker, "description": m.description, "type": "stock" }));
                    }
                }
                // The broker lists a currency alone ("EUR"): its pairs with the major currencies.
                SecurityType::ForexPair => {
                    let base = c.symbol.as_str().trim().to_ascii_uppercase();
                    for quote in CURRENCIES.iter().take(8).filter(|q| **q != base) {
                        let pair = format!("{base}{quote}");
                        if c.currency.as_str().is_empty() || c.currency.as_str() == *quote {
                            rows.push(json!({ "ticker": pair, "description": format!("{base} / {quote}"), "type": "forex" }));
                        }
                    }
                }
                _ if m.derivatives.iter().any(|d| d == "FUT") && c.currency.as_str() == "USD" && roots.len() < 2 => roots.push(c.clone()),
                _ => {}
            }
        }
        // The futures of an index or commodity found ("ES" → ESZ6, ESH7…): the nearest expiries.
        for root in roots {
            let wanted = Contract {
                symbol: root.symbol.clone(),
                security_type: SecurityType::Future,
                currency: root.currency.clone(),
                exchange: root.primary_exchange.clone(),
                ..Default::default()
            };
            let Ok(mut list) = link.contract_details(&wanted).await else { continue };
            list.sort_by(|a, b| a.contract.last_trade_date_or_contract_month.cmp(&b.contract.last_trade_date_or_contract_month));
            list.dedup_by_key(|d| d.contract.contract_id);
            // Typed whole ("ES"), the root's futures come first.
            let mut at = if root.symbol.as_str().eq_ignore_ascii_case(query) { 0 } else { rows.len() };
            for d in list.iter().take(FUTURES_PER_ROOT) {
                if let Some(ticker) = data_ticker(&d.contract) {
                    let description = format!("{} {}", d.long_name, d.contract_month);
                    self.keep(&ticker, describe(d));
                    rows.insert(at, json!({ "ticker": ticker, "description": description.trim(), "type": "futures" }));
                    at += 1;
                }
            }
        }
        rows.truncate(SEARCH_ROWS);
        Ok(json!({ "symbols": rows }))
    }

    pub async fn symbol_info(&self, link: &Link, ticker: &str) -> Result<Value, RpcError> {
        Ok(self.resolve(link, ticker).await?.info.clone())
    }

    /// `data.bars`: the bars whose start is in `[from, to]`, the newest `count_back`, oldest first.
    pub async fn bars(&self, link: &Link, ticker: &str, resolution: &str, from: i64, to: i64, count_back: usize) -> Result<Value, RpcError> {
        let s = self.resolve(link, ticker).await?;
        let (size, secs, max_days) = match resolution {
            "1" => (HistSize::Min1, 60, 7),
            "5" => (HistSize::Min5, 300, 30),
            "15" => (HistSize::Min15, 900, 60),
            "30" => (HistSize::Min30, 1800, 120),
            "60" => (HistSize::Hour1, 3600, 365),
            "1D" | "D" => (HistSize::Day1, 86_400, 365 * 30),
            other => return Err(RpcError::new(crate::rpc::BAD_PARAMS, format!("Resolution {other} is not served"))),
        };
        let now = chrono::Utc::now().timestamp();
        let to = to.min(now);
        if from > to {
            return Ok(json!({ "bars": [] }));
        }
        let q = HistQuery { size, end: to + secs, days: request_days(from, to, secs, count_back, max_days), midpoint: s.kind == Kind::Forex };
        let Ok(_turn) = tokio::time::timeout(TURN_WAIT, self.turn.acquire()).await else {
            return Err(RpcError::new(BUSY, "Interactive Brokers is busy with other history requests"));
        };
        let bars = match link.history(&s.contract, q).await {
            Ok(b) => b,
            Err(HistError::NoData) => Vec::new(),
            Err(HistError::Busy(m)) => return Err(RpcError::new(BUSY, m)),
            Err(HistError::Unknown) => return Err(RpcError::new(UNKNOWN_SYMBOL, format!("Interactive Brokers has no {ticker}"))),
            Err(HistError::Failed(m)) => return Err(RpcError::new(FAILED, m)),
        };
        Ok(json!({ "bars": shape(&bars, s.tz, from, to, count_back, q.midpoint) }))
    }
}

/// The calendar days one request covers: the range asked, no more than `count_back` bars need, within the broker's
/// limit for the size.
fn request_days(from: i64, to: i64, secs: i64, count_back: usize, max_days: u32) -> u32 {
    let range = ((to - from + secs) as f64 / 86_400.0).ceil() as u32;
    // A day of extended trading holds about 16 hours of bars; daily bars come 5 a week.
    let needed = if secs >= 86_400 { (count_back as f64 * 7.0 / 5.0).ceil() as u32 + 7 } else { (count_back as f64 * secs as f64 / 57_600.0).ceil() as u32 + 3 };
    range.min(needed).clamp(1, max_days)
}

/// Bars as the app takes them: `[time, open, high, low, close, volume]`. A daily bar starts at its day's midnight in
/// the symbol's time zone. The broker fills minutes without trades with empty bars: they are left out, as on other
/// sources (not for forex, whose midpoint bars have no volume).
pub fn shape(bars: &[HistBar], tz: Tz, from: i64, to: i64, count_back: usize, midpoint: bool) -> Vec<Value> {
    let mut out: Vec<Value> = bars
        .iter()
        .filter(|b| midpoint || b.volume > 0.0)
        .filter_map(|b| {
            let t = match b.time {
                BarTime::At(t) => t,
                BarTime::Day(d) => tz.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).earliest()?.timestamp(),
            };
            (from..=to).contains(&t).then(|| {
                if midpoint {
                    json!([t, b.open, b.high, b.low, b.close])
                } else {
                    json!([t, b.open, b.high, b.low, b.close, b.volume])
                }
            })
        })
        .collect();
    if out.len() > count_back {
        out.drain(..out.len() - count_back);
    }
    out
}

/// The contracts a ticker may stand for, most likely first.
fn guesses(ticker: &str) -> Vec<Contract> {
    let t = ticker.trim().to_ascii_uppercase();
    let mut out = Vec::new();
    if t.len() == 6 && CURRENCIES.contains(&&t[..3]) && CURRENCIES.contains(&&t[3..]) {
        out.push(Contract {
            symbol: t[..3].into(),
            currency: t[3..].into(),
            security_type: SecurityType::ForexPair,
            exchange: "IDEALPRO".into(),
            ..Default::default()
        });
    }
    out.push(Contract::stock(crate::symbols::broker_ticker(&t)).build());
    if is_future_code(&t) {
        out.push(Contract { local_symbol: t.clone(), security_type: SecurityType::Future, currency: "USD".into(), ..Default::default() });
    }
    out
}

/// "ESZ6", "MNQH7": a root, a month code, a year digit.
fn is_future_code(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() >= 3 && b.len() <= 7 && b[b.len() - 1].is_ascii_digit() && b"FGHJKMNQUVXZ".contains(&b[b.len() - 2]) && b[..b.len() - 2].iter().all(|c| c.is_ascii_alphanumeric())
}

/// The data ticker of a contract (see the top of this file); None for what the plugin doesn't serve.
pub fn data_ticker(c: &Contract) -> Option<String> {
    match c.security_type {
        SecurityType::Stock if c.currency.as_str() == "USD" => Some(c.symbol.as_str().trim().replace(' ', ".")),
        SecurityType::ForexPair => Some(format!("{}{}", c.symbol.as_str().trim(), c.currency.as_str().trim())),
        SecurityType::Future => Some(c.local_symbol.split_whitespace().collect::<String>()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// The symbol info of a contract's details.
fn describe(d: &ContractDetails) -> Symbol {
    let c = crate::symbols::routed(d.contract.clone());
    let kind = match c.security_type {
        SecurityType::ForexPair => Kind::Forex,
        SecurityType::Future => Kind::Futures,
        _ if d.stock_type.eq_ignore_ascii_case("ETF") || d.stock_type.eq_ignore_ascii_case("ETN") => Kind::Fund,
        _ => Kind::Stock,
    };
    let zone = iana_zone(&d.time_zone_id);
    let tz: Tz = zone.parse().unwrap_or(chrono_tz::America::New_York);
    let extended = sessions(&d.trading_hours);
    let regular = sessions(&d.liquid_hours).or_else(|| extended.clone());
    let (pricescale, minmov) = price_scale(d.min_tick);
    let multiplier = c.multiplier.parse::<f64>().ok().filter(|m| *m > 0.0).unwrap_or(1.0);
    let description = if kind == Kind::Futures { format!("{} {}", d.long_name, d.contract_month).trim().to_string() } else { d.long_name.clone() };
    let info = json!({
        "description": description,
        "type": kind.name(),
        "currency": c.currency.as_str(),
        "timezone": zone,
        "session": regular.as_ref().map_or("0930-1600".to_string(), |s| s.0.clone()),
        "extended": extended.as_ref().filter(|e| Some(&e.0) != regular.as_ref().map(|r| &r.0)).map(|e| e.0.clone()),
        "holidays": regular.as_ref().map(|s| s.1.clone()).unwrap_or_default(),
        "pricescale": pricescale,
        "minmov": minmov,
        "pointValue": multiplier,
        "intervals": INTERVALS,
        "history": { "minute": 365 },
    });
    Symbol { contract: c, kind, tz, info }
}

/// IANA name of the broker's time zone ids ("US/Eastern").
fn iana_zone(id: &str) -> String {
    match id.trim() {
        "US/Eastern" | "EST" | "EST5EDT" | "EDT" => "America/New_York",
        "US/Central" | "CST" | "CST6CDT" | "CDT" => "America/Chicago",
        "US/Mountain" | "MST" | "MST7MDT" => "America/Denver",
        "US/Pacific" | "PST" | "PST8PDT" => "America/Los_Angeles",
        "GB" | "GB-Eire" => "Europe/London",
        "MET" | "CET" => "Europe/Berlin",
        "Japan" => "Asia/Tokyo",
        "Hongkong" => "Asia/Hong_Kong",
        "" => "America/New_York",
        other => return other.to_string(),
    }
    .to_string()
}

/// One tick as the app takes it: `minmov / pricescale`.
fn price_scale(tick: f64) -> (u64, u64) {
    if !(tick.is_finite() && tick > 0.0) {
        return (100, 1);
    }
    for d in 0..=8 {
        let p = 10u64.pow(d);
        let m = tick * p as f64;
        if (m - m.round()).abs() < 1e-6 && m.round() >= 1.0 {
            return (p, m.round() as u64);
        }
    }
    (100_000_000, 1)
}

/// The session of the broker's hours ("20261120:0930-20261120:1600", "20261121:CLOSED"…): the most common day,
/// "HHMM-HHMM", and the weekdays it lists closed (`YYYYMMDD,…`). The broker lists a week or so: trading days are Monday
/// to Friday, plus a weekend day seen open (1 = Sunday, the day a session ends), then written out.
pub fn sessions(hours: &[String]) -> Option<(String, String)> {
    let mut days: Vec<(NaiveDate, String)> = Vec::new();
    let mut closed: Vec<NaiveDate> = Vec::new();
    for entry in hours.iter().flat_map(|h| h.split(';')) {
        let entry = entry.trim();
        let Some((date, rest)) = entry.split_once(':') else { continue };
        let Ok(date) = NaiveDate::parse_from_str(date, "%Y%m%d") else { continue };
        if rest == "CLOSED" {
            closed.push(date);
            continue;
        }
        let mut parts = Vec::new();
        let mut end_date = date;
        for seg in rest.split(',') {
            let Some((a, b)) = seg.split_once('-') else { continue };
            let start = a.rsplit(':').next().unwrap_or(a);
            let (end_day, end) = match b.split_once(':') {
                Some((d, e)) => (NaiveDate::parse_from_str(d, "%Y%m%d").unwrap_or(date), e),
                None => (date, b),
            };
            end_date = end_day;
            parts.push(format!("{start}-{end}"));
        }
        if !parts.is_empty() {
            days.push((end_date, parts.join(",")));
        }
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (_, s) in &days {
        *counts.entry(s.as_str()).or_default() += 1;
    }
    let common = counts.into_iter().max_by_key(|(s, n)| (*n, std::cmp::Reverse(*s)))?.0.to_string();
    let mut open_days: Vec<u32> = vec![2, 3, 4, 5, 6];
    open_days.extend(days.iter().filter(|(_, s)| *s == common).map(|(d, _)| d.weekday().number_from_sunday()).filter(|d| *d == 1 || *d == 7));
    open_days.sort_unstable();
    open_days.dedup();
    let session = if open_days == [2, 3, 4, 5, 6] {
        common
    } else {
        format!("{common}:{}", open_days.iter().map(|d| d.to_string()).collect::<String>())
    };
    let holidays = closed
        .iter()
        .filter(|d| open_days.contains(&d.weekday().number_from_sunday()))
        .map(|d| d.format("%Y%m%d").to_string())
        .collect::<Vec<_>>()
        .join(",");
    Some((session, holidays))
}

/// A ticker's live quote, folded from the broker's ticks (`data.quote`).
#[derive(Debug, Clone)]
pub struct Live {
    pub tz: Tz,
    pub forex: bool,
    last: Option<f64>,
    bid: Option<f64>,
    ask: Option<f64>,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    prev_close: Option<f64>,
    /// The day's volume so far.
    volume: Option<f64>,
    /// The forming minute: start, open, high, low, close, and the day's volume when it started (None until the day's
    /// volume is known: the minute then counts from there).
    minute: Option<(i64, f64, f64, f64, f64, Option<f64>)>,
}

impl Live {
    pub fn new(tz: Tz, forex: bool) -> Self {
        Self { tz, forex, last: None, bid: None, ask: None, open: None, high: None, low: None, prev_close: None, volume: None, minute: None }
    }

    /// The price shown: the last trade, or the middle of bid and ask (forex has no trades).
    pub fn price(&self) -> Option<f64> {
        if self.forex {
            match (self.bid, self.ask) {
                (Some(b), Some(a)) => Some((b + a) / 2.0),
                (b, a) => b.or(a).or(self.last),
            }
        } else {
            self.last
        }
    }

    /// Fold a tick in at `now` (UNIX seconds); true when the quote changed.
    pub fn apply(&mut self, tick: &TickTypes, now: i64) -> bool {
        let before = self.price();
        let (tt, value) = match tick {
            TickTypes::Price(t) => (&t.tick_type, t.price),
            TickTypes::PriceSize(t) => (&t.price_tick_type, t.price),
            TickTypes::Size(t) => (&t.tick_type, t.size),
            _ => return false,
        };
        if !value.is_finite() || value < 0.0 {
            return false;
        }
        let positive = (value > 0.0).then_some(value);
        match tt {
            TickType::Last | TickType::DelayedLast => self.last = positive,
            TickType::Bid | TickType::DelayedBid => self.bid = positive,
            TickType::Ask | TickType::DelayedAsk => self.ask = positive,
            TickType::Open | TickType::DelayedOpen => self.open = positive,
            TickType::High | TickType::DelayedHigh => self.high = positive,
            TickType::Low | TickType::DelayedLow => self.low = positive,
            TickType::Close | TickType::DelayedClose => self.prev_close = positive,
            TickType::Volume | TickType::DelayedVolume => self.volume = Some(value),
            _ => return false,
        }
        let Some(price) = self.price() else { return false };
        let start = now - now.rem_euclid(60);
        match &mut self.minute {
            Some(m) if m.0 == start => {
                m.2 = m.2.max(price);
                m.3 = m.3.min(price);
                m.4 = price;
                m.5 = m.5.or(self.volume);
            }
            _ => self.minute = Some((start, price, price, price, price, self.volume)),
        }
        before != Some(price) || matches!(tt, TickType::Volume | TickType::DelayedVolume | TickType::Close | TickType::DelayedClose)
    }

    pub fn quote(&self, ticker: &str, now: i64) -> Option<Value> {
        let price = self.price()?;
        let day_start = self.tz.timestamp_opt(now, 0).single().and_then(|t| t.date_naive().and_hms_opt(0, 0, 0)).and_then(|d| self.tz.from_local_datetime(&d).earliest()).map_or(now, |d| d.timestamp());
        let volume = self.volume.unwrap_or(0.0);
        let minute = self.minute.map(|(t, o, h, l, c, v0)| json!([t, o, h, l, c, v0.map_or(0.0, |v0| (volume - v0).max(0.0))]));
        let open = self.open.unwrap_or(price);
        let day = json!([day_start, open, self.high.unwrap_or(price).max(price), self.low.unwrap_or(price).min(price), price, volume]);
        Some(json!({ "ticker": ticker, "time": now, "price": price, "prevClose": self.prev_close, "minute": minute, "day": day }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ibapi::market_data::realtime::{TickPrice, TickSize};

    #[test]
    fn hours_make_sessions() {
        let stock = vec!["20261120:0400-20261120:2000".to_string(), "20261121:CLOSED".into(), "20261122:CLOSED".into(), "20261123:0400-20261123:2000".into(), "20261126:CLOSED".into()];
        assert_eq!(sessions(&stock), Some(("0400-2000".into(), "20261126".into())));
        let future = vec!["20261119:1700-20261120:1600;20261121:CLOSED;20261122:1700-20261123:1600;20261123:1700-20261124:1600".to_string()];
        assert_eq!(sessions(&future).unwrap().0, "1700-1600");
        let split = vec!["20261120:0930-20261120:1130,20261120:1230-20261120:1500".to_string()];
        assert_eq!(sessions(&split).unwrap().0, "0930-1130,1230-1500");
        let weekend = vec!["20261121:1000-20261121:1400".to_string(), "20261120:1000-20261120:1400".into()];
        assert_eq!(sessions(&weekend).unwrap().0, "1000-1400:234567");
        assert_eq!(sessions(&[]), None);
    }

    #[test]
    fn tickers() {
        assert_eq!(data_ticker(&Contract::stock("BRK B").build()).as_deref(), Some("BRK.B"));
        let fx = Contract { symbol: "EUR".into(), currency: "USD".into(), security_type: SecurityType::ForexPair, ..Default::default() };
        assert_eq!(data_ticker(&fx).as_deref(), Some("EURUSD"));
        assert!(is_future_code("ESZ6") && is_future_code("MNQH7") && !is_future_code("AAPL") && !is_future_code("Z6"));
        let g = guesses("EURUSD");
        assert_eq!(g[0].security_type, SecurityType::ForexPair);
        assert_eq!(guesses("ESZ6").last().map(|c| c.local_symbol.as_str()), Some("ESZ6"));
        assert_eq!(guesses("AAPL").len(), 1);
    }

    #[test]
    fn scales() {
        assert_eq!(price_scale(0.01), (100, 1));
        assert_eq!(price_scale(0.25), (100, 25));
        assert_eq!(price_scale(0.00005), (100_000, 5));
        assert_eq!(price_scale(1.0), (1, 1));
        assert_eq!(iana_zone("US/Central"), "America/Chicago");
    }

    #[test]
    fn bars_are_shaped() {
        let tz = chrono_tz::America::New_York;
        let bar = |time, volume| HistBar { time, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume };
        let b = [bar(BarTime::At(100), 10.0), bar(BarTime::At(160), 0.0), bar(BarTime::At(220), 5.0), bar(BarTime::At(280), 1.0)];
        let out = shape(&b, tz, 100, 220, 10, false);
        assert_eq!(out, vec![json!([100, 1.0, 2.0, 0.5, 1.5, 10.0]), json!([220, 1.0, 2.0, 0.5, 1.5, 5.0])]);
        assert_eq!(shape(&b, tz, 0, 1000, 2, false).len(), 2);
        assert_eq!(shape(&b, tz, 0, 1000, 10, true)[1], json!([160, 1.0, 2.0, 0.5, 1.5]));
        let day = shape(&[bar(BarTime::Day(NaiveDate::from_ymd_opt(2026, 11, 20).unwrap()), 3.0)], tz, 0, i64::MAX, 5, false);
        assert_eq!(day[0][0], json!(1_795_150_800));
        assert_eq!(request_days(0, 86_400 * 30, 60, 2000, 7), 6);
        assert_eq!(request_days(0, 86_400 * 30, 60, 50_000, 7), 7);
        assert_eq!(request_days(86_400 * 29, 86_400 * 30, 60, 100, 7), 2);
    }

    #[test]
    fn live_quote_folds_ticks() {
        let mut q = Live::new(chrono_tz::America::New_York, false);
        let price = |tick_type, price| TickTypes::Price(TickPrice { tick_type, price, ..Default::default() });
        // One minute: 999 960 to 1 000 019.
        assert!(!q.apply(&price(TickType::Close, 99.0), 999_970));
        assert!(q.apply(&price(TickType::DelayedLast, 100.0), 999_980));
        assert!(q.apply(&TickTypes::Size(TickSize { tick_type: TickType::Volume, size: 500.0 }), 999_990));
        assert!(q.apply(&TickTypes::Size(TickSize { tick_type: TickType::Volume, size: 530.0 }), 999_995));
        assert!(q.apply(&price(TickType::Last, 101.0), 1_000_000));
        let v = q.quote("AAPL", 1_000_000).unwrap();
        assert_eq!((v["price"].as_f64(), v["prevClose"].as_f64()), (Some(101.0), Some(99.0)));
        // The day's volume was unknown when the minute started: it counts from the first one known.
        assert_eq!(v["minute"], json!([999_960, 100.0, 101.0, 100.0, 101.0, 30.0]));
        let mut fx = Live::new(chrono_tz::America::New_York, true);
        fx.apply(&price(TickType::Bid, 1.1), 0);
        fx.apply(&price(TickType::Ask, 1.2), 0);
        assert!((fx.price().unwrap() - 1.15).abs() < 1e-12);
    }
}
