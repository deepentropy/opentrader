import { describe, expect, it, vi } from "vitest";

// A study's bars of the chart's symbol follow the chart's session; another symbol's are the regular session's.
const getBars = vi.hoisted(() => vi.fn(async () => ({ bars: [{ time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] })));
vi.mock("../../../../data/datafeed", () => ({
  getBars,
  getBarsBefore: vi.fn(async () => []),
  getEvents: vi.fn(async () => []),
  isIntradayResolution: (r: string) => /^\d+$/.test(r),
  isSecondResolution: (r: string) => /S$/.test(r),
  isSupportedResolution: () => true,
  setLiveSymbol: vi.fn(async () => {}),
  subscribeBars: vi.fn(async () => () => {}),
}));

import { OtherSymbolBars } from "../other-symbols";

describe("OtherSymbolBars sessions", () => {
  it("reads the chart symbol in the chart's session, another symbol in the regular one", () => {
    const s = new OtherSymbolBars(() => undefined, "t");
    s.setChartSession("NASDAQ:AAPL", "ETH");
    s.bars("NASDAQ:AAPL", "5S", "1");
    s.bars("NASDAQ:MSFT", "5S", "1");
    expect(getBars.mock.calls).toEqual([
      ["NASDAQ:AAPL", "5S", "ETH"],
      ["NASDAQ:MSFT", "5S", "RTH"],
    ]);
    // Its keys tell the sessions apart: a regular-session chart reads the symbol again.
    expect(s.key("NASDAQ:AAPL", "5S", "1")).toBe("NASDAQ:AAPL|5S@ETH");
    s.setChartSession("NASDAQ:AAPL", "RTH");
    expect(s.key("NASDAQ:AAPL", "5S", "1")).toBe("NASDAQ:AAPL|5S");
    s.bars("NASDAQ:AAPL", "5S", "1");
    expect(getBars.mock.calls[2]).toEqual(["NASDAQ:AAPL", "5S", "RTH"]);
  });
});
