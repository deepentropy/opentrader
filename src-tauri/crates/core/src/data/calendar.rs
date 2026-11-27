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
 * history entry ("…#YYYYMMDD/current") is the current schedule. The hours
 * of its longest day (regular and extended together) size how many bars a
 * day can hold.
 */
use crate::data::session::SymbolSession;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone};
use chrono_tz::Tz;
use std::collections::HashSet;

/// Loop-safety bound of the backward walk (same floor as the US calendar).
const FLOOR_YEAR: i32 = 2000;
const MINUTES_PER_DAY: i32 = 1440;

pub struct SessionCalendar {
    tz: Tz,
    /// Index `Weekday::num_days_from_monday()`: the session trades that day.
    days: [bool; 7],
    closed: HashSet<NaiveDate>,
    /// Traded minutes of the longest trading day (the widest of the session and its parts), and its earliest open
    /// from the trading day's local midnight: a day the spec doesn't tell is a whole calendar day.
    day_minutes: i32,
    open: i32,
}

/// TV-style day digit (1 = Sunday … 7 = Saturday) → Monday-based index.
fn monday_index(digit: u32) -> Option<usize> {
    match digit {
        1 => Some(6),
        2..=7 => Some((digit - 2) as usize),
        _ => None,
    }
}

/// The current schedule of a spec: its last history entry, without the first-day-of-week part.
fn current_body(spec: &str) -> &str {
    let current = spec.rsplit('/').next().unwrap_or(spec);
    match current.split_once(';') {
        // "2;spec" or "spec;2": the part with ranges is the spec.
        Some((a, b)) => if a.contains('-') { a } else { b },
        None => current,
    }
    .trim()
}

fn weekdays_of(spec: &str) -> [bool; 7] {
    let body = current_body(spec);
    if body.eq_ignore_ascii_case("24x7") {
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

/// "HHMM" or "HHMMF<n>" → minutes after midnight and the days it is moved back.
fn bound(s: &str) -> Option<(i32, i32)> {
    let (hhmm, back) = match s.split_once('F') {
        Some((t, n)) => (t, if n.is_empty() { 1 } else { n.parse().ok()? }),
        None => (s, 0),
    };
    if hhmm.len() != 4 || !hhmm.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let v: i32 = hhmm.parse().ok()?;
    Some((v / 100 * 60 + v % 100, back))
}

/// One "HHMM-HHMM" interval (markers stripped) → minutes from and to the trading day's local midnight (from is
/// negative when it opens on an earlier calendar day). Same reading as src/data/session/spec.ts.
fn interval(s: &str) -> Option<(i32, i32)> {
    let main = s.split('E').next()?.split('A').next()?;
    let mut parts = main.split('-');
    let (a, b) = (parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let ((start, mut start_back), (end, end_back)) = (bound(a)?, bound(b)?);
    let to = if end == 0 { MINUTES_PER_DAY } else { end };
    if start_back == end_back && to <= start {
        start_back += 1;
    }
    Some((start - start_back * MINUTES_PER_DAY, to - end_back * MINUTES_PER_DAY))
}

/// The traded minutes of the longest trading day of a spec, and the earliest open in minutes from the trading day's
/// local midnight (negative: the day before). None when it doesn't read.
fn day_hours(spec: &str) -> Option<(i32, i32)> {
    let body = current_body(spec);
    if body.eq_ignore_ascii_case("24x7") {
        return Some((MINUTES_PER_DAY, 0));
    }
    let (mut longest, mut open) = (0, i32::MAX);
    for section in body.split('|') {
        let ranges = section.split(':').next().unwrap_or_default();
        let mut day = 0;
        for piece in ranges.split([',', 'U', 'S']).filter(|p| !p.is_empty()) {
            let (from, to) = interval(piece)?;
            day += (to - from).max(0);
            open = open.min(from);
        }
        longest = longest.max(day);
    }
    (longest > 0).then_some((longest.min(MINUTES_PER_DAY), open))
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
        let specs = std::iter::once(&s.session).chain(s.subsessions.iter().map(|p| &p.session));
        let (day_minutes, open) = specs
            .filter_map(|spec| day_hours(spec))
            .reduce(|(m, o), (m2, o2)| (m.max(m2), o.min(o2)))
            .unwrap_or((MINUTES_PER_DAY, 0));
        Self { tz, days: weekdays_of(&s.session), closed, day_minutes, open }
    }

    /// Traded minutes of the longest trading day, regular and extended hours together (a whole day at most).
    pub fn day_minutes(&self) -> u32 {
        self.day_minutes as u32
    }

    /// UNIX seconds where the bars of trading day `d` can start: its earliest open (the evening before for an
    /// overnight session), or the UTC midnight of `d` when that is earlier (daily bars stamped at UTC midnight).
    pub fn day_start(&self, d: NaiveDate) -> i64 {
        let utc = d.and_hms_opt(0, 0, 0).map_or(0, |t| t.and_utc().timestamp());
        let local = d.and_hms_opt(0, 0, 0).and_then(|t| self.tz.from_local_datetime(&t).earliest()).map(|t| t.timestamp());
        local.map_or(utc, |l| (l + self.open.min(0) as i64 * 60).min(utc))
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
        crate::clock::utc().with_timezone(&self.tz).date_naive()
    }

    /// Last date a fetch window should reach: the later of the UTC and the
    /// exchange dates, so a zone east of UTC (its morning is UTC's evening
    /// before) still gets today's bars, and a zone west of UTC keeps the
    /// UTC date it had.
    pub fn window_end(&self) -> NaiveDate {
        self.today().max(crate::clock::utc().date_naive())
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
            pricescale: 100,
            minmov: 1,
            variable_tick_size: String::new(),
            intervals: Vec::new(),
            bar_origin: None,
            point_value: None,
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
    fn hours_of_the_longest_trading_day() {
        assert_eq!(day_hours("0915-1530"), Some((375, 555)));
        assert_eq!(day_hours("24x7"), Some((1440, 0)));
        // Overnight: FX opens at 17:00 the day before and trades 24 hours.
        assert_eq!(day_hours("1700-1700"), Some((1440, -420)));
        assert_eq!(day_hours("1800-1700:23456"), Some((1380, -360)));
        // Several intervals, sections and a history: the current entry's longest day.
        assert_eq!(day_hours("0900-1130,1230-1500"), Some((300, 540)));
        assert_eq!(day_hours("0930-1600:23456|0930-1300:7"), Some((390, 570)));
        assert_eq!(day_hours("0900-1000#20251201/0800-2200:234567"), Some((840, 480)));
        assert_eq!(day_hours("1700F-1600"), Some((1380, -420)));
        assert_eq!(day_hours("bad"), None);
    }

    #[test]
    fn day_start_is_the_earliest_open() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 16).unwrap();
        let utc = d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
        // Kolkata (UTC+05:30): its midnight, before the UTC one.
        let nse = SessionCalendar::new(&session("Asia/Kolkata", "0915-1530", "", ""));
        assert_eq!((nse.day_start(d), nse.day_minutes()), (utc - 19_800, 375));
        // New York: daily bars stamped at UTC midnight start before its own midnight.
        let mut us = session("America/New_York", "0930-1600", "", "");
        us.subsessions.push(Subsession::new("extended", "Extended", "0400-2000"));
        let us = SessionCalendar::new(&us);
        assert_eq!((us.day_start(d), us.day_minutes()), (utc, 960));
        // FX: Monday's session opens Sunday 17:00 New York (22:00 UTC).
        let fx = SessionCalendar::new(&session("America/New_York", "1700-1700", "", ""));
        assert_eq!((fx.day_start(d), fx.day_minutes()), (utc - 2 * 3600, 1440));
        // A spec that doesn't read: whole days.
        assert_eq!(SessionCalendar::new(&session("UTC", "?", "", "")).day_minutes(), 1440);
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
