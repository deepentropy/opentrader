import { describe, expect, it } from "vitest";
import type { Time } from "lightweight-charts";
import type { OHLC } from "lightweight-charts-drawing/core/coords";
import {
  assignTimes,
  atrAtLast,
  boxSize,
  minTickFor,
  priceOf,
  rangeSize,
  toHeikinAshi,
  toKagi,
  toLineBreak,
  toPnf,
  toRangeBars,
  toRenko,
  toSeconds,
} from "../series-transforms";

const T0 = 1_767_600_000;
const STEP = 60;
const bar = (i: number, open: number, high: number, low: number, close: number): OHLC => ({ time: (T0 + i * STEP) as Time, open, high, low, close });
/** Flat bars at the given closes (open = previous close, high/low = the move). */
function closes(cs: number[], firstOpen = cs[0]): OHLC[] {
  return cs.map((c, i) => {
    const o = i === 0 ? firstOpen : cs[i - 1];
    return bar(i, o, Math.max(o, c), Math.min(o, c), c);
  });
}
const shape = <T extends { open: number; close: number; high: number; low: number; up: boolean; proj: boolean }>(xs: T[]) =>
  xs.map((b) => ({ open: +b.open.toFixed(6), close: +b.close.toFixed(6), high: +b.high.toFixed(6), low: +b.low.toFixed(6), up: b.up, proj: b.proj }));

describe("toSeconds", () => {
  it("accepts UNIX seconds, ISO dates and business days", () => {
    expect(toSeconds(123 as Time)).toBe(123);
    expect(toSeconds("2026-01-05" as Time)).toBe(Date.UTC(2026, 0, 5) / 1000);
    expect(toSeconds({ year: 2026, month: 1, day: 5 } as Time)).toBe(Date.UTC(2026, 0, 5) / 1000);
  });
});

describe("assignTimes", () => {
  it("ends at the last source bar, spaced by the median interval", () => {
    const raw = Array.from({ length: 5 }, (_, i) => ({ ...bar(0, i, i, i, i), time: (T0 + i * 300) as Time }));
    const items = assignTimes([{ time: 0 as Time }, { time: 0 as Time }, { time: 0 as Time }], raw);
    expect(items.map((x) => x.time)).toEqual([T0 + 1200 - 600, T0 + 1200 - 300, T0 + 1200]);
  });

  it("spacing is at least 60 s", () => {
    const raw = [0, 10, 20].map((dt) => ({ ...bar(0, 1, 1, 1, 1), time: (T0 + dt) as Time }));
    const items = assignTimes([{ time: 0 as Time }, { time: 0 as Time }], raw);
    expect(items.map((x) => x.time)).toEqual([T0 + 20 - 60, T0 + 20]);
  });

  it("no source bars: items unchanged; one bar: 60 s spacing", () => {
    const items = [{ time: 7 as Time }];
    expect(assignTimes(items, [])).toEqual([{ time: 7 }]);
    expect(assignTimes([{ time: 0 as Time }, { time: 0 as Time }], [bar(0, 1, 1, 1, 1)]).map((x) => x.time)).toEqual([T0 - 60, T0]);
  });
});

describe("priceOf / minTickFor", () => {
  const b = bar(0, 1, 4, 0, 3);
  it("price sources", () => {
    expect(priceOf(b, "open")).toBe(1);
    expect(priceOf(b, "high")).toBe(4);
    expect(priceOf(b, "low")).toBe(0);
    expect(priceOf(b, "close")).toBe(3);
    expect(priceOf(b, "hl2")).toBe(2);
    expect(priceOf(b, "hlc3")).toBeCloseTo(7 / 3, 12);
    expect(priceOf(b, "ohlc4")).toBe(2);
  });

  it("US equity tick: 0.01 at or above $1, 0.0001 below", () => {
    expect(minTickFor(1)).toBe(0.01);
    expect(minTickFor(250)).toBe(0.01);
    expect(minTickFor(0.99)).toBe(0.0001);
    expect(minTickFor(0)).toBe(0.0001);
    expect(minTickFor(-5)).toBe(0.01);
  });
});

describe("atrAtLast / boxSize", () => {
  // True ranges: 2, max(3, 3, 0) = 3, max(4, 0, 4) = 4.
  const raw = [bar(0, 9, 10, 8, 9), bar(1, 10, 12, 9, 11), bar(2, 10, 11, 7, 8)];

  it("Wilder RMA of the true range", () => {
    expect(atrAtLast(raw, 2)).toBeCloseTo(3.25, 12); // (2 + 3) / 2 = 2.5, then (2.5 + 4) / 2
    expect(atrAtLast(raw, 1)).toBe(4);
    expect(atrAtLast(raw, 0.4)).toBe(4); // length rounds to at least 1
  });

  it("fewer bars than the length: mean true range", () => {
    expect(atrAtLast(raw, 14)).toBe(3);
    expect(atrAtLast([], 14)).toBe(0);
  });

  it("box size methods", () => {
    expect(boxSize(raw, { method: "Traditional", size: 0.5, atrLength: 14, percentage: 1 })).toBe(0.5);
    expect(boxSize(raw, { method: "Traditional", size: 0, atrLength: 14, percentage: 1 })).toBe(0.01); // at least one tick
    expect(boxSize(raw, { method: "Percentage LTP", size: 1, atrLength: 14, percentage: 1 })).toBeCloseTo(0.08, 12);
    // 3.333 % of 8 = 0.26664, rounded to the tick.
    expect(boxSize(raw, { method: "Percentage LTP", size: 1, atrLength: 14, percentage: 3.333 })).toBeCloseTo(0.27, 12);
    expect(boxSize(raw, { method: "ATR", size: 1, atrLength: 2, percentage: 1 })).toBeCloseTo(3.25, 12);
    expect(boxSize([], { method: "ATR", size: 1, atrLength: 2, percentage: 1 })).toBe(0);
  });
});

describe("toHeikinAshi", () => {
  it("HA open / close / extremes", () => {
    const ha = toHeikinAshi([bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12)]);
    expect(ha[0]).toMatchObject({ open: 10.5, close: 10.5, high: 12, low: 9 });
    expect(ha[1]).toMatchObject({ open: 10.5, close: 11.5, high: 13, low: 10 });
    expect(ha[1].time).toBe(T0 + STEP);
  });

  it("HA high / low include the HA open and close", () => {
    // A gap down: the HA open (from the previous HA bar) is above the bar's high.
    const ha = toHeikinAshi([bar(0, 100, 100, 100, 100), bar(1, 50, 52, 48, 50)]);
    expect(ha[1].open).toBe(100);
    expect(ha[1].high).toBe(100);
    expect(ha[1].low).toBe(48);
  });

  it("empty input", () => {
    expect(toHeikinAshi([])).toEqual([]);
  });
});

describe("toRenko", () => {
  const raw = closes([10.5, 11.2, 12.1, 10.4, 9.9, 8.7], 10);

  it("bricks on closes with a two-box reversal and touching corners", () => {
    expect(shape(toRenko(raw, 1, "Close", false))).toEqual([
      { open: 10, close: 11, high: 11, low: 10, up: true, proj: false },
      { open: 11, close: 12, high: 12, low: 11, up: true, proj: false },
      // Reversal: needs a fall to 12 - 2 boxes. No wick: the high since the last brick
      // (12) is not more than one box above the brick's open (11).
      { open: 11, close: 10, high: 11, low: 10, up: false, proj: false },
      { open: 10, close: 9, high: 10, low: 9, up: false, proj: false },
    ]);
  });

  it("a wick only past the previous brick's body (reference rule)", () => {
    // Up to 12, then 12.5 (no brick), then a fall to 9.5: the down brick 11 -> 10
    // has a wick to 12.5, more than one box above its open.
    const b = toRenko(closes([10, 11, 12, 12.5, 9.5]), 1, "Close", false);
    const down = b.find((x) => !x.up)!;
    expect([down.open, down.close, down.high, down.low]).toEqual([11, 10, 12.5, 10]);
  });

  it("bricks of the forming bar are projections", () => {
    const b = toRenko(raw, 1, "Close", true);
    expect(b.map((x) => x.proj)).toEqual([false, false, false, true]);
  });

  it("a gap of several boxes builds several bricks; times are ascending and end at the last bar", () => {
    const b = toRenko(closes([10, 13.5], 10), 1, "Close", false);
    expect(b.map((x) => [x.open, x.close])).toEqual([[10, 11], [11, 12], [12, 13]]);
    const times = b.map((x) => x.time as number);
    expect(times[times.length - 1]).toBe(T0 + STEP);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
  });

  it("OHLC source walks O-L-H-C on up bars", () => {
    // One up bar 10 -> low 8.5 -> high 12.2 -> close 12: two down bricks then up bricks.
    const b = toRenko([bar(0, 10, 12.2, 8.5, 12)], 1, "OHLC", false);
    expect(b.map((x) => [x.open, x.close])).toEqual([[10, 9], [10, 11], [11, 12]]);
  });

  it("no bricks for empty input or a non-positive box", () => {
    expect(toRenko([], 1, "Close", false)).toEqual([]);
    expect(toRenko(raw, 0, "Close", false)).toEqual([]);
    expect(toRenko(raw, Number.NaN, "Close", false)).toEqual([]);
    expect(toRenko(closes([10.1, 10.2, 10.3], 10), 1, "Close", false)).toEqual([]);
  });
});

describe("toLineBreak", () => {
  it("three-line break", () => {
    const lines = toLineBreak(closes([10, 11, 12, 11.5, 13, 9, 11.5, 8]), 3, false);
    expect(lines.map((l) => [l.open, l.close, l.up])).toEqual([
      [10, 11, true],
      [11, 12, true],
      [12, 13, true],
      // Must break the low of the last 3 lines (10); starts at the last up line's open.
      [12, 9, false],
      [9, 8, false],
    ]);
    expect(lines[3]).toMatchObject({ high: 12, low: 9 });
  });

  it("one-line break reverses on the last line alone", () => {
    // 10.5 stays inside the last line (10-11); 9.5 breaks its low; 12 breaks the down line's high.
    const lines = toLineBreak(closes([10, 11, 10.5, 9.5, 12]), 1, false);
    expect(lines.map((l) => [l.open, l.close])).toEqual([[10, 11], [10, 9.5], [10, 12]]);
  });

  it("flat closes build nothing; projection on the forming bar", () => {
    expect(toLineBreak(closes([10, 10, 10]), 3, false)).toEqual([]);
    expect(toLineBreak(closes([10]), 3, false)).toEqual([]);
    expect(toLineBreak([], 3, false)).toEqual([]);
    const lines = toLineBreak(closes([10, 11, 12]), 3, true);
    expect(lines.map((l) => l.proj)).toEqual([false, true]);
  });
});

describe("toRangeBars", () => {
  it("a bar closes once its range is reached; the rest is the projection bar", () => {
    // Up bar: path 10 -> 9.5 -> 13 -> 12.5, range 2.
    const raw = [bar(0, 10, 13, 9.5, 12.5)];
    expect(shape(toRangeBars(raw, 2, true, false))).toEqual([{ open: 10, close: 11.5, high: 11.5, low: 9.5, up: true, proj: false }]);
    expect(shape(toRangeBars(raw, 2, true, true))).toEqual([
      { open: 10, close: 11.5, high: 11.5, low: 9.5, up: true, proj: false },
      { open: 11.5, close: 12.5, high: 13, low: 11.5, up: true, proj: true },
    ]);
  });

  it("phantom bars fill an untraded gap", () => {
    const raw = [bar(0, 10, 10.5, 9.8, 10.2), bar(1, 15, 15.5, 14.8, 15.2)];
    expect(shape(toRangeBars(raw, 2, true, false))).toEqual([
      { open: 10, close: 11.8, high: 11.8, low: 9.8, up: true, proj: false },
      { open: 11.8, close: 13.8, high: 13.8, low: 11.8, up: true, proj: false },
    ]);
  });

  it("without phantom bars a gap closes the running bar and opens at the gap price", () => {
    const raw = [bar(0, 10, 10.5, 9.8, 10.2), bar(1, 15, 15.5, 14.8, 15.2)];
    expect(shape(toRangeBars(raw, 2, false, false))).toEqual([{ open: 10, close: 10.2, high: 10.5, low: 9.8, up: true, proj: false }]);
  });

  it("down moves close down bars", () => {
    const b = toRangeBars([bar(0, 10, 10, 5, 5)], 2, true, false);
    // Down bar path 10 -> 10 -> 5 -> 5: bars 10->8, 8->6.
    expect(b.map((x) => [x.open, x.close, x.up])).toEqual([[10, 8, false], [8, 6, false]]);
  });

  it("empty input / non-positive range", () => {
    expect(toRangeBars([], 1, true, false)).toEqual([]);
    expect(toRangeBars([bar(0, 1, 2, 0, 1)], 0, true, false)).toEqual([]);
  });

  it("rangeSize = average high - low, at least one tick", () => {
    expect(rangeSize([bar(0, 10, 12, 9, 11), bar(1, 10, 11, 10, 10)])).toBe(2);
    expect(rangeSize([bar(0, 10, 10, 10, 10)])).toBe(0.01);
    expect(rangeSize([])).toBe(0);
  });
});

describe("toKagi", () => {
  it("columns reverse on the reversal amount and extend with the trend", () => {
    const k = toKagi(closes([10, 11, 13, 12, 10.5, 9, 9.5, 12, 14]), 2, false);
    expect(k.map((x) => [x.start, x.end])).toEqual([[10, 13], [13, 9], [9, 14]]);
  });

  it("yin after breaking the prior waist, yang after exceeding the prior shoulder", () => {
    const k = toKagi(closes([10, 13, 11, 12, 8, 14]), 1, false);
    expect(k.map((x) => x.segments)).toEqual([
      [{ from: 10, to: 13, yang: true }],
      [{ from: 13, to: 11, yang: true }],
      [{ from: 11, to: 12, yang: true }],
      [{ from: 12, to: 11, yang: true }, { from: 11, to: 8, yang: false }],
      [{ from: 8, to: 12, yang: false }, { from: 12, to: 14, yang: true }],
    ]);
  });

  it("a first falling column starts yin", () => {
    const k = toKagi(closes([10, 7]), 1, false);
    expect(k[0].segments).toEqual([{ from: 10, to: 7, yang: false }]);
  });

  it("projection: a column extended by the forming bar", () => {
    const k = toKagi(closes([10, 13, 15]), 1, true);
    expect(k).toHaveLength(1);
    expect(k[0].proj).toBe(true);
  });

  it("nothing for a single bar, empty input or a non-positive reversal", () => {
    expect(toKagi(closes([10]), 1, false)).toEqual([]);
    expect(toKagi([], 1, false)).toEqual([]);
    expect(toKagi(closes([10, 20]), 0, false)).toEqual([]);
  });
});

describe("toPnf", () => {
  it("3-box reversal on closes", () => {
    const p = toPnf(closes([10.2, 11.5, 12.3, 13.7, 12.1, 10.4, 9.8, 12.9, 13.1]), 1, 3, "Close", false, false);
    expect(p.map((c) => [c.kind, c.min, c.max])).toEqual([
      ["x", 11, 13],
      ["o", 10, 12],
      ["x", 11, 13],
    ]);
    expect(p.every((c) => c.box === 1)).toBe(true);
  });

  it("HL source extends X columns with highs", () => {
    const raw = [bar(0, 10, 10, 10, 10), bar(1, 10, 12.4, 10, 10.5)];
    expect(toPnf(raw, 1, 3, "HL", false, false).map((c) => [c.kind, c.min, c.max])).toEqual([["x", 11, 12]]);
    expect(toPnf(raw, 1, 3, "Close", false, false)).toEqual([]);
  });

  it("one step back building keeps a one-box reversal in the same column", () => {
    const raw = closes([10.2, 11.3, 9.5]);
    const osb = toPnf(raw, 1, 1, "Close", true, false);
    expect(osb).toHaveLength(1);
    expect(osb[0]).toMatchObject({ kind: "o", min: 10, max: 10, extra: { kind: "x", top: 11 } });
    const plain = toPnf(raw, 1, 1, "Close", false, false);
    expect(plain.map((c) => [c.kind, c.min, c.max])).toEqual([["x", 11, 11], ["o", 10, 10]]);
  });

  it("empty input / non-positive box", () => {
    expect(toPnf([], 1, 3, "Close", false, false)).toEqual([]);
    expect(toPnf(closes([1, 5]), 0, 3, "Close", false, false)).toEqual([]);
  });
});
