/*
 * The evaluation of an alert condition, one sample at a time: the same code as
 * the backend's engine (src-tauri/crates/core/src/alerts/engine.rs), so a rule
 * fires the same way whichever side reads it. The shared vectors
 * (src-tauri/crates/core/src/alerts/vectors.json) run on both and pin it.
 *
 * A sample is the price at one moment with the range it went through since the
 * previous sample (the ticks coalesced into it): "greater" fires on its high,
 * "less" on its low, "inside" when the range touches the band. A single value
 * (a study's) is a sample whose range is that value.
 *
 * Pure: no store, no clock. The backend's rules go through `AlertEvalEngine`
 * (the web build runs it in the window); the rules only the window can read (a
 * study, an anchored VWAP, a moving amount) call `stepRule` with their own
 * reader (alert-engine.ts) and with two shapes the backend does not have: "flag"
 * (a study's own condition, [1] when true) and "moving" ([the value N bars back]).
 */

/** Every time: seconds between two fires at least. */
export const EVERY_TIME_SEC = 60;
/** Oldest time a replay goes back to, in seconds. */
export const REPLAY_MAX_SEC = 30 * 86_400;
/** A gap shorter than this (seconds) is not replayed: the next quote covers it. */
export const REPLAY_MIN_GAP_SEC = 120;
/** Most offline fires kept per rule (the latest ones). */
export const REPLAY_MAX_FIRES = 50;

/** The price at one moment and the range since the previous sample (`lo` / `hi` include `price`). */
export type Sample = {
  price: number;
  lo: number;
  hi: number;
  /** UNIX seconds. */
  time: number;
  /** The trade is pre- or post-market. */
  extended: boolean;
};

export const pointSample = (price: number, time: number): Sample => ({ price, lo: price, hi: price, time, extended: false });

/** A minute bar, UNIX seconds. */
export type MinuteBar = { time: number; open: number; high: number; low: number; close: number };

/** One condition as the evaluation reads it. `shape`: what its values hold — "level" [price], "band" [bound, bound],
 *  "position" [entry, stop, target], "time" [UNIX seconds], "flag" [1 | 0], "moving" [value N bars back]. */
export type EvalCondition = { op: string; shape: string; absentIsOutside: boolean; /** Moving operators: the amount. */ amount?: number };

export type EvalRule = EvalCondition & {
  id: string;
  /** only_once | once_per_bar | once_per_bar_close | every_time */
  frequency: string;
  /** UNIX ms after which the rule no longer fires. */
  expiresAt: number | null;
  /** The conditions after the first one: the rule fires when all of them hold with the first. */
  and: EvalCondition[];
};

/** Memory of one condition between two samples. */
export type CondState = {
  /** Value minus level at the previous sample (crossings). */
  prevDiff: number | null;
  /** Inside the band at the previous sample (entering / exiting). */
  prevInside: boolean | null;
  prevPrice: number | null;
  prevTime: number | null;
};

/** A rule's evaluation memory. */
export type RuleState = CondState & {
  /** Bar of the last fire (once per bar, once per bar close). */
  lastFiredBar: number | null;
  /** Time of the last fire (every time: at most once a minute). */
  lastFiredAt: number | null;
  /** Once per bar close: the forming bar, its latest sample and the values each condition read then. */
  forming: { bar: number; sample: Sample; values: (number[] | null)[] } | null;
  /** "Only once" has fired, or a position reached its stop or target. */
  done: boolean;
  /** A position's entry has fired (it fires once). */
  entryHit: boolean;
  /** Its missed bars are being replayed: live quotes wait. */
  replaying: boolean;
  /** Memory of the conditions after the first one. */
  and: CondState[];
};

const newCondState = (): CondState => ({ prevDiff: null, prevInside: null, prevPrice: null, prevTime: null });

export function newRuleState(): RuleState {
  return { ...newCondState(), lastFiredBar: null, lastFiredAt: null, forming: null, done: false, entryHit: false, replaying: false, and: [] };
}

export type EvalFire = {
  ruleId: string;
  price: number;
  /** UNIX seconds of the sample that fired. */
  time: number;
  /** Open time of the bar it fired in, when known. */
  barTime: number | null;
};

/** What a rule reads besides the sample. */
export type RuleReader = {
  /** Open time of the bar holding `t` (else of the next one to open); null when none is known. */
  bar(t: number): number | null;
  /** The sample is within the rule's session (out of it the rule's bars do not move: nothing is read). */
  inSession(s: Sample): boolean;
  /** The values of condition `k` (0: the first one) at `t`; null when it has none then. */
  values(k: number, t: number): number[] | null;
};

/** The price the condition is met at for this sample, if it is. Updates the memory the next sample compares with. */
export function evalCondition(c: EvalCondition, st: CondState, s: Sample, values: number[] | null): number | null {
  const vals = values && values.length > 0 ? values : null;
  switch (c.shape) {
    // Vertical line: the time reaches it.
    case "time": {
      if (!vals) return null;
      const line = vals[0];
      const prev = st.prevTime;
      st.prevTime = s.time;
      return prev != null && prev < line && s.time >= line ? s.price : null;
    }
    // Position: a level lies on the way from the previous price.
    case "position": {
      const prev = st.prevPrice;
      st.prevPrice = s.price;
      if (!vals || prev == null) return null;
      const lo = Math.min(s.lo, prev);
      const hi = Math.max(s.hi, prev);
      if (lo === hi) return null;
      return vals.find((l) => l >= lo && l <= hi && l !== prev) ?? null;
    }
    case "band": {
      const band = vals && vals.length >= 2 ? { lower: Math.min(vals[0], vals[1]), upper: Math.max(vals[0], vals[1]) } : null;
      if (c.op === "greater") {
        if (!band) return null;
        return s.hi > band.upper ? (s.price > band.upper ? s.price : s.hi) : null;
      }
      if (c.op === "less") {
        if (!band) return null;
        return s.lo < band.lower ? (s.price < band.lower ? s.price : s.lo) : null;
      }
      if (!band && !c.absentIsOutside) return null;
      const inside = !!band && s.price >= band.lower && s.price <= band.upper;
      const touched = !!band && s.hi >= band.lower && s.lo <= band.upper;
      const left = !band || s.hi > band.upper || s.lo < band.lower;
      if (c.op === "inside") return touched ? s.price : null;
      if (c.op === "outside") return left ? s.price : null;
      const prev = st.prevInside;
      st.prevInside = inside;
      if (prev == null) return null;
      const met = c.op === "entering" ? !prev && touched : c.op === "exiting" ? prev && left : false;
      return met ? s.price : null;
    }
    // A study's own condition, true on the current bar.
    case "flag":
      return vals?.[0] === 1 ? s.price : null;
    // Moving up / down (%): the value now against its value N bars back, as an amount or in percent of it; up reads
    // the sample's high, down its low.
    case "moving": {
      if (!vals) return null;
      const ref = vals[0];
      const pct = c.op.endsWith("_pct");
      if (pct && ref === 0) return null;
      const amount = c.amount ?? 0;
      const change = (v: number) => (pct ? ((v - ref) / Math.abs(ref)) * 100 : v - ref);
      if (c.op.startsWith("moving_up")) return change(s.price) >= amount ? s.price : change(s.hi) >= amount ? s.hi : null;
      return change(s.price) <= -amount ? s.price : change(s.lo) <= -amount ? s.lo : null;
    }
    default: {
      if (!vals) return null;
      const level = vals[0];
      const above = () => (s.price > level ? s.price : s.hi);
      const below = () => (s.price < level ? s.price : s.lo);
      switch (c.op) {
        case "greater":
          return s.hi > level ? above() : null;
        case "less":
          return s.lo < level ? below() : null;
        case "crossing":
        case "crossing_up":
        case "crossing_down": {
          const prev = st.prevDiff;
          st.prevDiff = s.price - level;
          if (prev == null) return null;
          const up = prev <= 0 && s.hi > level;
          const down = prev >= 0 && s.lo < level;
          if (c.op === "crossing_up") return up ? above() : null;
          if (c.op === "crossing_down") return down ? below() : null;
          return up ? above() : down ? below() : null;
        }
        default:
          return null;
      }
    }
  }
}

/** All the conditions of the rule for this sample: the price the first one is met at when every one is met. Each
 *  condition reads the sample, so its memory moves on even when another one is not met. */
function evalConditions(rule: EvalRule, st: RuleState, s: Sample, values: (k: number) => number[] | null): number | null {
  const first = evalCondition(rule, st, s, values(0));
  if (rule.and.length === 0) return first;
  while (st.and.length < rule.and.length) st.and.push(newCondState());
  st.and.length = rule.and.length;
  let all = first != null;
  rule.and.forEach((c, i) => {
    all = evalCondition(c, st.and[i], s, values(i + 1)) != null && all;
  });
  return all ? first : null;
}

/** Evaluate one sample: the conditions, then the trigger rule. */
export function stepRule(rule: EvalRule, st: RuleState, s: Sample, reader: RuleReader): EvalFire | null {
  if (st.done || (rule.expiresAt != null && s.time * 1000 >= rule.expiresAt)) return null;
  const bar = reader.bar(s.time);
  const fire = (price: number, time: number, barTime: number | null): EvalFire => ({ ruleId: rule.id, price, time, barTime });
  // Out of the rule's session its bars do not move: nothing is read.
  const inside = reader.inSession(s);
  if (!inside && rule.frequency !== "once_per_bar_close") return null;
  // A long / short position fires as the trade it draws: once at its entry, then at its stop or profit level, which
  // ends the alert (its trigger is fixed). Its values are [entry, stop, target].
  if (rule.shape === "position") {
    const prev = st.prevPrice;
    st.prevPrice = s.price;
    const v = reader.values(0, s.time);
    if (!v || v.length === 0 || prev == null) return null;
    const [entry, ...exits] = v;
    const lo = Math.min(s.lo, prev);
    const hi = Math.max(s.hi, prev);
    const crossed = (l: number) => lo < hi && l >= lo && l <= hi && l !== prev;
    if (!st.entryHit && crossed(entry)) {
      st.entryHit = true;
      // The next sample reads the way on from the entry (a stop passed in the same move fires then).
      st.prevPrice = entry;
      return fire(entry, s.time, bar);
    }
    const exit = exits.find(crossed);
    if (exit === undefined) return null;
    st.done = true;
    return fire(exit, s.time, bar);
  }
  const read = (k: number) => reader.values(k, s.time);
  switch (rule.frequency) {
    // The bar that just closed is judged on its last sample, so a crossing compares close with close.
    case "once_per_bar_close": {
      let closed: NonNullable<RuleState["forming"]>;
      if (inside) {
        if (bar == null) return null;
        const prev = st.forming;
        st.forming = { bar, sample: s, values: [0, ...rule.and.map((_, i) => i + 1)].map(read) };
        if (!prev || prev.bar === bar) return null;
        closed = prev;
      } else {
        // No sample, but the session's last bar has closed.
        if (!st.forming) return null;
        closed = st.forming;
        st.forming = null;
      }
      const last = closed.sample;
      const price = evalConditions(rule, st, pointSample(last.price, last.time), (k) => closed.values[k] ?? null);
      if (price == null || st.lastFiredBar === closed.bar) return null;
      st.lastFiredBar = closed.bar;
      return fire(price, last.time, closed.bar);
    }
    case "once_per_bar": {
      const price = evalConditions(rule, st, s, read);
      if (price == null || bar == null || st.lastFiredBar === bar) return null;
      st.lastFiredBar = bar;
      return fire(price, s.time, bar);
    }
    // "Once per minute while condition remains met".
    case "every_time": {
      const price = evalConditions(rule, st, s, read);
      if (price == null) return null;
      if (st.lastFiredAt != null && s.time - st.lastFiredAt < EVERY_TIME_SEC) return null;
      st.lastFiredAt = s.time;
      return fire(price, s.time, bar);
    }
    default: {
      const price = evalConditions(rule, st, s, read);
      if (price == null) return null;
      st.done = rule.frequency === "only_once";
      return fire(price, s.time, bar);
    }
  }
}

// ── The backend's rules: compiled values on a grid of bars ──

/** A rule as the backend takes it (bindings' EngineRule, with plain numbers). */
export type GridRule = EvalRule & {
  symbol: string;
  /** Changes whenever the condition or what it reads changes: the memory is kept only while it stays the same. */
  sig: string;
  /** UNIX ms the rule became active: a replay never starts before it. */
  since: number;
  /** Key of the bars of the rule's interval. */
  grid: string;
  /** Values that hold at any time. */
  values: number[];
  /** Values per bar of the grid; an empty entry = no value on that bar. Replaces `values`. */
  perBar: number[][] | null;
  and: GridRule[];
};

/** Bars (open, close) of one symbol on one interval and session, ascending, UNIX seconds. */
export type Grid = {
  key: string;
  bars: [number, number][];
  /** Regular-session intervals: tell a pre- or post-market trade from a regular one. Empty = all regular. */
  regular: [number, number][];
  /** Hours of the rule's session: a quote outside them is not read. Empty = always. */
  session?: [number, number][];
  /** The session is the extended one: a pre- or post-market trade is read. */
  extendedHours?: boolean;
};

/** Index of the bar containing `t`, else of the next one to open. */
function gridBarIndex(g: Grid, t: number): number | null {
  let lo = 0;
  let hi = g.bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.bars[mid][1] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo < g.bars.length ? lo : null;
}

const within = (ivs: [number, number][], t: number) => ivs.some((iv) => t >= iv[0] && t < iv[1]);
const gridInRegular = (g: Grid, t: number) => g.regular.length === 0 || within(g.regular, t);
const gridInSession = (g: Grid, s: Sample) => (!!g.extendedHours || !s.extended) && (!g.session?.length || within(g.session, s.time));
/** True when a minute bar opening at `t` is one of the rule's bars. */
const gridReadsMinute = (g: Grid, t: number) => gridInSession(g, { ...pointSample(0, t), extended: !gridInRegular(g, t) });

function valuesAt(r: GridRule, t: number, grid: Grid | undefined): number[] | null {
  let v: number[] | undefined;
  if (r.perBar) {
    const i = grid ? gridBarIndex(grid, t) : null;
    v = i == null ? undefined : r.perBar[i];
  } else v = r.values;
  return v && v.length > 0 ? v : null;
}

/** The reader of a compiled rule: its grid's bars and session, its compiled values. */
export function gridReader(rule: GridRule, grid: Grid | undefined, more: (Grid | undefined)[]): RuleReader {
  return {
    bar: (t) => {
      const i = grid ? gridBarIndex(grid, t) : null;
      return i == null ? null : grid!.bars[i][0];
    },
    inSession: (s) => !grid || gridInSession(grid, s),
    values: (k, t) => (k === 0 ? valuesAt(rule, t, grid) : rule.and[k - 1] ? valuesAt(rule.and[k - 1], t, more[k - 1]) : null),
  };
}

/** Run a rule over the minute bars after `from` (UNIX seconds): the state it ends in and what fired (the latest
 *  REPLAY_MAX_FIRES). Each bar of the rule's session is read as its open, then its close with the bar's range. */
export function replayGridRule(rule: GridRule, grid: Grid | undefined, more: (Grid | undefined)[], bars: MinuteBar[], from: number): { state: RuleState; fires: EvalFire[] } {
  const reader = gridReader(rule, grid, more);
  const state = newRuleState();
  const fires: EvalFire[] = [];
  for (const b of bars) {
    if (b.time <= from || (grid && !gridReadsMinute(grid, b.time))) continue;
    const close: Sample = { price: b.close, lo: Math.min(b.low, b.close), hi: Math.max(b.high, b.close), time: b.time, extended: false };
    for (const s of [pointSample(b.open, b.time), close]) {
      const f = stepRule(rule, state, s, reader);
      if (f) fires.push(f);
    }
  }
  return { state, fires: fires.slice(-REPLAY_MAX_FIRES) };
}

/** Bars to replay for the rules of one symbol. */
export type ReplayJob = { symbol: string; /** UNIX seconds: bars after it are replayed. */ from: number; rules: { rule: GridRule; grid?: Grid; more: (Grid | undefined)[] }[] };

/** The range each symbol's quotes went through since the previous one, from the minute bar that comes with a quote:
 *  all of a new bar, else a new high or low; nothing on the first quote. The time never goes back (a quote without
 *  bar is stamped `now`). */
export class QuoteRanges {
  private seen = new Map<string, { time: number; high: number; low: number }>();
  /** Time of each symbol's last sample. */
  readonly last = new Map<string, number>();

  take(symbol: string, bar: MinuteBar | null, now: number): { lo: number; hi: number; time: number } {
    let lo = Infinity;
    let hi = -Infinity;
    let time = now;
    if (bar) {
      time = Math.min(bar.time, now);
      const seen = this.seen.get(symbol);
      if (seen) {
        if (bar.time > seen.time || bar.high > seen.high) hi = bar.high;
        if (bar.time > seen.time || bar.low < seen.low) lo = bar.low;
      }
      this.seen.set(symbol, { time: bar.time, high: bar.high, low: bar.low });
    } else this.seen.delete(symbol);
    time = Math.max(time, this.last.get(symbol) ?? time);
    this.last.set(symbol, time);
    return { lo, hi, time };
  }
}

/** The sample a rule reads from one quote: `last` the regular-session last, `bar` the latest minute bar (its close
 *  the latest trade, pre- and post-market included). `regularTrade`: the bar is in the regular session; `extendedHours`:
 *  the rule reads the extended session. */
export function quoteSample(range: { lo: number; hi: number; time: number }, last: number, bar: MinuteBar | null, regularTrade: boolean, extendedHours: boolean): Sample {
  const withRange = (price: number): Sample => ({ price, lo: Math.min(range.lo, price), hi: Math.max(range.hi, price), time: range.time, extended: false });
  if (!bar) return pointSample(last, range.time);
  // A pre- or post-market trade: only extended-hours bars move.
  if (!regularTrade) return { ...withRange(bar.close), extended: true };
  // Extended-hours bars follow every trade.
  if (extendedHours) return withRange(bar.close);
  // Regular hours read the regular-session last, with the bar's range when the bar holds it.
  if (bar.low <= last && last <= bar.high) return withRange(last);
  return pointSample(last, range.time);
}

/** The backend's engine: its rules with their memory, fed one quote at a time. The desktop runs it in Rust; the web
 *  build runs this one in the window. */
export class AlertEvalEngine {
  private rules = new Map<string, { rule: GridRule; st: RuleState }>();
  private grids = new Map<string, Grid>();
  private ranges = new QuoteRanges();

  /** `previous`: the time of each symbol's last sample in the previous run; null on the very first run (nothing is
   *  replayed then). */
  constructor(private previous: Map<string, number> | null = null) {}

  /** Time of each symbol's last sample, this run. */
  get last(): Map<string, number> {
    return this.ranges.last;
  }

  /** Replace the rules. A rule whose `sig` is unchanged keeps its memory. Returns the replays to run for the rules
   *  seen for the first time. */
  set(rules: GridRule[], grids: Grid[], now: number): ReplayJob[] {
    this.grids = new Map(grids.map((g) => [g.key, g]));
    const old = this.rules;
    this.rules = new Map();
    const jobs = new Map<string, ReplayJob>();
    for (const rule of rules) {
      const was = old.get(rule.id);
      const kept = was && was.rule.sig === rule.sig ? was.st : null;
      const st = kept ?? newRuleState();
      if (!kept) {
        const from = this.replayFrom(rule, now);
        if (from != null) {
          st.replaying = true;
          let job = jobs.get(rule.symbol);
          if (!job) jobs.set(rule.symbol, (job = { symbol: rule.symbol, from, rules: [] }));
          job.from = Math.min(job.from, from);
          job.rules.push({ rule, grid: this.grids.get(rule.grid), more: rule.and.map((c) => this.grids.get(c.grid)) });
        }
      }
      this.rules.set(rule.id, { rule, st });
    }
    return [...jobs.values()];
  }

  /** Where a new rule's replay starts: the symbol's last sample of the previous run, not before the rule became
   *  active. Null when there is nothing to replay. */
  private replayFrom(rule: GridRule, now: number): number | null {
    if (!this.previous) return null;
    const since = rule.since / 1000;
    const prev = this.previous.get(rule.symbol);
    const from = Math.max(prev == null ? since : Math.max(prev, since), now - REPLAY_MAX_SEC);
    return now - from > REPLAY_MIN_GAP_SEC ? from : null;
  }

  /** End a replay: each rule takes the state its bars left it in (null: the bars could not be read, the rules start
   *  from the next quote). */
  finishReplay(job: ReplayJob, bars: MinuteBar[] | null): EvalFire[] {
    const fires: EvalFire[] = [];
    for (const { rule, grid, more } of job.rules) {
      const current = this.rules.get(rule.id);
      if (!current || current.rule.sig !== rule.sig || !current.st.replaying) continue;
      const from = Math.max(job.from, rule.since / 1000);
      const out = bars ? replayGridRule(rule, grid, more, bars, from) : { state: newRuleState(), fires: [] };
      current.st = out.state;
      fires.push(...out.fires);
    }
    return fires;
  }

  /** One quote of `symbol`: the regular-session last and the latest minute bar. Returns what fires. */
  sample(symbol: string, last: number, bar: MinuteBar | null, now: number): EvalFire[] {
    const range = this.ranges.take(symbol, bar, now);
    const fires: EvalFire[] = [];
    for (const { rule, st } of this.rules.values()) {
      if (rule.symbol !== symbol || st.replaying) continue;
      const grid = this.grids.get(rule.grid);
      const s = quoteSample(range, last, bar, !bar || !grid || gridInRegular(grid, bar.time), !!grid?.extendedHours);
      const f = stepRule(rule, st, s, gridReader(rule, grid, rule.and.map((c) => this.grids.get(c.grid))));
      if (f) fires.push(f);
    }
    return fires;
  }
}
