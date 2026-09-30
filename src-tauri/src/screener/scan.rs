/*
 * Scan: filter, sort and page the in-memory table. The request mirrors
 * the reference app's `/scan` grammar (columns, filter clauses, sort, range) so
 * the frontend maps the reference app filters 1:1. Runs synchronously on a snapshot of the
 * table (13k rows: a few milliseconds).
 */
use crate::screener::fields::{Field, Val};
use crate::screener::table::{Row, Table};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    /// Field ids returned in each row's `d`, in this order.
    pub columns: Vec<String>,
    /// Clauses, all must hold.
    pub filter: Vec<Clause>,
    pub sort: Option<SortSpec>,
    /// Rows `[from, to)` of the sorted matches.
    pub range: (u32, u32),
    /// Restrict the universe to these tickers (watchlist scope).
    pub tickers: Option<Vec<String>>,
}

#[derive(Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    /// A field id, or "name" for the ticker.
    pub sort_by: String,
    pub sort_order: SortOrder,
}

#[derive(Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Deserialize, specta::Type, Clone, Debug)]
pub struct Clause {
    pub left: String,
    pub operation: Op,
    pub right: Operand,
}

#[derive(Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    #[serde(rename = "greater")]
    Greater,
    #[serde(rename = "egreater")]
    EGreater,
    #[serde(rename = "less")]
    Less,
    #[serde(rename = "eless")]
    ELess,
    #[serde(rename = "equal")]
    Equal,
    #[serde(rename = "nequal")]
    NEqual,
    /// `[lo, hi]` for numbers, or a list of texts.
    #[serde(rename = "in_range")]
    InRange,
    #[serde(rename = "not_in_range")]
    NotInRange,
    /// `[field, pct]`: left > field * (1 + pct / 100).
    #[serde(rename = "above%")]
    AbovePct,
    /// `[field, pct]`: left < field * (1 - pct / 100).
    #[serde(rename = "below%")]
    BelowPct,
    /// `[field, lo, hi]`: field * lo <= left <= field * hi.
    #[serde(rename = "in_range%")]
    InRangePct,
    #[serde(rename = "not_in_range%")]
    NotInRangePct,
}

/// A number, a text (a field id when one matches, else a literal) or a list.
#[derive(Deserialize, specta::Type, Clone, Debug)]
#[serde(untagged)]
pub enum Operand {
    Num(f64),
    Text(String),
    List(Vec<Operand>),
}

#[derive(Serialize, specta::Type, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Cell {
    Num(f64),
    Text(String),
}

#[derive(Serialize, specta::Type, Debug)]
pub struct ScanRow {
    /// Ticker.
    pub s: String,
    /// Values in `columns` order.
    pub d: Vec<Option<Cell>>,
}

#[derive(Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub total_count: u32,
    pub rows: Vec<ScanRow>,
    pub version: u32,
    pub updated_ms: Option<f64>,
    /// New York date (YYYY-MM-DD) of the daily state, `None` when absent.
    pub state_asof: Option<String>,
}

/// A clause's right side, resolved once per request.
enum Rhs {
    Num(f64),
    Field(Field),
    Text(String),
}

enum Compiled {
    Cmp(Field, Op, Rhs),
    NumRange(Field, bool, Rhs, Rhs),
    TextSet(Field, bool, Vec<String>),
    Pct(Field, Op, Rhs, f64, f64),
}

fn rhs(o: &Operand) -> Result<Rhs, String> {
    match o {
        Operand::Num(n) => Ok(Rhs::Num(*n)),
        Operand::Text(s) => Ok(Field::parse(s).map(Rhs::Field).unwrap_or_else(|| Rhs::Text(s.clone()))),
        Operand::List(_) => Err("nested list operand".into()),
    }
}

fn num(o: &Operand) -> Result<f64, String> {
    match o {
        Operand::Num(n) => Ok(*n),
        _ => Err("expected a number".into()),
    }
}

fn compile(c: &Clause) -> Result<Compiled, String> {
    let left = Field::parse(&c.left).ok_or_else(|| format!("unknown field {}", c.left))?;
    let list = |min: usize| match &c.right {
        Operand::List(v) if v.len() >= min => Ok(v),
        _ => Err(format!("{:?} needs a list of {min}", c.operation)),
    };
    Ok(match c.operation {
        Op::Greater | Op::EGreater | Op::Less | Op::ELess | Op::Equal | Op::NEqual => {
            Compiled::Cmp(left, c.operation, rhs(&c.right)?)
        }
        Op::InRange | Op::NotInRange => {
            let neg = c.operation == Op::NotInRange;
            let v = list(1)?;
            if left.is_text() {
                let set = v
                    .iter()
                    .filter_map(|o| match o {
                        Operand::Text(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect();
                Compiled::TextSet(left, neg, set)
            } else {
                let v = list(2)?;
                Compiled::NumRange(left, neg, rhs(&v[0])?, rhs(&v[1])?)
            }
        }
        Op::AbovePct | Op::BelowPct => {
            let v = list(2)?;
            Compiled::Pct(left, c.operation, rhs(&v[0])?, num(&v[1])?, 0.0)
        }
        Op::InRangePct | Op::NotInRangePct => {
            let v = list(3)?;
            Compiled::Pct(left, c.operation, rhs(&v[0])?, num(&v[1])?, num(&v[2])?)
        }
    })
}

fn value_num(t: &Table, row: &Row, r: &Rhs) -> Option<f64> {
    match r {
        Rhs::Num(n) => Some(*n),
        Rhs::Field(f) => match f.eval(t, row)? {
            Val::Num(n) => Some(n),
            Val::Text(_) => None,
        },
        Rhs::Text(_) => None,
    }
}

fn holds(t: &Table, row: &Row, c: &Compiled) -> bool {
    match c {
        Compiled::Cmp(f, op, r) => {
            let Some(lv) = f.eval(t, row) else { return false };
            match lv {
                Val::Num(l) => {
                    let Some(rv) = value_num(t, row, r) else { return false };
                    match op {
                        Op::Greater => l > rv,
                        Op::EGreater => l >= rv,
                        Op::Less => l < rv,
                        Op::ELess => l <= rv,
                        Op::Equal => l == rv,
                        Op::NEqual => l != rv,
                        _ => false,
                    }
                }
                Val::Text(l) => {
                    let rv = match r {
                        Rhs::Text(s) => Some(s.as_str()),
                        Rhs::Field(f) => match f.eval(t, row) {
                            Some(Val::Text(s)) => Some(s),
                            _ => None,
                        },
                        Rhs::Num(_) => None,
                    };
                    match (op, rv) {
                        (Op::Equal, Some(r)) => l == r,
                        (Op::NEqual, Some(r)) => l != r,
                        _ => false,
                    }
                }
            }
        }
        Compiled::NumRange(f, neg, lo, hi) => {
            let (Some(Val::Num(l)), Some(lo), Some(hi)) =
                (f.eval(t, row), value_num(t, row, lo), value_num(t, row, hi))
            else {
                return false;
            };
            (lo <= l && l <= hi) != *neg
        }
        Compiled::TextSet(f, neg, set) => match f.eval(t, row) {
            Some(Val::Text(l)) => set.iter().any(|s| s == l) != *neg,
            _ => false,
        },
        Compiled::Pct(f, op, base, a, b) => {
            let (Some(Val::Num(l)), Some(base)) = (f.eval(t, row), value_num(t, row, base)) else {
                return false;
            };
            match op {
                Op::AbovePct => l > base * (1.0 + a / 100.0),
                Op::BelowPct => l < base * (1.0 - a / 100.0),
                Op::InRangePct => base * a <= l && l <= base * b,
                Op::NotInRangePct => !(base * a <= l && l <= base * b),
                _ => false,
            }
        }
    }
}

fn cell(v: Option<Val>) -> Option<Cell> {
    match v? {
        Val::Num(n) => Some(Cell::Num(n)),
        Val::Text(s) => Some(Cell::Text(s.to_string())),
    }
}

fn cmp_vals(a: Option<Val>, b: Option<Val>) -> Ordering {
    match (a, b) {
        (Some(Val::Num(x)), Some(Val::Num(y))) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        (Some(Val::Text(x)), Some(Val::Text(y))) => x.cmp(y),
        _ => Ordering::Equal,
    }
}

pub fn run(t: &Table, req: &ScanRequest) -> Result<ScanResult, String> {
    let clauses = req.filter.iter().map(compile).collect::<Result<Vec<_>, _>>()?;
    let columns = req
        .columns
        .iter()
        .map(|c| Field::parse(c).ok_or_else(|| format!("unknown field {c}")))
        .collect::<Result<Vec<_>, _>>()?;
    let scope: Option<std::collections::HashSet<String>> =
        req.tickers.as_ref().map(|v| v.iter().map(|s| s.to_uppercase()).collect());

    let mut hits: Vec<&Row> = t
        .rows
        .iter()
        .filter(|r| scope.as_ref().map_or(true, |s| s.contains(&r.m.ticker)))
        .filter(|r| clauses.iter().all(|c| holds(t, r, c)))
        .collect();

    // Ticker order unless a field sort is asked; rows without a value go last
    // in both directions, ties keep ticker order.
    hits.sort_by(|a, b| a.m.ticker.cmp(&b.m.ticker));
    if let Some(sort) = &req.sort {
        let desc = sort.sort_order == SortOrder::Desc;
        if sort.sort_by == "name" || sort.sort_by == "ticker-view-sort" {
            if desc {
                hits.reverse();
            }
        } else {
            let f = Field::parse(&sort.sort_by).ok_or_else(|| format!("unknown sort field {}", sort.sort_by))?;
            let mut keyed: Vec<(Option<Val>, &Row)> = hits.iter().map(|r| (f.eval(t, r), *r)).collect();
            keyed.sort_by(|(a, _), (b, _)| match (a.is_some(), b.is_some()) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => {
                    let o = cmp_vals(*a, *b);
                    if desc {
                        o.reverse()
                    } else {
                        o
                    }
                }
            });
            hits = keyed.into_iter().map(|(_, r)| r).collect();
        }
    }

    let total = hits.len();
    let (from, to) = (req.range.0 as usize, (req.range.1 as usize).min(total));
    let rows = hits
        .get(from.min(total)..to.max(from.min(total)))
        .unwrap_or(&[])
        .iter()
        .map(|r| ScanRow { s: r.m.ticker.clone(), d: columns.iter().map(|f| cell(f.eval(t, r))).collect() })
        .collect();
    Ok(ScanResult {
        total_count: total as u32,
        rows,
        version: t.version,
        updated_ms: t.updated_ms,
        state_asof: t.state_asof().map(|d| d.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::massive_rest::{MarketRow, RefTicker};
    use crate::screener::state::{StateFile, STATE_VERSION};
    use chrono::NaiveDate;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn mrow(t: &str, last: f64, vol: f64, live: bool, updated: &str) -> MarketRow {
        let ms = chrono::DateTime::parse_from_rfc3339(updated).unwrap().timestamp_millis() as f64;
        MarketRow {
            ticker: t.into(),
            last,
            change: 0.0,
            change_percent: 0.0,
            open: last,
            high: last * 1.02,
            low: last * 0.98,
            volume: vol,
            prev_close: Some(last),
            live,
            updated_ms: ms,
        }
    }

    fn table(state: Option<StateFile>) -> Table {
        // Tue 29/09/2026 16:30 New York (20:30 UTC): live rows show the 29th.
        let rows = vec![
            mrow("AAA", 10.0, 1000.0, true, "2026-09-29T20:30:00Z"),
            mrow("BBB", 4.0, 5000.0, true, "2026-09-29T20:30:00Z"),
            mrow("CCC", 50.0, 10.0, true, "2026-09-29T20:30:00Z"),
        ];
        let refs = vec![RefTicker {
            ticker: "AAA".into(),
            name: "Aaa Inc".into(),
            kind: "CS".into(),
            primary_exchange: "XNAS".into(),
            currency_name: "usd".into(),
        }];
        Table::build(7, rows, Arc::new(refs), state.map(Arc::new))
    }

    fn state(asof: (i32, u32, u32)) -> StateFile {
        let mut num = HashMap::new();
        num.insert("EMA50".to_string(), vec![Some(9.0), Some(5.0), None]);
        num.insert("SMA5".to_string(), vec![Some(9.5), Some(4.5), None]);
        num.insert("SMA5|next".to_string(), vec![Some(40.0), Some(16.0), None]);
        num.insert("shares".to_string(), vec![Some(100.0), None, None]);
        let mut text = HashMap::new();
        text.insert("sector".to_string(), vec![Some("Finance".to_string()), Some("Energy".to_string()), None]);
        StateFile {
            version: STATE_VERSION,
            asof: NaiveDate::from_ymd_opt(asof.0, asof.1, asof.2).unwrap(),
            tickers: vec!["AAA".into(), "BBB".into(), "CCC".into()],
            num,
            text,
        }
    }

    fn req(filter: Vec<Clause>, sort: Option<(&str, SortOrder)>) -> ScanRequest {
        ScanRequest {
            columns: vec!["close".into(), "EMA50".into(), "description".into()],
            filter,
            sort: sort.map(|(f, o)| SortSpec { sort_by: f.into(), sort_order: o }),
            range: (0, 100),
            tickers: None,
        }
    }

    fn clause(left: &str, op: Op, right: Operand) -> Clause {
        Clause { left: left.into(), operation: op, right }
    }

    fn tickers(r: &ScanResult) -> Vec<&str> {
        r.rows.iter().map(|r| r.s.as_str()).collect()
    }

    #[test]
    fn filters_sorts_and_pages() {
        let t = table(None);
        let r = run(&t, &req(vec![clause("close", Op::EGreater, Operand::Num(5.0))], Some(("volume", SortOrder::Desc)))).unwrap();
        assert_eq!(r.total_count, 2);
        assert_eq!(tickers(&r), vec!["AAA", "CCC"]);
        assert_eq!(r.rows[0].d[0], Some(Cell::Num(10.0)));
        assert_eq!(r.rows[0].d[2], Some(Cell::Text("Aaa Inc".into())));
        // No state: state fields are null, never an error.
        assert_eq!(r.rows[0].d[1], None);
        let mut paged = req(vec![], None);
        paged.range = (1, 2);
        let r = run(&t, &paged).unwrap();
        assert_eq!((r.total_count, tickers(&r)), (3, vec!["BBB"]));
    }

    #[test]
    fn state_steps_one_session() {
        // State at Mon 28/09, rows on Tue 29/09: one live step.
        let t = table(Some(state((2026, 9, 28))));
        let r = run(&t, &req(vec![clause("close", Op::EGreater, Operand::Text("EMA50".into()))], None)).unwrap();
        // AAA: EMA50 = 9 + 2/51 * (10 - 9); close 10 >= it. BBB: 5 + 2/51*(4-5) > 4. CCC: no state.
        assert_eq!(tickers(&r), vec!["AAA"]);
        match r.rows[0].d[1] {
            Some(Cell::Num(v)) => assert!((v - (9.0 + 2.0 / 51.0)).abs() < 1e-12),
            ref other => panic!("{other:?}"),
        }
        let sma = Field::parse("SMA5").unwrap();
        assert_eq!(sma.eval(&t, &t.rows[0]), Some(Val::Num((40.0 + 10.0) / 5.0)));
        let cap = Field::parse("market_cap_basic").unwrap();
        assert_eq!(cap.eval(&t, &t.rows[0]), Some(Val::Num(1000.0)));
    }

    #[test]
    fn state_of_the_same_day_is_used_as_is_and_old_state_is_dropped() {
        let t = table(Some(state((2026, 9, 29))));
        let ema = Field::parse("EMA50").unwrap();
        assert_eq!(ema.eval(&t, &t.rows[0]), Some(Val::Num(9.0)));
        let t = table(Some(state((2026, 9, 25))));
        assert_eq!(ema.eval(&t, &t.rows[0]), None);
    }

    #[test]
    fn text_sets_and_percent_bands() {
        let t = table(Some(state((2026, 9, 28))));
        let sectors = Operand::List(vec![Operand::Text("Energy".into()), Operand::Text("Tech".into())]);
        let r = run(&t, &req(vec![clause("sector", Op::InRange, sectors)], None)).unwrap();
        assert_eq!(tickers(&r), vec!["BBB"]);
        // close within 100%..103% of EMA50 (the reference app `in_range%`).
        let band = Operand::List(vec![Operand::Text("EMA50".into()), Operand::Num(1.0), Operand::Num(1.2)]);
        let r = run(&t, &req(vec![clause("close", Op::InRangePct, band)], None)).unwrap();
        assert_eq!(tickers(&r), vec!["AAA"]);
        let r = run(&t, &req(vec![clause("close", Op::InRange, Operand::List(vec![Operand::Num(3.0), Operand::Num(12.0)]))], None)).unwrap();
        assert_eq!(tickers(&r), vec!["AAA", "BBB"]);
    }

    #[test]
    fn text_values_are_distinct_and_sorted() {
        let t = table(Some(state((2026, 9, 28))));
        assert_eq!(crate::screener::fields::text_values(&t, "sector").unwrap(), vec!["Energy", "Finance"]);
        assert!(crate::screener::fields::text_values(&t, "close").is_err());
    }

    #[test]
    fn nulls_sort_last_both_ways() {
        let t = table(Some(state((2026, 9, 28))));
        for order in [SortOrder::Asc, SortOrder::Desc] {
            let r = run(&t, &req(vec![], Some(("EMA50", order)))).unwrap();
            assert_eq!(*tickers(&r).last().unwrap(), "CCC");
        }
    }

    #[test]
    fn unknown_fields_are_errors() {
        let t = table(None);
        assert!(run(&t, &req(vec![clause("nope", Op::Greater, Operand::Num(1.0))], None)).is_err());
    }

    /// Live: the whole market through the gateway, then a scan.
    /// `cargo test screener_live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn screener_live_market_scan() {
        let t0 = std::time::Instant::now();
        let rows = crate::data::massive_rest::fetch_market_snapshot().await.unwrap();
        let fetched = t0.elapsed();
        let n = rows.len();
        let t1 = std::time::Instant::now();
        let t = Table::build(1, rows, Arc::new(Vec::new()), None);
        let built = t1.elapsed();
        let t2 = std::time::Instant::now();
        let r = run(&t, &req(vec![clause("close", Op::EGreater, Operand::Num(5.0))], Some(("volume", SortOrder::Desc)))).unwrap();
        let scanned = t2.elapsed();
        println!("rows {n} fetch {fetched:?} build {built:?} scan {scanned:?} matches {} top {:?}", r.total_count, tickers(&r).iter().take(5).collect::<Vec<_>>());
        assert!(n > 5000);
    }
}

#[cfg(test)]
mod live_step {
    use super::*;
    use crate::screener::fields::Field;
    use crate::screener::state::StateFile;
    use std::sync::Arc;

    /// Env SCREENER_STATE: a state file path, or "gateway" for the live
    /// `/screener/v1/state` (the app's own fetch).
    pub(super) async fn load_state() -> StateFile {
        let src = std::env::var("SCREENER_STATE").unwrap();
        if src == "gateway" {
            return crate::screener::state::fetch().await.unwrap().expect("gateway serves the state");
        }
        serde_json::from_slice(&std::fs::read(src).unwrap()).unwrap()
    }

    /// Live step check: a state file built at D-1 (env SCREENER_STATE) plus the
    /// live snapshot of D, evaluated for the tickers in env SCREENER_TICKERS;
    /// writes a CSV to env SCREENER_OUT for research/screener/code/check_state.py.
    #[tokio::test]
    #[ignore]
    async fn screener_live_step_csv() {
        let state: StateFile =
            load_state().await;
        let tickers: Vec<String> =
            std::env::var("SCREENER_TICKERS").unwrap().split(',').map(|s| s.to_string()).collect();
        let rows = crate::data::massive_rest::fetch_market_snapshot().await.unwrap();
        let t = Table::build(1, rows, Arc::new(Vec::new()), Some(Arc::new(state)));
        let ids: Vec<&str> = crate::screener::fields::catalog(&t)
            .iter()
            .filter(|f| f.kind == "number")
            .map(|f| Box::leak(f.id.clone().into_boxed_str()) as &str)
            .collect();
        let fields: Vec<Field> = ids.iter().map(|i| Field::parse(i).unwrap()).collect();
        let mut out = format!("ticker,join,{}\n", ids.join(","));
        for row in t.rows.iter().filter(|r| tickers.contains(&r.m.ticker)) {
            let vals: Vec<String> = fields
                .iter()
                .map(|f| match f.eval(&t, row) {
                    Some(crate::screener::fields::Val::Num(n)) => format!("{n}"),
                    _ => String::new(),
                })
                .collect();
            out.push_str(&format!("{},{:?},{}\n", row.m.ticker, row.join, vals.join(",")));
        }
        std::fs::write(std::env::var("SCREENER_OUT").unwrap(), out).unwrap();
    }
}

#[cfg(test)]
mod live_popular {
    use super::live_step::load_state;
    use super::*;
    use std::sync::Arc;

    /// The reference app popular screen "Most capitalized" (market cap >= 10 B, sorted by
    /// market cap) on the live table + a state file (env SCREENER_STATE);
    /// tickers to env SCREENER_OUT.
    #[tokio::test]
    #[ignore]
    async fn screener_live_most_capitalized() {
        let state = load_state().await;
        let rows = crate::data::massive_rest::fetch_market_snapshot().await.unwrap();
        let t = Table::build(1, rows, Arc::new(Vec::new()), Some(Arc::new(state)));
        let req = ScanRequest {
            columns: vec!["close".into(), "market_cap_basic".into()],
            filter: vec![Clause {
                left: "market_cap_basic".into(),
                operation: Op::EGreater,
                right: Operand::Num(1e10),
            }],
            sort: Some(SortSpec { sort_by: "market_cap_basic".into(), sort_order: SortOrder::Desc }),
            range: (0, 100000),
            tickers: None,
        };
        let t0 = std::time::Instant::now();
        let r = run(&t, &req).unwrap();
        println!("matches {} in {:?}", r.total_count, t0.elapsed());
        let list: Vec<String> = r.rows.into_iter().map(|r| r.s).collect();
        std::fs::write(std::env::var("SCREENER_OUT").unwrap(), list.join("\n")).unwrap();
    }
}
