/*
 * Alerts found after the fact: the rules the window evaluates (on a study, an
 * anchored VWAP, a moving percentage) read again over the bars missed while
 * the app was not running.
 *
 * The rule is read bar by bar on its own interval and session, each bar with
 * the final value of its operands:
 *  - the price against a level: the level is reached when it lies within the
 *    bar's range; a crossing also needs the price on the other side before
 *    (the previous close) or after (the bar's close);
 *  - a study against a level, a rule that waits for the bar to close: the
 *    values at the close of two bars in a row, as on live samples;
 *  - a moving amount or percentage: the bar's high / low (or the study's
 *    value) against the value N bars back;
 *  - a channel between two bounds: the bar's range (or the study's value)
 *    against the bounds, entering / exiting against the previous bar;
 *  - a study's own condition: true at the bar's close;
 *  - a script's alert() calls: the calls of the bar's last run (see
 *    replayAlertCalls).
 * One fire per bar at most, at the bar's close (now for the bar in progress).
 */
import type { AlertRule } from "./alert-store";
import type { StudyAlertCall } from "./alert-study-conditions";

export type ReplayBar = { time: number; open: number; high: number; low: number; close: number };
export type ReplayFire = { price: number; /** Open of the bar, epoch ms. */ barTime: number; /** Epoch ms. */ fireTime: number };

/** Most fires found for one rule (the latest ones are kept). */
export const REPLAY_MAX_FIRES = 50;
/** How far back the bars are read, in seconds. */
export const REPLAY_MAX_SEC = 30 * 86_400;

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
  const fires: ReplayFire[] = [];
  const onClose = rule.frequency === "once_per_bar_close";
  let wasInside: boolean | null = null;
  // A rule on the close reads the closes only, like a study.
  const series = left ?? (onClose ? bars.map((b) => b.close) : null);
  const pct = rule.right.kind === "value" ? rule.right.value : 0;
  const back = Math.max(1, Math.min(300, Math.round(rule.bars ?? 1)));
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = Math.min(b.time + stepSec, bars[i + 1]?.time ?? Infinity);
    if (close <= fromSec || b.time >= nowSec) continue;
    if (rule.expiresAt != null && b.time * 1000 >= rule.expiresAt) break;
    // The bar in progress has no close yet.
    if (onClose && close > nowSec) continue;
    let price: number | null = null;
    if (rule.op === "moving_up_pct" || rule.op === "moving_down_pct") {
      const up = rule.op === "moving_up_pct";
      const ref = i - back >= 0 ? (left ? left[i - back] : bars[i - back].close) : null;
      const now = series ? series[i] : up ? b.high : b.low;
      if (ref == null || ref === 0 || now == null) continue;
      const change = ((now - ref) / Math.abs(ref)) * 100;
      if (up ? change >= pct : change <= -pct) price = series ? b.close : ref + (up ? 1 : -1) * Math.abs(ref) * (pct / 100);
    } else if (rule.op === "moving_up" || rule.op === "moving_down") {
      const up = rule.op === "moving_up";
      const ref = i - back >= 0 ? (left ? left[i - back] : bars[i - back].close) : null;
      const now = series ? series[i] : up ? b.high : b.low;
      if (ref == null || now == null) continue;
      if (up ? now - ref >= pct : now - ref <= -pct) price = series ? b.close : ref + (up ? pct : -pct);
    } else if (lower && (rule.op === "entering" || rule.op === "exiting" || rule.op === "inside" || rule.op === "outside")) {
      const a = right[i];
      const c = lower[i];
      if (a == null || c == null) {
        wasInside = null;
        continue;
      }
      const lo = Math.min(a, c);
      const hi = Math.max(a, c);
      // A study (or a rule on the close): its value at the close; the price: the bar's range.
      const v = series ? series[i] : null;
      if (series && v == null) continue;
      const inside = v != null ? v >= lo && v <= hi : b.close >= lo && b.close <= hi;
      const touched = v != null ? inside : b.high >= lo && b.low <= hi;
      const out = v != null ? !inside : b.high > hi || b.low < lo;
      const prev = wasInside;
      wasInside = inside;
      const met = rule.op === "inside" ? touched : rule.op === "outside" ? out : prev == null ? false : rule.op === "entering" ? !prev && touched : prev && out;
      if (met) price = b.close;
    } else {
      const level = right[i];
      if (level == null) continue;
      const before = i > 0 ? right[i - 1] : null;
      if (series) {
        const now = series[i];
        const was = i > 0 ? series[i - 1] : null;
        if (now == null) continue;
        const diff = now - level;
        const prev = was != null && before != null ? was - before : null;
        const up = prev != null && prev <= 0 && diff > 0;
        const down = prev != null && prev >= 0 && diff < 0;
        if (hit(rule.op, up, down, diff > 0, diff < 0)) price = b.close;
      } else {
        const start = i > 0 ? bars[i - 1].close : b.open;
        const from = before ?? level;
        const up = (start < from && b.high > level) || (b.low < level && b.close > level);
        const down = (start > from && b.low < level) || (b.high > level && b.close < level);
        if (hit(rule.op, up, down, b.high > level, b.low < level)) price = level;
      }
    }
    if (price == null) continue;
    fires.push({ price, barTime: b.time * 1000, fireTime: Math.min(close, nowSec) * 1000 });
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

function hit(op: AlertRule["op"], up: boolean, down: boolean, above: boolean, below: boolean): boolean {
  switch (op) {
    case "crossing":
      return up || down;
    case "crossing_up":
      return up;
    case "crossing_down":
      return down;
    case "greater":
      return above;
    case "less":
      return below;
    default:
      return false;
  }
}
