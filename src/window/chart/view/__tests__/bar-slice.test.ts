import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createBarSlice } from "../bar-slice";
import type { ChartCx } from "../context";
import type { OHLC } from "../../chart-types";

const bars = (n: number): OHLC[] =>
  Array.from({ length: n }, (_, i) => ({ time: (1_000 + i * 60) as OHLC["time"], open: 1, high: 1, low: 1, close: 1 }));

function setup(n: number) {
  const cx = { allBars: [] as OHLC[], raw: [] as OHLC[], replayActive: false, activeType: "candle", rawDaily: [], chart: null, series: null } as unknown as ChartCx;
  const slice = createRoot(() => createBarSlice(cx));
  slice.loadBars(bars(n));
  return { cx, slice };
}

describe("bar slice in Bar Replay (#353)", () => {
  it("the replayed bars are the chart's newest: live paints and the legend use them", () => {
    const { cx, slice } = setup(100);
    expect(slice.sliceAtEnd()).toBe(true);
    // Replay cuts the chart's bars at the replay time; every loaded bar stays in allBars.
    (cx as { replayActive: boolean }).replayActive = true;
    cx.raw = cx.allBars.slice(0, 40);
    expect(slice.sliceAtEnd()).toBe(true);
    expect(slice.latestBar()).toBe(cx.raw[39]);
  });

  it("a slice move keeps the replayed bars", () => {
    const { cx, slice } = setup(100);
    (cx as { replayActive: boolean }).replayActive = true;
    const shown = cx.allBars.slice(0, 40);
    cx.raw = shown;
    expect(slice.sliceToEnd()).toBe(false);
    expect(slice.sliceAround(1_000 + 90 * 60)).toBe(false);
    expect(cx.raw).toBe(shown);
  });

  it("out of replay, a chart given older bars is not at the end", () => {
    const { cx, slice } = setup(20_000);
    expect(slice.sliceAtEnd()).toBe(true);
    expect(cx.raw.length).toBeLessThan(cx.allBars.length);
    slice.sliceToStart();
    expect(slice.sliceAtEnd()).toBe(false);
  });
});
