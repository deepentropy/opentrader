import { describe, expect, it } from "vitest";
import { METRICS, metricDef, metricPoints, priceInputs } from "../fundamental-metrics";
import type { Fundamentals } from "../fundamentals";

/** Five quarters and one year of a company (amounts in millions). */
const F: Fundamentals = {
  ticker: "TEST",
  currency: "USD",
  fiscalYearEnd: "1231",
  quarterly: {
    end: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"],
    fy: [2025, 2025, 2025, 2025, 2026],
    fp: ["Q1", "Q2", "Q3", "Q4", "Q1"],
    date: ["2025-04-24", "2025-07-24", "2025-10-23", "2026-02-12", "2026-04-23"],
    items: {
      revenue: [10, 20, 30, 40, 50],
      cogs: [4, 8, 12, 16, 20],
      netIncome: [10, 20, 30, 40, 50],
      epsDiluted: [0.1, 0.2, 0.3, 0.4, 0.5],
      sharesDiluted: [100, 100, 102, 102, 104],
      totalAssets: [500, 510, 520, 530, 540],
      currentAssets: [200, 210, 220, 230, 240],
      currentLiabilities: [100, 100, 100, 100, 120],
      sharesOutstanding: [100, 101, 102, 103, 104],
      cashFromOperations: [5, 7, 8, 10, 11],
      capex: [1, 1, 2, 2, 3],
    },
  },
  annual: {
    end: ["2025-12-31"], fy: [2025], fp: ["FY"], date: ["2026-02-12"],
    items: { revenue: [100], cogs: [40], netIncome: [100] },
  },
  earnings: [],
};

const def = (key: string) => {
  const d = metricDef(key);
  if (!d) throw new Error(`no metric ${key}`);
  return d;
};

describe("fundamental metrics", () => {
  it("lists unique keys, a period on every statement metric and a price formula on the others", () => {
    expect(new Set(METRICS.map((m) => m.key)).size).toBe(METRICS.length);
    for (const m of METRICS) expect(m.periods.length > 0 ? !!m.value : !!m.price).toBe(true);
  });

  it("values a statement metric per quarter and year, from the day the results were released", () => {
    const q = metricPoints(F, def("revenue"), "FQ");
    expect(q.map((p) => [p.end, p.date, p.value])).toEqual([
      ["2025-03-31", "2025-04-24", 10], ["2025-06-30", "2025-07-24", 20], ["2025-09-30", "2025-10-23", 30],
      ["2025-12-31", "2026-02-12", 40], ["2026-03-31", "2026-04-23", 50],
    ]);
    expect(metricPoints(F, def("revenue"), "FY").map((p) => p.value)).toEqual([100]);
    expect(metricPoints(F, def("grossProfit"), "FY").map((p) => p.value)).toEqual([60]);
  });

  it("TTM sums the last four quarters of amounts, averages share counts, keeps balances", () => {
    expect(metricPoints(F, def("revenue"), "TTM").map((p) => [p.end, p.value])).toEqual([["2025-12-31", 100], ["2026-03-31", 140]]);
    expect(metricPoints(F, def("epsDiluted"), "TTM").map((p) => +p.value.toFixed(4))).toEqual([0.9863, 1.367]);
    expect(metricPoints(F, def("freeCashFlow"), "TTM").map((p) => p.value)).toEqual([24, 28]);
    expect(metricPoints(F, def("grossMargin"), "TTM").map((p) => p.value)).toEqual([60, 60]);
  });

  it("computes ratios from their parts and leaves out periods without them", () => {
    expect(metricPoints(F, def("currentRatio"), "FQ").map((p) => p.value)).toEqual([2, 2.1, 2.2, 2.3, 2]);
    expect(metricPoints(F, def("currentRatio"), "FY")).toEqual([]);
  });

  it("price metrics use the bar's close with the latest TTM and quarter", () => {
    const known = priceInputs(F);
    expect(known.map((k) => k.date)).toEqual(["2026-02-12", "2026-04-23"]);
    expect(def("priceEarnings").price!(50, known[0].ttm, known[0].q)).toBeCloseTo(50 / 0.9863, 2);
    expect(def("marketCap").price!(50, known[1].ttm, known[1].q)).toBe(5200);
  });
});
