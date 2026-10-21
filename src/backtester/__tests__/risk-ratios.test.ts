/** Sharpe / Sortino ratios of the report (monthly returns, the reference app's rule; see report.ts). */
import { describe, expect, it } from "vitest";
import { computePerformance } from "../report";
import type { Bar, Trade } from "../types";

const ms = (iso: string) => Date.parse(iso);

function trade(entry: string, exit: string, profit: number, open = false): Trade {
  return {
    direction: "long",
    entryId: "L",
    entry: { signal: "L", price: 100, bar: 0, time: ms(entry) },
    exit: { signal: open ? "" : "X", price: 100, bar: 1, time: ms(exit) },
    open,
    qty: 1,
    profit,
    profitPercent: profit / 100,
    commission: 0,
  } as Trade;
}

const bar = (iso: string): Bar => ({ time: ms(iso) / 1000, open: 100, high: 100, low: 100, close: 100, volume: 1 });

function expected(returns: number[]) {
  const rf = 0.02 / 12;
  const n = returns.length;
  const mean = returns.reduce((a, r) => a + r, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  const dd = Math.sqrt(returns.reduce((a, r) => a + Math.min(0, r - rf) ** 2, 0) / n);
  return [(mean - rf) / sd, (mean - rf) / dd];
}

const run = (closed: Trade[], open: Trade[], openPL: number, lastBar: string) =>
  computePerformance([bar("2024-01-02T14:30:00Z"), bar(lastBar)], closed, open, 10000, { all: 1, long: 1, short: 1 }, openPL, []);

describe("Sharpe / Sortino", () => {
  it("monthly returns from the month after the first entry; open PnL in the last bar's month", () => {
    const p = run(
      [trade("2024-01-15T14:30:00Z", "2024-03-10T14:30:00Z", 500), trade("2024-03-20T14:30:00Z", "2024-04-05T14:30:00Z", -200)],
      [trade("2024-05-02T14:30:00Z", "2024-06-03T14:30:00Z", 95, true)],
      100,
      "2024-06-03T14:30:00Z",
    );
    // Feb 0, Mar +500, Apr -200, May 0, Jun +100 (openPL, not the open trade's profit).
    const [sharpe, sortino] = expected([0, 500 / 10000, -200 / 10500, 0, 100 / 10300]);
    expect(p.sharpeRatio).toBeCloseTo(sharpe, 12);
    expect(p.sortinoRatio).toBeCloseTo(sortino, 12);
  });

  it("starts at the first exit's month when it is the entry month; ends at the last exit without open trades", () => {
    const p = run(
      [trade("2024-01-03T14:30:00Z", "2024-01-20T14:30:00Z", 300), trade("2024-02-01T14:30:00Z", "2024-04-01T14:30:00Z", -100)],
      [],
      0,
      "2024-09-03T14:30:00Z",
    );
    const [sharpe, sortino] = expected([300 / 10000, 0, 0, -100 / 10300]);
    expect(p.sharpeRatio).toBeCloseTo(sharpe, 12);
    expect(p.sortinoRatio).toBeCloseTo(sortino, 12);
  });

  it("is null without trades", () => {
    const p = run([], [], 0, "2024-09-03T14:30:00Z");
    expect(p.sharpeRatio).toBeNull();
    expect(p.sortinoRatio).toBeNull();
  });
});
