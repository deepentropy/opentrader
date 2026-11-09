import { describe, expect, it } from "vitest";
import { bucketOf, colorScale, heatSizes, legendLabel, squarify } from "../screener-heatmap";

describe("screener heatmap colour scale", () => {
  it("widens past ±3.25: a legend of −8 … 8 for an extremum near 9.5", () => {
    const values = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1) * (i / 10));
    const sc = colorScale("signed", values, null);
    expect(sc.centres.map((c) => legendLabel(c, true))).toEqual(["−8%", "−5%", "−2%", "0%", "2%", "5%", "8%"]);
    expect(bucketOf(sc, 0)).toBe(3);
    expect(bucketOf(sc, 0.5)).toBe(4);
    expect(bucketOf(sc, -20)).toBe(0);
    expect(bucketOf(sc, null)).toBe(3);
  });
  it("is symmetric with steps of S/3 up to ±3.25", () => {
    const sc = colorScale("signed", [0.1, -0.2, 0.25, 0.3], null);
    expect(sc.centres.map((c) => legendLabel(c, true))).toEqual(["−0.3%", "−0.2%", "−0.1%", "0%", "0.1%", "0.2%", "0.3%"]);
  });
  it("puts a value on its nearest centre with a fixed depth", () => {
    const sc = colorScale("signed", [], 1);
    expect(sc.centres).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(bucketOf(sc, 1.4)).toBe(4);
    expect(bucketOf(sc, 1.5)).toBe(5);
  });
  it("keeps relative volume positive, in nice steps", () => {
    const sc = colorScale("relVol", Array.from({ length: 20 }, (_, i) => i / 4), null);
    expect(sc.positive).toBe(true);
    expect(sc.centres[1]).toBe(1);
    expect(bucketOf(sc, -1)).toBe(0);
  });
});

describe("squarified treemap", () => {
  it("fills the box with areas proportional to the weights", () => {
    const placed = squarify([6, 6, 4, 3, 2, 2, 1].map((w, i) => ({ weight: w, item: i })), { x: 0, y: 0, w: 6, h: 4 });
    expect(placed).toHaveLength(7);
    const area = placed.reduce((s, p) => s + p.w * p.h, 0);
    expect(area).toBeCloseTo(24);
    expect(placed[0].w * placed[0].h).toBeCloseTo(6);
  });
});

describe("size options", () => {
  it("volume and turnover of the day, the week and the month, each kind in its own group", () => {
    expect(heatSizes("stock").map((o) => o.short)).toEqual(["Mkt cap", "Vol, 1D", "Vol, 1W", "Vol, 1M", "Price × vol, 1D", "Price × vol, 1W", "Price × vol, 1M", "Mono size"]);
    expect(heatSizes("stock").find((o) => o.id === "Volume1W")?.column).toEqual({ id: "Volume", params: { resolution: "TimeResolution1W" } });
  });
});
