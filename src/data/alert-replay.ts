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
 *  - a moving percentage: the bar's high / low (or the study's value) against
 *    the value N bars back.
 * One fire per bar at most, at the bar's close (now for the bar in progress).
 */
import type { AlertRule } from "./alert-store";

export type ReplayBar = { time: number; open: number; high: number; low: number; close: number };
export type ReplayFire = { price: number; /** Open of the bar, epoch ms. */ barTime: number; /** Epoch ms. */ fireTime: number };

/** Most fires found for one rule (the latest ones are kept). */
export const REPLAY_MAX_FIRES = 50;
/** How far back the bars are read, in seconds. */
export const REPLAY_MAX_SEC = 30 * 86_400;

/** The fires of `rule` in the bars closing after `fromSec` (UNIX seconds, the
 *  last moment it was evaluated) up to `nowSec`. `left` / `right`: the value
 *  of each operand at the close of every bar (`left` null = the price);
 *  `stepSec`: length of a bar. */
export function replayRule(
  rule: Pick<AlertRule, "op" | "frequency" | "expiresAt" | "bars" | "right">,
  bars: ReplayBar[],
  left: (number | null)[] | null,
  right: (number | null)[],
  fromSec: number,
  nowSec: number,
  stepSec: number,
): ReplayFire[] {
  const fires: ReplayFire[] = [];
  const onClose = rule.frequency === "once_per_bar_close";
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
