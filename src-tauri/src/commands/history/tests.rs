//! Unit tests of the history assembly, and the live checks run by hand.
use super::*;
use super::adjustments::{dividend_steps, scale_by_dividends, scale_by_splits};
use super::archive_join::prepend_archive;
use super::listing::{listing_of, stretch_start, times_inside, Listing, Segment};
use super::symbol_chain::{merge_between, prepend_older};
use crate::data::provider::SymbolChange;
use crate::data::types::{DividendEvent, SplitEvent};
use crate::data::provider::{HistoryProvider, MassiveProvider, ReferenceProvider};

/// The US equities calendar the current provider reports.
fn us() -> SessionCalendar {
    let session = tauri::async_runtime::block_on(MassiveProvider.symbol_session(&SymbolRef::parse("NASDAQ:AAPL"))).unwrap();
    SessionCalendar::new(&session)
}

/// Regression for the sub-minute scroll-back stall: a 1S page (span_days = 1)
/// whose oldest bar sits on a Monday open must still reach back to the prior
/// Friday session, not stop one calendar day back inside the empty weekend.
#[test]
fn before_window_jumps_the_weekend() {
    // 2025-05-12 is a Monday; the prior session is Friday 2025-05-09.
    let mon = NaiveDate::from_ymd_opt(2025, 5, 12).unwrap();
    let fri = NaiveDate::from_ymd_opt(2025, 5, 9).unwrap();
    // span_days = 1 (1S/5S) — the calendar-day window [Sun, Mon] returned an
    // empty older page; the trading-day window must include Friday.
    assert_eq!(aggregates_before_window(&us(), mon, 1), (fri, mon));
    // span_days = 2 (10S/15S) reaches one more session back (Thursday the 8th).
    let thu = NaiveDate::from_ymd_opt(2025, 5, 8).unwrap();
    assert_eq!(aggregates_before_window(&us(), mon, 2), (thu, mon));
}

fn bar(day: i64) -> Candle {
    Candle { time: (day * 86_400) as f64, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1.0 }
}

fn days(bars: &[Candle]) -> Vec<i64> {
    bars.iter().map(|b| b.time as i64 / 86_400).collect()
}

/// Archived sessions go in front of the first live bar; the ones the live
/// series already covers are dropped.
#[test]
fn archive_is_joined_before_the_first_live_bar() {
    let joined = prepend_archive(vec![bar(1003), bar(1004)], (1000..=1004).map(bar).collect(), 0.0, &Listing::default());
    assert_eq!(days(&joined), vec![1000, 1001, 1002, 1003, 1004]);
}

/// A reused symbol: the bars of the earlier listing sit behind a hole of
/// several years, in the archive or between the archive and the live bars.
#[test]
fn archive_stops_at_a_long_hole() {
    let archive: Vec<Candle> = [100, 101, 102, 2000, 2001].into_iter().map(bar).collect();
    assert_eq!(days(&prepend_archive(vec![bar(2002)], archive.clone(), 0.0, &Listing::default())), vec![2000, 2001, 2002]);
    assert_eq!(days(&prepend_archive(vec![bar(5000)], archive, 0.0, &Listing::default())), vec![5000]);
}

/// Bars before the requested start are left out; no archive or no live
/// bars changes nothing.
#[test]
fn archive_respects_the_requested_start() {
    let archive: Vec<Candle> = (1000..=1002).map(bar).collect();
    let from = (1001 * 86_400) as f64;
    assert_eq!(days(&prepend_archive(vec![bar(1003)], archive.clone(), from, &Listing::default())), vec![1001, 1002, 1003]);
    assert_eq!(days(&prepend_archive(vec![bar(1003)], Vec::new(), 0.0, &Listing::default())), vec![1003]);
    assert!(prepend_archive(Vec::new(), archive, 0.0, &Listing::default()).is_empty());
}

/// A symbol used again without a long hole: the bars before the current
/// listing's start are the earlier company's. A listing date after the
/// first live bar is no start of this series and changes nothing.
#[test]
fn archive_starts_at_the_listing_date() {
    let archive: Vec<Candle> = (1000..=1005).map(bar).collect();
    let listed = |d: i64| Listing { listed_sec: Some((d * 86_400) as f64), ..Listing::default() };
    assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listed(1003))), vec![1003, 1004, 1005, 1006]);
    assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listed(900))).len(), 7);
    assert_eq!(days(&prepend_archive(vec![bar(1006)], archive, 0.0, &listed(1010))).len(), 7);
}

fn date(day: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp(day * 86_400, 0).unwrap().date_naive()
}

fn change(day: i64, ticker: &str) -> SymbolChange {
    SymbolChange { date: date(day), ticker: ticker.into() }
}

fn segment(ticker: &str, start: i64, end: i64) -> Segment {
    Segment { ticker: ticker.into(), start_sec: (start * 86_400) as f64, end_sec: (end * 86_400) as f64 }
}

/// Every older entry of the symbol history is one earlier symbol, from
/// its date to the next entry's; none when the company never moved here
/// from another symbol.
#[test]
fn earlier_symbols_follow_the_symbol_history() {
    let listing = Listing::new("C", None, &[change(1200, "C"), change(1100, "B"), change(1000, "A")]);
    assert_eq!(listing.earlier, vec![segment("B", 1100, 1200), segment("A", 1000, 1100)]);
    assert!(Listing::new("GSL", None, &[change(1004, "GSL")]).earlier.is_empty());
    assert!(Listing::new("TLF", None, &[change(1500, "TLFA"), change(900, "TLF")]).earlier.is_empty());
}

/// An entry with another symbol that is newer than the oldest entry of
/// the symbol is a stretch in between: to the next entry, or without an
/// end when the history does not hold the return.
#[test]
fn symbols_in_between_follow_the_symbol_history() {
    let open = |ticker: &str, start: i64| Segment { ticker: ticker.into(), start_sec: (start * 86_400) as f64, end_sec: f64::MAX };
    let listing = Listing::new("FISV", None, &[change(1500, "FI"), change(900, "FISV")]);
    assert_eq!((listing.between, listing.taken_sec), (vec![open("FI", 1500)], None));
    let listing = Listing::new("ABC", None, &[change(1004, "ABC"), change(1002, "XYZ"), change(900, "ABC")]);
    assert_eq!(listing.between, vec![segment("XYZ", 1002, 1004)]);
    let listing = Listing::new("C", None, &[change(1300, "E"), change(1250, "D"), change(1200, "C"), change(1100, "B")]);
    assert_eq!(listing.between, vec![open("E", 1300), segment("D", 1250, 1300)]);
    assert_eq!(listing.earlier, vec![segment("B", 1100, 1200)]);
    assert!(Listing::new("META", None, &[change(1008, "META"), change(900, "FB")]).between.is_empty());
    assert!(Listing::new("GOOGL", None, &[change(1004, "GOOG")]).between.is_empty());
}

/// Bars of a symbol used in between go into the hole of the series (in
/// front of it when the window starts inside the hole), never over one
/// of its bars.
#[test]
fn bars_in_between_fill_the_hole() {
    let series: Vec<Candle> = [1000, 1001, 1005, 1006].into_iter().map(bar).collect();
    let mut other = bar(1001);
    other.close = 9.0;
    let between = vec![bar(999), other, bar(1002), bar(1003), bar(1004)];
    let merged = merge_between(series.clone(), between.clone());
    assert_eq!(days(&merged), vec![999, 1000, 1001, 1002, 1003, 1004, 1005, 1006]);
    assert_eq!(merged[2].close, 1.0);
    assert_eq!(days(&merge_between(series, Vec::new())).len(), 4);
    assert_eq!(days(&merge_between(Vec::new(), between)).len(), 5);
    assert_eq!(times_inside(&merged, (1001 * 86_400) as f64, (1004 * 86_400) as f64), Some(((1001 * 86_400) as f64, (1003 * 86_400) as f64)));
    assert_eq!(times_inside(&merged, (2000 * 86_400) as f64, (2004 * 86_400) as f64), None);
}

/// The oldest earlier symbol starts where its own bars do: back from the
/// change to the first long hole (an earlier user of that symbol).
#[test]
fn stretch_starts_after_the_last_long_hole() {
    let bars: Vec<Candle> = [100, 101, 1000, 1001, 1002, 1500].into_iter().map(bar).collect();
    assert_eq!(stretch_start(&bars, (1003 * 86_400) as f64), (1000 * 86_400) as f64);
    assert_eq!(stretch_start(&bars, (102 * 86_400) as f64), (100 * 86_400) as f64);
    assert_eq!(stretch_start(&bars, (50 * 86_400) as f64), (50 * 86_400) as f64);
}

/// Earlier-symbol bars go in front of the series and never over it.
#[test]
fn older_bars_end_before_the_series() {
    let older: Vec<Candle> = (1000..=1004).map(bar).collect();
    assert_eq!(days(&prepend_older(vec![bar(1003), bar(1005)], older.clone())), vec![1000, 1001, 1002, 1003, 1005]);
    assert_eq!(days(&prepend_older(Vec::new(), older)).len(), 5);
}

/// Unadjusted bars are scaled by the splits executed after their session
/// (the execution day itself trades on the new scale).
#[test]
fn earlier_bars_are_scaled_by_later_splits() {
    let cal = us();
    // 16:00 UTC of 16/05 and 17/05/2017, a 2:1 split executed on the 17th.
    let at = |d: u32| NaiveDate::from_ymd_opt(2017, 5, d).unwrap().and_hms_opt(16, 0, 0).unwrap().and_utc().timestamp() as f64;
    let candle = |time: f64| Candle { time, open: 80.0, high: 82.0, low: 78.0, close: 80.0, volume: 100.0 };
    let mut bars = vec![candle(at(16)), candle(at(17))];
    let split = SplitEvent { date: midnight(NaiveDate::from_ymd_opt(2017, 5, 17).unwrap()).unwrap(), from: 1.0, to: 2.0 };
    scale_by_splits(&mut bars, &[split], &cal);
    assert_eq!((bars[0].close, bars[0].high, bars[0].volume), (40.0, 41.0, 200.0));
    assert_eq!((bars[1].close, bars[1].volume), (80.0, 100.0));
}

/// A dividend lowers the bars before its ex-dividend date by
/// `1 - amount / previous close`; an amount declared before a split is
/// put on the split-adjusted scale first; volume is not changed.
#[test]
fn bars_before_an_ex_date_are_scaled_by_the_dividend() {
    let cal = us();
    // 04:00 UTC (midnight New York) of 10/06 to 12/06/2024.
    let at = |d: u32| NaiveDate::from_ymd_opt(2024, 6, d).unwrap().and_hms_opt(4, 0, 0).unwrap().and_utc().timestamp() as f64;
    let candle = |time: f64, close: f64| Candle { time, open: close, high: close, low: close, close, volume: 100.0 };
    let daily = vec![candle(at(10), 100.0), candle(at(11), 101.0), candle(at(12), 102.0)];
    let ex = |d: u32| midnight(NaiveDate::from_ymd_opt(2024, 6, d).unwrap()).unwrap();
    // 1.00 on the 11th; 5.00 declared before a 10:1 split of the 12th (0.50 on the adjusted scale).
    let dividends =
        vec![DividendEvent { date: ex(12), amount: 5.0 }, DividendEvent { date: ex(11), amount: 1.0 }, DividendEvent { date: ex(10), amount: 1.0 }];
    let splits = vec![SplitEvent { date: ex(13), from: 1.0, to: 10.0 }];
    let steps = dividend_steps(&daily, &dividends, &splits, &cal);
    // No session before the 10th: that dividend has no factor.
    assert_eq!(steps.len(), 2);
    assert!((steps[0].1 - (1.0 - 0.5 / 101.0)).abs() < 1e-12 && (steps[1].1 - (1.0 - 0.1 / 100.0)).abs() < 1e-12);
    let mut bars = daily.clone();
    scale_by_dividends(&mut bars, &steps, &cal);
    assert!((bars[0].close - 100.0 * steps[0].1 * steps[1].1).abs() < 1e-9);
    assert!((bars[1].close - 101.0 * steps[0].1).abs() < 1e-9);
    assert_eq!((bars[2].close, bars[0].volume), (102.0, 100.0));
}

/// The daily series with and without the dividend adjustment (network),
/// written as `time,close,adjusted_close` to `OT_OUT/<ticker>.csv` for
/// the tickers of `OT_TICKERS`. Run with:
///   cargo test --lib dividend_adjust_live -- --nocapture --ignored
#[tokio::test]
#[ignore = "hits the gateway; run explicitly"]
async fn dividend_adjust_live() {
    let provider: Provider = Arc::new(MassiveProvider);
    let out = std::env::var("OT_OUT").unwrap();
    for t in std::env::var("OT_TICKERS").unwrap_or_else(|_| "NASDAQ:NFLX,NASDAQ:NVDA,NASDAQ:AAPL,NYSE:KO".into()).split(',') {
        let sym = SymbolRef::parse(t);
        let cal = SessionCalendar::new(&provider.symbol_session(&sym).await.unwrap());
        let plain = daily_series(&provider, &cal, &sym, DIVIDEND_BASIS_DAYS).await.unwrap();
        let adjusted = with_dividends(&provider, &cal, &sym, (*plain).clone(), true).await.unwrap();
        let biggest = plain.windows(2).map(|w| (w[1].close / w[0].close - 1.0).abs()).fold(0.0_f64, f64::max);
        eprintln!(
            "{t}: {} bars, first close {:.4} (with dividends {:.4}), largest daily close move {:.1}%",
            plain.len(), plain[0].close, adjusted[0].close, biggest * 100.0
        );
        let rows: Vec<String> =
            plain.iter().zip(&adjusted).map(|(p, a)| format!("{},{},{},{}", p.time, p.close, a.close, a.volume - p.volume)).collect();
        std::fs::write(format!("{out}/ot-{}.csv", sym.ticker), rows.join("\n")).unwrap();
    }
}

/// A company delisted for more than a year and listed again under its
/// symbol: it held the symbol before the hole, so the hole is no cut. A
/// hole before the company took the symbol still is.
#[test]
fn archive_keeps_a_relisted_company_across_the_hole() {
    let archive: Vec<Candle> = [100, 101, 1000, 1001, 2000, 2001].into_iter().map(bar).collect();
    // TLF shape: the symbol since day 900, another symbol in between.
    let listing = Listing::new("TLF", None, &[change(1500, "TLFA"), change(900, "TLF")]);
    assert_eq!(listing.taken_sec, None);
    assert_eq!(days(&prepend_archive(vec![bar(2002)], archive.clone(), 0.0, &listing)), vec![1000, 1001, 2000, 2001, 2002]);
    // GHC shape: the only entry is the end of the hole.
    let listing = Listing::new("GHC", None, &[change(2000, "GHC")]);
    assert_eq!(days(&prepend_archive(vec![bar(2002)], archive, 0.0, &listing)), vec![2000, 2001, 2002]);
}

/// A company that moved to the symbol from another one: the bars before
/// that date are another company's, with or without a hole. A lone
/// entry is no start (its date can be years after the first bar).
#[test]
fn archive_starts_where_the_company_took_the_symbol() {
    let archive: Vec<Candle> = (1000..=1005).map(bar).collect();
    // WEX shape: WXS, then WEX on day 1003.
    let listing = Listing::new("WEX", Some(date(950)), &[change(1003, "WEX"), change(990, "WXS")]);
    assert_eq!(listing.taken_sec, Some((1003 * 86_400) as f64));
    assert_eq!(listing.earlier, vec![segment("WXS", 990, 1003)]);
    assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listing)), vec![1003, 1004, 1005, 1006]);
    // META shape: the symbol taken inside the live window; the live bars
    // before that date go too.
    let live: Vec<Candle> = (1006..=1009).map(bar).collect();
    let listing = Listing::new("META", None, &[change(1008, "META"), change(900, "FB")]);
    let cut = prepend_archive(live, archive.clone(), 0.0, &listing);
    assert_eq!(days(&cut), vec![1008, 1009]);
    // Its own bars under the earlier symbol then go in front.
    assert_eq!(days(&prepend_older(cut, vec![bar(1006), bar(1007)])), vec![1006, 1007, 1008, 1009]);
    // GSL shape: one entry, later than the first bar.
    let listing = Listing::new("GSL", None, &[change(1004, "GSL")]);
    assert_eq!(listing.taken_sec, None);
    assert_eq!(days(&prepend_archive(vec![bar(1006)], archive.clone(), 0.0, &listing)).len(), 7);
    // Back to a symbol it held before: the first time counts.
    let listing = Listing::new("ABC", None, &[change(1004, "ABC"), change(1002, "XYZ"), change(900, "ABC")]);
    assert_eq!(listing.taken_sec, None);
    // Entries under other symbols only (GOOGL has `GOOG`): nothing known.
    assert_eq!(Listing::new("GOOGL", None, &[change(1004, "GOOG")]), Listing::default());
    assert_eq!(days(&prepend_archive(vec![bar(1006)], archive, 0.0, &Listing::default())).len(), 7);
}

/// Mid-week the window is just the prior `span_days` sessions — no surprises.
#[test]
fn before_window_midweek() {
    // 2025-05-14 Wed → span 1 reaches Tuesday the 13th.
    let wed = NaiveDate::from_ymd_opt(2025, 5, 14).unwrap();
    let tue = NaiveDate::from_ymd_opt(2025, 5, 13).unwrap();
    assert_eq!(aggregates_before_window(&us(), wed, 1), (tue, wed));
}

/// The real join on AAPL (network): the series starts on 10/09/2003, the
/// archived bars sit on the scale of the adjusted live bars where the two
/// overlap, and no split date or the join leaves a step. A ticker without
/// an archive yields no archived bars. Run with:
///   cargo test --lib daily_archive_join_live -- --nocapture --ignored
#[tokio::test]
#[ignore = "hits the gateway; run explicitly"]
async fn daily_archive_join_live() {
    let provider = MassiveProvider;
    let sym = SymbolRef::parse("NASDAQ:AAPL");
    let cal = SessionCalendar::new(&provider.symbol_session(&sym).await.unwrap());
    let to = cal.window_end();
    let from = clamp_to_floor(BarFamily::Day, *cal.last_trading_days(7560).first().unwrap(), to)
        .await
        .unwrap()
        .0;
    let live = provider.daily_aggs(&sym, from, to, true).await.unwrap();
    let t0 = std::time::Instant::now();
    let archive = provider.daily_archive(&sym, true).await.unwrap();
    let cold_ms = t0.elapsed().as_millis();
    let t1 = std::time::Instant::now();
    provider.daily_archive(&sym, true).await.unwrap();
    eprintln!("archive: {} bars, first read {cold_ms} ms, memo {} us", archive.len(), t1.elapsed().as_micros());

    // Overlap: archived bars of sessions the live series also has.
    let by_time: HashMap<i64, &Candle> = live.iter().map(|b| (b.time as i64, b)).collect();
    let (mut common, mut worst, mut off) = (0, 0.0_f64, 0);
    for a in &archive {
        if let Some(l) = by_time.get(&(a.time as i64)) {
            common += 1;
            let diff = (a.close / l.close - 1.0).abs();
            worst = worst.max(diff);
            if diff > 0.005 {
                off += 1;
            }
        }
    }
    eprintln!("overlap: {common} sessions, closes off by more than 0.5%: {off}, worst {:.4}%", worst * 100.0);
    assert!(common > 1000 && off == 0);

    let joined = prepend_archive(live.clone(), archive, 0.0, &Listing::default());
    let first = joined.first().unwrap();
    eprintln!(
        "joined: {} bars ({} live from {:?}), first {:?} close {:.4} volume {:.0}",
        joined.len(), live.len(), cal.date_of(live[0].time as i64), cal.date_of(first.time as i64), first.close, first.volume,
    );
    assert_eq!(cal.date_of(first.time as i64), NaiveDate::from_ymd_opt(2003, 9, 10));
    assert!(joined.windows(2).all(|w| w[0].time < w[1].time), "times not strictly ascending");
    // Largest close-to-close move: a missed split would show as 50% or more.
    let (mut big, mut at) = (0.0_f64, 0.0);
    for w in joined.windows(2) {
        let m = (w[1].close / w[0].close - 1.0).abs();
        if m > big {
            (big, at) = (m, w[1].time);
        }
    }
    eprintln!("largest daily close move: {:.2}% on {:?}", big * 100.0, cal.date_of(at as i64));
    assert!(big < 0.35);
    for (y, m, d) in [(2005, 2, 28), (2014, 6, 9), (2020, 8, 31)] {
        let day = NaiveDate::from_ymd_opt(y, m, d);
        let i = joined.iter().position(|b| cal.date_of(b.time as i64) == day).unwrap();
        eprintln!("split {day:?}: close before {:.4}, on the day {:.4}", joined[i - 1].close, joined[i].close);
    }
    let join = joined.iter().position(|b| b.time == live[0].time).unwrap();
    eprintln!("join: {:.4} -> {:.4}", joined[join - 1].close, joined[join].close);

    let raw = provider.daily_archive(&sym, false).await.unwrap();
    assert_eq!((raw[0].close, raw[0].volume), (22.18, 3_957_751.0));
    let none = provider.daily_archive(&SymbolRef::parse("ZZZZQQ"), true).await.unwrap();
    assert!(none.is_empty());
}

/// Where the daily series of each ticker of `OT_TICKERS` (comma list,
/// source spelling) starts, with the listing date alone and with the
/// symbol history (network). Prints the tickers whose start differs. Run with:
///   OT_TICKERS=TLF,WEX,GHC cargo test --lib archive_start_live -- --nocapture --ignored
#[tokio::test]
#[ignore = "hits the gateway; run explicitly"]
async fn archive_start_live() {
    use crate::data::{daily_archive, massive_rest, ticker_case};
    use futures_util::stream::{self, StreamExt};
    let tickers: Vec<String> =
        std::env::var("OT_TICKERS").unwrap_or_else(|_| "TLF,WEX,GHC,META,GSL,AAPL".into()).split(',').map(str::to_string).collect();
    let to = crate::data::trading_calendar::ny_today();
    let from = clamp_to_floor(BarFamily::Day, to - Duration::days(30 * 366), to).await.unwrap().0;
    let day = |sec: f64| chrono::DateTime::from_timestamp(sec as i64, 0).unwrap().date_naive();
    let rows: Vec<String> = stream::iter(tickers)
        .map(|t| async move {
            let live = massive_rest::fetch_daily_aggs(&t, from, to, true).await.unwrap_or_default();
            let archive = daily_archive::daily_bars(&t, true).await.unwrap_or_default();
            if live.is_empty() || archive.is_empty() {
                return format!("{t},,,,no live bars or no archive");
            }
            let sym = SymbolRef::parse(&ticker_case::to_app(&t));
            let listed = MassiveProvider.listing_date(&sym).await;
            let Some(changes) = MassiveProvider.symbol_changes(&sym).await else {
                return format!("{t},,,,symbol history not read");
            };
            let listing = listing_of(&MassiveProvider, &sym).await;
            let before = prepend_archive(live.clone(), archive.clone(), 0.0, &Listing::new(&sym.ticker, listed, &[]));
            let after = prepend_archive(live.clone(), archive, 0.0, &listing);
            let named = Listing::new(&sym.ticker, listed, &changes).taken_sec.is_some();
            let dropped = if named && listing.taken_sec.is_none() { " (move not proven, ignored)" } else { "" };
            let history = changes.iter().map(|c| format!("{} {}", c.ticker, c.date)).collect::<Vec<_>>().join(" < ") + dropped;
            format!("{t},{},{},{},{history}", day(before[0].time), day(after[0].time), day(live[0].time))
        })
        .buffered(8)
        .collect()
        .await;
    let mut changed = 0;
    for r in &rows {
        let f: Vec<&str> = r.splitn(5, ',').collect();
        if f[1] != f[2] {
            changed += 1;
            eprintln!("CHANGED {r}");
        }
    }
    eprintln!("{} tickers, start changed for {changed}", rows.len());
    if let Ok(out) = std::env::var("OT_OUT") {
        std::fs::write(out, format!("ticker,start_listing_date_only,start_with_symbol_history,first_live_bar,symbol_history
{}
", rows.join("
"))).unwrap();
    }
}

/// The series across a symbol change (network), for each ticker of
/// `OT_TICKERS`: where the daily series starts, the closes on both sides
/// of the change, the largest daily close move, and the 5-minute bars of
/// the 20 sessions around the change (which symbols they come from is
/// told by the count per side). Run with:
///   OT_TICKERS=META,T,WEX cargo test --lib symbol_chain_live -- --nocapture --ignored
#[tokio::test]
#[ignore = "hits the gateway; run explicitly"]
async fn symbol_chain_live() {
    let provider: Provider = Arc::new(MassiveProvider);
    let cal = SessionCalendar::new(&provider.symbol_session(&SymbolRef::parse("NASDAQ:AAPL")).await.unwrap());
    let to = cal.window_end();
    let wanted_from = *cal.last_trading_days(7560).first().unwrap();
    let from = clamp_to_floor(BarFamily::Day, wanted_from, to).await.unwrap().0;
    // No entitlement store in a test: the oldest minute bar is probed.
    let probe = provider.probe_history().await.unwrap();
    let minute_floor = NaiveDate::parse_from_str(&probe.floor.minute.unwrap(), "%Y-%m-%d").unwrap();
    let tickers = std::env::var("OT_TICKERS").unwrap_or_else(|_| "META,T,WEX,BALL,ELV,COR,KELYA,AAPL,TLF,GHC".into());
    let mut rows = vec!["ticker,earlier_symbols,bars,first_bar,first_close,last_before_change,close_before,first_after_change,open_after,largest_close_move_pct,largest_move_date,minute_bars_before,minute_bars_after,complete".to_string()];
    for t in tickers.split(',') {
        let sym = SymbolRef::parse(t);
        let listing = listing_of(provider.as_ref(), &sym).await;
        let (bars, complete) = joined_daily(&provider, &cal, &sym, wanted_from, from, to, true).await.unwrap();
        assert!(bars.windows(2).all(|w| w[0].time < w[1].time), "{t}: times not strictly ascending");
        let day = |b: &Candle| cal.date_of(b.time as i64).unwrap().format("%d/%m/%Y").to_string();
        let (mut big, mut at) = (0.0_f64, String::new());
        for w in bars.windows(2) {
            let m = (w[1].close / w[0].close - 1.0).abs();
            if m > big {
                (big, at) = (m, day(&w[1]));
            }
        }
        let earlier = listing.earlier.iter().map(|s| format!("{} {:?}..{:?}", s.ticker, day_of(s.start_sec), day_of(s.end_sec))).collect::<Vec<_>>().join(" | ");
        for s in &listing.between {
            let (start, end) = (day_of(s.start_sec).unwrap(), day_of(s.end_sec).unwrap());
            let (i, j) = (bars.iter().position(|b| cal.date_of(b.time as i64).unwrap() >= start).unwrap(), bars.iter().position(|b| cal.date_of(b.time as i64).unwrap() >= end).unwrap());
            eprintln!(
                "{t}: in between {} {start}..{end}: {} daily bars inside; {} close {:.4} -> {} open {:.4}; {} close {:.4} -> {} open {:.4}",
                s.ticker, j - i, day(&bars[i - 1]), bars[i - 1].close, day(&bars[i]), bars[i].open, day(&bars[j - 1]), bars[j - 1].close, day(&bars[j]), bars[j].open,
            );
            if end - Duration::days(30) >= minute_floor {
                let m = chained_aggs(&provider, &cal, &sym, Span::MinuteChunked(5), end - Duration::days(30), end + Duration::days(13), true, false).await.unwrap();
                assert!(m.windows(2).all(|w| w[0].time < w[1].time), "{t}: minute times not strictly ascending");
                let n = m.iter().filter(|c| cal.date_of(c.time as i64).unwrap() < end).count();
                let lows = m.iter().take(n).map(|c| c.low).fold(f64::MAX, f64::min);
                let highs = m.iter().take(n).map(|c| c.high).fold(f64::MIN, f64::max);
                eprintln!("{t}: 5-minute bars of the 30 days before {end}: {n} (low {lows:.2}, high {highs:.2}), after: {}", m.len() - n);
            }
        }
        let (mut before, mut after, mut minutes) = ((String::new(), 0.0), (String::new(), 0.0), (0, 0));
        if let Some(taken) = listing.taken_sec {
            let i = bars.iter().position(|b| b.time >= taken).unwrap();
            if i > 0 {
                before = (day(&bars[i - 1]), bars[i - 1].close);
            }
            after = (day(&bars[i]), bars[i].open);
            let taken_day = day_of(taken).unwrap();
            let a = *cal.trading_days_before(taken_day, 11).first().unwrap();
            let b = taken_day + Duration::days(13);
            if a >= minute_floor {
                let m = chained_aggs(&provider, &cal, &sym, Span::MinuteChunked(5), a, b, true, false).await.unwrap();
                assert!(m.windows(2).all(|w| w[0].time < w[1].time), "{t}: minute times not strictly ascending");
                let n = m.iter().filter(|c| cal.date_of(c.time as i64).unwrap() < taken_day).count();
                minutes = (n, m.len() - n);
            }
        }
        let row = format!(
            "{t},{earlier},{},{},{:.4},{},{:.4},{},{:.4},{:.2},{at},{},{},{complete}",
            bars.len(), day(&bars[0]), bars[0].close, before.0, before.1, after.0, after.1, big * 100.0, minutes.0, minutes.1,
        );
        eprintln!("{row}");
        rows.push(row);
    }
    if let Ok(out) = std::env::var("OT_OUT") {
        std::fs::write(out, rows.join("\n") + "\n").unwrap();
    }
}

/// Exercises the real daily-load path against the on-disk cache (no network
/// for the cached recent window). Prints cold vs warm timing so we can see
/// the per-session REST cache actually take effect, and asserts the series
/// is non-empty and ends at a recent (2026) bar. Calls the provider directly
/// (the command needs injected `State`, unavailable in a unit test); this
/// still exercises the per-session REST disk cache for the cold/warm split.
/// Run with:
///   cargo test --lib daily_load_smoke -- --nocapture --ignored
#[tokio::test]
#[ignore = "hits the real REST aggregate cache; run explicitly"]
async fn daily_load_smoke() {
    // Through the gateway; build.rs compiles the token in from ../.env.
    assert!(
        crate::data::gateway::token().is_some(),
        "{}",
        crate::data::gateway::NO_TOKEN
    );

    let provider = MassiveProvider;
    let cal = us();
    let to = cal.window_end();
    let from = *cal.last_trading_days(252).first().unwrap_or(&to);

    for sym in ["AMD", "NVDA", "TSLA"] {
        let t0 = std::time::Instant::now();
        let bars = provider
            .daily_aggs(&SymbolRef::parse(sym), from, to, true)
            .await
            .unwrap_or_else(|e| panic!("{sym} daily load failed: {e}"));
        let cold_ms = t0.elapsed().as_millis();
        assert!(!bars.is_empty(), "{sym} returned ZERO bars");
        let last = bars.last().unwrap();

        let t1 = std::time::Instant::now();
        let warm = provider.daily_aggs(&SymbolRef::parse(sym), from, to, true).await.unwrap();
        let warm_ms = t1.elapsed().as_millis();

        eprintln!(
            "{sym}: {} bars | cold {cold_ms}ms -> warm {warm_ms}ms | last t={} close={}",
            bars.len(), last.time as i64, last.close,
        );
        assert_eq!(bars.len(), warm.len(), "{sym} cold/warm length mismatch");
        // unix seconds for 2026-01-01 = 1_767_225_600 — guards against a stale window.
        assert!((last.time as i64) >= 1_767_225_600, "{sym} newest bar is stale");
    }
}
