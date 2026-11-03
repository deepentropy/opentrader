import { describe, expect, it } from "vitest";
import { volumeHalfWidth, volumeWidthFactor } from "../volume-widths";

describe("volume candle widths", () => {
  it("weighs a bar 1 + log2(volume / average), at least the weight of 0.9 x average, the heaviest on screen = 1", () => {
    // 0 and NaN volumes are left out of the average (and weigh as the floor)
    const f = volumeWidthFactor([50, 100, 200, 400, 0, NaN]);
    const avg = 750 / 4;
    const w = (v: number) => 1 + Math.log2(Math.max(v, 0.9 * avg) / avg);
    expect(f(400)).toBeCloseTo(1);
    expect(f(200)).toBeCloseTo(w(200) / w(400));
    expect(f(50)).toBeCloseTo(w(0.9 * avg) / w(400));
    expect(f(0)).toBeCloseTo(f(50));
  });

  it("gives equal widths without volume", () => {
    expect(volumeWidthFactor([])(123)).toBe(1);
    expect(volumeWidthFactor([0, 0])(0)).toBe(1);
  });

  it("fills the slot minus a 1px gap each side, at least a sliver", () => {
    expect(volumeHalfWidth(10, 1)).toBe(4);
    expect(volumeHalfWidth(10, 0.5)).toBe(2);
    expect(volumeHalfWidth(10, 0.01)).toBe(0.8);
  });
});
