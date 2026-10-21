import { describe, expect, it, vi } from "vitest";

const DAY = 86400;
const D0 = 1_700_000_000 - (1_700_000_000 % DAY); // a UTC midnight
// Daily bars: day 0 and day 1. Five-minute bars of day 1: 4 bars from 10:00.
vi.mock("../../../../data/datafeed", () => ({
  getBars: vi.fn(async (_s: string, res: string) => ({
    bars:
      res === "1D"
        ? [
            { time: D0, open: 10, high: 12, low: 9, close: 11, volume: 100 },
            { time: D0 + DAY, open: 11, high: 20, low: 5, close: 19, volume: 400 },
          ]
        : [0, 1, 2, 3].map((k) => ({ time: D0 + DAY + 36000 + k * 300, open: 11 + k, high: 12 + k, low: 10 + k, close: 11.5 + k, volume: 10 })),
  })),
  getBarsBefore: vi.fn(async () => []),
  getEvents: vi.fn(async () => []),
  isIntradayResolution: (r: string) => /^\d+$/.test(r),
  isSecondResolution: (r: string) => /S$/.test(r),
  isSupportedResolution: () => true,
  setLiveSymbol: vi.fn(async () => {}),
  subscribeBars: vi.fn(async () => () => {}),
}));
// Daily bars as loaded (no session restamp in this test).
vi.mock("../../../../backtester/oakscript", () => ({ scriptBars: (b: unknown[]) => b }));
vi.mock("../script-chart", () => ({ scriptChartContext: () => undefined, symbolDetails: () => undefined }));

import { OtherSymbolBars } from "../other-symbols";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("OtherSymbolBars: higher-timeframe bar forming at the replay time", () => {
  it("rebuilds it from the chart-interval bars up to the replay time", async () => {
    const changed: string[][] = [];
    const s = new OtherSymbolBars((keys) => changed.push([...keys]), "t");
    s.setChartSpan(D0, 300, "5");
    s.bars("NASDAQ:SPY", "D", "5");
    await tick();
    // Replay time after the second five-minute bar of day 1.
    s.setCutoff(D0 + DAY + 36000 + 300);
    // First read starts the five-minute load: the forming day is left out meanwhile.
    expect(s.bars("NASDAQ:SPY", "D", "5")?.map((b) => b.time)).toEqual([D0]);
    await tick();
    // The five-minute bars arrived: the daily key is told too.
    expect(changed.some((k) => k.includes("NASDAQ:SPY|1D"))).toBe(true);
    const daily = s.bars("NASDAQ:SPY", "D", "5")!;
    expect(daily).toHaveLength(2);
    expect(daily[1]).toMatchObject({ time: D0 + DAY, open: 11, high: 13, low: 10, close: 12.5, volume: 20 });
    // Replay off: the real daily bar.
    s.setCutoff(null);
    expect(s.bars("NASDAQ:SPY", "D", "5")![1]).toMatchObject({ high: 20, close: 19 });
  });
});
