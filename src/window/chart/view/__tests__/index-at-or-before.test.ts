import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import { indexAtOrBefore } from "../helpers";

const bars = [100, 200, 300].map((t) => ({ time: t as UTCTimestamp, open: 1, high: 1, low: 1, close: 1 }));

describe("bar holding a synced crosshair time", () => {
  it("is the last bar opened at or before it", () => {
    expect(indexAtOrBefore(bars, 50)).toBe(-1);
    expect(indexAtOrBefore(bars, 100)).toBe(0);
    expect(indexAtOrBefore(bars, 250)).toBe(1);
    expect(indexAtOrBefore(bars, 300)).toBe(2);
    expect(indexAtOrBefore(bars, 999)).toBe(2);
  });
});
