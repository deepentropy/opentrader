/** Pine built-ins of the TypeScript strategy ports, hand-computed on short series. */
import { describe, expect, it } from "vitest";
import * as pine from "../pine";
import type { Bar } from "../types";

const nan = NaN;
const bars = (rows: [number, number, number, number, number?][], t0 = 1_704_067_200, step = 86_400): Bar[] =>
  rows.map(([open, high, low, close, volume], i) => ({ time: t0 + i * step, open, high, low, close, volume }));

function expectSeries(actual: number[], expected: number[], digits = 12): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((e, i) => {
    if (Number.isNaN(e)) expect(actual[i], `index ${i}`).toBeNaN();
    else expect(actual[i], `index ${i}`).toBeCloseTo(e, digits);
  });
}

describe("moving windows", () => {
  it("sum / sma are na until the window is full", () => {
    expectSeries(pine.sum([1, 2, 3, 4], 2), [nan, 3, 5, 7]);
    expectSeries(pine.sma([1, 2, 3, 4], 2), [nan, 1.5, 2.5, 3.5]);
    expectSeries(pine.sma([1, 2], 3), [nan, nan]);
    expect(pine.sma([], 3)).toEqual([]);
  });

  it("ema / rma are seeded with the SMA of the first n values", () => {
    // alpha 2/3: 1.5, then 2/3 x 3 + 1/3 x 1.5 = 2.5, 3.5, 4.5
    expectSeries(pine.ema([1, 2, 3, 4, 5], 2), [nan, 1.5, 2.5, 3.5, 4.5]);
    // alpha 1/2: 1.5, 2.25, 3.125
    expectSeries(pine.rma([1, 2, 3, 4], 2), [nan, 1.5, 2.25, 3.125]);
  });

  it("highest / lowest over the last n bars", () => {
    expectSeries(pine.highest([3, 1, 4, 1, 5], 3), [nan, nan, 4, 4, 5]);
    expectSeries(pine.lowest([3, 1, 4, 1, 5], 3), [nan, nan, 1, 1, 1]);
  });

  it("stdev: population by default, sample on request", () => {
    const x = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(pine.stdev(x, 8)[7]).toBeCloseTo(2, 12);
    expect(pine.stdev(x, 8, false)[7]).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(pine.stdev([5, 5, 5], 3)[2]).toBe(0);
    expect(pine.stdev(x, 8)[6]).toBeNaN();
  });
});

describe("oscillators", () => {
  it("rsi is 100 on a rising series, 0 on a falling one, na at first", () => {
    const up = pine.rsi([1, 2, 3, 4, 5, 6], 3);
    expect(up[0]).toBeNaN();
    expect(up[5]).toBe(100);
    expect(pine.rsi([6, 5, 4, 3, 2, 1], 3)[5]).toBe(0);
    // One loss of 1 and gains of 1 (rma 3): up 2/3, down 1/3 at bar 3 -> 100 - 100 / 3
    expect(pine.rsi([1, 2, 1, 2], 3)[3]).toBeCloseTo(100 - 100 / (1 + 2), 10);
  });

  it("stoch is na on a flat range (Pine division by zero)", () => {
    const s = pine.stoch([5, 5, 5], [5, 5, 5], [5, 5, 5], 2);
    expect(s[1]).toBeNaN();
    // bar 1: 100 x (2 - 0) / (3 - 0); bar 2: 100 x (3 - 1) / (4 - 1)
    expectSeries(pine.stoch([1, 2, 3], [2, 3, 4], [0, 1, 2], 2), [nan, 200 / 3, 200 / 3]);
  });

  it("macd: histogram = macd - signal", () => {
    const x = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const [m, s, h] = pine.macd(x, 3, 6, 4);
    for (let i = 0; i < x.length; i++) {
      if (Number.isNaN(s[i])) continue;
      expect(h[i]).toBeCloseTo(m[i] - s[i], 12);
    }
    expect(m[4]).toBeNaN();
    expect(m[5]).not.toBeNaN();
  });

  it("mfi is 100 with only rising money flow", () => {
    const b = bars([
      [1, 1, 1, 1, 10],
      [2, 2, 2, 2, 10],
      [3, 3, 3, 3, 10],
      [4, 4, 4, 4, 10],
    ]);
    const m = pine.mfi(b, pine.hlc3Of(b), 2);
    expect(m[3]).toBe(100);
  });
});

describe("true range", () => {
  const b = bars([
    [10, 12, 9, 11],
    [11, 15, 10, 14],
    [14, 14, 8, 9],
  ]);
  it("tr is na on bar 0, then the largest of the three ranges", () => {
    expectSeries(pine.tr(b), [nan, 5, 6]);
  });
  it("atr uses high - low on bar 0", () => {
    // rma 2 of [3, 5, 6]: seed (3 + 5) / 2 = 4, then (6 + 4) / 2 = 5
    expectSeries(pine.atr(b, 2), [nan, 4, 5]);
  });
});

describe("comparisons and crosses", () => {
  it("script comparisons treat values closer than 1e-10 as equal", () => {
    expect(pine.lt(489.2914285714285, 489.2914285714286)).toBe(false);
    expect(pine.le(489.2914285714286, 489.2914285714285)).toBe(true);
    expect(pine.gt(1 + 1e-9, 1)).toBe(true);
    expect(pine.ge(1, 1 + 1e-11)).toBe(true);
    expect(pine.gt(NaN, 0)).toBe(false);
    expect(pine.lt(0, NaN)).toBe(false);
  });

  it("crossover / crossunder compare exactly, against a series or a constant", () => {
    expect(pine.crossover([1, 3], [2, 2], 1)).toBe(true);
    expect(pine.crossover([2, 3], [2, 2], 1)).toBe(true); // from equal
    expect(pine.crossover([3, 4], [2, 2], 1)).toBe(false); // already above
    expect(pine.crossover([1, 3], 2, 1)).toBe(true);
    expect(pine.crossover([1, 3], 2, 1, true)).toBe(false); // first call: history is na
    expect(pine.crossover([3], 2, 0)).toBe(false); // no previous bar
    expect(pine.crossunder([3, 1], [2, 2], 1)).toBe(true);
    expect(pine.crossunder([1, 0], [2, 2], 1)).toBe(false);
  });
});

describe("helpers", () => {
  it("at / nz / div / change", () => {
    expect(pine.at([1, 2, 3], 2, 1)).toBe(2);
    expect(pine.at([1, 2, 3], 0, 1)).toBeNaN();
    expect(pine.nz(NaN)).toBe(0);
    expect(pine.nz(NaN, 7)).toBe(7);
    expect(pine.nz(3, 7)).toBe(3);
    expect(pine.div(1, 0)).toBeNaN();
    expect(pine.div(1, 4)).toBe(0.25);
    expectSeries(pine.change([1, 4, 2]), [nan, 3, -2]);
  });

  it("round is half away from zero", () => {
    expect(pine.round(2.5)).toBe(3);
    expect(pine.round(-2.5)).toBe(-3);
    expect(pine.round(2.4)).toBe(2);
    expect(pine.round(-0.4)).toBe(-0);
  });

  it("sources", () => {
    const b = bars([[1, 4, 0, 3]]);
    expect(pine.sourceOf(b, "open")).toEqual([1]);
    expect(pine.sourceOf(b, "high")).toEqual([4]);
    expect(pine.sourceOf(b, "low")).toEqual([0]);
    expect(pine.sourceOf(b, "hl2")).toEqual([2]);
    expect(pine.sourceOf(b, "hlc3")).toEqual([7 / 3]);
    expect(pine.sourceOf(b, "hlcc4")).toEqual([2.5]);
    expect(pine.sourceOf(b, "ohlc4")).toEqual([2]);
    expect(pine.sourceOf(b, "anything else")).toEqual([3]);
    expect(pine.volumeOf(b)).toEqual([NaN]);
    expect(pine.timeMs(b, 0)).toBe(1_704_067_200_000);
  });

  it("vwap restarts on each session day of the exchange zone", () => {
    // 5-minute bars: two at the end of a New York day (20:50 and 20:55 UTC in January), then two the next day.
    const t0 = Date.UTC(2024, 0, 10, 20, 50) / 1000;
    const b: Bar[] = [
      { time: t0, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { time: t0 + 300, open: 20, high: 20, low: 20, close: 20, volume: 3 },
      { time: t0 + 86_400, open: 30, high: 30, low: 30, close: 30, volume: 2 },
      { time: t0 + 86_700, open: 40, high: 40, low: 40, close: 40, volume: 2 },
    ];
    expectSeries(pine.vwap(b, pine.closeOf(b), "America/New_York"), [10, 17.5, 30, 35]);
    expect(pine.sessionDays(b, "America/New_York")).toEqual(["2024-01-10", "2024-01-10", "2024-01-11", "2024-01-11"]);
  });

  it("timestamp is the exchange wall time, DST included", () => {
    expect(new Date(pine.timestamp("America/New_York", 2024, 1, 10, 9, 30)).toISOString()).toBe("2024-01-10T14:30:00.000Z");
    expect(new Date(pine.timestamp("America/New_York", 2024, 7, 10, 9, 30)).toISOString()).toBe("2024-07-10T13:30:00.000Z");
    expect(new Date(pine.timestamp("Etc/UTC", 2024, 2, 29)).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
});
