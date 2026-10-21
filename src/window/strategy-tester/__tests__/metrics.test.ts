import { describe, expect, it } from "vitest";
import { bestEntry, cagr, correlation, derivedPerformance, distribution, entryBuckets, equityPoints, growthStats, outliers, pnlBy, streaks, totalPnl, tradeBuyHold } from "../metrics";
import { DAY_MS, ms, report, trade } from "./fixtures";

describe("totalPnl", () => {
  it("net profit + open PnL", () => {
    expect(totalPnl(report([], { netProfit: 129_974, openPL: 3_218.13 }))).toBeCloseTo(133_192.13, 6);
  });
});

describe("pnlBy", () => {
  const trades = [
    trade({ direction: "long", profit: 10, commission: 1, entry: { signal: "L" } }),
    trade({ direction: "short", profit: -5, commission: 1, entry: { signal: "S" } }),
    trade({ direction: "long", profit: 3, commission: 0.5, entry: { signal: "L" }, open: true }),
  ];

  it("by entry signal, total first (open trades included)", () => {
    expect(pnlBy(report(trades), "signal")).toEqual([
      { label: "All signals", pnl: 8, profitSum: 13, lossSum: 5, commission: 2.5 },
      { label: "L", pnl: 13, profitSum: 13, lossSum: 0, commission: 1.5 },
      { label: "S", pnl: -5, profitSum: 0, lossSum: 5, commission: 1 },
    ]);
  });

  it("by side in a fixed order, missing sides left out", () => {
    expect(pnlBy(report(trades), "side").map((r) => [r.label, r.pnl])).toEqual([["Both sides", 8], ["Longs", 13], ["Shorts", -5]]);
    expect(pnlBy(report([trades[0]]), "side").map((r) => r.label)).toEqual(["Both sides", "Longs"]);
    expect(pnlBy(report([]), "side")).toEqual([]);
  });
});

describe("streaks", () => {
  it("runs over closed trades in exit order; breakevens break a run", () => {
    const profits = [5, 2, -1, 3, 4, 1, -2, -3, 0];
    // Shuffled array order: exit time decides.
    const trades = profits.map((p, i) => trade({ profit: p, exit: { time: ms(2026, 1, 1) + i * DAY_MS } })).reverse();
    trades.push(trade({ profit: 100, open: true, exit: { time: ms(2027, 1, 1) } }));
    expect(streaks(report(trades))).toEqual({ longestWin: 3, longestLoss: 2, avgWin: 2.5, avgLoss: 1.5 });
  });

  it("no trades", () => {
    expect(streaks(report([]))).toEqual({ longestWin: 0, longestLoss: 0, avgWin: null, avgLoss: null });
  });
});

describe("cagr", () => {
  it("compounded over 365-day years", () => {
    expect(cagr(report([], { netProfit: 1_000, range: { from: 0, to: 365 * DAY_MS } }))).toBeCloseTo(0.1, 12);
    expect(cagr(report([], { netProfit: 2_100, range: { from: 0, to: 730 * DAY_MS } }))).toBeCloseTo(0.1, 12);
    expect(cagr(report([], { netProfit: -1_900, range: { from: 0, to: 730 * DAY_MS } }))).toBeCloseTo(-0.1, 12);
  });

  it("0 under 30 days or for a final equity of 0 or less", () => {
    expect(cagr(report([], { netProfit: 1_000, range: { from: 5, to: 5 } }))).toBe(0);
    expect(cagr(report([], { netProfit: 1_000, range: { from: 0, to: 29 * DAY_MS } }))).toBe(0);
    expect(cagr(report([], { netProfit: -10_000, range: { from: 0, to: 365 * DAY_MS } }))).toBe(0);
  });
});

describe("outliers", () => {
  it("closed trades more than 2 standard deviations from the mean return", () => {
    const rets = [0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 1.0];
    const trades = rets.map((r, i) => trade({ profitPercent: r, profit: i === 9 ? 500 : 1 }));
    const o = outliers(report(trades));
    expect(o.trades).toHaveLength(1);
    expect(o.trades[0].profitPercent).toBe(1.0);
    expect(o.pnl).toBe(500);
  });

  it("sample deviation; a return of NaN is left out; fewer than 2 closed trades: none", () => {
    // 0.6 is out by the population deviation (0.4714 > 2 x 0.2185) but not by the sample one (2 x 0.2360).
    const rets = [0, 0, 0, 0, 0, 0.3, 0.6];
    expect(outliers(report(rets.map((p) => trade({ profitPercent: p }))))).toEqual({ pnl: 0, trades: [] });
    const trades = [...Array.from({ length: 9 }, () => trade({ profitPercent: 0.5 })), trade({ profitPercent: Number.NaN, profit: -7 })];
    expect(outliers(report(trades)).trades).toHaveLength(0);
    expect(outliers(report([trade({ profitPercent: 9 })]))).toEqual({ pnl: 0, trades: [] });
  });

  it("all equal returns: no outlier", () => {
    expect(outliers(report([trade({ profitPercent: 0.1 }), trade({ profitPercent: 0.1 })])).trades).toEqual([]);
  });
});

describe("entryBuckets / bestEntry", () => {
  it("D chart: by month of the exchange trading day, the first month wins a tie; no hour or weekday", () => {
    const trades = [
      trade({ profit: 1, entry: { time: ms(2026, 2, 3, 14, 30) } }),
      trade({ profit: 1, entry: { time: ms(2025, 2, 3, 14, 30) } }),
      trade({ profit: 1, entry: { time: ms(2026, 3, 3, 14, 30) } }),
      trade({ profit: -1, entry: { time: ms(2026, 3, 4, 14, 30) } }),
      trade({ profit: 1, entry: { time: ms(2026, 5, 4, 14, 30) } }),
      // Jan 31 in New York (Feb 1 in UTC).
      trade({ profit: -1, entry: { time: ms(2026, 2, 1, 2) } }),
    ];
    const b = entryBuckets(report(trades), 86_400, "America/New_York");
    expect(b.hour).toEqual([]);
    expect(b.day).toEqual([]);
    expect(b.month[0]).toEqual({ winning: 0, losing: 1 });
    expect(bestEntry(b, "month")).toEqual({ index: 1, winRate: 1 });
    expect(bestEntry(b, "hour")).toBeUndefined();
  });

  it("intraday: hour, weekday and month in the local zone; open trades count, breakevens do not", () => {
    const t = new Date(2026, 6, 6, 10, 15).getTime(); // a Monday, local time
    const trades = [trade({ profit: 2, open: true, entry: { time: t } }), trade({ profit: 0, entry: { time: t } }), trade({ profit: -1, entry: { time: t + 3_600_000 } })];
    const b = entryBuckets(report(trades), 900, "UTC");
    expect(b.hour[10]).toEqual({ winning: 1, losing: 0 });
    expect(b.hour[11]).toEqual({ winning: 0, losing: 1 });
    expect(bestEntry(b, "day")).toEqual({ index: 1, winRate: 0.5 });
    expect(bestEntry(b, "month")).toEqual({ index: 6, winRate: 0.5 });
    // From 1 h: no hour.
    expect(entryBuckets(report(trades), 3_600, "UTC").hour).toEqual([]);
  });

  it("no trade with a profit or loss: no buckets; no winner: no best", () => {
    expect(entryBuckets(report([trade({ profit: 0 })]), 900, "UTC")).toEqual({ hour: [], day: [], month: [] });
    expect(bestEntry(entryBuckets(report([trade({ profit: -1 })]), 900, "UTC"), "hour")).toBeUndefined();
  });
});

describe("growthStats", () => {
  it("average / max run-up and drawdown of the close-to-close periods", () => {
    // Cumulative PnL 0 -> 300 (run-up), -> -100 (drawdown), -> 1,000 (run-up), one trade a day.
    const cums = [0, 100, 200, 300, 100, 0, -100, 400, 900, 1000];
    const trades = cums.map((c, i) => trade({ cumProfit: c, profit: i ? c - cums[i - 1] : 0, exit: { time: i * DAY_MS } }));
    const g = growthStats(report(trades));
    expect(g.averageDrawdown).toBe(400);
    expect(g.averageDrawdownDuration).toBe(3 * DAY_MS);
    expect(g.maxDrawdownPercent).toBeCloseTo(400 / 10_300, 12);
    expect(g.maxRunup).toBe(1100);
    expect(g.averageRunup).toBe(700);
    expect(g.averageRunupDuration).toBe(3 * DAY_MS);
  });

  it("null without periods", () => {
    expect(growthStats(report([])).averageRunup).toBeNull();
  });
});

describe("buy & hold per trade, correlation", () => {
  const trades = [
    trade({ profit: 10, entry: { price: 50 }, exit: { price: 55 } }),
    trade({ profit: -5, exit: { price: 52 } }),
    trade({ profit: 20, exit: { price: 60 } }),
    trade({ profit: 3, open: true, exit: { price: 61 } }),
  ];
  const r = report(trades, { capital: 1_000 });
  Object.assign(r.performance, { buyHoldReturn: 220 });
  Object.assign(r.performance.all, { avgTrade: 25 / 3 });

  it("whole shares at the first entry price, valued at each exit; open trades repeat the final value", () => {
    expect(tradeBuyHold(r)).toEqual([1000, 1100, 1040, 1200, 1220]);
  });

  it("Pearson correlation of the closed trades' PnL with the buy & hold change", () => {
    const pnl = [10, -5, 20];
    const bh = [100, -60, 160];
    const ma = 25 / 3;
    const mb = 220 / 4;
    const cov = pnl.reduce((s, v, i) => s + (v - ma) * (bh[i] - mb), 0);
    const va = pnl.reduce((s, v) => s + (v - ma) ** 2, 0);
    const vb = bh.reduce((s, v) => s + (v - mb) ** 2, 0);
    expect(correlation(r)).toBeCloseTo(cov / Math.sqrt(va * vb), 12);
  });
});

describe("derivedPerformance", () => {
  it("ratios of the report converter", () => {
    const r = report([trade({ profit: 300, direction: "short" }), trade({ profit: -100 })], { capital: 1_000, netProfit: 200 });
    Object.assign(r.performance, { openPL: 50, maxStrategyDrawDown: 100, maxStrategyRunUp: 400, buyHoldReturn: 80, maxMarginUsed: 900 });
    Object.assign(r.performance.all, { grossProfit: 300, grossLoss: 100, largestWinTrade: 300, largestLosTrade: 100, commissionPaid: 30 });
    Object.assign(r.performance, {
      long: { netProfit: -100, grossProfit: 0, grossLoss: 100, largestWinTrade: null, largestLosTrade: 100 },
      short: { netProfit: 300, grossProfit: 300, grossLoss: 0, largestWinTrade: 300, largestLosTrade: null },
    });
    const d = derivedPerformance(r);
    expect(d.all).toMatchObject({
      accountSizeRequired: 1000,
      returnOnAccount: 0.2,
      returnOnInitialCapital: 0.2,
      returnOfMaxEquityDrawdown: 2.5,
      netProfitAsPercentOfLargestLoss: 2,
      largestWinnerAsPercentOfGrossProfit: 1,
      largestLoserAsPercentOfGrossLoss: 1,
      maxEquityRunUpAsPercentOfInitialCapital: 0.4,
      maxEquityDrawdownAsPercentOfInitialCapital: 0.1,
      strategyOutperformance: 120,
      strategyOutperformancePercent: 0.12,
      totalProfit: 250,
      commissionLoadPercent: 0.1,
      totalLiquidatedVolume: 0,
    });
    expect(d.long.netProfitAsPercentOfLargestLoss).toBe(-1);
    expect(d.short.largestLoserAsPercentOfGrossLoss).toBe(0);
  });

  it("liquidated volume: margin call exits; the largest at one price and time", () => {
    const call = (qty: number, price: number, time: number) => trade({ qty, exit: { signal: "Margin call", price, time } });
    const r = report([call(10, 5, 1), call(4, 5, 1), call(20, 3, 2), trade({ qty: 99, exit: { price: 9 } })]);
    Object.assign(r.performance, { long: {}, short: {} });
    expect(derivedPerformance(r).all).toMatchObject({ totalLiquidatedVolume: 130, largestLiquidatedVolume: 70 });
  });
});

describe("distribution", () => {
  it("winners / losers / breakevens among closed trades", () => {
    const trades = [trade({ profit: 3 }), trade({ profit: -1 }), trade({ profit: 0 }), trade({ profit: 2 }), trade({ profit: 9, open: true })];
    expect(distribution(report(trades))).toEqual({ total: 4, winners: 2, losers: 1, breakevens: 1 });
  });
});

describe("equityPoints (summary curve)", () => {
  it("starts at 0 at the first entry, one point per exit, same-bar exits keep the last", () => {
    const t0 = ms(2026, 1, 5);
    const trades = [
      trade({ cumProfit: 10, entry: { time: t0 }, exit: { time: t0 + DAY_MS, bar: 1 } }),
      trade({ cumProfit: 15, exit: { time: t0 + DAY_MS, bar: 1 } }),
      trade({ cumProfit: 5, exit: { time: t0 + 2 * DAY_MS, bar: 2 } }),
    ];
    expect(equityPoints(report(trades, { buyHold: [0, 7, 9] }))).toEqual([
      { time: t0 / 1000, value: 0, buyHold: 0 },
      { time: (t0 + DAY_MS) / 1000, value: 15, buyHold: 7 },
      { time: (t0 + 2 * DAY_MS) / 1000, value: 5, buyHold: 9 },
    ]);
  });

  it("empty without trades", () => {
    expect(equityPoints(report([]))).toEqual([]);
  });
});
