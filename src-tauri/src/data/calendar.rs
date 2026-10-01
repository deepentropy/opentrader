/*
 * Trading calendar of one symbol, from its session (`SymbolSession`): which
 * days it trades (the weekdays of its session spec, minus holidays and
 * "dayoff" corrections) and its exchange-local dates. The history commands
 * size their windows in this calendar, so a provider serving NSE or TSE pages
 * by its own trading days and dates, not the US ones.
 *
 * Spec grammar: see src/data/session/spec.ts. Only the weekdays matter here:
 * "24x7" trades every day; a section "ranges:days" lists its days (1 = Sunday
 * … 7 = Saturday); a section without days trades Monday to Friday; the last
 * history entry ("…#YYYYMMDD/current") is the current schedule.
 */
use crate::data::session::SymbolSession;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use std::collections::HashSet;

/// Loop-safety bound of the backward walk (same floor as the US calendar).
const FLOOR_YEAR: i32 = 2000;

pub struct SessionCalendar {
    tz: Tz,
    /// Index `Weekday::num_days_from_monday()`: the session trades that day.
    days: [bool; 7],
    closed: HashSet<NaiveDate>,
}

/// TV-style day digit (1 = Sunday … 7 = Saturday) → Monday-based index.
fn monday_index(digit: u32) -> Option<usize> {
    match digit {
        1 => Some(6),
        2..=7 => Some((digit - 2) as usize),
        _ => None,
    }
}

fn weekdays_of(spec: &str) -> [bool; 7] {
    let current = spec.rsplit('/').next().unwrap_or(spec);
    let body = match current.split_once(';') {
        // "2;spec" or "spec;2": the part with ranges is the spec.
        Some((a, b)) => if a.contains('-') { a } else { b },
        None => current,
    };
    if body.trim().eq_ignore_ascii_case("24x7") {
        return [true; 7];
    }
    let mut days = [false; 7];
    for section in body.split('|') {
        match section.split_once(':') {
            Some((_, list)) if !list.is_empty() => {
                for c in list.chars() {
                    if let Some(i) = c.to_digit(10).and_then(monday_index) {
                        days[i] = true;
                    }
                }
            }
            _ => days[..5].iter_mut().for_each(|d| *d = true),
        }
    }
    days
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y%m%d").ok()
}

impl SessionCalendar {
    pub fn new(s: &SymbolSession) -> Self {
        let tz: Tz = s.timezone.parse().unwrap_or(Tz::UTC);
        let mut closed: HashSet<NaiveDate> = s.holidays.split(',').filter_map(parse_date).collect();
        for section in s.corrections.split(';') {
            if let Some(("dayoff", dates)) = section.split_once(':') {
                closed.extend(dates.split(',').filter_map(parse_date));
            }
        }
        Self { tz, days: weekdays_of(&s.session), closed }
    }

    pub fn is_trading_day(&self, d: NaiveDate) -> bool {
        self.days[d.weekday().num_days_from_monday() as usize] && !self.closed.contains(&d)
    }

    /// Exchange-local date of UNIX seconds `sec`.
    pub fn date_of(&self, sec: i64) -> Option<NaiveDate> {
        Some(DateTime::from_timestamp(sec, 0)?.with_timezone(&self.tz).date_naive())
    }

    /// Exchange-local today.
    pub fn today(&self) -> NaiveDate {
        Utc::now().with_timezone(&self.tz).date_naive()
    }

    /// Last date a fetch window should reach: the later of the UTC and the
    /// exchange dates, so a zone east of UTC (its morning is UTC's evening
    /// before) still gets today's bars, and a zone west of UTC keeps the
    /// UTC date it had.
    pub fn window_end(&self) -> NaiveDate {
        self.today().max(Utc::now().date_naive())
    }

    /// Up to `n` trading days ending at (and including) `end`, ascending.
    /// Stops at `FLOOR_YEAR` (deep look-backs come back shorter).
    pub fn trading_days_before(&self, end: NaiveDate, n: usize) -> Vec<NaiveDate> {
        let mut out = Vec::with_capacity(n);
        let mut cursor = end;
        while out.len() < n && cursor.year() >= FLOOR_YEAR {
            if self.is_trading_day(cursor) {
                out.push(cursor);
            }
            cursor -= Duration::days(1);
        }
        out.reverse();
        out
    }

    /// Trading days within `[from, to]`, ascending.
    pub fn trading_days_in_range(&self, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
        let mut out = Vec::new();
        let mut cursor = from;
        while cursor <= to {
            if self.is_trading_day(cursor) {
                out.push(cursor);
            }
            cursor += Duration::days(1);
        }
        out
    }

    /// The last `n` trading days, ending no later than the day before
    /// `window_end` (today's daily bar is not final).
    pub fn last_trading_days(&self, n: usize) -> Vec<NaiveDate> {
        self.trading_days_before(self.window_end() - Duration::days(1), n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::session::Subsession;
    use crate::data::trading_calendar;

    fn session(tz: &str, spec: &str, holidays: &str, corrections: &str) -> SymbolSession {
        SymbolSession {
            timezone: tz.into(),
            session: spec.into(),
            subsessions: vec![Subsession::new("regular", "Regular", spec)],
            holidays: holidays.into(),
            corrections: corrections.into(),
        }
    }

    /// With the US session the calendar walks exactly like the US calendar.
    #[test]
    fn us_session_matches_us_calendar() {
        let hol = trading_calendar::holidays_spec(2000, 2027);
        let cal = SessionCalendar::new(&session("America/New_York", "0930-1600", &hol, ""));
        let end = NaiveDate::from_ymd_opt(2026, 9, 30).unwrap();
        assert_eq!(cal.trading_days_before(end, 600), trading_calendar::trading_days_before(end, 600));
        let from = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        assert_eq!(cal.trading_days_in_range(from, end), trading_calendar::trading_days_in_range(from, end));
    }

    #[test]
    fn weekdays_from_spec() {
        // FX trades Monday to Friday (its Monday session opens Sunday 17:00).
        assert_eq!(weekdays_of("1700-1700"), [true, true, true, true, true, false, false]);
        assert_eq!(weekdays_of("24x7"), [true; 7]);
        // Explicit days: Sunday (1) + Monday..Thursday (2-5).
        assert_eq!(weekdays_of("1700-1600:12345"), [true, true, true, true, false, false, true]);
        // History: the current (last) entry counts.
        assert_eq!(weekdays_of("0900-1746:23456#20251201/0800-2200:234567"), [true, true, true, true, true, true, false]);
    }

    #[test]
    fn holidays_dayoff_and_zone() {
        let cal = SessionCalendar::new(&session("Asia/Kolkata", "0915-1530", "20261002", "0915-1300:20261106;dayoff:20261009"));
        assert!(!cal.is_trading_day(NaiveDate::from_ymd_opt(2026, 10, 2).unwrap())); // holiday
        assert!(!cal.is_trading_day(NaiveDate::from_ymd_opt(2026, 10, 9).unwrap())); // dayoff
        assert!(cal.is_trading_day(NaiveDate::from_ymd_opt(2026, 11, 6).unwrap())); // short day still trades
        // 01/10/2026 20:00 UTC is already 02/10 in Kolkata.
        let t = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap().and_hms_opt(20, 0, 0).unwrap().and_utc().timestamp();
        assert_eq!(cal.date_of(t), NaiveDate::from_ymd_opt(2026, 10, 2));
    }
}
