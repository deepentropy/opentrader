import { describe, expect, it } from "vitest";
import type { Candle } from "../../../bindings";
import { computeYearRange } from "../ticker-stats";

/** Daily bar at New York midnight of `date` (EDT / EST offsets as the chart stores them). */
function bar(date: string, low: number, high: number): Candle {
  const t = Date.parse(`${date}T00:00:00-04:00`) / 1000;
  return { time: t, open: low, high, low, close: high, volume: 100 } as Candle;
}

describe("computeYearRange 52 week range", () => {
  it("keeps the bars of the 364 days up to the last bar's day", () => {
    const bars = [
      bar("2003-09-10", 0.34, 0.4), // archive bar: out of the window
      bar("2025-10-15", 1, 500), // 365 days back: out
      bar("2025-10-16", 150, 160), // 364 days back: out (window = after the last day minus 364)
      bar("2025-10-17", 140, 170), // 363 days back: in
      bar("2026-06-01", 120, 230),
      bar("2026-10-15", 200, 210),
    ];
    const r = computeYearRange(bars);
    expect(r.low).toBe(120);
    expect(r.high).toBe(230);
  });

  it("uses every bar when the history is shorter than a year", () => {
    const r = computeYearRange([bar("2026-09-01", 10, 12), bar("2026-10-15", 9, 11)]);
    expect(r.low).toBe(9);
    expect(r.high).toBe(12);
  });
});
