import { describe, expect, it } from "vitest";
import type { MarginPoint } from "../../../backtester/types";
import type { EquityPeriod } from "../equity-data";
import {
  allowedDetails,
  averageReturns,
  benchmarking,
  bucketStart,
  growthComparison,
  liquidations,
  marginLine,
  periodicals,
  returnBins,
  streakBars,
  withEmptyBuckets,
} from "../metrics";
import { ms, report, trade } from "./fixtures";

const sec = (y: number, m: number, d: number) => ms(y, m, d) / 1000;

describe("allowedDetails / bucketStart", () => {
  it("none finer than the chart interval", () => {
    expect(allowedDetails(300, ["day", "week", "quarter", "year"])).toEqual(["day", "week", "quarter", "year"]);
    expect(allowedDetails(86_400, ["day", "week", "quarter", "year"])).toEqual(["week", "quarter", "year"]);
    expect(allowedDetails(2_628_003, ["day", "week", "quarter", "year"])).toEqual(["quarter", "year"]);
    expect(allowedDetails(3_600, ["hour", "day", "month"])).toEqual(["day", "month"]);
  });

  it("UTC day, week from Sunday, quarter, year", () => {
    const t = ms(2026, 5, 14, 15, 30); // Thursday
    expect(bucketStart(t, "day")).toBe(sec(2026, 5, 14));
    expect(bucketStart(t, "week")).toBe(sec(2026, 5, 10));
    expect(bucketStart(t, "quarter")).toBe(sec(2026, 4, 1));
    expect(bucketStart(t, "year")).toBe(sec(2026, 1, 1));
  });

  it("empty buckets between two bars keep their slot", () => {
    const bars = [{ time: sec(2026, 1, 4), values: [1] }, { time: sec(2026, 1, 25), values: [2] }];
    expect(withEmptyBuckets(bars, "week").map((b) => b.time)).toEqual([sec(2026, 1, 4), sec(2026, 1, 11), sec(2026, 1, 18), sec(2026, 1, 25)]);
    expect(withEmptyBuckets([{ time: sec(2025, 10, 1), values: [1] }, { time: sec(2026, 4, 1), values: [2] }], "quarter").map((b) => b.time)).toEqual([
      sec(2025, 10, 1),
      sec(2026, 1, 1),
      sec(2026, 4, 1),
    ]);
  });
});

describe("periodicals / benchmarking", () => {
  const trades = [
    trade({ profit: 10, entry: { price: 50 }, exit: { price: 55, time: ms(2026, 1, 5) } }),
    trade({ profit: -15, exit: { price: 52, time: ms(2026, 1, 6) } }),
    trade({ profit: 3, exit: { price: 60, time: ms(2026, 1, 8) } }),
    trade({ profit: -4, exit: { price: 58, time: ms(2026, 1, 20) } }),
    trade({ profit: 100, open: true, exit: { price: 61, time: ms(2026, 1, 21) } }),
  ];
  const r = report(trades, { capital: 1_000 });
  Object.assign(r.performance, { buyHoldReturn: 200 });

  it("per exit bucket: [highest running PnL, final if > 0, lowest running PnL, final if < 0]; open trades left out", () => {
    const p = periodicals(r, 86_400);
    expect(p.day).toEqual([]);
    expect(p.week).toEqual([
      { time: sec(2026, 1, 4), values: [10, 0, -5, -2] },
      { time: sec(2026, 1, 18), values: [0, 0, -4, -4] },
    ]);
    expect(p.quarter).toEqual([{ time: sec(2026, 1, 1), values: [10, 0, -6, -6] }]);
    expect(p.year).toEqual(p.quarter);
  });

  it("strategy PnL and the buy & hold change since the previous bucket's last trade", () => {
    // Buy & hold: 20 shares at 50 -> 1100, 1040, 1200, 1160.
    const b = benchmarking(r, 86_400);
    expect(b.week).toEqual([
      { time: sec(2026, 1, 4), values: [-2, 200] },
      { time: sec(2026, 1, 18), values: [-4, -40] },
    ]);
    expect(b.year).toEqual([{ time: sec(2026, 1, 1), values: [-6, 160] }]);
  });
});

describe("streakBars", () => {
  it("streak length (signed) or streak PnL per closed trade; a breakeven resets", () => {
    const profits = [10, -15, 3, -4, 0, 5, 7];
    const r = report([...profits.map((p, i) => trade({ profit: p, profitPercent: p / 100, direction: i === 1 ? "short" : "long" })), trade({ profit: 1, open: true })]);
    const s = streakBars(r);
    expect(s.count.map((b) => b.value)).toEqual([1, -1, 1, -1, 0, 1, 2]);
    expect(s.amount.map((b) => b.value)).toEqual([10, -15, 3, -4, 0, 5, 12]);
    expect(s.count[1]).toMatchObject({ tradeNumber: 2, short: true, profit: -15, profitPercent: -0.15 });
  });
});

describe("returnBins / averageReturns", () => {
  it("one width on both sides of 0; an outlier counts in the last bin and keeps its return", () => {
    const returns = [-0.02, -0.01, 0, 0.01, 0.02, 0.03, 1];
    const r = report(returns.map((v) => trade({ profit: v * 100, profitPercent: v })));
    expect(returnBins(r)).toEqual([
      { rangeStart: -0.03, rangeEnd: 0, rangeMiddle: -0.015, isProfit: false, tradesCount: 3 },
      { rangeStart: 0, rangeEnd: 0.03, rangeMiddle: 0.015, isProfit: true, tradesCount: 4, originalRangeEnd: 1 },
    ]);
    const avg = averageReturns(r);
    expect(avg.profit).toBeCloseTo(0.02, 12);
    expect(avg.loss).toBeCloseTo(-0.015, 12);
  });

  it("Freedman-Diaconis bin count", () => {
    const r = report([-0.1, -0.05, 0.02, 0.04, 0.1].map((v) => trade({ profit: v, profitPercent: v })));
    expect(returnBins(r).map((b) => [b.rangeStart, b.rangeEnd, b.tradesCount])).toEqual([
      [-0.1, 0, 2],
      [0, 0.1, 3],
    ]);
  });

  it("no bins without a spread or without closed trades", () => {
    expect(returnBins(report([trade({ profitPercent: 0.01 }), trade({ profitPercent: 0.01 })]))).toEqual([]);
    expect(returnBins(report([]))).toEqual([]);
    expect(averageReturns(report([]))).toEqual({ profit: null, loss: null });
  });
});

describe("growthComparison", () => {
  it("largest / average relative change; current = the last period of that kind", () => {
    const p = (type: EquityPeriod["type"], relativeChange: number) => ({ type, relativeChange }) as EquityPeriod;
    expect(growthComparison([p("runup", 0.5), p("drawdown", 0.2), p("runup", 0.3)])).toEqual({
      runup: { max: 0.5, average: 0.4, current: 0.3 },
      drawdown: { max: 0.2, average: 0.2, current: undefined },
    });
  });
});

describe("liquidations", () => {
  it("trades closed by a margin call, by exit time", () => {
    const r = report([
      trade({ qty: 3, exit: { signal: "Margin call", price: 20, time: ms(2026, 2, 1) } }),
      trade({ exit: { signal: "X" } }),
      trade({ qty: 2, exit: { signal: "Margin call", price: 10, time: ms(2026, 1, 1) } }),
    ]);
    expect(liquidations(r)).toEqual([
      { tradeNumber: 3, quantity: 2, price: 10, time: ms(2026, 1, 1), amount: 20 },
      { tradeNumber: 1, quantity: 3, price: 20, time: ms(2026, 2, 1), amount: 60 },
    ]);
  });
});

describe("marginLine", () => {
  const pt = (time: number, value: number, percent: number): MarginPoint => ({ time, value, percent, tradesOpen: value ? 1 : 0 });
  const usage = [
    { current: pt(1000, 0, 0), peak: pt(1000, 0, 0) },
    { current: pt(5000, 50, 0.5), peak: pt(3000, 60, 0.6) },
    { current: pt(5000, 0, 0), peak: pt(5000, 70, 1.2) },
  ];

  it("each item's margin, then the next item's peak, at ascending times; percent at most 100 %", () => {
    const line = marginLine(usage, true);
    expect(line.map((p) => [p.time, p.value])).toEqual([
      [1, 0],
      [3, 0.6],
      [5, 0.5],
      [5.001, 1],
      [5.002, 0],
    ]);
    expect(marginLine(usage, false).map((p) => p.value)).toEqual([0, 60, 50, 70, 0]);
  });
});
