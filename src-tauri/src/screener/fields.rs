/*
 * Screener field catalog. Field ids are the reference app scanner names so the
 * frontend can map the reference app columns and filters 1:1.
 *
 *   live       from the full-market snapshot (every 10 s)
 *   reference  from the reference ticker list (once a day)
 *   state      history-derived: the daily state file (`state.rs`) joined with
 *              the live bar. State key `<id>` is the value at the close of D;
 *              `<id>|next` is the carry-over the next session needs.
 */
use crate::data::massive_rest::MarketRow;
use crate::screener::state::StateFile;
use crate::screener::table::{Join, Row, Table};
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Live(Live),
    Reference(Reference),
    State(&'static str, Step),
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
];

impl Field {
    pub fn parse(id: &str) -> Option<Field> {
        if let Some((_, f)) = LIVE.iter().find(|(k, _)| *k == id) {
            return Some(Field::Live(*f));
        }
        if let Some((_, f)) = REFERENCE.iter().find(|(k, _)| *k == id) {
            return Some(Field::Reference(*f));
        }
        STATE.iter().find(|(k, _)| *k == id).map(|(k, s)| Field::State(k, *s))
    }

    pub fn is_text(&self) -> bool {
        matches!(self, Field::Reference(_) | Field::State(_, Step::Text | Step::List))
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
                    Reference::Exchange => &r?.primary_exchange,
                    Reference::Currency => &r?.currency_name,
                };
                (!s.is_empty()).then_some(Val::Text(s))
            }
            Field::State(key, Step::Text | Step::List) => {
                let s = t.state.as_ref()?;
                s.text(key, row.st?).filter(|v| !v.is_empty()).map(Val::Text)
            }
            Field::State(key, step) => state_num(t, row, key, step).filter(|v| v.is_finite()).map(Val::Num),
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
            Step::Text | Step::List => None,
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
        let kind = if matches!(step, Step::Text | Step::List) { "text" } else { "number" };
        out.push(FieldInfo { id: id.to_string(), kind: kind.into(), source: "state".into(), available: has_state });
    }
    out
}

/// Distinct values of a text field over the table, sorted (the options of the
/// Sector / Industry checkbox filters). Errors on an unknown or numeric field.
pub fn text_values(t: &Table, id: &str) -> Result<Vec<String>, String> {
    let f = Field::parse(id).ok_or_else(|| format!("unknown field {id}"))?;
    if !f.is_text() {
        return Err(format!("{id} is not a text field"));
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
