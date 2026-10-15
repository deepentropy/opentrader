import { describe, expect, it } from "vitest";
import type { AlertFrequency, AlertOperator, Operand } from "../alert-store";
import { REPLAY_MAX_FIRES, replayAlertCalls, replayCondition, replayConditions, replayRule, ruleFlags, type ReplayBar, type ReplayConditionSeries } from "../alert-replay";

const STEP = 60;
const T0 = 6000;
const t = (i: number) => T0 + STEP * i;

const bar = (i: number, open: number, high: number, low: number, close: number): ReplayBar => ({ time: t(i), open, high, low, close });

type Rule = { op: AlertOperator; frequency: AlertFrequency; expiresAt: number | null; bars?: number; right: Operand };
const rule = (op: AlertOperator, frequency: AlertFrequency = "once_per_bar", over: Partial<Rule> = {}): Rule => ({
  op,
  frequency,
  expiresAt: null,
  right: { kind: "value", value: 0 },
  ...over,
});
const level = (n: number, v = 100) => Array.from({ length: n }, () => v);

describe("replayRule: the price against a level", () => {
  // 98 -> up through 100 -> above -> down through 100.
  const bars = [bar(0, 98, 99, 97, 98), bar(1, 98, 101, 97.5, 100.5), bar(2, 100.5, 102, 100.2, 101), bar(3, 101, 101.5, 99, 99.5)];
  const right = level(4);
  const run = (op: AlertOperator, from = t(0), now = t(4), freq: AlertFrequency = "once_per_bar") => replayRule(rule(op, freq), bars, null, right, from, now, STEP);

  it("finds crossings within the bars' ranges, at the level price, one per bar at its close", () => {
    expect(run("crossing")).toEqual([
      { price: 100, barTime: t(1) * 1000, fireTime: t(2) * 1000 },
      { price: 100, barTime: t(3) * 1000, fireTime: t(4) * 1000 },
    ]);
    expect(run("crossing_up").map((f) => f.barTime)).toEqual([t(1) * 1000]);
    expect(run("crossing_down").map((f) => f.barTime)).toEqual([t(3) * 1000]);
  });

  it("greater / less: the bar's high above / low below the level", () => {
    expect(run("greater").map((f) => f.barTime / 1000)).toEqual([t(1), t(2), t(3)]);
    expect(run("less").map((f) => f.barTime / 1000)).toEqual([t(0), t(1), t(3)]);
    expect(run("greater").every((f) => f.price === 100)).toBe(true);
  });

  it("reads only the bars closing after fromSec", () => {
    expect(run("crossing", t(2)).map((f) => f.barTime / 1000)).toEqual([t(3)]);
    expect(run("crossing", t(4))).toEqual([]);
  });

  it("fires in the bar in progress at nowSec", () => {
    const now = t(3) + 30;
    expect(run("crossing", t(0), now)).toEqual([
      { price: 100, barTime: t(1) * 1000, fireTime: t(2) * 1000 },
      { price: 100, barTime: t(3) * 1000, fireTime: now * 1000 },
    ]);
    // A bar that opens at nowSec is not read.
    expect(run("crossing", t(0), t(3)).map((f) => f.barTime / 1000)).toEqual([t(1)]);
  });

  it("only_once stops at the first fire", () => {
    expect(run("crossing", t(0), t(4), "only_once")).toHaveLength(1);
  });

  it("stops at the rule's expiry", () => {
    const fires = replayRule(rule("crossing", "once_per_bar", { expiresAt: t(2) * 1000 }), bars, null, right, t(0), t(4), STEP);
    expect(fires.map((f) => f.barTime / 1000)).toEqual([t(1)]);
  });

  it("skips bars without a level and reads a moving level against the previous one", () => {
    const moving = [100, null, 100, 100];
    expect(replayRule(rule("crossing"), bars, null, moving, t(0), t(4), STEP).map((f) => f.barTime / 1000)).toEqual([t(3)]);
  });

  it("a bar that opens across the level crosses through its range (open vs close)", () => {
    // First bar: no previous close, the open is the start.
    const one = [bar(0, 99, 101, 98.5, 100.5)];
    expect(replayRule(rule("crossing_up"), one, null, [100], t(-1), t(1), STEP)).toHaveLength(1);
    const gap = [bar(0, 101, 102, 100.5, 101.5)];
    expect(replayRule(rule("crossing"), gap, null, [100], t(-1), t(1), STEP)).toHaveLength(0);
  });

  it("ignores operators it does not evaluate", () => {
    expect(run("hits_level")).toEqual([]);
    expect(run("alert_condition")).toEqual([]);
  });
});

describe("replayRule: rules on the close and studies", () => {
  const bars = [bar(0, 98, 99, 97, 98), bar(1, 98, 101, 97.5, 100.5), bar(2, 100.5, 102, 100.2, 101), bar(3, 101, 101.5, 99, 99.5)];

  it("once per bar close reads the closes: two in a row across the level", () => {
    const fires = replayRule(rule("crossing", "once_per_bar_close"), bars, null, level(4), t(0), t(4), STEP);
    expect(fires).toEqual([
      { price: 100.5, barTime: t(1) * 1000, fireTime: t(2) * 1000 },
      { price: 99.5, barTime: t(3) * 1000, fireTime: t(4) * 1000 },
    ]);
  });

  it("skips the bar in progress for a rule on the close", () => {
    const fires = replayRule(rule("crossing", "once_per_bar_close"), bars, null, level(4), t(0), t(3) + 30, STEP);
    expect(fires.map((f) => f.barTime / 1000)).toEqual([t(1)]);
  });

  it("a value that touches the level crosses when it leaves it", () => {
    const study = [99, 100, 101];
    const b3 = bars.slice(0, 3);
    const fires = replayRule(rule("crossing_up"), b3, study, level(3), t(0), t(3), STEP);
    expect(fires.map((f) => f.barTime / 1000)).toEqual([t(2)]);
    expect(fires[0].price).toBe(101); // the bar's close
  });

  it("greater / less on a study value", () => {
    const study = [99, 100, 101, null];
    expect(replayRule(rule("greater"), bars, study, level(4), t(0), t(4), STEP).map((f) => f.barTime / 1000)).toEqual([t(2)]);
    expect(replayRule(rule("less"), bars, study, level(4), t(0), t(4), STEP).map((f) => f.barTime / 1000)).toEqual([t(0)]);
  });

  it("study crossing against a moving level (two values in a row)", () => {
    const study = [10, 12, 12];
    const lvl = [11, 11, 13];
    const b3 = bars.slice(0, 3);
    expect(replayRule(rule("crossing"), b3, study, lvl, t(0), t(3), STEP).map((f) => f.barTime / 1000)).toEqual([t(1), t(2)]);
  });
});

describe("replayRule: moving operators", () => {
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 102.5, 99, 101), bar(2, 101, 101.5, 98, 99)];
  const pct = (op: AlertOperator, value: number, n?: number) => rule(op, "once_per_bar", { right: { kind: "value", value }, bars: n });

  it("Moving Up %: the high against the close N bars back, at the threshold price", () => {
    const fires = replayRule(pct("moving_up_pct", 2), bars, null, [], t(0), t(3), STEP);
    expect(fires).toEqual([{ price: 102, barTime: t(1) * 1000, fireTime: t(2) * 1000 }]);
  });

  it("Moving Down %: the low against the close N bars back", () => {
    const fires = replayRule(pct("moving_down_pct", 2), bars, null, [], t(0), t(3), STEP);
    expect(fires).toHaveLength(1);
    expect(fires[0].barTime).toBe(t(2) * 1000);
    expect(fires[0].price).toBeCloseTo(98.98, 10);
  });

  it("reads N bars back", () => {
    expect(replayRule(pct("moving_up_pct", 2, 2), bars, null, [], t(0), t(3), STEP)).toEqual([]);
    const fires = replayRule(pct("moving_up_pct", 1, 2), bars, null, [], t(0), t(3), STEP);
    expect(fires).toEqual([{ price: 101, barTime: t(2) * 1000, fireTime: t(3) * 1000 }]);
  });

  it("clamps the bar count to 1..300", () => {
    expect(replayRule(pct("moving_up_pct", 2, 0), bars, null, [], t(0), t(3), STEP)).toHaveLength(1);
    expect(replayRule(pct("moving_up_pct", 2, 1000), bars, null, [], t(0), t(3), STEP)).toEqual([]);
  });

  it("Moving Up / Down by an amount", () => {
    expect(replayRule(pct("moving_up", 2), bars, null, [], t(0), t(3), STEP)).toEqual([{ price: 102, barTime: t(1) * 1000, fireTime: t(2) * 1000 }]);
    expect(replayRule(pct("moving_down", 2), bars, null, [], t(0), t(3), STEP)).toEqual([{ price: 99, barTime: t(2) * 1000, fireTime: t(3) * 1000 }]);
  });

  it("on a study: its values, the fire at the bar's close", () => {
    const study = [10, 10.5, 10.1];
    expect(replayRule(pct("moving_up_pct", 4), bars, study, [], t(0), t(3), STEP)).toEqual([{ price: 101, barTime: t(1) * 1000, fireTime: t(2) * 1000 }]);
    // A missing value (now or N bars back) is skipped.
    expect(replayRule(pct("moving_up_pct", 4), bars, [10, null, 10.5], [], t(0), t(3), STEP)).toEqual([]);
    expect(replayRule(pct("moving_up_pct", 4, 2), bars, [10, null, 10.5], [], t(0), t(3), STEP).map((f) => f.barTime / 1000)).toEqual([t(2)]);
  });

  it("skips a zero reference for a percentage", () => {
    const zero = [bar(0, 0, 0, 0, 0), bar(1, 0, 5, 0, 5)];
    expect(replayRule(pct("moving_up_pct", 1), zero, null, [], t(0), t(2), STEP)).toEqual([]);
  });

  it("a right operand that is not a value reads as 0", () => {
    const r = rule("moving_up", "once_per_bar", { right: { kind: "price" } });
    expect(replayRule(r, bars, null, [], t(0), t(3), STEP)).toHaveLength(2);
  });
});

describe("replayRule: channels between two bounds", () => {
  // Bounds 95..105.
  const bars = [bar(0, 108, 110, 106, 108), bar(1, 106, 107, 100, 102), bar(2, 102, 104, 96, 100), bar(3, 100, 101, 90, 92)];
  const upper: (number | null)[] = level(4, 105);
  const lower: (number | null)[] = level(4, 95);
  const run = (op: AlertOperator, left: (number | null)[] | null = null, up = upper, lo = lower) =>
    replayRule(rule(op), bars, left, up, t(0), t(4), STEP, lo).map((f) => f.barTime / 1000);

  it("the price: inside = the range touches the band, outside = the range leaves it", () => {
    expect(run("inside")).toEqual([t(1), t(2), t(3)]);
    expect(run("outside")).toEqual([t(0), t(1), t(3)]);
  });

  it("entering / exiting compare with the previous bar's close", () => {
    expect(run("entering")).toEqual([t(1)]);
    expect(run("exiting")).toEqual([t(3)]);
  });

  it("swapped bounds work the same", () => {
    expect(run("entering", null, lower, upper)).toEqual([t(1)]);
  });

  it("a missing bound resets the previous state", () => {
    const up = [105, null, 105, 105];
    expect(run("entering", null, up)).toEqual([]);
    expect(run("inside", null, up)).toEqual([t(2), t(3)]);
  });

  it("a study value against the bounds", () => {
    const study = [110, 100, 90, null];
    expect(run("inside", study)).toEqual([t(1)]);
    expect(run("outside", study)).toEqual([t(0), t(2)]);
    expect(run("entering", study)).toEqual([t(1)]);
    expect(run("exiting", study)).toEqual([t(2)]);
  });

  it("without lower bounds a band operator is not evaluated", () => {
    expect(replayRule(rule("inside"), bars, null, upper, t(0), t(4), STEP)).toEqual([]);
  });
});

describe("replayRule: bar close times", () => {
  it("a bar closes at the next bar's open when it comes earlier than a full step", () => {
    const bars = [bar(0, 98, 101, 97, 100.5)];
    const irregular = [bars[0], { ...bar(0, 100, 100, 100, 100), time: t(0) + 30 }];
    const fires = replayRule(rule("crossing_up"), irregular, null, [100, 100], t(-1), t(5), STEP);
    expect(fires[0].fireTime).toBe((t(0) + 30) * 1000);
  });

  it("keeps the latest REPLAY_MAX_FIRES fires", () => {
    const many = Array.from({ length: 60 }, (_, i) => bar(i, 100, 101, 99, 100));
    const fires = replayRule(rule("greater"), many, null, level(60), t(0) - 1, t(60), STEP);
    expect(fires).toHaveLength(REPLAY_MAX_FIRES);
    expect(fires[0].barTime).toBe(t(10) * 1000);
    expect(fires[fires.length - 1].barTime).toBe(t(59) * 1000);
  });
});

describe("replayCondition", () => {
  const bars = [bar(0, 1, 1, 1, 10), bar(1, 1, 1, 1, 11), bar(2, 1, 1, 1, 12), bar(3, 1, 1, 1, 13)];
  const flags = [false, true, true, true];

  it("fires on each flagged bar at its close with the close price", () => {
    expect(replayCondition({ frequency: "once_per_bar", expiresAt: null }, bars, flags, t(0), t(4), STEP)).toEqual([
      { price: 11, barTime: t(1) * 1000, fireTime: t(2) * 1000 },
      { price: 12, barTime: t(2) * 1000, fireTime: t(3) * 1000 },
      { price: 13, barTime: t(3) * 1000, fireTime: t(4) * 1000 },
    ]);
  });

  it("the bar in progress fires now, except for a rule on the close", () => {
    const now = t(3) + 10;
    const live = replayCondition({ frequency: "once_per_bar", expiresAt: null }, bars, flags, t(0), now, STEP);
    expect(live[live.length - 1].fireTime).toBe(now * 1000);
    expect(replayCondition({ frequency: "once_per_bar_close", expiresAt: null }, bars, flags, t(0), now, STEP)).toHaveLength(2);
  });

  it("only once, expiry and fromSec", () => {
    expect(replayCondition({ frequency: "only_once", expiresAt: null }, bars, flags, t(0), t(4), STEP)).toHaveLength(1);
    expect(replayCondition({ frequency: "once_per_bar", expiresAt: t(3) * 1000 }, bars, flags, t(0), t(4), STEP)).toHaveLength(2);
    expect(replayCondition({ frequency: "once_per_bar", expiresAt: null }, bars, flags, t(3), t(4), STEP)).toHaveLength(1);
    expect(replayCondition({ frequency: "once_per_bar", expiresAt: null }, bars, [], t(0), t(4), STEP)).toEqual([]);
  });
});

describe("replayAlertCalls", () => {
  const bars = [bar(0, 1, 1, 1, 10), bar(1, 1, 1, 1, 11), bar(2, 1, 1, 1, 12)];

  it("one once-per-bar call per bar, every other call, with its message", () => {
    const fires = replayAlertCalls(
      { expiresAt: null },
      bars,
      [
        { time: t(0), message: "a1", freq: "once_per_bar" },
        { time: t(0), message: "a2", freq: "once_per_bar" },
        { time: t(1), message: "b1", freq: "once_per_bar_close" },
        { time: t(1), message: "b2", freq: "all" },
        { time: t(1), message: "b3", freq: "once_per_bar" },
        { time: t(9), message: "nowhere", freq: "all" },
      ],
      t(0) - 1,
      t(3),
      STEP,
    );
    expect(fires).toEqual([
      { price: 10, barTime: t(0) * 1000, fireTime: t(1) * 1000, message: "a1" },
      { price: 11, barTime: t(1) * 1000, fireTime: t(2) * 1000, message: "b1" },
      { price: 11, barTime: t(1) * 1000, fireTime: t(2) * 1000, message: "b2" },
      { price: 11, barTime: t(1) * 1000, fireTime: t(2) * 1000, message: "b3" },
    ]);
  });

  it("leaves the bar in progress to the live evaluation and stops at expiry", () => {
    const calls = [
      { time: t(1), message: "x", freq: "all" as const },
      { time: t(2), message: "y", freq: "all" as const },
    ];
    expect(replayAlertCalls({ expiresAt: null }, bars, calls, t(0), t(2) + 30, STEP).map((f) => f.message)).toEqual(["x"]);
    expect(replayAlertCalls({ expiresAt: t(2) * 1000 }, bars, calls, t(0), t(3), STEP).map((f) => f.message)).toEqual(["x"]);
    expect(replayAlertCalls({ expiresAt: null }, bars, calls, t(2), t(3), STEP).map((f) => f.message)).toEqual(["y"]);
  });
});

describe("replayConditions: several conditions read together", () => {
  // Fine condition: 1-minute bars 0..9; coarse condition: 5-minute bars (closing at t(5) and t(10)).
  const fine = Array.from({ length: 10 }, (_, i) => bar(i, 100, 101, 99, 100 + i));
  const coarse = [bar(0, 100, 106, 99, 105), bar(5, 105, 110, 104, 109)];
  const COARSE = STEP * 5;
  const flags = (n: number, on: number[]) => Array.from({ length: n }, (_, i) => on.includes(i));
  const freq = (frequency: AlertFrequency) => ({ frequency, expiresAt: null });

  it("a state holds until its next bar closes, an event at its own bar's close only", () => {
    // Fine crossing at minutes 2 and 7; coarse level true on its first bar only (holds from t(5) to t(10)).
    const conds: ReplayConditionSeries[] = [
      { bars: fine, stepSec: STEP, met: flags(10, [2, 7]), event: true },
      { bars: coarse, stepSec: COARSE, met: [true, false], event: false },
    ];
    // Minute 7 closes at t(8): the coarse state of the bar closed at t(5) holds then; minute 2 (t(3)) is before it.
    expect(replayConditions(freq("every_time"), conds, fine, STEP, t(0), t(10))).toEqual([{ price: fine[7].close, barTime: t(7) * 1000, fireTime: t(8) * 1000 }]);
  });

  it("two events must happen at the same close", () => {
    const conds: ReplayConditionSeries[] = [
      { bars: fine, stepSec: STEP, met: flags(10, [4, 8]), event: true },
      { bars: coarse, stepSec: COARSE, met: [true, true], event: true },
    ];
    // The coarse event closes at t(5) and t(10): minute 4 closes at t(5), minute 9 (not met) at t(10).
    expect(replayConditions(freq("every_time"), conds, fine, STEP, t(0), t(10)).map((f) => f.fireTime)).toEqual([t(5) * 1000]);
  });

  it("the trigger counts in the alert's own bars; closed bars only", () => {
    const conds: ReplayConditionSeries[] = [
      { bars: coarse, stepSec: COARSE, met: [true, true], event: false },
      { bars: fine, stepSec: STEP, met: flags(10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), event: false },
    ];
    // Alert on the 5-minute bars, once per bar: the first moment each 5-minute bar has both. The coarse state starts at
    // its first close, t(5), the last moment of the first bar; the second bar has both from t(6).
    expect(replayConditions(freq("once_per_bar"), conds, coarse, COARSE, t(0), t(10)).map((f) => [f.barTime, f.fireTime])).toEqual([
      [t(0) * 1000, t(5) * 1000],
      [t(5) * 1000, t(6) * 1000],
    ]);
    // At the bar's close: the alert's closes only.
    expect(replayConditions(freq("once_per_bar_close"), conds, coarse, COARSE, t(0), t(10)).map((f) => f.fireTime)).toEqual([t(5) * 1000, t(10) * 1000]);
    // Only once: the first fire.
    expect(replayConditions(freq("only_once"), conds, fine, STEP, t(0), t(10)).length).toBe(1);
    // A bar not closed yet is not read.
    expect(replayConditions(freq("every_time"), conds, fine, STEP, t(0), t(9) + 30).map((f) => f.fireTime).pop()).toBe(t(9) * 1000);
  });

  it("nothing before the last moment read, nothing after expiry", () => {
    const conds: ReplayConditionSeries[] = [{ bars: fine, stepSec: STEP, met: flags(10, [1, 6]), event: true }, { bars: fine, stepSec: STEP, met: flags(10, [1, 6]), event: false }];
    expect(replayConditions(freq("every_time"), conds, fine, STEP, t(3), t(10)).map((f) => f.barTime)).toEqual([t(6) * 1000]);
    expect(replayConditions({ frequency: "every_time", expiresAt: t(5) * 1000 }, conds, fine, STEP, t(0), t(10)).map((f) => f.barTime)).toEqual([t(1) * 1000]);
  });
});

describe("ruleFlags", () => {
  it("gives, per bar, the price a fire would give (null when not met), as replayRule finds them", () => {
    const bars = [bar(0, 98, 99, 97, 98), bar(1, 98, 101, 97.5, 100.5), bar(2, 100.5, 102, 100.2, 101)];
    const r = rule("crossing_up");
    expect(ruleFlags(r, bars, null, level(3), t(0), STEP)).toEqual([null, 100, null]);
    expect(replayRule(r, bars, null, level(3), t(0), t(3), STEP).map((f) => f.price)).toEqual([100]);
  });
});

describe("replayConditions: bars closing at their session's end", () => {
  it("a daily event read with intraday bars counts at the session close, given as the daily bar's close", () => {
    // Intraday bars 0..3 (the session ends with bar 3's close, t(4)); then the next day's bars 10..11.
    const intraday = [0, 1, 2, 3, 10, 11].map((i) => bar(i, 100, 101, 99, 100));
    const daily = [bar(-20, 100, 101, 99, 100), bar(10, 100, 101, 99, 100)];
    const conds: ReplayConditionSeries[] = [
      { bars: intraday, stepSec: STEP, met: [true, true, true, true, true, true], event: false },
      // The daily crossing of the first day: an event at the session's close (not at the bar's time plus a day).
      { bars: daily, stepSec: 86_400, met: [true, false], event: true, closes: [t(4), t(12)] },
    ];
    expect(replayConditions({ frequency: "every_time", expiresAt: null }, conds, intraday, STEP, t(-1), t(12)).map((f) => [f.barTime, f.fireTime])).toEqual([[t(3) * 1000, t(4) * 1000]]);
  });
});
