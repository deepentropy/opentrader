import { describe, expect, it } from "vitest";
import { applyDelta, encodeDelta } from "../study-worker-types";

const points = (n: number, last = 0) => Array.from({ length: n }, (_, i) => ({ time: i, value: i === n - 1 ? last : i, color: "#fff" }));

describe("study worker result changes", () => {
  it("sends the tail of a live update and rebuilds the same result", () => {
    const prev = { plots: { a: points(1000, 1), b: points(1000, 2) }, barColors: points(1000), metadata: { title: "x" } };
    const next = { plots: { a: points(1001, 5), b: points(1000, 3) }, barColors: points(1000), metadata: { title: "x" } };
    const delta = encodeDelta(next, prev) as { plots: { a: { items: unknown[] }; b: { items: unknown[] } }; barColors: { items: unknown[] } };
    expect(delta.plots.a.items).toHaveLength(2);
    expect(delta.plots.b.items).toHaveLength(1);
    expect(delta.barColors.items).toHaveLength(0);
    expect(applyDelta(structuredClone(delta), prev)).toEqual(next);
  });

  it("keeps NaN points equal and sends short or new arrays whole", () => {
    const nan = (n: number) => Array.from({ length: n }, (_, i) => ({ time: i, value: NaN }));
    const prev = { plots: { a: nan(100) }, labels: [{ time: 1, text: "a" }] };
    const next = { plots: { a: nan(100) }, labels: [{ time: 1, text: "b" }], lines: [{ time1: 1 }] };
    const delta = encodeDelta(next, prev) as { plots: { a: { items: unknown[] } }; labels: unknown[] };
    expect(delta.plots.a.items).toHaveLength(0);
    expect(delta.labels).toEqual(next.labels);
    expect(applyDelta(delta, prev)).toEqual(next);
  });

  it("rebuilds a result whose history changed in the middle", () => {
    const prev = { plots: { a: points(500) } };
    const next = { plots: { a: points(500) } };
    next.plots.a[200] = { time: 200, value: -1, color: "#fff" };
    expect(applyDelta(encodeDelta(next, prev), prev)).toEqual(next);
  });
});
