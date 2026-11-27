/*
 * The server clock (#422): the time of the servers the data comes from, so a computer whose clock is wrong still
 * shows the right countdown, market status and session day, and stamps live data on the right bar.
 *
 * The gateway puts its time on every answer and on its live socket's status messages; a plugin can send its server's
 * (`data.serverTime`). From the first one on, the clock runs on the monotonic clock, so a change of the computer's
 * clock does not move it. A later time only moves it forward: a time left its server before it arrived here, so it is
 * behind, never ahead. Ten minutes after it was set, the next time sets it again, so the monotonic clock's drift does
 * not pile up. The gateway comes first: a plugin's time counts only when the gateway gave none for ten minutes.
 * Without either, it is the computer's clock.
 */
use crate::sync::LockExt;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Where the time came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Gateway,
    Plugin,
}

/// The clock now: UNIX milliseconds, how far the computer's clock is behind it, and where its time came from (none:
/// the computer's clock).
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub now: f64,
    pub offset: f64,
    pub source: Option<Source>,
}

/// How long a set time stands before the next one sets it again, and how long a gateway time keeps plugins' out.
const HOLD: Duration = Duration::from_secs(600);
/// The smallest change of the offset that listeners hear of.
const NOTICE_MS: f64 = 1000.0;
/// Times before 2017: not a clock (a test value, seconds sent as milliseconds).
const EARLIEST_MS: f64 = 1.5e12;

struct Set {
    /// The server's time at `at`.
    ms: f64,
    at: Instant,
    /// When it was last set (not moved forward).
    since: Instant,
    source: Source,
}

#[derive(Default)]
struct Clock {
    set: Option<Set>,
    /// When the gateway last gave its time.
    gateway: Option<Instant>,
    /// The offset listeners last heard of.
    told: Option<f64>,
}

impl Clock {
    fn now(&self, at: Instant, system: f64) -> f64 {
        match &self.set {
            Some(s) => s.ms + at.saturating_duration_since(s.at).as_secs_f64() * 1000.0,
            None => system,
        }
    }

    /// Take a server's time `ms` that arrived at `at`, when the computer's clock read `system`. True when the offset
    /// moved enough to tell the listeners.
    fn observe(&mut self, ms: f64, source: Source, at: Instant, system: f64) -> bool {
        if !(ms.is_finite() && ms >= EARLIEST_MS) {
            return false;
        }
        if source == Source::Gateway {
            self.gateway = Some(at);
        } else if self.gateway.is_some_and(|g| at.saturating_duration_since(g) < HOLD) {
            return false;
        }
        let reset = match &self.set {
            None => true,
            Some(s) => s.source != source || at.saturating_duration_since(s.since) >= HOLD,
        };
        if reset {
            self.set = Some(Set { ms, at, since: at, source });
        } else if ms > self.now(at, system) {
            let s = self.set.as_mut().expect("set");
            (s.ms, s.at) = (ms, at);
        }
        let offset = self.now(at, system) - system;
        let tell = self.told.is_none_or(|t| (offset - t).abs() >= NOTICE_MS);
        if tell {
            self.told = Some(offset);
        }
        tell
    }

    fn reading(&self, at: Instant, system: f64) -> Reading {
        let now = self.now(at, system);
        Reading { now, offset: now - system, source: self.set.as_ref().map(|s| s.source) }
    }
}

static CLOCK: Mutex<Clock> = Mutex::new(Clock { set: None, gateway: None, told: None });
static LISTENER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// The computer's clock, UNIX milliseconds.
pub fn system_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// The server time, UNIX milliseconds.
pub fn now_ms() -> f64 {
    CLOCK.locked().now(Instant::now(), system_ms())
}

/// The server time as a date-time.
pub fn utc() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp_millis(now_ms() as i64).unwrap_or_else(chrono::Utc::now)
}

/// The server time, whole UNIX seconds.
pub fn now() -> f64 {
    (now_ms() / 1000.0).floor()
}

pub fn reading() -> Reading {
    CLOCK.locked().reading(Instant::now(), system_ms())
}

/// A server's time (UNIX milliseconds), just received.
pub fn observe(ms: f64, source: Source) {
    let tell = CLOCK.locked().observe(ms, source, Instant::now(), system_ms());
    if tell {
        if let Some(f) = LISTENER.get() {
            f();
        }
    }
}

/// Called when the offset moves by a second or more (the desktop app tells its windows and the plugins). Once.
pub fn on_change(f: impl Fn() + Send + Sync + 'static) {
    let _ = LISTENER.set(Box::new(f));
}

/// The gateway's time on an answer (`X-Server-Time`, UNIX milliseconds).
pub const HEADER: &str = "x-server-time";

#[cfg(test)]
mod tests {
    use super::*;

    const T: f64 = 1_800_000_000_000.0;

    #[test]
    fn the_first_time_sets_it_and_it_runs_on() {
        let mut c = Clock::default();
        let at = Instant::now();
        assert_eq!(c.now(at, 5.0), 5.0, "the computer's clock until a time comes");
        assert!(c.observe(T, Source::Gateway, at, T - 120_000.0));
        assert_eq!(c.now(at + Duration::from_secs(3), 0.0), T + 3000.0);
        let r = c.reading(at, T - 120_000.0);
        assert_eq!((r.offset, r.source), (120_000.0, Some(Source::Gateway)));
    }

    #[test]
    fn later_times_only_move_it_forward_until_it_is_set_again() {
        let mut c = Clock::default();
        let at = Instant::now();
        c.observe(T, Source::Gateway, at, T);
        assert!(!c.observe(T - 400.0, Source::Gateway, at + Duration::from_secs(1), T + 1000.0));
        assert_eq!(c.now(at + Duration::from_secs(1), T), T + 1000.0, "an older time does not move it back");
        c.observe(T + 1300.0, Source::Gateway, at + Duration::from_secs(1), T);
        assert_eq!(c.now(at + Duration::from_secs(1), T), T + 1300.0, "a later one moves it forward");
        let later = at + HOLD + Duration::from_secs(1);
        c.observe(T, Source::Gateway, later, T);
        assert_eq!(c.now(later, T), T, "ten minutes on, the next time sets it again");
    }

    #[test]
    fn the_gateway_comes_first() {
        let mut c = Clock::default();
        let at = Instant::now();
        c.observe(T, Source::Plugin, at, T);
        assert_eq!(c.reading(at, T).source, Some(Source::Plugin), "a plugin's time without the gateway");
        c.observe(T + 50.0, Source::Gateway, at, T);
        c.observe(T + 9000.0, Source::Plugin, at + Duration::from_secs(60), T);
        assert_eq!(c.reading(at, T).source, Some(Source::Gateway));
        assert_eq!(c.now(at + Duration::from_secs(60), T), T + 50.0 + 60_000.0, "a plugin's time is left out");
        let later = at + HOLD + Duration::from_secs(1);
        c.observe(T + 9000.0, Source::Plugin, later, T);
        assert_eq!(c.reading(later, T).source, Some(Source::Plugin), "after ten minutes without the gateway");
    }

    #[test]
    fn small_moves_are_not_told_and_bad_times_are_left_out() {
        let mut c = Clock::default();
        let at = Instant::now();
        assert!(!c.observe(f64::NAN, Source::Gateway, at, T));
        assert!(!c.observe(1_800_000_000.0, Source::Gateway, at, T), "seconds, not milliseconds");
        assert!(c.observe(T, Source::Gateway, at, T));
        assert!(!c.observe(T + 500.0, Source::Gateway, at, T));
        assert!(c.observe(T + 1500.0, Source::Gateway, at, T));
    }
}
