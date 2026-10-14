import { describe, expect, it } from "vitest";
import { bestMonth, cagr, distribution, equityPoints, outliers, pnlBy, streaks, totalPnl } from "../metrics";
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
    expect(cagr(report([], { netProfitPercent: 0.1, range: { from: 0, to: 365 * DAY_MS } }))).toBeCloseTo(0.1, 12);
    expect(cagr(report([], { netProfitPercent: 0.21, range: { from: 0, to: 730 * DAY_MS } }))).toBeCloseTo(0.1, 12);
    expect(cagr(report([], { netProfitPercent: -0.19, range: { from: 0, to: 730 * DAY_MS } }))).toBeCloseTo(-0.1, 12);
  });

  it("null for an empty period", () => {
    expect(cagr(report([], { netProfitPercent: 0.1, range: { from: 5, to: 5 } }))).toBeNull();
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

  it("a return of NaN counts as 0; fewer than 2 closed trades: none", () => {
    const trades = [...Array.from({ length: 9 }, () => trade({ profitPercent: 0.5 })), trade({ profitPercent: Number.NaN, profit: -7 })];
    expect(outliers(report(trades)).trades).toHaveLength(1);
    expect(outliers(report(trades)).pnl).toBe(-7);
    expect(outliers(report([trade({ profitPercent: 9 })]))).toEqual({ pnl: 0, trades: [] });
  });

  it("all equal returns: no outlier", () => {
    expect(outliers(report([trade({ profitPercent: 0.1 }), trade({ profitPercent: 0.1 })])).trades).toEqual([]);
  });
});

describe("bestMonth", () => {
  it("entry month with the best win rate; the first month wins a tie", () => {
    const trades = [
      trade({ profit: 1, entry: { time: ms(2026, 2, 3) } }),
      trade({ profit: 1, entry: { time: ms(2025, 2, 3) } }),
      trade({ profit: 1, entry: { time: ms(2026, 3, 3) } }),
      trade({ profit: -1, entry: { time: ms(2026, 3, 4) } }),
      trade({ profit: 1, entry: { time: ms(2026, 5, 4) } }),
    ];
    expect(bestMonth(report(trades))).toEqual({ month: "February", winRate: 1 });
  });

  it("null without closed trades; a breakeven is not a win", () => {
    expect(bestMonth(report([trade({ open: true, profit: 5 })]))).toBeNull();
    expect(bestMonth(report([trade({ profit: 0, entry: { time: ms(2026, 7, 1) } })]))).toEqual({ month: "July", winRate: 0 });
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
