import { describe, expect, it, vi } from "vitest";

vi.mock("../../../bindings", () => ({ commands: {} }));

import type { Candle } from "../../../bindings";
import { SessionSpec } from "../../../data/session/spec";
import { localToUtc } from "../../../data/session/zone";
import { aggregateCandles, bucketStart, periodStart } from "../chart-aggregate";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
const dayNo = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000;
/** 00:00 UTC of a date (the bucket keys). */
const key = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
/** A daily bar stamp: local midnight of the date in `tz`. */
const stamp = (y: number, m: number, d: number, tz = NY) => localToUtc(tz, dayNo(y, m, d), 0);

// US equities: Monday-Friday, holidays 01/01/2026 and 19/01/2026.
const spec = new SessionSpec(NY, "0930-1600", "20260101,20260119");

describe("bucketStart", () => {
  it("week: back to Monday 00:00 UTC", () => {
    expect(bucketStart(stamp(2026, 1, 7), "week", NY)).toBe(key(2026, 1, 5)); // Wed
    expect(bucketStart(stamp(2026, 1, 5), "week", NY)).toBe(key(2026, 1, 5)); // Mon
    expect(bucketStart(stamp(2026, 1, 11), "week", NY)).toBe(key(2026, 1, 5)); // Sun
    expect(bucketStart(stamp(2026, 1, 12), "week", NY)).toBe(key(2026, 1, 12));
  });

  it("week across a month / year end", () => {
    // Thu 01/01/2026 -> Mon 29/12/2025.
    expect(bucketStart(stamp(2026, 1, 1), "week", NY)).toBe(key(2025, 12, 29));
  });

  it("month: the 1st of the month", () => {
    expect(bucketStart(stamp(2026, 2, 27), "month", NY)).toBe(key(2026, 2, 1));
    expect(bucketStart(stamp(2026, 12, 31), "month", NY)).toBe(key(2026, 12, 1));
    expect(bucketStart(stamp(2024, 2, 29), "month", NY)).toBe(key(2024, 2, 1));
  });

  it("reads the date in the exchange zone (east of UTC stamps the previous UTC day)", () => {
    // Mon 02/03/2026 00:00 Tokyo = Sun 01/03 15:00 UTC.
    const t = stamp(2026, 3, 2, TOKYO);
    expect(new Date(t * 1000).getUTCDate()).toBe(1);
    expect(bucketStart(t, "week", TOKYO)).toBe(key(2026, 3, 2));
    expect(bucketStart(t, "month", TOKYO)).toBe(key(2026, 3, 1));
    // Read in UTC it would land in the previous week.
    expect(bucketStart(t, "week", "UTC")).toBe(key(2026, 2, 23));
  });
});

describe("periodStart — months", () => {
  it("N = 1 is the plain month", () => {
    expect(periodStart(stamp(2026, 5, 15), { unit: "month", n: 1 }, spec)).toBe(key(2026, 5, 1));
  });

  it("N months group the month index within the calendar year", () => {
    const q = { unit: "month" as const, n: 3 };
    expect(periodStart(stamp(2026, 2, 10), q, spec)).toBe(key(2026, 1, 1));
    expect(periodStart(stamp(2026, 5, 15), q, spec)).toBe(key(2026, 4, 1));
    expect(periodStart(stamp(2026, 12, 31), q, spec)).toBe(key(2026, 10, 1));
    expect(periodStart(stamp(2026, 7, 1), { unit: "month", n: 6 }, spec)).toBe(key(2026, 7, 1));
    expect(periodStart(stamp(2026, 6, 30), { unit: "month", n: 6 }, spec)).toBe(key(2026, 1, 1));
  });

  it("5 months: the last group of the year is short (Nov-Dec) and the next year restarts", () => {
    const p = { unit: "month" as const, n: 5 };
    expect(periodStart(stamp(2026, 12, 15), p, spec)).toBe(key(2026, 11, 1));
    expect(periodStart(stamp(2027, 1, 4), p, spec)).toBe(key(2027, 1, 1));
  });
});

describe("periodStart — weeks", () => {
  const two = { unit: "week" as const, n: 2 };

  it("N = 1 is the plain Monday week", () => {
    expect(periodStart(stamp(2026, 1, 8), { unit: "week", n: 1 }, spec)).toBe(key(2026, 1, 5));
  });

  it("2 weeks counted from the year's first Monday", () => {
    // First Monday of 2026: 05/01.
    expect(periodStart(stamp(2026, 1, 5), two, spec)).toBe(key(2026, 1, 5));
    expect(periodStart(stamp(2026, 1, 16), two, spec)).toBe(key(2026, 1, 5));
    expect(periodStart(stamp(2026, 1, 19), two, spec)).toBe(key(2026, 1, 19));
  });

  it("days before the first Monday belong to the previous year's last group", () => {
    // First Monday of 2025: 06/01; 02/01/2026 is week 51 -> group 50 = Mon 22/12/2025.
    expect(periodStart(stamp(2026, 1, 2), two, spec)).toBe(key(2025, 12, 22));
    expect(periodStart(stamp(2025, 12, 29), two, spec)).toBe(key(2025, 12, 22));
  });
});

describe("periodStart — trading days", () => {
  it("N days group the year's trading days (weekends and holidays skipped)", () => {
    const p = { unit: "day" as const, n: 2 };
    // 2026 trading days: 02/01 (0), 05/01 (1), 06/01 (2), 07/01 (3), 08/01 (4) …
    expect(periodStart(stamp(2026, 1, 2), p, spec)).toBe(key(2026, 1, 2));
    expect(periodStart(stamp(2026, 1, 5), p, spec)).toBe(key(2026, 1, 2));
    expect(periodStart(stamp(2026, 1, 6), p, spec)).toBe(key(2026, 1, 6));
    expect(periodStart(stamp(2026, 1, 7), p, spec)).toBe(key(2026, 1, 6));
    expect(periodStart(stamp(2026, 1, 8), p, spec)).toBe(key(2026, 1, 8));
  });

  it("3 days and a holiday inside the group", () => {
    const p = { unit: "day" as const, n: 3 };
    // 15/01 (9), 16/01 (10), [19/01 holiday], 20/01 (11) -> group 9 starts 15/01.
    expect(periodStart(stamp(2026, 1, 20), p, spec)).toBe(key(2026, 1, 15));
    expect(periodStart(stamp(2026, 1, 21), p, spec)).toBe(key(2026, 1, 21));
  });

  it("a bar on a closed day takes the next trading day's index", () => {
    // Saturday 03/01 -> index of Monday 05/01 (1) -> group 0 = 02/01.
    expect(periodStart(stamp(2026, 1, 3), { unit: "day", n: 2 }, spec)).toBe(key(2026, 1, 2));
    // With N = 1 the bar is keyed to that next trading day.
    expect(periodStart(stamp(2026, 1, 3), { unit: "day", n: 1 }, spec)).toBe(key(2026, 1, 5));
  });
});

describe("aggregateCandles", () => {
  const c = (t: number, o: number, h: number, l: number, cl: number, v: number | null = 100): Candle => ({ time: t, open: o, high: h, low: l, close: cl, volume: v });

  it("weekly OHLCV reduce", () => {
    const daily = [
      c(stamp(2026, 1, 5), 10, 12, 9, 11),
      c(stamp(2026, 1, 6), 11, 15, 10, 14),
      c(stamp(2026, 1, 7), 14, 14, 8, 9, null),
      c(stamp(2026, 1, 12), 9, 10, 7, 8, 50),
    ];
    expect(aggregateCandles(daily, { unit: "week", n: 1 }, spec)).toEqual([
      { time: key(2026, 1, 5), open: 10, high: 15, low: 8, close: 9, volume: 200 },
      { time: key(2026, 1, 12), open: 9, high: 10, low: 7, close: 8, volume: 50 },
    ]);
  });

  it("sorts the input and skips candles with a null field", () => {
    const daily = [
      c(stamp(2026, 2, 3), 20, 21, 19, 20.5),
      c(stamp(2026, 2, 2), 19, 22, 18, 20),
      { time: stamp(2026, 2, 4), open: null, high: 99, low: 1, close: 50, volume: 10 },
      { time: null, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const out = aggregateCandles(daily, { unit: "month", n: 1 }, spec);
    expect(out).toEqual([{ time: key(2026, 2, 1), open: 19, high: 22, low: 18, close: 20.5, volume: 200 }]);
  });

  it("empty input and a single bar", () => {
    expect(aggregateCandles([], { unit: "week", n: 1 }, spec)).toEqual([]);
    const one = aggregateCandles([c(stamp(2026, 3, 4), 1, 2, 0.5, 1.5, null)], { unit: "month", n: 3 }, spec);
    expect(one).toEqual([{ time: key(2026, 1, 1), open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }]);
  });

  it("does not mutate the input candles", () => {
    const a = c(stamp(2026, 1, 5), 10, 12, 9, 11);
    const b = c(stamp(2026, 1, 6), 11, 15, 10, 14);
    aggregateCandles([a, b], { unit: "week", n: 1 }, spec);
    expect(a).toEqual(c(stamp(2026, 1, 5), 10, 12, 9, 11));
  });
});
