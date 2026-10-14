import { describe, expect, it } from "vitest";
import { equityPoints, intervalSeconds, reportPeriods, runupDrawdownPeriods, whitespaceTimes, type EquityPoint } from "../equity-data";
import { DAY_MS, report, trade } from "./fixtures";

describe("intervalSeconds", () => {
  it("as Pine timeframe.in_seconds", () => {
    expect(intervalSeconds("5")).toBe(300);
    expect(intervalSeconds("60")).toBe(3600);
    expect(intervalSeconds("30S")).toBe(30);
    expect(intervalSeconds("1D")).toBe(86400);
    expect(intervalSeconds("D")).toBe(86400);
    expect(intervalSeconds("2W")).toBe(2 * 604800);
    expect(intervalSeconds("1M")).toBe(2628003);
    expect(intervalSeconds(" 15 ")).toBe(900);
  });

  it("unknown ids fall back to a day", () => {
    expect(intervalSeconds("1H")).toBe(86400);
    expect(intervalSeconds("abc")).toBe(86400);
  });
});

describe("equityPoints", () => {
  const t0 = Date.UTC(2026, 0, 5);
  const trades = [
    trade({ profit: 100, profitPercent: 0.1, runUp: 150, runUpPercent: 0.15, drawdown: 20, drawdownPercent: 0.02, cumProfit: 100, exit: { time: t0, bar: 2 } }),
    trade({ profit: -50, profitPercent: -0.05, runUp: 10, runUpPercent: 0.01, drawdown: 60, drawdownPercent: 0.06, cumProfit: 50, exit: { time: t0, bar: 2 } }),
    trade({ profit: 30, profitPercent: 0.03, cumProfit: 80, exit: { time: t0 - 5, bar: 3 } }),
  ];
  const r = report(trades, { capital: 1000, buyHold: [0, 0, 40, 60] });

  it("one point per trade; same-time exits shifted by +1 ms", () => {
    const pts = equityPoints(r, false);
    expect(pts.map((p) => p.time)).toEqual([t0 / 1000, (t0 + 1) / 1000, (t0 + 2) / 1000]);
    expect(pts.map((p) => p.value)).toEqual([100, 50, 80]);
    expect(pts.map((p) => p.buyHold)).toEqual([40, 40, 60]);
    expect(pts.map((p) => p.tradeIndex)).toEqual([0, 1, 2]);
  });

  it("excursions: [run-up, profit > 0, -drawdown, loss < 0]", () => {
    const pts = equityPoints(r, false);
    expect(pts[0].excursions).toEqual([150, 100, -20, 0]);
    expect(pts[1].excursions).toEqual([10, 0, -60, -50]);
  });

  it("percent scale: PnL / capital, excursions in the trade's percent", () => {
    const pts = equityPoints(r, true);
    expect(pts.map((p) => p.value)).toEqual([0.1, 0.05, 0.08]);
    expect(pts[2].buyHold).toBe(0.06);
    expect(pts[1].excursions).toEqual([0.01, 0, -0.06, -0.05]);
  });

  it("a missing buy & hold bar reads 0", () => {
    expect(equityPoints(report([trade({ exit: { bar: 99 } })]), false)[0].buyHold).toBe(0);
  });
});

describe("whitespaceTimes", () => {
  const pts = (...times: number[]) => times.map((time) => ({ time }) as EquityPoint);

  it("round(gap / g) - 1 evenly spaced slots per gap", () => {
    expect(whitespaceTimes(pts(0, 100, 400), 50)).toEqual([50, 150, 200, 250, 300, 350]);
  });

  it("the grid widens with the span (at most ~2000 slots)", () => {
    // Short span: the step itself (1080 / 60 - 1 = 17 slots).
    expect(whitespaceTimes(pts(0, 1080), 60)).toHaveLength(17);
    // span 1e6 s, step 60: g = 60 x ceil(1e6 / 2000 / 60) = 540 -> round(1e6 / 540) - 1 = 1851 slots.
    const out = whitespaceTimes(pts(0, 1_000_000), 60);
    expect(out).toHaveLength(1851);
    expect(out[0]).toBeCloseTo(1_000_000 / 1852, 9);
  });

  it("nothing for fewer than 2 points, a non-positive step or adjacent points", () => {
    expect(whitespaceTimes(pts(5), 60)).toEqual([]);
    expect(whitespaceTimes(pts(0, 600), 0)).toEqual([]);
    expect(whitespaceTimes(pts(0, 60, 120), 60)).toEqual([]);
  });
});

describe("runupDrawdownPeriods", () => {
  const samples = (values: number[], pendingLast = false) =>
    values.map((value, i) => ({ time: i * 10, value, delta: i === 0 ? value : value - values[i - 1], pending: pendingLast && i === values.length - 1 }));

  it("a steady rise is one run-up", () => {
    const p = runupDrawdownPeriods(samples([10, 20, 30, 40]), 1000);
    expect(p).toEqual([
      { type: "runup", startIndex: 0, endIndex: 3, startTime: 0, endTime: 30, startValue: 10, endValue: 40, change: 30, relativeChange: 30 / 1010 },
    ]);
  });

  it("a drawdown then the recovery run-up", () => {
    const p = runupDrawdownPeriods(samples([100, 50, 20, 30, 120]), 1000);
    expect(p.map((x) => [x.type, x.startIndex, x.endIndex, x.startValue, x.endValue])).toEqual([
      ["drawdown", 0, 2, 100, 20],
      ["runup", 2, 4, 20, 120],
    ]);
    expect(p[0].change).toBe(80);
    expect(p[0].relativeChange).toBeCloseTo(80 / 1100, 12);
    expect(p[1].relativeChange).toBeCloseTo(100 / 1020, 12);
  });

  it("a small one-trade dip stays inside the run-up", () => {
    const p = runupDrawdownPeriods(samples([100, 200, 190, 300]), 10_000);
    expect(p.map((x) => [x.type, x.startIndex, x.endIndex])).toEqual([["runup", 0, 3]]);
  });

  it("a one-trade dip deeper than 5 % of the equity is kept", () => {
    const p = runupDrawdownPeriods(samples([100, 200, 0, 300]), 1000);
    expect(p.map((x) => x.type)).toContain("drawdown");
    const dd = p.find((x) => x.type === "drawdown")!;
    expect([dd.startValue, dd.endValue]).toEqual([200, 0]);
  });

  it("the open (pending) trade is skipped", () => {
    expect(runupDrawdownPeriods(samples([10, 20, 30, 40, -500], true), 1000)).toEqual(runupDrawdownPeriods(samples([10, 20, 30, 40]), 1000));
  });

  it("nothing below 2 samples", () => {
    expect(runupDrawdownPeriods([], 1000)).toEqual([]);
    expect(runupDrawdownPeriods(samples([10]), 1000)).toEqual([]);
  });
});

describe("reportPeriods", () => {
  it("one sample per trade on the shifted exit times", () => {
    const t0 = Date.UTC(2026, 0, 5);
    const r = report([10, 20, 30, 40].map((cum, i) => trade({ profit: 10, cumProfit: cum, exit: { time: t0 + i * DAY_MS, bar: i } })), { capital: 1000 });
    const pts = equityPoints(r, false);
    const p = reportPeriods(r, pts);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ type: "runup", startTime: t0 / 1000, endTime: (t0 + 3 * DAY_MS) / 1000, startValue: 10, endValue: 40 });
  });
});
