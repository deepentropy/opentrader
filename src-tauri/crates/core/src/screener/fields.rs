/*
 * Screener field catalog. Field ids are the reference app scanner names so the
 * frontend can map the reference app columns and filters 1:1.
 *
 *   live       from the full-market snapshot (every 10 s)
 *   reference  from the reference ticker list (once a day)
 *   state      history-derived: the daily state file (`state.rs`) joined with
 *              the live bar. State key `<id>` is the value at the close of D;
 *              `<id>|next` is the carry-over the next session needs.
 *   fundamentals  state keys `f.<name>`: company financials as of D (the
 *              same all session), and the price ratios built from them
 *              with the live price (`Ratio`: P/E, P/S, EV...).
 */
use crate::data::market_rest::MarketRow;
use crate::sync::LockExt;
use crate::screener::state::StateFile;
use crate::screener::table::{Join, Row, Table};
use crate::screener::technicals::{self, Tech};
use serde::Serialize;

/// A computed cell.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Val<'a> {
    Num(f64),
    Text(&'a str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Live {
    Close,
    Open,
    High,
    Low,
    Volume,
    Change,
    ChangeAbs,
    Gap,
    ChangeFromOpen,
    ValueTraded,
    /// 100 * true range / low.
    VolatilityD,
    /// The shown session as a daily bar time (00:00 New York of its date,
    /// UNIX seconds, the stamp of the daily bars): where the row's open /
    /// high / low / close / volume go in a daily series.
    SessionDay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reference {
    Name,
    Description,
    Type,
    Exchange,
    Currency,
}

/// How a state field becomes a live value on the session after D (S).
/// Formulas matched on the reference app values of 29/09/2026 (74 symbols,
/// .tmp/screener/doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Pine `ta.ema`: prev + 2/(n+1) * (price - prev).
    Ema(u32),
    /// Mean of the last n closes: (`|next` = sum of the last n-1 + price) / n.
    Sma(u32),
    /// Pine `ta.rsi` (Wilder RMA): `|gain`, `|loss` at D and `close` of D.
    Rsi(u32),
    /// Pine `ta.atr`: RMA of the true range; ATR at D and `close` of D.
    Atr(u32),
    /// 100 * ATR / close, from the `ATR` key.
    Atrp(u32),
    /// SMA(high - low, n): (`|next` = sum of the last n-1 ranges + today's) / n.
    Adr(u32),
    /// 100 * ADR / close, from the `ADR|next` key.
    Adrp(u32),
    /// Max high of the bars with date > S - N days: max(`|next`, today's high).
    WindowHigh,
    /// Min low of the bars with date > S - N days: min(`|next`, today's low).
    WindowLow,
    /// 100 * (price / base - 1); `|next` = open of the last bar with date
    /// <= S - N days.
    Perf,
    /// Like `Perf` with the open of the year's first bar (today's open on
    /// the year's first session).
    PerfYtd,
    /// Mean volume of the last n bars, today included:
    /// (`|next` = sum of the last n-1 + volume) / n.
    AvgVolIncl(u32),
    /// Today's volume / `|next` (= average_volume_10d_calc at D).
    RelVol,
    /// Price * `shares` (weighted shares outstanding).
    MarketCap,
    /// Text column (sector, industry): the same value all day.
    Text,
    /// Text column holding several values joined with commas (the index
    /// codes of a ticker, "SPX,NDX,IXIC"). A set filter matches when any of
    /// them is in the set.
    List,
    /// Value at the close of D that stays the same all session: dividend
    /// yield (cash dividends of the last 12 months / close of D) and beta
    /// (weekly or monthly returns against the S&P 500).
    Daily,
    /// Technical ratings and oscillators (`technicals.rs`).
    Tech(Tech),
    /// Text bucket of a rating ("StrongBuy" ... "StrongSell"), for the rating checkbox filters.
    Rating(Tech),
    /// Mean of 100 * (high - low) / low over the window's bars: (`|s` + today's) / (`|n` + 1).
    MeanSwing,
    /// Volume of the current week / month: `|next` (the bars of the period before today) + today's volume.
    PeriodVolume,
    /// Price * the period volume of the given key.
    PeriodTurnover(&'static str),
}

/// A price ratio of the fundamentals: the live price (or market cap) against
/// a financial value of the state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ratio {
    /// Price / a per-share amount (P/S, P/B, P/CF, P/FCF, price to cash).
    PriceOver(&'static str),
    /// Price / diluted EPS (TTM): none when the company lost money.
    Pe,
    /// P/E / diluted EPS growth (TTM YoY): none unless both are positive.
    Peg,
    /// Enterprise value: market cap + total debt + minority interest - cash and short-term investments.
    Ev,
    /// Enterprise value / an amount (revenue, EBIT, EBITDA).
    EvOver(&'static str),
    /// 100 * an annual dividend amount / price.
    YieldOf(&'static str),
    /// 100 * (market cap / a past market cap - 1).
    McapPerf(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Live(Live),
    Reference(Reference),
    State(&'static str, Step),
    Ratio(Ratio),
}

const LIVE: &[(&str, Live)] = &[
    ("close", Live::Close),
    ("open", Live::Open),
    ("high", Live::High),
    ("low", Live::Low),
    ("volume", Live::Volume),
    ("change", Live::Change),
    ("change_abs", Live::ChangeAbs),
    ("gap", Live::Gap),
    ("change_from_open", Live::ChangeFromOpen),
    ("Value.Traded", Live::ValueTraded),
    ("Volatility.D", Live::VolatilityD),
    ("session_day", Live::SessionDay),
];

const REFERENCE: &[(&str, Reference)] = &[
    ("name", Reference::Name),
    ("description", Reference::Description),
    ("type", Reference::Type),
    ("exchange", Reference::Exchange),
    ("currency", Reference::Currency),
];

/// State fields and how each steps to the next session. The definitions
/// match the reference app's values (.tmp/screener/doc, 29/09/2026).
const STATE: &[(&str, Step)] = &[
    ("EMA5", Step::Ema(5)),
    ("EMA9", Step::Ema(9)),
    ("EMA10", Step::Ema(10)),
    ("EMA20", Step::Ema(20)),
    ("EMA21", Step::Ema(21)),
    ("EMA30", Step::Ema(30)),
    ("EMA50", Step::Ema(50)),
    ("EMA100", Step::Ema(100)),
    ("EMA200", Step::Ema(200)),
    ("SMA5", Step::Sma(5)),
    ("SMA10", Step::Sma(10)),
    ("SMA20", Step::Sma(20)),
    ("SMA30", Step::Sma(30)),
    ("SMA50", Step::Sma(50)),
    ("SMA100", Step::Sma(100)),
    ("SMA200", Step::Sma(200)),
    ("RSI", Step::Rsi(14)),
    ("RSI7", Step::Rsi(7)),
    ("ATR", Step::Atr(14)),
    ("ATRP", Step::Atrp(14)),
    ("ADR", Step::Adr(14)),
    ("ADRP", Step::Adrp(14)),
    ("High.5D", Step::WindowHigh),
    ("Low.5D", Step::WindowLow),
    ("High.1M", Step::WindowHigh),
    ("Low.1M", Step::WindowLow),
    ("High.3M", Step::WindowHigh),
    ("Low.3M", Step::WindowLow),
    ("High.6M", Step::WindowHigh),
    ("Low.6M", Step::WindowLow),
    ("price_52_week_high", Step::WindowHigh),
    ("price_52_week_low", Step::WindowLow),
    ("Perf.W", Step::Perf),
    ("Perf.5D", Step::Perf),
    ("Perf.1M", Step::Perf),
    ("Perf.3M", Step::Perf),
    ("Perf.6M", Step::Perf),
    ("Perf.Y", Step::Perf),
    ("Perf.5Y", Step::Perf),
    ("Perf.YTD", Step::PerfYtd),
    ("average_volume_10d_calc", Step::AvgVolIncl(10)),
    ("average_volume_30d_calc", Step::AvgVolIncl(30)),
    ("average_volume_60d_calc", Step::AvgVolIncl(60)),
    ("average_volume_90d_calc", Step::AvgVolIncl(90)),
    ("relative_volume_10d_calc", Step::RelVol),
    ("market_cap_basic", Step::MarketCap),
    ("sector", Step::Text),
    ("industry", Step::Text),
    ("indexes", Step::List),
    ("dividends_yield_current", Step::Daily),
    ("beta_1_year", Step::Daily),
    ("beta_3_year", Step::Daily),
    ("beta_5_year", Step::Daily),
    ("Recommend.All", Step::Tech(Tech::RatingAll)),
    ("Recommend.MA", Step::Tech(Tech::RatingMa)),
    ("Recommend.Other", Step::Tech(Tech::RatingOther)),
    ("TechRating_1D", Step::Rating(Tech::RatingAll)),
    ("MARating_1D", Step::Rating(Tech::RatingMa)),
    ("OsRating_1D", Step::Rating(Tech::RatingOther)),
    ("Mom", Step::Tech(Tech::Mom(10))),
    ("Mom_14", Step::Tech(Tech::Mom(14))),
    ("AO", Step::Tech(Tech::Ao)),
    ("CCI20", Step::Tech(Tech::Cci)),
    ("Stoch.K", Step::Tech(Tech::StochK)),
    ("Stoch.D", Step::Tech(Tech::StochD)),
    ("Stoch.K_14_1_3", Step::Tech(Tech::StochKFast)),
    ("Stoch.D_14_1_3", Step::Tech(Tech::StochDFast)),
    ("Volatility.W", Step::MeanSwing),
    ("Volatility.M", Step::MeanSwing),
    ("volume|1W", Step::PeriodVolume),
    ("volume|1M", Step::PeriodVolume),
    ("Value.Traded|1W", Step::PeriodTurnover("volume|1W")),
    ("Value.Traded|1M", Step::PeriodTurnover("volume|1M")),
];

/// Price ratios (field id -> ratio).
const RATIO: &[(&str, Ratio)] = &[
    ("f.pe", Ratio::Pe),
    ("f.peg", Ratio::Peg),
    ("f.ps", Ratio::PriceOver("f.revenue_ps_ttm")),
    ("f.pb", Ratio::PriceOver("f.book_ps_fq")),
    ("f.pcf", Ratio::PriceOver("f.ocf_ps_ttm")),
    ("f.pfcf", Ratio::PriceOver("f.fcf_ps_ttm")),
    ("f.pcash", Ratio::PriceOver("f.cash_ps_fq")),
    ("f.ev", Ratio::Ev),
    ("f.ev_revenue", Ratio::EvOver("f.revenue_ttm")),
    ("f.ev_ebit", Ratio::EvOver("f.ebit_ttm")),
    ("f.ev_ebitda", Ratio::EvOver("f.ebitda_ttm")),
    ("f.div_yield_indicated", Ratio::YieldOf("f.div_indicated")),
    ("f.market_cap_perf_1y", Ratio::McapPerf("f.market_cap_1y")),
];

/// Text fundamentals (every other `f.` key is a number).
const FUND_TEXT: &[&str] = &["f.fiscal_period"];

/// State keys a ratio reads (its field is offered when they are all in the state).
fn ratio_inputs(r: Ratio) -> Vec<&'static str> {
    match r {
        Ratio::PriceOver(k) | Ratio::YieldOf(k) => vec![k],
        Ratio::Pe => vec!["f.eps_dil_ttm"],
        Ratio::Peg => vec!["f.eps_dil_ttm", "f.eps_dil_growth_ttm_yoy"],
        Ratio::Ev => vec!["shares", "f.total_debt_fq", "f.cash_fq"],
        Ratio::EvOver(k) => vec!["shares", "f.total_debt_fq", "f.cash_fq", k],
        Ratio::McapPerf(k) => vec!["shares", k],
    }
}

/// State fields offered only once the served state holds their key (added after the first state version).
const STATE_OPTIONAL: &[&str] = &[
    "Perf.5Y", "Recommend.All", "Recommend.MA", "Recommend.Other", "TechRating_1D", "MARating_1D", "OsRating_1D", "Mom",
    "Mom_14", "AO", "CCI20", "Stoch.K", "Stoch.D", "Stoch.K_14_1_3", "Stoch.D_14_1_3", "Volatility.W", "Volatility.M",
    "volume|1W", "volume|1M", "Value.Traded|1W", "Value.Traded|1M",
];

/// The state key whose presence offers an optional field.
fn held_key(id: &str, step: Step) -> String {
    match step {
        Step::Rating(t) => technicals::state_key(t).to_string(),
        Step::PeriodTurnover(k) => k.to_string(),
        Step::Perf => format!("{id}|next"),
        _ => id.to_string(),
    }
}

impl Field {
    pub fn parse(id: &str) -> Option<Field> {
        if let Some((_, r)) = RATIO.iter().find(|(k, _)| *k == id) {
            return Some(Field::Ratio(*r));
        }
        if id.len() > 2 && id.starts_with("f.") {
            let step = if FUND_TEXT.contains(&id) { Step::Text } else { Step::Daily };
            return Some(Field::State(intern(id), step));
        }
        if let Some((_, f)) = LIVE.iter().find(|(k, _)| *k == id) {
            return Some(Field::Live(*f));
        }
        if let Some((_, f)) = REFERENCE.iter().find(|(k, _)| *k == id) {
            return Some(Field::Reference(*f));
        }
        if let Some((k, s)) = STATE.iter().find(|(k, _)| *k == id) {
            return Some(Field::State(k, *s));
        }
        // A custom length ("EMA137"): its columns come from the closes file (`closes.rs`) once a screen asks for it.
        let (kind, n) = crate::screener::closes::custom_id(id)?;
        let step = match kind {
            "EMA" => Step::Ema(n),
            "SMA" => Step::Sma(n),
            _ => Step::Rsi(n),
        };
        Some(Field::State(intern(id), step))
    }

    pub fn is_text(&self) -> bool {
        matches!(self, Field::Reference(_) | Field::State(_, Step::Text | Step::List | Step::Rating(_)))
    }

    /// Text field with several comma-joined values (see `Step::List`).
    pub fn is_list(&self) -> bool {
        matches!(self, Field::State(_, Step::List))
    }

    pub fn eval<'a>(&self, t: &'a Table, row: &'a Row) -> Option<Val<'a>> {
        match *self {
            Field::Live(f) => live(f, row).filter(|v| v.is_finite()).map(Val::Num),
            Field::Reference(f) => {
                let r = t.reference(row);
                let s: &str = match f {
                    Reference::Name => &row.m.ticker,
                    Reference::Description => &r?.name,
                    Reference::Type => &r?.kind,
                    Reference::Exchange => &r?.exchange,
                    Reference::Currency => &r?.currency,
                };
                (!s.is_empty()).then_some(Val::Text(s))
            }
            Field::State(key, Step::Text | Step::List) => {
                let s = t.state.as_ref()?;
                s.text(key, row.st?).filter(|v| !v.is_empty()).map(Val::Text)
            }
            Field::State(_, Step::Rating(tech)) => {
                let v = state_num(t, row, technicals::state_key(tech), Step::Tech(tech))?;
                v.is_finite().then(|| Val::Text(technicals::bucket(v)))
            }
            Field::State(key, step) => state_num(t, row, key, step).filter(|v| v.is_finite()).map(Val::Num),
            Field::Ratio(r) => ratio(t, row, r).filter(|v| v.is_finite()).map(Val::Num),
        }
    }
}

fn ratio(t: &Table, row: &Row, r: Ratio) -> Option<f64> {
    if row.join == Join::Missing {
        return None;
    }
    let s = t.state.as_ref()?;
    let i = row.st?;
    let price = (row.m.last > 0.0).then_some(row.m.last)?;
    let num = |k: &str| s.num(k, i);
    let div = |a: f64, b: f64| (b != 0.0).then(|| a / b);
    // The app's enterprise value: market cap + total debt + minority interest - cash and short-term investments.
    let ev = || Some(price * num("shares")? + num("f.total_debt_fq")? + num("f.minority_interest_fq").unwrap_or(0.0) - num("f.cash_fq")?);
    match r {
        Ratio::PriceOver(k) => div(price, num(k)?),
        Ratio::Pe => num("f.eps_dil_ttm").filter(|e| *e > 0.0).map(|e| price / e),
        Ratio::Peg => {
            let pe = num("f.eps_dil_ttm").filter(|e| *e > 0.0).map(|e| price / e)?;
            num("f.eps_dil_growth_ttm_yoy").filter(|g| *g > 0.0).map(|g| pe / g)
        }
        Ratio::Ev => ev(),
        Ratio::EvOver(k) => div(ev()?, num(k)?),
        Ratio::YieldOf(k) => Some(100.0 * num(k)? / price),
        Ratio::McapPerf(k) => {
            let before = num(k).filter(|v| *v > 0.0)?;
            Some(100.0 * (price * num("shares")? / before - 1.0))
        }
    }
}

fn live(f: Live, row: &Row) -> Option<f64> {
    let m = &row.m;
    let pos = |v: f64| (v > 0.0).then_some(v);
    Some(match f {
        Live::Close => pos(m.last)?,
        Live::Open => pos(m.open)?,
        Live::High => pos(m.high)?,
        Live::Low => pos(m.low)?,
        Live::Volume => m.volume,
        Live::Change => m.change_percent,
        Live::ChangeAbs => m.change,
        Live::Gap => {
            let pc = m.prev_close.filter(|p| *p > 0.0)?;
            (pos(m.open)? - pc) / pc * 100.0
        }
        Live::ChangeFromOpen => {
            let o = pos(m.open)?;
            (pos(m.last)? - o) / o * 100.0
        }
        Live::ValueTraded => pos(m.last)? * m.volume,
        Live::SessionDay => crate::screener::clock::ny_midnight_sec(row.day?)?,
        Live::VolatilityD => {
            let (h, l, pc) = (pos(m.high)?, pos(m.low)?, m.prev_close.filter(|p| *p > 0.0)?);
            100.0 * (h - l).max((h - pc).abs()).max((l - pc).abs()) / l
        }
    })
}

fn state_num(t: &Table, row: &Row, key: &str, step: Step) -> Option<f64> {
    let s = t.state.as_ref()?;
    let i = row.st?;
    let next = || s.num(&format!("{key}|next"), i);
    let m = &row.m;
    let price = (m.last > 0.0).then_some(m.last);
    match row.join {
        Join::Missing => None,
        Join::AtClose => match step {
            // Market cap moves with the price even on the state's own day.
            Step::MarketCap => Some(price? * s.num("shares", i)?),
            Step::PeriodTurnover(k) => Some(price? * s.num(k, i)?),
            _ => s.num(key, i),
        },
        Join::Step => match step {
            Step::Ema(n) => {
                let prev = s.num(key, i)?;
                Some(prev + 2.0 / (n as f64 + 1.0) * (price? - prev))
            }
            Step::Sma(n) => Some((next()? + price?) / n as f64),
            Step::Rsi(n) => {
                let n = n as f64;
                let diff = price? - s.num("close", i)?;
                let gain = (s.num(&format!("{key}|gain"), i)? * (n - 1.0) + diff.max(0.0)) / n;
                let loss = (s.num(&format!("{key}|loss"), i)? * (n - 1.0) + (-diff).max(0.0)) / n;
                Some(if loss == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + gain / loss) })
            }
            Step::Atr(n) => atr_step(s, i, m, n),
            Step::Atrp(n) => Some(100.0 * atr_step(s, i, m, n)? / price?),
            Step::Adr(n) => Some((s.num("ADR|next", i)? + range(m)?) / n as f64),
            Step::Adrp(n) => Some(100.0 * (s.num("ADR|next", i)? + range(m)?) / n as f64 / price?),
            Step::WindowHigh => Some(next()?.max((m.high > 0.0).then_some(m.high)?)),
            Step::WindowLow => Some(next()?.min((m.low > 0.0).then_some(m.low)?)),
            Step::Perf => perf(price?, next()?),
            Step::PerfYtd => {
                // First session of a new year: the base is today's open.
                let new_year = crate::screener::clock::ny_date_ms(m.updated_ms)
                    .map(|d| chrono::Datelike::year(&d) != chrono::Datelike::year(&s.asof));
                let base = if new_year == Some(true) { m.open } else { next()? };
                perf(price?, base)
            }
            Step::AvgVolIncl(n) => Some((next()? + m.volume) / n as f64),
            Step::RelVol => {
                let avg = next()?;
                (avg > 0.0).then(|| m.volume / avg)
            }
            Step::MarketCap => Some(price? * s.num("shares", i)?),
            Step::Daily => s.num(key, i),
            Step::Tech(tech) => technicals::step(s, i, m, tech),
            Step::MeanSwing => {
                let (h, l) = ((m.high > 0.0).then_some(m.high)?, (m.low > 0.0).then_some(m.low)?);
                let n = s.num(&format!("{key}|n"), i)?;
                Some((s.num(&format!("{key}|s"), i)? + 100.0 * (h - l) / l) / (n + 1.0))
            }
            Step::PeriodVolume => Some(next()? + m.volume),
            Step::PeriodTurnover(k) => Some(price? * (s.num(&format!("{k}|next"), i)? + m.volume)),
            Step::Text | Step::List | Step::Rating(_) => None,
        },
    }
}

fn range(m: &MarketRow) -> Option<f64> {
    (m.high > 0.0 && m.low > 0.0).then(|| m.high - m.low)
}

fn perf(price: f64, base: f64) -> Option<f64> {
    (base > 0.0).then(|| (price / base - 1.0) * 100.0)
}

/// Wilder ATR one session after D: (ATR * (n-1) + TR) / n.
fn atr_step(s: &StateFile, i: usize, m: &MarketRow, n: u32) -> Option<f64> {
    let n = n as f64;
    let pc = s.num("close", i)?;
    let (h, l) = ((m.high > 0.0).then_some(m.high)?, (m.low > 0.0).then_some(m.low)?);
    let tr = (h - l).max((h - pc).abs()).max((l - pc).abs());
    Some((s.num("ATR", i)? * (n - 1.0) + tr) / n)
}

/// A custom field id as a `'static` key (a few hundred at most: lengths 1 to 500 of three kinds).
fn intern(id: &str) -> &'static str {
    static KEYS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, &'static str>>> = std::sync::OnceLock::new();
    let mut keys = KEYS.get_or_init(Default::default).locked();
    if let Some(k) = keys.get(id) {
        return k;
    }
    let k: &'static str = Box::leak(id.to_string().into_boxed_str());
    keys.insert(id.to_string(), k);
    k
}

/// One entry of the field catalog sent to the frontend.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub id: String,
    /// "number" | "text"
    pub kind: String,
    /// "live" | "reference" | "state"
    pub source: String,
    /// False while the source is not loaded (e.g. no state file yet).
    pub available: bool,
}

pub fn catalog(t: &Table) -> Vec<FieldInfo> {
    let has_refs = !t.refs.is_empty();
    let has_state = t.state.is_some();
    let mut out = Vec::new();
    for (id, _) in LIVE {
        out.push(FieldInfo { id: id.to_string(), kind: "number".into(), source: "live".into(), available: true });
    }
    for (id, f) in REFERENCE {
        let available = has_refs || *f == Reference::Name;
        out.push(FieldInfo { id: id.to_string(), kind: "text".into(), source: "reference".into(), available });
    }
    for (id, step) in STATE {
        let kind = if matches!(step, Step::Text | Step::List | Step::Rating(_)) { "text" } else { "number" };
        let held = !STATE_OPTIONAL.contains(id) || t.state.as_ref().is_some_and(|s| s.num.contains_key(&held_key(id, *step)));
        out.push(FieldInfo { id: id.to_string(), kind: kind.into(), source: "state".into(), available: has_state && held });
    }
    // The fundamentals the served state holds, and the ratios whose inputs it holds.
    if let Some(s) = &t.state {
        let mut fund: Vec<(&String, &str)> = s.num.keys().map(|k| (k, "number")).chain(s.text.keys().map(|k| (k, "text"))).filter(|(k, _)| k.starts_with("f.")).collect();
        fund.sort();
        for (id, kind) in fund {
            out.push(FieldInfo { id: id.clone(), kind: kind.into(), source: "state".into(), available: true });
        }
        for (id, r) in RATIO {
            if ratio_inputs(*r).iter().all(|k| s.num.contains_key(*k)) {
                out.push(FieldInfo { id: id.to_string(), kind: "number".into(), source: "state".into(), available: true });
            }
        }
    }
    // The custom lengths computed for the screens that use them.
    if let Some(s) = &t.state {
        let mut custom: Vec<&String> = s.num.keys().filter(|k| crate::screener::closes::custom_id(k).is_some() && !STATE.iter().any(|(id, _)| id == k)).collect();
        custom.sort();
        for id in custom {
            out.push(FieldInfo { id: id.clone(), kind: "number".into(), source: "state".into(), available: true });
        }
    }
    out
}

/// Distinct values of a text field over the table, sorted (the options of the
/// Sector / Industry checkbox filters). Errors on an unknown or numeric field.
pub fn text_values(t: &Table, id: &str) -> crate::error::Result<Vec<String>> {
    use crate::error::Error;
    let f = Field::parse(id).ok_or_else(|| Error::invalid(format!("unknown field {id}")))?;
    if !f.is_text() {
        return Err(Error::invalid(format!("{id} is not a text field")));
    }
    let mut set = std::collections::BTreeSet::new();
    for row in &t.rows {
        if let Some(Val::Text(v)) = f.eval(t, row) {
            if !set.contains(v) {
                set.insert(v.to_string());
            }
        }
    }
    Ok(set.into_iter().collect())
}
