/*
 * New York session clock for the screener.
 *
 * The daily state file is stamped with the New York date of its last close
 * (`asof`). Joining it with the live snapshot needs the New York date of
 * each snapshot row, so UTC stamps are mapped to America/New_York with the
 * US DST rule in force since 2007 (second Sunday of March 02:00 local to
 * first Sunday of November 02:00 local).
 */
use crate::data::trading_calendar;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};

fn nth_sunday(year: i32, month: u32, n: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month start");
    let offset = (7 - first.weekday().num_days_from_sunday()) % 7;
    first + Duration::days((offset + (n - 1) * 7) as i64)
}

/// UTC offset of New York at `utc`, in hours (-4 in summer time, -5 else).
pub fn ny_offset_hours(utc: DateTime<Utc>) -> i64 {
    let year = utc.year();
    // DST starts 02:00 EST (07:00 UTC) and ends 02:00 EDT (06:00 UTC).
    let start = Utc
        .from_utc_datetime(&nth_sunday(year, 3, 2).and_hms_opt(7, 0, 0).expect("valid time"));
    let end = Utc
        .from_utc_datetime(&nth_sunday(year, 11, 1).and_hms_opt(6, 0, 0).expect("valid time"));
    if utc >= start && utc < end {
        -4
    } else {
        -5
    }
}

/// New York calendar date of a UNIX-milliseconds stamp.
pub fn ny_date_ms(ms: f64) -> Option<NaiveDate> {
    let utc = DateTime::<Utc>::from_timestamp_millis(ms as i64)?;
    Some((utc + Duration::hours(ny_offset_hours(utc))).date_naive())
}

/// The trading day before `date`.
pub fn prev_trading_day(date: NaiveDate) -> Option<NaiveDate> {
    trading_calendar::trading_days_before(date - Duration::days(1), 1).first().copied()
}

/// The last trading day on or before `date`.
pub fn trading_day_on_or_before(date: NaiveDate) -> Option<NaiveDate> {
    trading_calendar::trading_days_before(date, 1).first().copied()
}

/// The last regular session that has closed at `utc` (16:00 New York).
pub fn last_closed_session(utc: DateTime<Utc>) -> Option<NaiveDate> {
    let local = utc + Duration::hours(ny_offset_hours(utc));
    let today = local.date_naive();
    let on_or_before = trading_day_on_or_before(today)?;
    if on_or_before == today && local.time() < chrono::NaiveTime::from_hms_opt(16, 0, 0)? {
        prev_trading_day(today)
    } else {
        Some(on_or_before)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.from_utc_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap())
    }

    #[test]
    fn dst_boundaries_2026() {
        // 2026: DST from Sun 08/03 07:00 UTC to Sun 01/11 06:00 UTC.
        assert_eq!(ny_offset_hours(utc(2026, 3, 8, 6, 59)), -5);
        assert_eq!(ny_offset_hours(utc(2026, 3, 8, 7, 0)), -4);
        assert_eq!(ny_offset_hours(utc(2026, 11, 1, 5, 59)), -4);
        assert_eq!(ny_offset_hours(utc(2026, 11, 1, 6, 0)), -5);
    }

    #[test]
    fn ny_date_crosses_midnight() {
        // 29/09/2026 02:30 UTC is 28/09 22:30 in New York.
        let ms = utc(2026, 9, 29, 2, 30).timestamp_millis() as f64;
        assert_eq!(ny_date_ms(ms), NaiveDate::from_ymd_opt(2026, 9, 28));
    }

    #[test]
    fn last_closed_session_flips_at_the_close() {
        // Tue 29/09/2026: 19:59 UTC = 15:59 NY -> Mon 28; 20:00 UTC -> Tue 29.
        assert_eq!(last_closed_session(utc(2026, 9, 29, 19, 59)), NaiveDate::from_ymd_opt(2026, 9, 28));
        assert_eq!(last_closed_session(utc(2026, 9, 29, 20, 0)), NaiveDate::from_ymd_opt(2026, 9, 29));
        // Sun 27/09/2026 -> Fri 25.
        assert_eq!(last_closed_session(utc(2026, 9, 27, 15, 0)), NaiveDate::from_ymd_opt(2026, 9, 25));
    }

    #[test]
    fn previous_trading_day_skips_weekend() {
        let mon = NaiveDate::from_ymd_opt(2026, 9, 28).unwrap();
        assert_eq!(prev_trading_day(mon), NaiveDate::from_ymd_opt(2026, 9, 25));
    }
}
