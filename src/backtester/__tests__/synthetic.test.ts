/** The synthetic series of the golden backtests: deterministic, well formed, on a realistic US-equity calendar. */
import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { dailySeries, dayOf, intradaySeries, pennySeries, prng, sessionMinutes, tradingDays } from "./synthetic";

function wellFormed(bars: Bar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
    expect(b.low).toBeGreaterThan(0);
    expect(b.volume).toBeGreaterThan(0);
    if (i > 0) expect(b.time).toBeGreaterThan(bars[i - 1].time);
  }
}

describe("prng", () => {
  it("is deterministic per seed and uniform in [0, 1)", () => {
    const a = prng(7);
    const b = prng(7);
    const c = prng(8);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

describe("tradingDays", () => {
  it("skips weekends, the fixed holidays and extra holidays", () => {
    // 29/12/2023 (Friday) on: 01/01/2024 is a holiday, 30-31/12 a weekend.
    const days = tradingDays(dayOf(2023, 12, 29), 3, [dayOf(2024, 1, 3)]);
    expect(days).toEqual([dayOf(2023, 12, 29), dayOf(2024, 1, 2), dayOf(2024, 1, 4)]);
  });
});

describe("daily series", () => {
  const bars = dailySeries();
  it("has 1,500 well-formed bars stamped at New York midnight on weekdays", () => {
    expect(bars).toHaveLength(1500);
    wellFormed(bars);
    for (const b of bars) {
      const { day, minutes } = sessionMinutes(b);
      expect(minutes).toBe(0);
      const wd = (day + 4) % 7;
      expect(wd).toBeGreaterThanOrEqual(1);
      expect(wd).toBeLessThanOrEqual(5);
    }
  });
  it("is the same on every call", () => {
    expect(dailySeries()).toEqual(bars);
  });
});

describe("5-minute series", () => {
  const bars = intradaySeries();
  it("has 78 regular-session bars per day, 09:30 to 15:55 New York", () => {
    expect(bars).toHaveLength(49 * 78);
    wellFormed(bars);
    const perDay = new Map<number, number[]>();
    for (const b of bars) {
      const { day, minutes } = sessionMinutes(b);
      perDay.set(day, [...(perDay.get(day) ?? []), minutes]);
    }
    expect(perDay.size).toBe(49);
    for (const minutes of perDay.values()) {
      expect(minutes).toHaveLength(78);
      expect(minutes[0]).toBe(9 * 60 + 30);
      expect(minutes[77]).toBe(15 * 60 + 55);
    }
    expect(perDay.has(dayOf(2024, 3, 29))).toBe(false); // Good Friday
  });
  it("crosses the US DST change: the session opens at 14:30 UTC before 10/03/2024, 13:30 UTC after", () => {
    const opens = bars.filter((_, i) => i % 78 === 0).map((b) => new Date(b.time * 1000).toISOString());
    expect(opens).toContain("2024-03-08T14:30:00.000Z");
    expect(opens).toContain("2024-03-11T13:30:00.000Z");
  });
});

describe("penny series", () => {
  const bars = pennySeries();
  it("goes from above 1 USD down to cents and back up", () => {
    expect(bars).toHaveLength(900);
    wellFormed(bars);
    const closes = bars.map((b) => b.close);
    expect(closes[0]).toBeGreaterThan(1);
    expect(Math.min(...closes)).toBeLessThan(0.06);
    expect(closes[closes.length - 1]).toBeGreaterThan(0.2);
    // 4 decimals at most
    for (const b of bars) expect(Number(b.close.toFixed(4))).toBe(b.close);
  });
});
