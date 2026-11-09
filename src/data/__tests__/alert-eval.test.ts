import { describe, expect, it } from "vitest";
import vectors from "../../../src-tauri/crates/core/src/alerts/vectors.json";
import {
  AlertEvalEngine,
  EVERY_TIME_SEC,
  evalCondition,
  newRuleState,
  pointSample,
  REPLAY_MAX_FIRES,
  REPLAY_MAX_SEC,
  REPLAY_MIN_GAP_SEC,
  replayGridRule,
  stepRule,
  type EvalFire,
  type EvalRule,
  type Grid,
  type GridRule,
  type MinuteBar,
  type ReplayJob,
  type RuleReader,
  type Sample,
} from "../alert-eval";

type Json = Record<string, unknown>;

function withDefaults(r: Json): GridRule {
  const out = { ...(vectors.ruleDefaults as Json), ...r } as Json;
  out.and = (out.and as Json[]).map(withDefaults);
  return out as unknown as GridRule;
}
const rulesOf = (list: unknown) => (list as Json[]).map(withDefaults);
const barOf = (b: number[]): MinuteBar => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] });
const barsOf = (list: unknown) => (list as number[][]).map(barOf);

function expectFires(got: EvalFire[], want: unknown, where: string) {
  const sorted = [...got].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  const w = want as [string, number, number, number | null][];
  expect(sorted.length, `${where}: ${JSON.stringify(sorted)}`).toBe(w.length);
  sorted.forEach((f, i) => {
    expect(f.ruleId, where).toBe(w[i][0]);
    expect(f.price, where).toBeCloseTo(w[i][1], 9);
    expect(f.time, where).toBeCloseTo(w[i][2], 9);
    expect(f.barTime, where).toBe(w[i][3]);
  });
}
const jobsOf = (jobs: ReplayJob[]) => jobs.map((j) => [j.symbol, j.from]).sort();

describe("shared alert vectors (same as the backend's engine)", () => {
  it("pins the constants", () => {
    expect(vectors.constants).toEqual({ everyTimeSec: EVERY_TIME_SEC, replayMaxSec: REPLAY_MAX_SEC, replayMinGapSec: REPLAY_MIN_GAP_SEC, replayMaxFires: REPLAY_MAX_FIRES });
  });

  for (const c of vectors.cases as Json[]) {
    it(c.name as string, () => {
      const grids = ((c.grids ?? vectors.defaultGrids) as unknown) as Grid[];
      const previous = c.previous ? new Map(Object.entries(c.previous as Record<string, number>)) : null;
      const rules = rulesOf(c.rules);
      const engine = new AlertEvalEngine(previous);
      let jobs = engine.set(rules, grids, (c.setAt as number | undefined) ?? 0);
      if (c.jobs) expect(jobsOf(jobs)).toEqual(c.jobs);
      (c.steps as Json[]).forEach((step, i) => {
        const where = `${c.name}, step ${i}`;
        if (step.quote) {
          const q = step.quote as { symbol: string; last: number; bar: number[] | null; now: number };
          expectFires(engine.sample(q.symbol, q.last, q.bar ? barOf(q.bar) : null, q.now), step.fires, where);
        } else if (step.set) {
          const s = step.set as { rules: Json[]; now: number };
          jobs = engine.set(rulesOf(s.rules), grids, s.now);
          expect(jobsOf(jobs)).toEqual(step.jobs);
        } else if (step.finishReplay) {
          const f = step.finishReplay as { bars: number[][] | null };
          const bars = f.bars ? barsOf(f.bars) : null;
          expectFires(jobs.flatMap((j) => engine.finishReplay(j, bars)), step.fires, where);
        } else if (step.replay) {
          const r = step.replay as { rule: string; grid: string; from: number; bars: number[][] };
          const rule = rules.find((x) => x.id === r.rule)!;
          const grid = grids.find((g) => g.key === r.grid);
          const more = rule.and.map((a) => grids.find((g) => g.key === a.grid));
          expectFires(replayGridRule(rule, grid, more, barsOf(r.bars), r.from).fires, step.fires, where);
        } else throw new Error(`${where}: unknown step`);
      });
    });
  }
});

/** A reader with fixed values per condition and a bar every 300 s, always in session. */
const reader = (values: (number[] | null)[]): RuleReader => ({ bar: (t) => Math.floor(t / 300) * 300, inSession: () => true, values: (k) => values[k] ?? null });
const rule = (r: Partial<EvalRule>): EvalRule => ({ id: "r", op: "greater", shape: "level", absentIsOutside: false, frequency: "every_time", expiresAt: null, and: [], ...r });
const sample = (price: number, lo: number, hi: number, time: number): Sample => ({ price, lo, hi, time, extended: false });

describe("window-only shapes", () => {
  it("a study's condition fires while its flag is set", () => {
    const st = newRuleState();
    const r = rule({ op: "alert_condition", shape: "flag" });
    expect(stepRule(r, st, pointSample(10, 0), reader([[0]]))).toBeNull();
    expect(stepRule(r, st, pointSample(10, 5), reader([[1]]))?.price).toBe(10);
    expect(stepRule(r, st, pointSample(10, 10), reader([null]))).toBeNull();
  });

  it("moving up reads the high, moving down the low, against the value N bars back", () => {
    const up = { op: "moving_up", shape: "moving", absentIsOutside: false, amount: 2 };
    expect(evalCondition(up, newRuleState(), sample(101, 100, 102.5, 0), [100])).toBe(102.5);
    expect(evalCondition(up, newRuleState(), sample(103, 100, 103, 0), [100])).toBe(103);
    expect(evalCondition(up, newRuleState(), sample(101, 100, 101.5, 0), [100])).toBeNull();
    const downPct = { op: "moving_down_pct", shape: "moving", absentIsOutside: false, amount: 5 };
    expect(evalCondition(downPct, newRuleState(), sample(99, 94, 99, 0), [100])).toBe(94);
    expect(evalCondition(downPct, newRuleState(), sample(99, 96, 99, 0), [100])).toBeNull();
    // No reference, or a percentage of zero: not met.
    expect(evalCondition(downPct, newRuleState(), sample(99, 90, 99, 0), [0])).toBeNull();
    expect(evalCondition(up, newRuleState(), sample(200, 200, 200, 0), null)).toBeNull();
  });

  it("a single value is a sample whose range is that value", () => {
    // A study crossing a level: the values at two samples, as the price would be read at two quotes.
    const st = newRuleState();
    const r = rule({ op: "crossing_up" });
    expect(stepRule(r, st, pointSample(99, 0), reader([[100]]))).toBeNull();
    expect(stepRule(r, st, pointSample(101, 10), reader([[100.5]]))?.price).toBe(101);
  });

  it("once per bar close reads the values the conditions had at the bar's last sample", () => {
    const st = newRuleState();
    const r = rule({ op: "greater", frequency: "once_per_bar_close" });
    expect(stepRule(r, st, pointSample(101, 10), reader([[100]]))).toBeNull();
    // The level moved above the price by the time the next bar opens: the closed bar still read 100.
    expect(stepRule(r, st, pointSample(101, 310), reader([[200]]))).toEqual({ ruleId: "r", price: 101, time: 10, barTime: 0 });
  });
});
