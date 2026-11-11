import { describe, expect, it, vi } from "vitest";
import type { IChartApi } from "lightweight-charts";
import { pendingRange, trackPendingRange } from "../pending-range";

describe("pending range (#307)", () => {
  it("records the range a chart is asked to show until the next frame draws it", () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
    const applied: unknown[] = [];
    const ts = { setVisibleLogicalRange: (r: unknown) => applied.push(r) };
    const chart = { timeScale: () => ts } as unknown as IChartApi;
    trackPendingRange(chart);
    expect(pendingRange(chart)).toBeUndefined();
    ts.setVisibleLogicalRange({ from: 1, to: 5 });
    expect(applied).toEqual([{ from: 1, to: 5 }]);
    expect(pendingRange(chart)).toEqual({ from: 1, to: 5 });
    // A newer range asked in the same frame: the first frame callback leaves it.
    ts.setVisibleLogicalRange({ from: 2, to: 6 });
    frames.shift()!();
    expect(pendingRange(chart)).toEqual({ from: 2, to: 6 });
    frames.shift()!();
    expect(pendingRange(chart)).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
