import { describe, expect, it } from "vitest";
import { chartFrame, chartInterval, groupTrades, intervalSec, metricsInterval, tradeMetrics, type Bar } from "../trade-journal-calc";

const T0 = Date.UTC(2024, 0, 8, 14, 30) / 1000; // Monday 09:30 New York
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ time: T0 + i * 60, open: o, high: h, low: l, close: c });
const BARS = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 104, 100, 103), bar(2, 103, 103.5, 96, 97), bar(3, 97, 106, 97, 105), bar(4, 105, 105, 104, 104.5)];

describe("tradeMetrics", () => {
  it("estimates prices from the bars and measures excursions", () => {
    const c = tradeMetrics({ side: "long", entryTime: T0 + 10, exitTime: T0 + 3 * 60 + 5, dateOnly: false, qty: 10, fees: 2 }, BARS, 60, "1")!;
    expect(c.entryPrice).toBe(100);
    expect(c.exitPrice).toBe(97);
    expect(c.entryEstimated && c.exitEstimated).toBe(true);
    expect(c.pnl).toBeCloseTo(-32);
    expect(c.pnlPct).toBeCloseTo(-0.03);
    expect(c.runUpPct).toBeCloseTo(0.06); // high 106 in bar 3
    expect(c.drawdownPct).toBeCloseTo(0.04); // low 96
  });
  it("applies bar percentages to the file's own prices (split-adjusted bars)", () => {
    const c = tradeMetrics({ side: "long", entryTime: T0, exitTime: T0 + 4 * 60, dateOnly: false, entryPrice: 1000, exitPrice: 1045 }, BARS, 60, "1")!;
    expect(c.entryEstimated).toBe(false);
    expect(c.pnlPct).toBeCloseTo(0.045);
    expect(c.drawdownPct).toBeCloseTo(0.04);
    expect(c.drawdown).toBeCloseTo(40);
  });
  it("mirrors excursions for shorts", () => {
    const c = tradeMetrics({ side: "short", entryTime: T0 + 60, exitTime: T0 + 2 * 60, dateOnly: false }, BARS, 60, "1")!;
    expect(c.entryPrice).toBe(100.5);
    expect(c.exitPrice).toBe(103);
    expect(c.pnl).toBeCloseTo(-2.5);
    expect(c.drawdownPct).toBeCloseTo(104 / 100.5 - 1);
    expect(c.runUpPct).toBeCloseTo(1 - 96 / 100.5);
  });
  it("gives null when the bars do not reach the trade", () => {
    expect(tradeMetrics({ side: "long", entryTime: T0 - 86400, exitTime: T0 - 80000, dateOnly: false }, BARS, 60, "1")).toBeNull();
    expect(tradeMetrics({ side: "long", entryTime: T0, exitTime: T0 + 3600, dateOnly: false }, BARS, 60, "1")).toBeNull();
  });
  it("reads date-only trades on daily closes", () => {
    const day = (i: number, c: number): Bar => ({ time: 1704690000 + i * 86400, open: c - 1, high: c + 2, low: c - 3, close: c });
    const bars = [day(0, 50), day(1, 52), day(2, 49), day(3, 55)];
    const c = tradeMetrics({ side: "long", entryTime: bars[0].time, exitTime: bars[3].time, dateOnly: true }, bars, 86400, "1D")!;
    expect(c.entryPrice).toBe(50);
    expect(c.exitPrice).toBe(55);
    expect(c.drawdownPct).toBeCloseTo(0.08); // low 46 on the third day
  });
});

describe("intervals", () => {
  it("reads values on minutes, hours or days", () => {
    expect(metricsInterval({ entryTime: 0, exitTime: 3600, dateOnly: false })).toBe("1");
    expect(metricsInterval({ entryTime: 0, exitTime: 10 * 86400, dateOnly: false })).toBe("60");
    expect(metricsInterval({ entryTime: 0, exitTime: 90 * 86400, dateOnly: false })).toBe("1D");
    expect(metricsInterval({ entryTime: 0, exitTime: 3600, dateOnly: true })).toBe("1D");
    expect(intervalSec("15")).toBe(900);
    expect(intervalSec("1W")).toBe(604800);
  });
  it("fits the chart interval to the trade, coarser for old trades", () => {
    const now = T0 + 30 * 86400;
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 1800, dateOnly: false }, now)).toBe("1");
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 6 * 3600, dateOnly: false }, now)).toBe("5");
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 2 * 86400, dateOnly: false }, now)).toBe("15");
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 10 * 86400, dateOnly: false }, now)).toBe("60");
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 100 * 86400, dateOnly: false }, now)).toBe("1D");
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 30 * 86400, dateOnly: true }, now)).toBe("1D");
    // Three years back: 1-minute history would be too deep for the chart.
    expect(chartInterval({ entryTime: T0, exitTime: T0 + 1800, dateOnly: false }, T0 + 3 * 365 * 86400)).toBe("15");
  });
  it("frames a trade with margins of at least 15 bars", () => {
    expect(chartFrame({ entryTime: 1000, exitTime: 1600 }, "1")).toEqual({ from: 100, to: 2500 });
    expect(chartFrame({ entryTime: 0, exitTime: 3 * 86400 * 30 }, "1")).toEqual({ from: -86400 * 30, to: 4 * 86400 * 30 });
  });
});

describe("groupTrades", () => {
  const calc = (pnl: number, pnlPct: number, drawdownPct: number) => ({
    entryPrice: 1, exitPrice: 1, entryEstimated: false, exitEstimated: false, pnl, pnlPct, runUp: 0, runUpPct: 0, drawdown: 0, drawdownPct, interval: "1",
  });
  const trades = [
    { symbol: "AAPL", entryTime: T0, dateOnly: false, calc: calc(10, 0.12, 0.005) },
    { symbol: "MSFT", entryTime: T0 + 86400, dateOnly: false, calc: calc(-5, -0.03, 0.04) },
    { symbol: "AAPL", entryTime: T0 + 40 * 86400, dateOnly: false, calc: null },
  ];
  it("groups by symbol with totals", () => {
    const g = groupTrades(trades, "symbol", "America/New_York");
    expect(g.map((x) => [x.label, x.trades.length, x.pnl, x.wins, x.computed])).toEqual([
      ["AAPL", 2, 10, 1, 1],
      ["MSFT", 1, -5, 0, 1],
    ]);
  });
  it("groups by date, newest first, in dd/mm/yyyy", () => {
    expect(groupTrades(trades, "day", "America/New_York").map((x) => x.label)).toEqual(["17/02/2024", "09/01/2024", "08/01/2024"]);
    expect(groupTrades(trades, "week", "America/New_York").map((x) => x.label)).toEqual(["Week of 12/02/2024", "Week of 08/01/2024"]);
    expect(groupTrades(trades, "month", "America/New_York").map((x) => x.label)).toEqual(["February 2024", "January 2024"]);
  });
  it("groups by profit and drawdown ranges", () => {
    expect(groupTrades(trades, "profit", "UTC").map((x) => x.label)).toEqual(["+10% to +20%", "−5% to 0%", "Not computed"]);
    expect(groupTrades(trades, "drawdown", "UTC").map((x) => x.label)).toEqual(["0% to 1%", "2% to 5%", "Not computed"]);
  });
});
