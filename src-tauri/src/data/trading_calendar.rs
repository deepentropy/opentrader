/*
 * US-equities trading calendar — computed.
 *
 * Walks back from today, skipping weekends + the NYSE/NASDAQ full-close
 * holidays, COMPUTED for any year from the exchange rules (no more hardcoded
 * table that expires): New Year's, MLK Day (3rd Mon Jan), Presidents Day
 * (3rd Mon Feb), Good Friday (Easter − 2, Gregorian computus), Memorial Day
 * (last Mon May), Juneteenth (Jun 19, observed by NYSE from 2022), Independence
 * Day (Jul 4), Labor Day (1st Mon Sep), Thanksgiving (4th Thu Nov), and
 * Christmas (Dec 25). Saturday holidays are observed the preceding Friday
 * (except New Year's — a Dec 31 close would land in the prior year, so NYSE
 * skips the makeup, e.g. 2022) and Sunday holidays the following Monday.
 *
 * One-off full closes (e.g. presidential funerals) are not modelled: a missed
 * close is harmless — that date's fetch simply returns no bars and the empty
 * sentinel takes over — so the calendar is an optimization, not a correctness
 * requirement.
 */
use chrono::{Datelike, Duration, NaiveDate, Utc, Weekday};
use std::collections::HashSet;

/// `n`-th (1-based) `weekday` of a month.
fn nth_weekday(year: i32, month: u32, weekday: Weekday, n: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month start");
    let offset = (7 + weekday.num_days_from_monday() - first.weekday().num_days_from_monday()) % 7;
    first + Duration::days((offset + (n - 1) * 7) as i64)
}

/// Last `weekday` of a month.
fn last_weekday(year: i32, month: u32, weekday: Weekday) -> NaiveDate {
    let next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .expect("valid next month");
    let last = next_month - Duration::days(1);
    let back = (7 + last.weekday().num_days_from_monday() - weekday.num_days_from_monday()) % 7;
    last - Duration::days(back as i64)
}

/// Easter Sunday (Gregorian) via the anonymous computus.
fn easter(year: i32) -> NaiveDate {
    let y = year;
    let a = y % 19;
    let b = y / 100;
    let c = y % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = ((h + l - 7 * m + 114) % 31) + 1;
    NaiveDate::from_ymd_opt(y, month as u32, day as u32).expect("computus yields a valid date")
}

/// Weekend-observance shift: Sunday holidays close the market Monday, Saturday
/// holidays the preceding Friday. `None` when the Saturday shift is skipped
/// (New Year's Day — the Friday makeup would fall in the prior year).
fn observed(date: NaiveDate, skip_saturday: bool) -> Option<NaiveDate> {
    match date.weekday() {
        Weekday::Sun => Some(date + Duration::days(1)),
        Weekday::Sat if skip_saturday => None,
        Weekday::Sat => Some(date - Duration::days(1)),
        _ => Some(date),
    }
}

/// NYSE/NASDAQ full-close dates for one year, weekend-observance applied.
fn holidays_for_year(year: i32) -> Vec<NaiveDate> {
    let fixed = |m: u32, d: u32| NaiveDate::from_ymd_opt(year, m, d).expect("valid fixed date");
    let mut out = Vec::with_capacity(10);
    let mut push = |d: Option<NaiveDate>| {
        if let Some(d) = d {
            out.push(d);
        }
    };
    push(observed(fixed(1, 1), true)); // New Year's (no Saturday makeup)
    push(Some(nth_weekday(year, 1, Weekday::Mon, 3))); // MLK Day
    push(Some(nth_weekday(year, 2, Weekday::Mon, 3))); // Presidents Day
    push(Some(easter(year) - Duration::days(2))); // Good Friday
    push(Some(last_weekday(year, 5, Weekday::Mon))); // Memorial Day
    if year >= 2022 {
        push(observed(fixed(6, 19), false)); // Juneteenth (NYSE from 2022)
    }
    push(observed(fixed(7, 4), false)); // Independence Day
    push(Some(nth_weekday(year, 9, Weekday::Mon, 1))); // Labor Day
    push(Some(nth_weekday(year, 11, Weekday::Thu, 4))); // Thanksgiving
    push(observed(fixed(12, 25), false)); // Christmas
    out
}

/// Holiday set covering `[from_year, to_year]` (inclusive).
fn holidays_for_years(from_year: i32, to_year: i32) -> HashSet<NaiveDate> {
    (from_year..=to_year).flat_map(holidays_for_year).collect()
}

/// Loop-safety bound of the backward walk, below any plan's history floor
/// (Massive's largest plan lists 20+ years). Was 2020, which cut daily history
/// short of the 10 years the key can read (29/09/2016, probed 27/09/2026).
const CALENDAR_FLOOR_YEAR: i32 = 2000;

fn is_trading_day(date: NaiveDate, holidays: &HashSet<NaiveDate>) -> bool {
    let weekday = date.weekday();
    if weekday == Weekday::Sat || weekday == Weekday::Sun {
        return false;
    }
    !holidays.contains(&date)
}

/// Returns up to `n` US-equities trading days ending at (and including) `end`,
/// walking backwards and skipping weekends/holidays. Sorted ascending (oldest
/// first → most recent last). Stops at `CALENDAR_FLOOR_YEAR`, so the result
/// may be shorter than `n` for deep look-backs — callers read a short/empty
/// result as "history exhausted". The real data floor is the key's probed
/// history floor (`provider::entitlements`), applied by the history commands.
pub fn trading_days_before(end: NaiveDate, n: usize) -> Vec<NaiveDate> {
    let mut out = Vec::with_capacity(n);
    // The walk floors at CALENDAR_FLOOR_YEAR (below), so that span bounds the
    // holiday set.
    let holidays = holidays_for_years(CALENDAR_FLOOR_YEAR, end.year());
    let mut cursor = end;
    while out.len() < n {
        if is_trading_day(cursor, &holidays) {
            out.push(cursor);
        }
        cursor -= Duration::days(1);
        // Hard safety: don't loop forever on bad input.
        if cursor.year() < CALENDAR_FLOOR_YEAR {
            break;
        }
    }
    out.reverse();
    out
}

/// US-equities trading days within `[from, to]` (inclusive), ascending. Skips
/// weekends/holidays; empty when `from > to`. Used by the REST-aggregate cache
/// to enumerate which sessions a fetch range should cover.
pub fn trading_days_in_range(from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
    if from > to {
        return Vec::new();
    }
    let holidays = holidays_for_years(from.year(), to.year());
    let mut out = Vec::new();
    let mut cursor = from;
    while cursor <= to {
        if is_trading_day(cursor, &holidays) {
            out.push(cursor);
        }
        cursor += Duration::days(1);
    }
    out
}

/// Returns the last `n` US-equities trading days, ending no later than
/// yesterday (today's bar isn't published until ~11 AM ET the next day).
/// Result is sorted ascending (oldest first → most recent last).
pub fn last_trading_days(n: usize) -> Vec<NaiveDate> {
    // Start from yesterday — daily aggs aren't published for today.
    trading_days_before(Utc::now().date_naive() - Duration::days(1), n)
}

/// New York calendar date of UNIX seconds `sec` (US DST rule in force since
/// 2007: second Sunday of March 02:00 local to first Sunday of November 02:00
/// local). A session's bars (04:00-20:00 New York) share this date, while
/// their UTC date splits in winter (19:00-20:00 New York = 00:00-01:00 UTC).
pub fn ny_date(sec: i64) -> Option<NaiveDate> {
    let utc = chrono::DateTime::from_timestamp(sec, 0)?;
    let year = utc.year();
    let first_sunday = |month: u32| {
        let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month start");
        first + Duration::days(((7 - first.weekday().num_days_from_sunday()) % 7) as i64)
    };
    // DST starts 02:00 EST (07:00 UTC) and ends 02:00 EDT (06:00 UTC).
    let start = (first_sunday(3) + Duration::days(7)).and_hms_opt(7, 0, 0)?.and_utc();
    let end = first_sunday(11).and_hms_opt(6, 0, 0)?.and_utc();
    let offset = if utc >= start && utc < end { -4 } else { -5 };
    Some((utc + Duration::hours(offset)).date_naive())
}

/// Today's New York date.
pub fn ny_today() -> NaiveDate {
    ny_date(Utc::now().timestamp()).unwrap_or_else(|| Utc::now().date_naive())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ny_date_keeps_winter_post_market_on_its_session() {
        // 03/11/2025 19:30 New York (EST) = 04/11/2025 00:30 UTC.
        let t = NaiveDate::from_ymd_opt(2025, 11, 4).unwrap().and_hms_opt(0, 30, 0).unwrap().and_utc().timestamp();
        assert_eq!(ny_date(t), NaiveDate::from_ymd_opt(2025, 11, 3));
        // 29/09/2026 19:59 New York (EDT) = 29/09/2026 23:59 UTC.
        let t = NaiveDate::from_ymd_opt(2026, 9, 29).unwrap().and_hms_opt(23, 59, 0).unwrap().and_utc().timestamp();
        assert_eq!(ny_date(t), NaiveDate::from_ymd_opt(2026, 9, 29));
        // 08/03/2026 04:30 UTC is before the 07:00 UTC switch: 23:30 EST on 07/03.
        let t = NaiveDate::from_ymd_opt(2026, 3, 8).unwrap().and_hms_opt(4, 30, 0).unwrap().and_utc().timestamp();
        assert_eq!(ny_date(t), NaiveDate::from_ymd_opt(2026, 3, 7));
    }

    #[test]
    fn skips_weekends() {
        // 2024-12-21 is a Saturday; 2024-12-23 Mon should be in the list.
        let hs = holidays_for_years(2024, 2024);
        assert!(!is_trading_day(NaiveDate::from_ymd_opt(2024, 12, 21).unwrap(), &hs));
        assert!(is_trading_day(NaiveDate::from_ymd_opt(2024, 12, 23).unwrap(), &hs));
    }

    #[test]
    fn skips_christmas() {
        let hs = holidays_for_years(2024, 2024);
        assert!(!is_trading_day(NaiveDate::from_ymd_opt(2024, 12, 25).unwrap(), &hs));
    }

    /// The computed rules must reproduce the exact NYSE/NASDAQ closed dates the
    /// old hardcoded 2020–2027 table carried (weekend observance, the 2022
    /// Saturday New Year's skip, no Juneteenth before 2022, Good Friday via
    /// the Easter computus).
    #[test]
    fn computed_matches_published_2020_2027() {
        let expected: &[(i32, u32, u32)] = &[
            (2020, 1, 1), (2020, 1, 20), (2020, 2, 17), (2020, 4, 10),
            (2020, 5, 25), (2020, 7, 3), (2020, 9, 7),
            (2020, 11, 26), (2020, 12, 25),
            (2021, 1, 1), (2021, 1, 18), (2021, 2, 15), (2021, 4, 2),
            (2021, 5, 31), (2021, 7, 5), (2021, 9, 6),
            (2021, 11, 25), (2021, 12, 24),
            (2022, 1, 17), (2022, 2, 21), (2022, 4, 15), (2022, 5, 30),
            (2022, 6, 20), (2022, 7, 4), (2022, 9, 5),
            (2022, 11, 24), (2022, 12, 26),
            (2023, 1, 2), (2023, 1, 16), (2023, 2, 20), (2023, 4, 7),
            (2023, 5, 29), (2023, 6, 19), (2023, 7, 4), (2023, 9, 4),
            (2023, 11, 23), (2023, 12, 25),
            (2024, 1, 1), (2024, 1, 15), (2024, 2, 19), (2024, 3, 29),
            (2024, 5, 27), (2024, 6, 19), (2024, 7, 4), (2024, 9, 2),
            (2024, 11, 28), (2024, 12, 25),
            (2025, 1, 1), (2025, 1, 20), (2025, 2, 17), (2025, 4, 18),
            (2025, 5, 26), (2025, 6, 19), (2025, 7, 4), (2025, 9, 1),
            (2025, 11, 27), (2025, 12, 25),
            (2026, 1, 1), (2026, 1, 19), (2026, 2, 16), (2026, 4, 3),
            (2026, 5, 25), (2026, 6, 19), (2026, 7, 3), (2026, 9, 7),
            (2026, 11, 26), (2026, 12, 25),
            (2027, 1, 1), (2027, 1, 18), (2027, 2, 15), (2027, 3, 26),
            (2027, 5, 31), (2027, 6, 18), (2027, 7, 5), (2027, 9, 6),
            (2027, 11, 25), (2027, 12, 24),
        ];
        let want: HashSet<NaiveDate> = expected
            .iter()
            .map(|&(y, m, d)| NaiveDate::from_ymd_opt(y, m, d).unwrap())
            .collect();
        let got = holidays_for_years(2020, 2027);
        let missing: Vec<_> = want.difference(&got).collect();
        let extra: Vec<_> = got.difference(&want).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "missing: {missing:?}, extra: {extra:?}"
        );
    }

    /// Any-year support: 2030 closed dates per the same rules.
    #[test]
    fn computes_future_years() {
        let hs = holidays_for_years(2030, 2030);
        // New Year's Day 2030 is a Tuesday; Good Friday 2030 is April 19
        // (Easter April 21); Thanksgiving is Nov 28.
        assert!(hs.contains(&NaiveDate::from_ymd_opt(2030, 1, 1).unwrap()));
        assert!(hs.contains(&NaiveDate::from_ymd_opt(2030, 4, 19).unwrap()));
        assert!(hs.contains(&NaiveDate::from_ymd_opt(2030, 11, 28).unwrap()));
        assert_eq!(hs.len(), 10);
    }

    #[test]
    fn range_excludes_weekend_and_holiday() {
        // 2024-12-23 Mon … 2024-12-27 Fri: Christmas (25th, Wed) is closed,
        // and the 28th/29th weekend is outside the range. Expect Mon, Tue,
        // Thu, Fri = 4 sessions.
        let from = NaiveDate::from_ymd_opt(2024, 12, 23).unwrap();
        let to = NaiveDate::from_ymd_opt(2024, 12, 27).unwrap();
        let days = trading_days_in_range(from, to);
        assert_eq!(days.len(), 4);
        assert!(!days.contains(&NaiveDate::from_ymd_opt(2024, 12, 25).unwrap()));
        // Ascending and within bounds.
        assert_eq!(days[0], from);
        assert_eq!(*days.last().unwrap(), to);
    }

    #[test]
    fn range_empty_when_inverted() {
        let from = NaiveDate::from_ymd_opt(2024, 12, 27).unwrap();
        let to = NaiveDate::from_ymd_opt(2024, 12, 23).unwrap();
        assert!(trading_days_in_range(from, to).is_empty());
    }

    #[test]
    fn returns_n_days() {
        let v = last_trading_days(10);
        assert_eq!(v.len(), 10);
        // Ascending: first < last.
        assert!(v[0] < v[v.len() - 1]);
    }
}
