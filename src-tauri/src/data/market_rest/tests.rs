//! Unit tests of the disk cache sentinels and the split epoch.
use super::*;
use super::cache::empty_sentinel_days;
use super::corporate_actions::epoch_of;

fn c(time: i64, close: f64, volume: f64) -> Candle {
    Candle { time: time as f64, open: close, high: close, low: close, close, volume }
}

/// Candle dated `y-m-d` at 14:30 UTC (≈ US market open, so `bar_date` reads
/// the intended calendar day unambiguously).
fn cd(y: i32, m: u32, d: u32) -> Candle {
    let t = NaiveDate::from_ymd_opt(y, m, d)
        .unwrap()
        .and_hms_opt(14, 30, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    c(t, 10.0, 100.0)
}

fn nd(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

#[test]
fn sentinels_interior_no_trade_days_when_not_truncated() {
    // 2024-12-23 Mon … 27 Fri (25th Christmas closed → trading days 23,24,26,27).
    // Bars only on 23 and 27; 24 and 26 are genuine no-trade days.
    let bars = vec![cd(2024, 12, 23), cd(2024, 12, 27)];
    let got = empty_sentinel_days(&bars, nd(2024, 12, 23), nd(2024, 12, 27), false, nd(2025, 1, 2));
    assert_eq!(got, vec![nd(2024, 12, 24), nd(2024, 12, 26)]);
}

#[test]
fn truncated_does_not_sentinel_before_oldest_bar() {
    // Truncated: floor = oldest returned (24th). 23rd is ambiguous (could be
    // dropped) → not sentineled; the interior 26th is.
    let bars = vec![cd(2024, 12, 24), cd(2024, 12, 27)];
    let got = empty_sentinel_days(&bars, nd(2024, 12, 23), nd(2024, 12, 27), true, nd(2025, 1, 2));
    assert_eq!(got, vec![nd(2024, 12, 26)]);
}

#[test]
fn empty_response_yields_no_sentinels() {
    assert!(empty_sentinel_days(&[], nd(2024, 12, 23), nd(2024, 12, 27), false, nd(2025, 1, 2)).is_empty());
}

#[test]
fn today_and_later_are_never_sentineled() {
    // Range reaches today (26th). 24th is a closed no-trade day → sentineled;
    // 26th (== today, the mutable live tail) must not be.
    let bars = vec![cd(2024, 12, 23)];
    let got = empty_sentinel_days(&bars, nd(2024, 12, 23), nd(2024, 12, 26), false, nd(2024, 12, 26));
    assert_eq!(got, vec![nd(2024, 12, 24)]);
}

#[test]
fn epoch_is_newest_split_or_none() {
    assert_eq!(epoch_of(&[]), "none");
    // fetch_splits returns newest-first, so the first entry is the epoch.
    let splits = vec![
        Split { execution_date: NaiveDate::from_ymd_opt(2022, 1, 3).unwrap(), from: 1.0, to: 1.0 },
        Split { execution_date: NaiveDate::from_ymd_opt(2018, 6, 1).unwrap(), from: 1.0, to: 1.0 },
    ];
    assert_eq!(epoch_of(&splits), "2022-01-03");
}
