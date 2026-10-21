import { describe, expect, it, vi } from "vitest";

// Bars of another symbol, served at once; no live updates.
vi.mock("../../../../data/datafeed", () => ({
  getBars: vi.fn(async () => ({
    bars: [100, 200, 300, 400].map((t) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })),
  })),
  getBarsBefore: vi.fn(async () => []),
  getEvents: vi.fn(async () => []),
  isIntradayResolution: (r: string) => /^\d+$/.test(r),
  isSecondResolution: (r: string) => /S$/.test(r),
  isSupportedResolution: () => true,
  setLiveSymbol: vi.fn(async () => {}),
  subscribeBars: vi.fn(async () => () => {}),
}));

import { OtherSymbolBars } from "../other-symbols";

describe("OtherSymbolBars Bar Replay cut-off", () => {
  it("leaves out the bars after the replay time and tells the studies", async () => {
    const changed: string[][] = [];
    const s = new OtherSymbolBars((keys) => changed.push([...keys]), "t");
    expect(s.lowerBars("NASDAQ:AAPL", "5", "RTH", 0)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.lowerBars("NASDAQ:AAPL", "5", "RTH", 0)?.map((b) => b.time)).toEqual([100, 200, 300, 400]);
    changed.length = 0;
    s.setCutoff(250);
    expect(changed.length).toBe(1);
    expect(s.lowerBars("NASDAQ:AAPL", "5", "RTH", 0)?.map((b) => b.time)).toEqual([100, 200]);
    // Same cut-off: no recalculation.
    s.setCutoff(250);
    expect(changed.length).toBe(1);
    s.setCutoff(null);
    expect(s.lowerBars("NASDAQ:AAPL", "5", "RTH", 0)?.map((b) => b.time)).toEqual([100, 200, 300, 400]);
  });
});
