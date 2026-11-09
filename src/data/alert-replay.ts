/*
 * Alerts found after the fact: the rules the window evaluates (on a study, an
 * anchored VWAP, a moving percentage) read again over the bars missed while
 * the app was not running.
 *
 * The rule is read bar by bar on its own interval and session with the
 * evaluation of the live samples (alert-eval.ts), each operand at its value
 * of the bar:
 *  - the price: two samples per bar, its open, then its close with the bar's
 *    range (as the backend replays its minute bars); a rule that waits for the
 *    bar to close reads the closes only;
 *  - a study: one sample per bar, its value at the close (a sample whose range
 *    is that value);
 *  - a study's own condition: true at the bar's close;
 *  - a script's alert() calls: the calls of the bar's last run (see
 *    replayAlertCalls).
 * The trigger frequency applies as live, one fire per bar at most, dated at
 * the bar's close (now for the bar in progress). An alert with several
 * conditions: each condition is read that way on its own interval, and they
 * are read together at every bar close (see replayConditions).
 */
import type { AlertRule } from "./alert-store";
import type { StudyAlertCall } from "./alert-study-conditions";
import { evalCondition, newRuleState, pointSample, REPLAY_MAX_FIRES, stepRule, type EvalCondition, type Sample } from "./alert-eval";
import { isBandOperator, isMovingOperator } from "./alert-condition";

export { REPLAY_MAX_FIRES, REPLAY_MAX_SEC } from "./alert-eval";

export type ReplayBar = { time: number; open: number; high: number; low: number; close: number };
export type ReplayFire = { price: number; /** Open of the bar, epoch ms. */ barTime: number; /** Epoch ms. */ fireTime: number };

type ReplayRule = Pick<AlertRule, "op" | "frequency" | "bars" | "right">;

/** The condition of `rule` as the evaluation reads it (`banded`: the bounds of a channel are given). */
function evalConditionOf(rule: ReplayRule, banded: boolean): EvalCondition {
  if (isMovingOperator(rule.op)) return { op: rule.op, shape: "moving", absentIsOutside: false, amount: rule.right.kind === "value" ? rule.right.value : 0 };
  return { op: rule.op, shape: banded && isBandOperator(rule.op) ? "band" : "level", absentIsOutside: false };
}

/** Per bar of `rule`'s interval, the samples its condition reads and its values. `left`: the operand's value at each
 *  bar's close (null: the price); `right` / `lower`: the level, or the bounds of a channel. */
function barReader(rule: ReplayRule, bars: ReplayBar[], left: (number | null)[] | null, right: (number | null)[], lower: (number | null)[] | null) {
  const onClose = rule.frequency === "once_per_bar_close";
  const back = Math.max(1, Math.min(300, Math.round(rule.bars ?? 1)));
  const samples = (i: number): Sample[] => {
    const b = bars[i];
    const v = left?.[i];
    if (left) return v == null ? [] : [pointSample(v, b.time)];
    if (onClose) return [pointSample(b.close, b.time)];
    return [pointSample(b.open, b.time), { price: b.close, lo: Math.min(b.low, b.close), hi: Math.max(b.high, b.close), time: b.time, extended: false }];
  };
  const values = (i: number): number[] | null => {
    if (isMovingOperator(rule.op)) {
      const ref = i - back >= 0 ? (left ? left[i - back] : bars[i - back].close) : null;
      return ref == null ? null : [ref];
    }
    const a = right[i];
    if (a == null) return null;
    if (!lower) return [a];
    const c = lower[i];
    return c == null ? null : [a, c];
  };
  return { samples, values };
}

const closeOf = (bars: ReplayBar[], i: number, stepSec: number) => Math.min(bars[i].time + stepSec, bars[i + 1]?.time ?? Infinity);

/** Index of the first bar closing after `fromSec`, -1 when none does. */
const firstAfter = (bars: ReplayBar[], fromSec: number, stepSec: number) => bars.findIndex((_, k) => closeOf(bars, k, stepSec) > fromSec);

/** The fires of `rule` in the bars closing after `fromSec` (UNIX seconds, the
 *  last moment it was evaluated) up to `nowSec`. `left` / `right`: the value
 *  of each operand at the close of every bar (`left` null = the price);
 *  `stepSec`: length of a bar; `lower`: the lower bound of a channel
 *  between two bounds (`right` = the upper one). */
export function replayRule(
  rule: Pick<AlertRule, "op" | "frequency" | "expiresAt" | "bars" | "right">,
  bars: ReplayBar[],
  left: (number | null)[] | null,
  right: (number | null)[],
  fromSec: number,
  nowSec: number,
  stepSec: number,
  lower: (number | null)[] | null = null,
): ReplayFire[] {
  const cond = evalConditionOf(rule, lower != null);
  const evalRule = { ...cond, id: "", frequency: rule.frequency, expiresAt: rule.expiresAt, and: [] };
  const { samples, values } = barReader(rule, bars, left, right, lower);
  const st = newRuleState();
  const indexOf = new Map(bars.map((b, k) => [b.time, k]));
  let i = 0;
  // A sample is stamped with its bar's open, which is its bar. Out of session: the last bar read closes (below).
  let closing = false;
  const reader = { bar: (t: number) => t, inSession: () => !closing, values: () => values(i) };
  const fires: ReplayFire[] = [];
  const push = (f: { price: number; barTime: number | null } | null) => {
    const k = f?.barTime == null ? undefined : indexOf.get(f.barTime);
    if (!f || k === undefined) return;
    // A study's fire gives the bar's close.
    fires.push({ price: left ? bars[k].close : f.price, barTime: bars[k].time * 1000, fireTime: Math.min(closeOf(bars, k, stepSec), nowSec) * 1000 });
  };
  const first = firstAfter(bars, fromSec, stepSec);
  if (first < 0) return [];
  // The bar before the first one read: what a crossing or a channel compares with.
  if (first > 0) for (const s of samples(first - 1)) evalCondition(cond, st, s, values(first - 1));
  for (i = first; i < bars.length && bars[i].time < nowSec; i++) {
    for (const s of samples(i)) push(stepRule(evalRule, st, s, reader));
  }
  // A rule on the close: the last bar read has closed when its close is past, even before the next one comes.
  i--;
  if (rule.frequency === "once_per_bar_close" && i >= first && closeOf(bars, i, stepSec) <= nowSec) {
    closing = true;
    push(stepRule(evalRule, st, pointSample(bars[i].close, bars[i].time), reader));
  }
  return fires.slice(-REPLAY_MAX_FIRES);
}

/** Per bar, whether one condition is met at the bar's close (the price a fire gives, null when not met), read as
 *  replayRule reads it without its trigger; the bars closing at `fromSec` or before are not read. */
export function ruleFlags(
  rule: ReplayRule,
  bars: ReplayBar[],
  left: (number | null)[] | null,
  right: (number | null)[],
  fromSec: number,
  stepSec: number,
  lower: (number | null)[] | null = null,
): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  const cond = evalConditionOf(rule, lower != null);
  const { samples, values } = barReader(rule, bars, left, right, lower);
  const st = newRuleState();
  const first = firstAfter(bars, fromSec, stepSec);
  if (first < 0) return out;
  for (let i = Math.max(0, first - 1); i < bars.length; i++) {
    for (const s of samples(i)) {
      const price = evalCondition(cond, st, s, values(i));
      if (i >= first && price != null && out[i] == null) out[i] = left ? bars[i].close : price;
    }
  }
  return out;
}

/** One condition of a multi-condition alert for the replay: its bars (its own interval), per bar whether it is met at
 *  the bar's close, and how it holds: an event (a crossing, entering or exiting a channel) counts at its bar's close
 *  only, a state (a level, a channel, a moving amount, a study's condition) until its next bar closes. */
export type ReplayConditionSeries = {
  bars: ReplayBar[];
  stepSec: number;
  met: boolean[];
  event: boolean;
  /** The moment each bar closes (UNIX seconds: the end of its session for a daily or longer bar); unset: its time
   *  plus the interval, at most the next bar's time. */
  closes?: number[];
};

/** True for the operators that are an event in time (they hold at one moment). */
export function isEventOperator(op: AlertRule["op"]): boolean {
  return op === "crossing" || op === "crossing_up" || op === "crossing_down" || op === "entering" || op === "exiting";
}

/** The fires of a multi-condition alert in the bars closing after `fromSec` up to `nowSec`: every condition is read at
 *  each close of any of their bars (each on its own bars: the latest bar closed by then) and the alert fires when all
 *  hold, as the live evaluation does on one update. `frame`: the bars of the alert's interval (its first condition's),
 *  which the trigger counts in (one fire per bar, or at the bar's close only); the fire gives the close of a
 *  condition bar closing then. Closed bars only: the bar in progress is left to the live evaluation. */
export function replayConditions(
  rule: Pick<AlertRule, "frequency" | "expiresAt">,
  conds: ReplayConditionSeries[],
  frame: ReplayBar[],
  frameStepSec: number,
  fromSec: number,
  nowSec: number,
): ReplayFire[] {
  const closeOf = (bars: ReplayBar[], i: number, step: number) => Math.min(bars[i].time + step, bars[i + 1]?.time ?? Infinity);
  const closes = conds.map((c) => c.closes ?? c.bars.map((_, i) => closeOf(c.bars, i, c.stepSec)));
  const frameCloses = frame === conds[0]?.bars ? closes[0] : frame.map((_, i) => closeOf(frame, i, frameStepSec));
  const onClose = rule.frequency === "once_per_bar_close";
  // The moments read: every close (of the alert's own bars only, for a trigger at the bar's close).
  const times = [...new Set(onClose ? frameCloses : closes.flat())].filter((t) => t > fromSec && t <= nowSec).sort((a, b) => a - b);
  const at = conds.map(() => -1);
  const fires: ReplayFire[] = [];
  let lastFrame = -1;
  let f = 0;
  for (const t of times) {
    // The alert's bar this moment belongs to (the one it closes, or the one forming).
    while (f < frame.length - 1 && frameCloses[f] < t) f++;
    if (f >= frame.length || frame[f].time >= t) continue;
    if (rule.expiresAt != null && frame[f].time * 1000 >= rule.expiresAt) break;
    let all = true;
    let price: number | null = null;
    for (let k = 0; k < conds.length; k++) {
      const c = conds[k];
      while (at[k] + 1 < c.bars.length && closes[k][at[k] + 1] <= t) at[k]++;
      const i = at[k];
      if (i < 0 || !c.met[i] || (c.event && closes[k][i] !== t)) {
        all = false;
        continue;
      }
      if (closes[k][i] === t && price == null) price = c.bars[i].close;
    }
    if (!all) continue;
    if ((rule.frequency === "once_per_bar" || onClose) && lastFrame === f) continue;
    lastFrame = f;
    fires.push({ price: price ?? frame[f].close, barTime: frame[f].time * 1000, fireTime: t * 1000 });
    if (rule.frequency === "only_once") break;
  }
  return fires.slice(-REPLAY_MAX_FIRES);
}

/** The fires of a rule on a study's condition (`flags`: per bar, true when the condition is true at the bar's
 *  close) in the bars closing after `fromSec` up to `nowSec`: one per bar, at the bar's close (now for the bar in
 *  progress, except for a rule that waits for the close). */
export function replayCondition(
  rule: Pick<AlertRule, "frequency" | "expiresAt">,
  bars: ReplayBar[],
  flags: boolean[],
  fromSec: number,
  nowSec: number,
  stepSec: number,
): ReplayFire[] {
  const fires: ReplayFire[] = [];
  const onClose = rule.frequency === "once_per_bar_close";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = Math.min(b.time + stepSec, bars[i + 1]?.time ?? Infinity);
    if (close <= fromSec || b.time >= nowSec) continue;
    if (rule.expiresAt != null && b.time * 1000 >= rule.expiresAt) break;
    if (onClose && close > nowSec) continue;
    if (!flags[i]) continue;
    fires.push({ price: b.close, barTime: b.time * 1000, fireTime: Math.min(close, nowSec) * 1000 });
    if (rule.frequency === "only_once") break;
  }
  return fires.slice(-REPLAY_MAX_FIRES);
}

/** A fire of a script's alert() call: with the call's message. */
export type ReplayCallFire = ReplayFire & { message: string };

/** The fires of a rule on a script's alert() calls (`calls`: the calls of a run on the bars, each bar's calls being
 *  those of its last run) in the closed bars closing after `fromSec` up to `nowSec`, at the bar's close: per bar, the
 *  first call made once per bar and every call made once per bar close or on every update. The bar in progress is
 *  left to the live evaluation. */
export function replayAlertCalls(
  rule: Pick<AlertRule, "expiresAt">,
  bars: ReplayBar[],
  calls: StudyAlertCall[],
  fromSec: number,
  nowSec: number,
  stepSec: number,
): ReplayCallFire[] {
  const byBar = new Map<number, StudyAlertCall[]>();
  for (const c of calls) {
    const list = byBar.get(c.time);
    if (list) list.push(c);
    else byBar.set(c.time, [c]);
  }
  const fires: ReplayCallFire[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = Math.min(b.time + stepSec, bars[i + 1]?.time ?? Infinity);
    if (close <= fromSec || close > nowSec) continue;
    if (rule.expiresAt != null && b.time * 1000 >= rule.expiresAt) break;
    const list = byBar.get(b.time);
    if (!list) continue;
    let once = false;
    for (const c of list) {
      if (c.freq === "once_per_bar") {
        if (once) continue;
        once = true;
      }
      fires.push({ price: b.close, barTime: b.time * 1000, fireTime: close * 1000, message: c.message });
    }
  }
  return fires.slice(-REPLAY_MAX_FIRES);
}
