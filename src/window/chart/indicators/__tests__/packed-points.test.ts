import { describe, expect, it } from "vitest";
import { isPacked, packPlots, packPoints, packedPrefix, withField } from "../packed-points";
import { applyDelta, deltaSnapshot, encodeDelta } from "../study-worker-types";

const points = (n: number, last = 0) =>
  Array.from({ length: n }, (_, i) => ({ time: 1000 + i, value: i === n - 1 ? last : i % 7 === 0 ? NaN : i, ...(i % 3 === 0 && { color: "#fff" }) }));

describe("packed points", () => {
  it("reads as the array of points it was made from", () => {
    const src = points(1000, 5);
    const p = packPoints(src);
    expect(isPacked(p)).toBe(true);
    expect(Array.isArray(p)).toBe(true);
    expect(p.length).toBe(1000);
    expect(p[3]).toEqual(src[3]);
    expect(p[999]).toEqual(src[999]);
    expect(p[1000]).toBeUndefined();
    expect([...p]).toEqual(src);
    expect(p.slice(10, 13)).toEqual(src.slice(10, 13));
    expect(p.some((x) => x.value === 5)).toBe(true);
    expect(p.filter((x) => x.color).length).toBe(src.filter((x) => x.color).length);
    expect(JSON.parse(JSON.stringify(p))).toEqual(JSON.parse(JSON.stringify(src)));
    expect(Object.keys(p).length).toBe(1000);
  });

  it("keeps a short list or a list of other values as it is", () => {
    const short = points(10);
    expect(packPoints(short)).toBe(short);
    const nums = Array.from({ length: 1000 }, (_, i) => i);
    expect(packPoints(nums)).toBe(nums);
  });

  it("is cut back and grows in place, as a worker's changes are put in a result", () => {
    const p = packPoints(points(1000));
    p.length = 998;
    p.push({ time: 5000, value: 1, color: "#000" }, { time: 5001, value: 2 });
    expect(p.length).toBe(1000);
    expect(p[998]).toEqual({ time: 5000, value: 1, color: "#000" });
    expect(p[999]).toEqual({ time: 5001, value: 2 });
    p[1005] = { time: 6000, value: 3 };
    expect(p.length).toBe(1006);
    expect(p[1002].value).toBeNaN();
  });

  it("puts a worker's changes back as the plain result would", () => {
    const prev = { plots: { a: points(1000, 1) }, metadata: { title: "x" } };
    const next = { plots: { a: points(1001, 7) }, metadata: { title: "x" } };
    const held = packPlots(structuredClone(prev));
    const delta = encodeDelta(next, deltaSnapshot(prev, 1000));
    const out = applyDelta(structuredClone(delta), held) as typeof next;
    expect([...out.plots.a]).toEqual(next.plots.a);
    expect(isPacked(out.plots.a)).toBe(true);
  });

  it("compares a result with a packed one without making points", () => {
    const prev = packPoints(points(1000, 1));
    const next = points(1000, 2);
    expect(packedPrefix(next, prev, 1000)).toBe(999);
    expect(packedPrefix(next, next, 1000)).toBeNull();
    const withColor = next.map((x, i) => (i === 500 ? { ...x, color: "#123" } : x));
    expect(packedPrefix(withColor, prev, 1000)).toBe(500);
  });

  it("gives a plot a colour column from another field", () => {
    const src = points(1000).map((x, i) => ({ ...x, paletteIndex: i % 2 }));
    const shaded = ["#a", "#b"];
    for (const list of [src, packPoints(src)]) {
      const out = withField(list, "color", "paletteIndex", (ix) => shaded[ix as number]);
      expect(out[0]).toEqual({ ...src[0], color: "#a" });
      expect(out[1]).toEqual({ ...src[1], color: "#b" });
      expect(out.length).toBe(1000);
    }
  });
});
