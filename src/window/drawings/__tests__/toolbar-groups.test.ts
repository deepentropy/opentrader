import { describe, expect, it } from "vitest";
import type { Coords } from "lightweight-charts-drawing/core/coords";
import { offsetCoords } from "../pane-coords";
import { groupValue, sameColor } from "../toolbar-groups";

describe("groupValue", () => {
  it("the common value, else mixed", () => {
    expect(groupValue([2, 2, 2])).toBe(2);
    expect(groupValue([2, 3])).toBe("mixed");
    expect(groupValue(["a"])).toBe("a");
    expect(groupValue([])).toBe("mixed");
  });

  it("custom equality", () => {
    expect(groupValue(["#2962FF", "rgba(41, 98, 255, 1)"], sameColor)).toBe("#2962FF");
    expect(groupValue(["#2962FF", "rgba(41, 98, 255, 0.5)"], sameColor)).toBe("mixed");
  });
});

describe("sameColor", () => {
  it("compares hex and opacity across notations and case", () => {
    expect(sameColor("#2962ff", "#2962FF")).toBe(true);
    expect(sameColor("rgb(41, 98, 255)", "#2962FF")).toBe(true);
    expect(sameColor("rgba(41, 98, 255, 0.25)", "rgba(41,98,255,0.25)")).toBe(true);
    expect(sameColor("rgba(41, 98, 255, 0.25)", "rgba(41, 98, 255, 0.3)")).toBe(false);
    expect(sameColor("#2962FF", "#2962FE")).toBe(false);
  });
});

describe("offsetCoords", () => {
  const base = { priceToY: (p: number) => (p > 0 ? 100 - p : null), yToPrice: (y: number) => 100 - y } as unknown as Coords;

  it("no offset: the same coords object", () => {
    expect(offsetCoords(base, 0)).toBe(base);
  });

  it("shifts price -> y down and y -> price back", () => {
    const c = offsetCoords(base, 50);
    expect(c.priceToY(10)).toBe(140);
    expect(c.priceToY(-1)).toBeNull();
    expect(c.yToPrice(140)).toBe(10);
  });
});
