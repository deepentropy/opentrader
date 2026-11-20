import { describe, expect, it } from "vitest";
import { TICK_BAR_GAP, isTickResolution, nextTickBarTime, tickBarMs, tickBars, tickCount, ticksPerPage } from "../tick-bars";

const t = (timeMs: number, price: number, volume = 1) => ({ timeMs, price, volume });

describe("tick intervals (#376)", () => {
  it("reads N of an NT id", () => {
    expect(tickCount("1T")).toBe(1);
    expect(tickCount("100T")).toBe(100);
    expect(tickCount("1000T")).toBe(1000);
    expect(tickCount("1001T")).toBeNull();
    expect(tickCount("0T")).toBeNull();
    expect(tickCount("10S")).toBeNull();
    expect(isTickResolution("10T")).toBe(true);
    expect(isTickResolution("10")).toBe(false);
  });

  it("asks whole bars, at most 100 000 ticks", () => {
    expect(ticksPerPage(1)).toBe(1500);
    expect(ticksPerPage(10)).toBe(15000);
    expect(ticksPerPage(100)).toBe(100000);
    expect(ticksPerPage(1000)).toBe(100000);
    expect(ticksPerPage(7) % 7).toBe(0);
  });
});

describe("tickBars", () => {
  it("groups N ticks a bar from the oldest, stamped at its first tick", () => {
    const bars = tickBars([t(1000, 5), t(1500, 7, 2), t(2000, 4), t(2600, 6), t(3000, 6.5)], 2);
    expect(bars).toEqual([
      { time: 1, open: 5, high: 7, low: 5, close: 7, volume: 3 },
      { time: 2, open: 4, high: 6, low: 4, close: 6, volume: 2 },
      { time: 3, open: 6.5, high: 6.5, low: 6.5, close: 6.5, volume: 1 },
    ]);
  });

  it("keeps bars of one millisecond apart, after the bar before them", () => {
    const bars = tickBars([t(1_795_169_016_812, 1), t(1_795_169_016_812, 2), t(1_795_169_016_812, 3)], 1);
    const times = bars.map((b) => b.time as number);
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(times[2]).toBeGreaterThan(times[1]);
    expect(times.map(tickBarMs)).toEqual([1_795_169_016_812, 1_795_169_016_812, 1_795_169_016_812]);
    const after = tickBars([t(1000, 1)], 1, 5);
    expect(after[0].time).toBeCloseTo(5 + TICK_BAR_GAP, 9);
  });

  it("a live bar starts after the last one", () => {
    expect(nextTickBarTime(2500, 1)).toBe(2.5);
    expect(nextTickBarTime(1000, 1)).toBeCloseTo(1 + TICK_BAR_GAP, 9);
  });
});
