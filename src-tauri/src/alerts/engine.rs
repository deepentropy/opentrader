//! The pure evaluation: rules, their memory, the replay of missed bars
//! and the engine that holds them.
use crate::data::types::Candle;
use serde::Deserialize;
use std::collections::HashMap;

/// Oldest time a replay goes back to.
const REPLAY_MAX: f64 = 30.0 * 86_400.0;
/// A gap shorter than this is not replayed: the next quote covers it.
const REPLAY_MIN_GAP: f64 = 120.0;
/// Most offline fires kept per rule (the latest ones).
const REPLAY_MAX_FIRES: usize = 50;

/// One rule, compiled by the window.
#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineRule {
    pub id: String,
    /// Full name, uppercased ("NASDAQ:AAPL").
    pub symbol: String,
    /// Changes whenever the condition or what it reads changes: the rule's
    /// evaluation memory is kept only while it stays the same.
    pub sig: String,
    /// crossing | crossing_up | crossing_down | greater | less | entering |
    /// exiting | inside | outside | hits_level
    pub op: String,
    /// What `values` hold: "level" [price], "band" [bound, bound], "position"
    /// [entry, stop, target], "time" [UNIX seconds].
    pub shape: String,
    /// only_once | once_per_bar | once_per_bar_close | every_time
    pub frequency: String,
    /// UNIX ms after which the rule no longer fires.
    pub expires_at: Option<f64>,
    /// UNIX ms the rule became active: a replay never starts before it.
    pub since: f64,
    /// Key of the bars of the rule's interval (`EngineGrid::key`).
    pub grid: String,
    /// Values that hold at any time.
    pub values: Vec<f64>,
    /// Values per bar of the grid (a sloped line, a drawing limited to its
    /// dates); an empty entry = no value on that bar. Replaces `values`.
    pub per_bar: Option<Vec<Vec<f64>>>,
    /// A band without value counts as "outside" (a rectangle outside its
    /// dates) instead of leaving the condition undecided.
    pub absent_is_outside: bool,
    /// A multi-condition alert: the conditions after the first one, each on
    /// its own grid; the rule fires when all of them hold with the first.
    #[serde(default)]
    pub and: Vec<EngineRule>,
}

/// Bars of one symbol on one interval and session (regular or extended
/// hours), ascending: (open, close) in UNIX seconds (the last bar of a session
/// closes with it).
#[derive(Clone, Debug, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineGrid {
    pub key: String,
    pub bars: Vec<(f64, f64)>,
    /// Regular-session intervals (start, end) over the same dates: tell a
    /// pre- or post-market trade from a regular one. Empty = all regular.
    pub regular: Vec<(f64, f64)>,
    /// Hours (start, end) of the rule's session over the same dates: a quote
    /// outside them is not read. Empty = always.
    #[serde(default)]
    pub session: Vec<(f64, f64)>,
    /// The session is the extended one: a pre- or post-market trade is read
    /// (on regular hours it is not: those bars do not move then).
    #[serde(default)]
    pub extended_hours: bool,
}

impl EngineGrid {
    /// Index of the bar containing `t`, else of the next one to open.
    fn bar_at(&self, t: f64) -> Option<usize> {
        let i = self.bars.partition_point(|b| b.1 <= t);
        (i < self.bars.len()).then_some(i)
    }
    fn in_regular(&self, t: f64) -> bool {
        self.regular.is_empty() || self.regular.iter().any(|iv| t >= iv.0 && t < iv.1)
    }
    fn in_session(&self, s: &Sample) -> bool {
        (self.extended_hours || !s.extended) && (self.session.is_empty() || self.session.iter().any(|iv| s.time >= iv.0 && s.time < iv.1))
    }
    /// True when a minute bar opening at `t` is one of the rule's bars.
    fn reads_minute(&self, t: f64) -> bool {
        self.in_session(&Sample { extended: !self.in_regular(t), ..Sample::point(0.0, t) })
    }
}

/// The price at one moment and the range it went through since the previous
/// sample (`lo` / `hi` include `price`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub price: f64,
    pub lo: f64,
    pub hi: f64,
    /// UNIX seconds.
    pub time: f64,
    /// The trade is pre- or post-market.
    pub extended: bool,
}

impl Sample {
    fn point(price: f64, time: f64) -> Self {
        Self { price, lo: price, hi: price, time, extended: false }
    }
}

/// Every time: seconds between two fires at least.
const EVERY_TIME_SEC: f64 = 60.0;

/// A rule's evaluation memory.
#[derive(Clone, Debug, Default)]
pub struct RuleState {
    /// Price minus level at the previous sample (crossings).
    prev_diff: Option<f64>,
    /// Inside the band at the previous sample (entering / exiting).
    prev_inside: Option<bool>,
    prev_price: Option<f64>,
    prev_time: Option<f64>,
    /// Bar of the last fire (once per bar, once per bar close).
    last_fired_bar: Option<f64>,
    /// Time of the last fire (every time: at most once a minute).
    last_fired_at: Option<f64>,
    /// Once per bar close: the forming bar and its latest sample.
    forming: Option<(f64, Sample)>,
    /// "Only once" has fired.
    done: bool,
    /// A position's entry has fired (it fires once).
    entry_hit: bool,
    /// Its missed bars are being replayed: live quotes wait.
    replaying: bool,
    /// Memory of the conditions after the first one.
    and: Vec<RuleState>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Fire {
    pub rule_id: String,
    pub price: f64,
    /// UNIX seconds of the sample that fired.
    pub time: f64,
    /// Open time of the bar it fired in, when the grid knows it.
    pub bar_time: Option<f64>,
}

impl EngineRule {
    fn values_at(&self, t: f64, grid: Option<&EngineGrid>) -> Option<&[f64]> {
        let v = match &self.per_bar {
            Some(per_bar) => per_bar.get(grid?.bar_at(t)?)?,
            None => &self.values,
        };
        (!v.is_empty()).then_some(v.as_slice())
    }

    /// The price the condition is met at for this sample, if it is. Updates
    /// the memory the next sample compares with.
    fn condition(&self, st: &mut RuleState, s: Sample, grid: Option<&EngineGrid>) -> Option<f64> {
        let vals = self.values_at(s.time, grid);
        match self.shape.as_str() {
            // Vertical line: the time reaches it.
            "time" => {
                let line = *vals?.first()?;
                let prev = st.prev_time.replace(s.time)?;
                (prev < line && s.time >= line).then_some(s.price)
            }
            // Position: a level lies on the way from the previous price.
            "position" => {
                let prev = st.prev_price.replace(s.price);
                let levels = vals?;
                let p0 = prev?;
                let (lo, hi) = (s.lo.min(p0), s.hi.max(p0));
                if lo == hi {
                    return None;
                }
                levels.iter().copied().find(|l| *l >= lo && *l <= hi && *l != p0)
            }
            "band" => {
                let band = vals.filter(|v| v.len() >= 2).map(|v| (v[0].min(v[1]), v[0].max(v[1])));
                match self.op.as_str() {
                    "greater" => {
                        let (_, upper) = band?;
                        (s.hi > upper).then_some(if s.price > upper { s.price } else { s.hi })
                    }
                    "less" => {
                        let (lower, _) = band?;
                        (s.lo < lower).then_some(if s.price < lower { s.price } else { s.lo })
                    }
                    op => {
                        if band.is_none() && !self.absent_is_outside {
                            return None;
                        }
                        let inside = band.is_some_and(|(l, u)| s.price >= l && s.price <= u);
                        let touched = band.is_some_and(|(l, u)| s.hi >= l && s.lo <= u);
                        let left = band.map_or(true, |(l, u)| s.hi > u || s.lo < l);
                        if op == "inside" {
                            return touched.then_some(s.price);
                        }
                        if op == "outside" {
                            return left.then_some(s.price);
                        }
                        let prev = st.prev_inside.replace(inside)?;
                        let met = match op {
                            "entering" => !prev && touched,
                            "exiting" => prev && left,
                            _ => false,
                        };
                        met.then_some(s.price)
                    }
                }
            }
            _ => {
                let level = *vals?.first()?;
                let above = || if s.price > level { s.price } else { s.hi };
                let below = || if s.price < level { s.price } else { s.lo };
                match self.op.as_str() {
                    "greater" => (s.hi > level).then(above),
                    "less" => (s.lo < level).then(below),
                    "crossing" | "crossing_up" | "crossing_down" => {
                        let prev = st.prev_diff.replace(s.price - level)?;
                        let up = prev <= 0.0 && s.hi > level;
                        let down = prev >= 0.0 && s.lo < level;
                        match self.op.as_str() {
                            "crossing_up" => up.then(above),
                            "crossing_down" => down.then(below),
                            _ if up => Some(above()),
                            _ if down => Some(below()),
                            _ => None,
                        }
                    }
                    _ => None,
                }
            }
        }
    }

    /// All the conditions of the rule for this sample: the price the first one
    /// is met at when every one is met. Each condition reads the sample, so its
    /// memory moves on even when another one is not met.
    fn conditions(&self, st: &mut RuleState, s: Sample, grid: Option<&EngineGrid>, more: &[Option<&EngineGrid>]) -> Option<f64> {
        let first = self.condition(st, s, grid);
        if self.and.is_empty() {
            return first;
        }
        st.and.resize_with(self.and.len(), RuleState::default);
        let mut all = first.is_some();
        for (i, c) in self.and.iter().enumerate() {
            all &= c.condition(&mut st.and[i], s, more.get(i).copied().flatten()).is_some();
        }
        if all { first } else { None }
    }

    /// Evaluate one sample: the conditions, then the trigger rule. `more`: the
    /// grids of the conditions after the first one.
    fn step(&self, st: &mut RuleState, s: Sample, grid: Option<&EngineGrid>, more: &[Option<&EngineGrid>]) -> Option<Fire> {
        if st.done || self.expires_at.is_some_and(|e| s.time * 1000.0 >= e) {
            return None;
        }
        let bar = grid.and_then(|g| g.bar_at(s.time).map(|i| g.bars[i].0));
        let fire = |price: f64, time: f64, bar_time: Option<f64>| Fire { rule_id: self.id.clone(), price, time, bar_time };
        // Out of the rule's session its bars do not move: nothing is read.
        let inside = grid.map_or(true, |g| g.in_session(&s));
        if !inside && self.frequency != "once_per_bar_close" {
            return None;
        }
        // A long / short position fires as the trade it draws: once at its entry, then at its stop or profit level,
        // which ends the alert (its trigger is fixed). Its values are [entry, stop, target].
        if self.shape == "position" {
            let prev = st.prev_price.replace(s.price);
            let v = self.values_at(s.time, grid)?;
            let (entry, exits) = (*v.first()?, &v[1..]);
            let p0 = prev?;
            let (lo, hi) = (s.lo.min(p0), s.hi.max(p0));
            let crossed = |l: f64| lo < hi && l >= lo && l <= hi && l != p0;
            if !st.entry_hit && crossed(entry) {
                st.entry_hit = true;
                // The next sample reads the way on from the entry (a stop passed in the same move fires then).
                st.prev_price = Some(entry);
                return Some(fire(entry, s.time, bar));
            }
            let exit = exits.iter().copied().find(|l| crossed(*l))?;
            st.done = true;
            return Some(fire(exit, s.time, bar));
        }
        match self.frequency.as_str() {
            // The bar that just closed is judged on its last sample, so a
            // crossing compares close with close.
            "once_per_bar_close" => {
                let (closed, last) = if inside {
                    let bar = bar?;
                    st.forming.replace((bar, s)).filter(|(b, _)| *b != bar)?
                } else {
                    // No sample, but the session's last bar has closed.
                    st.forming.take()?
                };
                let price = self.conditions(st, Sample::point(last.price, last.time), grid, more)?;
                if st.last_fired_bar == Some(closed) {
                    return None;
                }
                st.last_fired_bar = Some(closed);
                Some(fire(price, last.time, Some(closed)))
            }
            "once_per_bar" => {
                let price = self.conditions(st, s, grid, more)?;
                let bar = bar?;
                if st.last_fired_bar == Some(bar) {
                    return None;
                }
                st.last_fired_bar = Some(bar);
                Some(fire(price, s.time, Some(bar)))
            }
            // "Once per minute while condition remains met".
            "every_time" => {
                let price = self.conditions(st, s, grid, more)?;
                if st.last_fired_at.is_some_and(|t| s.time - t < EVERY_TIME_SEC) {
                    return None;
                }
                st.last_fired_at = Some(s.time);
                Some(fire(price, s.time, bar))
            }
            freq => {
                let price = self.conditions(st, s, grid, more)?;
                st.done = freq == "only_once";
                Some(fire(price, s.time, bar))
            }
        }
    }
}

/// Run a rule over the minute bars after `from` (UNIX seconds): the state it
/// ends in and what fired (the latest `REPLAY_MAX_FIRES`). Each bar of the
/// rule's session is read as its open, then its close with the bar's range.
pub fn replay_rule(rule: &EngineRule, grid: Option<&EngineGrid>, more: &[Option<EngineGrid>], bars: &[Candle], from: f64) -> (RuleState, Vec<Fire>) {
    let more: Vec<Option<&EngineGrid>> = more.iter().map(|g| g.as_ref()).collect();
    let mut st = RuleState::default();
    let mut fires = Vec::new();
    for b in bars {
        if b.time <= from || !grid.map_or(true, |g| g.reads_minute(b.time)) {
            continue;
        }
        let close = Sample { price: b.close, lo: b.low.min(b.close), hi: b.high.max(b.close), time: b.time, extended: false };
        for s in [Sample::point(b.open, b.time), close] {
            fires.extend(rule.step(&mut st, s, grid, &more));
        }
    }
    if fires.len() > REPLAY_MAX_FIRES {
        fires.drain(..fires.len() - REPLAY_MAX_FIRES);
    }
    (st, fires)
}

/// Bars to replay for the rules of one symbol.
pub struct ReplayJob {
    pub symbol: String,
    /// UNIX seconds: bars after it are replayed.
    pub from: f64,
    /// Each rule with its grid and the grids of its other conditions.
    pub rules: Vec<(EngineRule, Option<EngineGrid>, Vec<Option<EngineGrid>>)>,
}

/// Minute bar last seen for a symbol: what is new in the next one.
pub(super) struct SeenBar {
    time: f64,
    high: f64,
    low: f64,
}

#[derive(Default)]
pub struct Engine {
    pub(super) rules: HashMap<String, (EngineRule, RuleState)>,
    pub(super) grids: HashMap<String, EngineGrid>,
    pub(super) seen: HashMap<String, SeenBar>,
    /// Time of each symbol's last sample, this run (saved for the next one).
    pub(super) last: HashMap<String, f64>,
    /// The same map as the previous run left it; None on the very first run
    /// (nothing is replayed then).
    pub(super) previous: Option<HashMap<String, f64>>,
}

impl Engine {
    /// Replace the rules. A rule whose `sig` is unchanged keeps its memory.
    /// Returns the replays to run for the rules seen for the first time.
    pub fn set(&mut self, rules: Vec<EngineRule>, grids: Vec<EngineGrid>, now: f64) -> Vec<ReplayJob> {
        self.grids = grids.into_iter().map(|g| (g.key.clone(), g)).collect();
        let mut old = std::mem::take(&mut self.rules);
        let mut jobs: HashMap<String, ReplayJob> = HashMap::new();
        for rule in rules {
            let kept = old.remove(&rule.id).filter(|(r, _)| r.sig == rule.sig).map(|(_, st)| st);
            let mut st = kept.clone().unwrap_or_default();
            if kept.is_none() {
                if let Some(from) = self.replay_from(&rule, now) {
                    st.replaying = true;
                    let job = jobs.entry(rule.symbol.clone()).or_insert_with(|| ReplayJob { symbol: rule.symbol.clone(), from, rules: Vec::new() });
                    job.from = job.from.min(from);
                    let more = rule.and.iter().map(|c| self.grids.get(&c.grid).cloned()).collect();
                    job.rules.push((rule.clone(), self.grids.get(&rule.grid).cloned(), more));
                }
            }
            self.rules.insert(rule.id.clone(), (rule, st));
        }
        jobs.into_values().collect()
    }

    /// Where a new rule's replay starts: the symbol's last sample of the
    /// previous run, not before the rule became active. None when there is
    /// nothing to replay.
    fn replay_from(&self, rule: &EngineRule, now: f64) -> Option<f64> {
        let previous = self.previous.as_ref()?;
        let since = rule.since / 1000.0;
        let from = previous.get(&rule.symbol).map_or(since, |t| t.max(since)).max(now - REPLAY_MAX);
        (now - from > REPLAY_MIN_GAP).then_some(from)
    }

    /// End a replay: each rule takes the state its bars left it in (None:
    /// the bars could not be read, the rules start from the next quote).
    pub fn finish_replay(&mut self, job: &ReplayJob, bars: Option<&[Candle]>) -> Vec<Fire> {
        let mut fires = Vec::new();
        for (rule, grid, more) in &job.rules {
            let Some((current, st)) = self.rules.get_mut(&rule.id) else { continue };
            if current.sig != rule.sig || !st.replaying {
                continue;
            }
            let from = job.from.max(rule.since / 1000.0);
            let (state, fired) = bars.map(|b| replay_rule(rule, grid.as_ref(), more, b, from)).unwrap_or_default();
            *st = state;
            fires.extend(fired);
        }
        fires
    }

    /// One quote of `symbol`: the regular-session last (`last`) and the
    /// latest minute bar, whose close is the latest trade (pre- and
    /// post-market included). Returns what fires.
    pub fn sample(&mut self, symbol: &str, last: f64, bar: Option<&Candle>, now: f64) -> Vec<Fire> {
        // What the bar adds since the previous quote: all of a new bar, else
        // a new high or low. Nothing on the first quote.
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        let mut time = now;
        match bar {
            Some(b) => {
                time = b.time.min(now);
                if let Some(seen) = self.seen.get(symbol) {
                    if b.time > seen.time || b.high > seen.high {
                        hi = b.high;
                    }
                    if b.time > seen.time || b.low < seen.low {
                        lo = b.low;
                    }
                }
                self.seen.insert(symbol.to_string(), SeenBar { time: b.time, high: b.high, low: b.low });
            }
            None => {
                self.seen.remove(symbol);
            }
        }
        // The time never goes back (a quote without bar is stamped "now").
        let seen_last = self.last.entry(symbol.to_string()).or_insert(time);
        time = time.max(*seen_last);
        *seen_last = time;
        let with_range = |price: f64| Sample { price, lo: lo.min(price), hi: hi.max(price), time, extended: false };
        let grids = &self.grids;
        self.rules
            .values_mut()
            .filter(|(r, st)| r.symbol == symbol && !st.replaying)
            .filter_map(|(r, st)| {
                let grid = grids.get(&r.grid);
                let s = match bar {
                    None => Sample::point(last, time),
                    // A pre- or post-market trade: only extended-hours bars move.
                    Some(b) if !grid.map_or(true, |g| g.in_regular(b.time)) => Sample { extended: true, ..with_range(b.close) },
                    // Extended-hours bars follow every trade.
                    Some(b) if grid.is_some_and(|g| g.extended_hours) => with_range(b.close),
                    // Regular hours read the regular-session last, with the
                    // bar's range when the bar holds it.
                    Some(b) if b.low <= last && last <= b.high => with_range(last),
                    Some(_) => Sample::point(last, time),
                };
                let more: Vec<Option<&EngineGrid>> = r.and.iter().map(|c| grids.get(&c.grid)).collect();
                r.step(st, s, grid, &more)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(op: &str, shape: &str, frequency: &str, values: &[f64]) -> EngineRule {
        EngineRule {
            id: "r".into(),
            symbol: "X:A".into(),
            sig: "1".into(),
            op: op.into(),
            shape: shape.into(),
            frequency: frequency.into(),
            expires_at: None,
            since: 0.0,
            grid: "g".into(),
            values: values.to_vec(),
            per_bar: None,
            absent_is_outside: false,
            and: Vec::new(),
        }
    }

    fn bar(time: f64, open: f64, high: f64, low: f64, close: f64) -> Candle {
        Candle { time, open, high, low, close, volume: 0.0 }
    }

    /// Five-minute bars from 0 to 1500 s.
    fn grid() -> EngineGrid {
        EngineGrid { key: "g".into(), bars: (0..5).map(|i| (i as f64 * 300.0, (i + 1) as f64 * 300.0)).collect(), ..EngineGrid::default() }
    }

    fn engine(rules: Vec<EngineRule>) -> Engine {
        let mut e = Engine::default();
        assert!(e.set(rules, vec![grid()], 0.0).is_empty());
        e
    }

    #[test]
    fn crossing_needs_a_previous_sample_and_fires_once() {
        let mut e = engine(vec![rule("crossing_up", "level", "every_time", &[100.0])]);
        assert!(e.sample("X:A", 99.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 101.0, None, 15.0).len(), 1);
        assert!(e.sample("X:A", 102.0, None, 20.0).is_empty());
        assert!(e.sample("X:B", 101.0, None, 20.0).is_empty());
    }

    #[test]
    fn a_spike_between_two_quotes_fires_from_the_bar_high() {
        let mut e = engine(vec![rule("crossing_up", "level", "every_time", &[100.0])]);
        assert!(e.sample("X:A", 99.0, Some(&bar(0.0, 99.0, 99.5, 98.5, 99.0)), 10.0).is_empty());
        // Same minute bar, new high above the level, price back under it.
        let fires = e.sample("X:A", 99.2, Some(&bar(0.0, 99.0, 100.4, 98.5, 99.2)), 15.0);
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].price, 100.4);
        // The same high is not read a second time.
        assert!(e.sample("X:A", 99.3, Some(&bar(0.0, 99.0, 100.4, 98.5, 99.3)), 20.0).is_empty());
        // A new bar counts whole (a minute after the fire).
        assert_eq!(e.sample("X:A", 99.4, Some(&bar(60.0, 99.3, 100.1, 99.3, 99.4)), 76.0).len(), 1);
    }

    #[test]
    fn all_conditions_must_hold() {
        // Price crossing up 100 AND price less than 105.
        let mut r = rule("crossing_up", "level", "every_time", &[100.0]);
        r.and = vec![rule("less", "level", "every_time", &[105.0])];
        let mut e = engine(vec![r]);
        assert!(e.sample("X:A", 99.0, None, 10.0).is_empty());
        // Crosses 100 but jumps above 105: the second condition is not met.
        assert!(e.sample("X:A", 106.0, None, 20.0).is_empty());
        assert!(e.sample("X:A", 99.0, None, 30.0).is_empty());
        // Crosses 100 and stays under 105: fires at the first condition's price.
        let fires = e.sample("X:A", 101.0, None, 40.0);
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].price, 101.0);
    }

    #[test]
    fn each_condition_keeps_its_own_memory() {
        // Price greater than 100 AND price crossing up 110: the crossing reads its own previous sample even while the
        // first condition is not met.
        let mut r = rule("greater", "level", "every_time", &[100.0]);
        r.and = vec![rule("crossing_up", "level", "every_time", &[110.0])];
        let mut e = engine(vec![r]);
        assert!(e.sample("X:A", 90.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 111.0, None, 20.0).len(), 1);
        // Above both: no new crossing.
        assert!(e.sample("X:A", 112.0, None, 90.0).is_empty());
    }

    #[test]
    fn every_time_fires_at_most_once_a_minute() {
        let mut e = engine(vec![rule("greater", "level", "every_time", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 102.0, None, 40.0).is_empty());
        assert!(e.sample("X:A", 102.0, None, 69.0).is_empty());
        assert_eq!(e.sample("X:A", 102.0, None, 70.0).len(), 1);
    }

    #[test]
    fn the_first_bar_seen_gives_no_range() {
        let mut e = engine(vec![rule("greater", "level", "every_time", &[100.0])]);
        assert!(e.sample("X:A", 99.0, Some(&bar(0.0, 99.0, 101.0, 98.0, 99.0)), 10.0).is_empty());
    }

    #[test]
    fn once_per_bar_and_only_once() {
        let mut e = engine(vec![rule("greater", "level", "once_per_bar", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0)[0].bar_time, Some(0.0));
        assert!(e.sample("X:A", 102.0, None, 200.0).is_empty());
        assert_eq!(e.sample("X:A", 102.0, None, 310.0)[0].bar_time, Some(300.0));

        let mut e = engine(vec![rule("greater", "level", "only_once", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 102.0, None, 400.0).is_empty());
    }

    #[test]
    fn once_per_bar_close_compares_the_closes() {
        let mut e = engine(vec![rule("crossing_up", "level", "once_per_bar_close", &[100.0])]);
        assert!(e.sample("X:A", 99.0, None, 10.0).is_empty());
        // Above the level inside the bar, back under it at the close.
        assert!(e.sample("X:A", 101.0, None, 100.0).is_empty());
        assert!(e.sample("X:A", 99.5, None, 290.0).is_empty());
        // Bar 0 closed at 99.5 (first close: no fire). Bar 300 closes above.
        assert!(e.sample("X:A", 100.5, None, 310.0).is_empty());
        let fires = e.sample("X:A", 100.6, None, 610.0);
        assert_eq!(fires.len(), 1);
        assert_eq!((fires[0].price, fires[0].bar_time), (100.5, Some(300.0)));
    }

    #[test]
    fn band_conditions() {
        let mut e = engine(vec![rule("entering", "band", "every_time", &[110.0, 100.0])]);
        assert!(e.sample("X:A", 95.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 105.0, None, 15.0).len(), 1);
        assert!(e.sample("X:A", 106.0, None, 20.0).is_empty());

        let mut e = engine(vec![rule("exiting", "band", "every_time", &[100.0, 110.0])]);
        assert!(e.sample("X:A", 105.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 111.0, None, 15.0).len(), 1);

        // A rectangle outside its dates: the price is outside it.
        let mut r = rule("outside", "band", "every_time", &[]);
        r.absent_is_outside = true;
        assert_eq!(engine(vec![r]).sample("X:A", 105.0, None, 10.0).len(), 1);
        assert!(engine(vec![rule("outside", "band", "every_time", &[])]).sample("X:A", 105.0, None, 10.0).is_empty());
    }

    #[test]
    fn position_and_time() {
        let mut e = engine(vec![rule("hits_level", "position", "every_time", &[100.0, 95.0, 110.0])]);
        assert!(e.sample("X:A", 101.0, None, 10.0).is_empty());
        assert!(e.sample("X:A", 102.0, None, 15.0).is_empty());
        assert_eq!(e.sample("X:A", 99.0, None, 20.0)[0].price, 100.0);
        // The entry fires once; the profit level a few seconds later (no once-a-minute limit) ends the alert.
        assert!(e.sample("X:A", 101.0, None, 25.0).is_empty());
        assert_eq!(e.sample("X:A", 111.0, None, 30.0)[0].price, 110.0);
        assert!(e.sample("X:A", 99.0, None, 35.0).is_empty());
        // An exit before the entry was reached fires and ends it too.
        let mut e = engine(vec![rule("hits_level", "position", "only_once", &[100.0, 95.0, 110.0])]);
        assert!(e.sample("X:A", 97.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 94.0, None, 15.0)[0].price, 95.0);
        assert!(e.sample("X:A", 101.0, None, 20.0).is_empty());
        // Entry and stop passed in one move: the entry, then the stop at the next sample.
        let mut e = engine(vec![rule("hits_level", "position", "only_once", &[100.0, 95.0, 110.0])]);
        assert!(e.sample("X:A", 102.0, None, 10.0).is_empty());
        assert_eq!(e.sample("X:A", 94.0, None, 15.0)[0].price, 100.0);
        assert_eq!(e.sample("X:A", 94.0, None, 20.0)[0].price, 95.0);

        let mut e = engine(vec![rule("crossing", "time", "only_once", &[100.0])]);
        assert!(e.sample("X:A", 5.0, None, 90.0).is_empty());
        assert_eq!(e.sample("X:A", 5.0, None, 100.0).len(), 1);
    }

    #[test]
    fn per_bar_levels_follow_the_bars() {
        let mut r = rule("greater", "level", "every_time", &[]);
        r.per_bar = Some(vec![vec![100.0], vec![101.0], vec![], vec![103.0], vec![104.0]]);
        let mut e = engine(vec![r]);
        assert_eq!(e.sample("X:A", 100.5, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 100.5, None, 310.0).is_empty());
        // No value on the third bar, none after the last one.
        assert!(e.sample("X:A", 500.0, None, 610.0).is_empty());
        assert!(e.sample("X:A", 500.0, None, 1600.0).is_empty());
    }

    #[test]
    fn expiry_and_time_never_going_back() {
        let mut r = rule("greater", "level", "every_time", &[100.0]);
        r.expires_at = Some(50_000.0);
        let mut e = engine(vec![r]);
        assert_eq!(e.sample("X:A", 101.0, None, 10.0).len(), 1);
        assert!(e.sample("X:A", 101.0, None, 60.0).is_empty());

        let mut e = engine(vec![rule("greater", "level", "once_per_bar", &[100.0])]);
        assert_eq!(e.sample("X:A", 101.0, None, 310.0).len(), 1);
        // A quote with an older bar stays in the bar already reached.
        assert!(e.sample("X:A", 101.0, Some(&bar(60.0, 101.0, 101.0, 101.0, 101.0)), 320.0).is_empty());
    }

    #[test]
    fn memory_is_kept_while_the_rule_is_unchanged() {
        let mut e = engine(vec![rule("crossing_up", "level", "every_time", &[100.0])]);
        e.sample("X:A", 99.0, None, 10.0);
        e.set(vec![rule("crossing_up", "level", "every_time", &[100.0])], vec![grid()], 12.0);
        assert_eq!(e.sample("X:A", 101.0, None, 15.0).len(), 1);
        // A changed rule starts again from its first sample.
        let mut changed = rule("crossing_down", "level", "every_time", &[100.0]);
        changed.sig = "2".into();
        e.set(vec![changed], vec![grid()], 16.0);
        assert!(e.sample("X:A", 99.0, None, 20.0).is_empty());
    }

    #[test]
    fn replay_of_the_missed_bars() {
        let bars = [bar(60.0, 99.0, 99.5, 98.0, 99.0), bar(120.0, 99.0, 100.5, 99.0, 99.4), bar(180.0, 99.4, 99.6, 99.0, 99.2)];
        let r = rule("crossing_up", "level", "every_time", &[100.0]);
        let (st, fires) = replay_rule(&r, Some(&grid()), &[], &bars, 0.0);
        assert_eq!(fires.len(), 1);
        assert_eq!((fires[0].time, fires[0].price), (120.0, 100.5));
        assert_eq!(st.prev_diff, Some(99.2 - 100.0));
        // Bars at or before the start are not read; nor those outside the
        // regular session.
        assert!(replay_rule(&r, Some(&grid()), &[], &bars, 120.0).1.is_empty());
        let closed = EngineGrid { regular: vec![(0.0, 100.0)], ..grid() };
        assert!(replay_rule(&r, Some(&closed), &[], &bars, 0.0).1.is_empty());
    }

    #[test]
    fn quotes_outside_the_session_are_not_read() {
        // Regular hours from 0 to 600 s and from 1200 s (two bars of 300 s
        // each); extended hours from -300 to 900 s and from 900 s.
        let rth = || EngineGrid {
            key: "g".into(),
            bars: vec![(0.0, 300.0), (300.0, 600.0), (1200.0, 1500.0), (1500.0, 1800.0)],
            regular: vec![(0.0, 600.0), (1200.0, 1800.0)],
            session: vec![(0.0, 600.0), (1200.0, 1800.0)],
            ..EngineGrid::default()
        };
        let eth = || EngineGrid {
            bars: vec![(-300.0, 0.0), (0.0, 300.0), (300.0, 600.0), (600.0, 900.0), (900.0, 1200.0), (1200.0, 1500.0)],
            session: vec![(-300.0, 900.0), (900.0, 2100.0)],
            extended_hours: true,
            ..rth()
        };
        let pre = bar(-120.0, 101.0, 101.0, 101.0, 101.0);
        let mut e = Engine::default();
        e.set(vec![rule("greater", "level", "once_per_bar", &[100.0])], vec![rth()], 0.0);
        // A pre-market trade, then a quote without trade after the close: nothing.
        assert!(e.sample("X:A", 99.0, Some(&pre), -100.0).is_empty());
        assert!(e.sample("X:A", 101.0, None, 700.0).is_empty());
        // Inside: the bar of the session's own grid.
        assert_eq!(e.sample("X:A", 101.0, None, 1210.0)[0].bar_time, Some(1200.0));
        // On regular hours the regular-session last is read, not the trade.
        let mut e = Engine::default();
        e.set(vec![rule("greater", "level", "once_per_bar", &[100.0])], vec![rth()], 0.0);
        assert!(e.sample("X:A", 99.0, Some(&bar(60.0, 101.0, 101.0, 101.0, 101.0)), 70.0).is_empty());
        // On extended hours a pre-market trade is read, at its price.
        let mut e = Engine::default();
        e.set(vec![rule("greater", "level", "once_per_bar", &[100.0])], vec![eth()], 0.0);
        let fires = e.sample("X:A", 99.0, Some(&pre), -100.0);
        assert_eq!((fires.len(), fires[0].bar_time, fires[0].price), (1, Some(-300.0), 101.0));
        // ... and a post-market one in its own bar.
        assert_eq!(e.sample("X:A", 99.0, Some(&bar(660.0, 101.0, 101.0, 101.0, 101.0)), 700.0)[0].bar_time, Some(600.0));

        // Once per bar close: the session's last bar closes on the first quote
        // after it, which is not read itself.
        let mut e = Engine::default();
        e.set(vec![rule("greater", "level", "once_per_bar_close", &[100.0])], vec![rth()], 0.0);
        assert!(e.sample("X:A", 101.0, None, 400.0).is_empty());
        let fires = e.sample("X:A", 99.0, None, 700.0);
        assert_eq!((fires.len(), fires[0].bar_time, fires[0].price), (1, Some(300.0), 101.0));
        assert!(e.sample("X:A", 101.0, None, 1210.0).is_empty());
        assert!(e.sample("X:A", 101.0, None, 1220.0).is_empty());
        assert_eq!(e.sample("X:A", 101.0, None, 1510.0)[0].bar_time, Some(1200.0));

        // The replay reads the minutes of the rule's session.
        let minutes = [bar(-120.0, 101.0, 101.0, 101.0, 101.0), bar(660.0, 101.0, 101.0, 101.0, 101.0)];
        let r = rule("greater", "level", "once_per_bar", &[100.0]);
        assert!(replay_rule(&r, Some(&rth()), &[], &minutes, -1000.0).1.is_empty());
        let fires: Vec<_> = replay_rule(&r, Some(&eth()), &[], &minutes, -1000.0).1.iter().map(|f| f.bar_time).collect();
        assert_eq!(fires, vec![Some(-300.0), Some(600.0)]);
    }

    #[test]
    fn replay_only_after_a_previous_run() {
        let now = 1_000_000.0;
        let mut e = Engine::default();
        assert!(e.set(vec![rule("greater", "level", "every_time", &[100.0])], vec![grid()], now).is_empty());

        let mut e = Engine { previous: Some(HashMap::from([("X:A".to_string(), now - 3600.0)])), ..Engine::default() };
        let jobs = e.set(vec![rule("greater", "level", "every_time", &[100.0])], vec![grid()], now);
        assert_eq!((jobs.len(), jobs[0].from), (1, now - 3600.0));
        // Quotes wait for the replay, which leaves the rule ready.
        assert!(e.sample("X:A", 101.0, None, now).is_empty());
        // Its open and its close are in the same minute: one fire (every time = once a minute).
        let fires = e.finish_replay(&jobs[0], Some(&[bar(now - 600.0, 101.0, 101.0, 101.0, 101.0)]));
        assert_eq!(fires.len(), 1);
        assert_eq!(e.sample("X:A", 101.0, None, now + 5.0).len(), 1);
        // The same rules again: nothing to replay.
        assert!(e.set(vec![rule("greater", "level", "every_time", &[100.0])], vec![grid()], now).is_empty());

        // A rule that became active a moment ago has missed nothing.
        let mut e = Engine { previous: Some(HashMap::from([("X:A".to_string(), now - 3600.0)])), ..Engine::default() };
        let mut fresh = rule("greater", "level", "every_time", &[100.0]);
        fresh.since = (now - 10.0) * 1000.0;
        assert!(e.set(vec![fresh], vec![grid()], now).is_empty());
    }
}
