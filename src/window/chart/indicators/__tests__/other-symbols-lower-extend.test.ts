import { describe, expect, it, vi } from "vitest";

// A study's bars on a timeframe below the chart's (`request.security_lower_tf`, `request.security` of a lower one)
// follow the chart's loaded history back as it pages, up to the lower-timeframe bars a script is given.
const DAY = 86400;
const NOW = 100 * DAY;
const bar = (time: number) => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
/** `n` bars of `step` seconds ending before `end`. */
const run = (end: number, step: number, n: number) => Array.from({ length: n }, (_, i) => bar(end - (n - i) * step));

const getBars = vi.hoisted(() => vi.fn());
const getBarsBefore = vi.hoisted(() => vi.fn());
vi.mock("../../../../data/datafeed", () => ({
  getBars,
  getBarsBefore,
  getEvents: vi.fn(async () => []),
  getTickerInfo: vi.fn(async () => ({})),
  isIntradayResolution: (r: string) => /^\d+$/.test(r),
  isSecondResolution: (r: string) => /S$/.test(r),
  isSupportedResolution: () => true,
  setLiveSymbol: vi.fn(async () => {}),
  subscribeBars: vi.fn(async () => () => {}),
}));

import { OtherSymbolBars } from "../other-symbols";

const settle = () => new Promise((r) => setTimeout(r, 0));
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i++) await settle();
}

describe("OtherSymbolBars lower timeframes", () => {
  it("pages a timeframe below the chart's back to the chart's first bar", async () => {
    getBars.mockReset().mockResolvedValue({ bars: run(NOW, 60, 1000) });
    // A day of 1-minute bars per page.
    getBarsBefore.mockReset().mockImplementation(async (_s: string, _r: string, before: number) => run(before, 60, 1440));
    const s = new OtherSymbolBars(() => undefined, "t");
    s.setChartSpan(NOW - 10 * DAY, 300, "5");
    s.bars("NSE:RELIANCE", "1", "5");
    await settled();
    const bars = s.bars("NSE:RELIANCE", "1", "5")!;
    expect(bars[0].time).toBeLessThanOrEqual(NOW - 10 * DAY);
    // The chart scrolls back: they follow.
    s.setChartSpan(NOW - 20 * DAY, 300, "5");
    await settled();
    expect(s.bars("NSE:RELIANCE", "1", "5")![0].time).toBeLessThanOrEqual(NOW - 20 * DAY);
  });

  it("stops at the lower-timeframe bars a script is given", async () => {
    getBars.mockReset().mockResolvedValue({ bars: run(NOW, 5, 1000) });
    getBarsBefore.mockReset().mockImplementation(async (_s: string, _r: string, before: number) => run(before, 5, 17280));
    const s = new OtherSymbolBars(() => undefined, "t");
    // A year of 5-minute chart bars: millions of 5-second bars.
    s.setChartSpan(NOW - 365 * DAY, 300, "5");
    s.bars("NSE:RELIANCE", "5S", "5");
    await settled();
    const n = s.bars("NSE:RELIANCE", "5S", "5")!.length;
    expect(n).toBeGreaterThanOrEqual(100_000);
    expect(n).toBeLessThan(100_000 + 17280);
    // No single request asks for the chart's whole span.
    for (const call of getBarsBefore.mock.calls) expect(call[4]).toBeLessThan(10);
  });
});
