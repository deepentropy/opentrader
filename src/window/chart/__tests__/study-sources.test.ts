import { describe, expect, it } from "vitest";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { alignToBars, canHaveChildren, parentsOf, parseSourceRef, plotChoices, sourceRef, withDescendants } from "../indicators/study-sources";

const entry = (plots: string[], sources: string[] = ["src"]): IndicatorRegistryEntry =>
  ({
    id: "x",
    name: "X",
    defaultInputs: Object.fromEntries(sources.map((s) => [s, "close"])),
    inputConfig: sources.map((s) => ({ id: s, type: "source", title: "Source", defval: "close" })),
    plotConfig: plots.map((p) => ({ id: p, title: p.toUpperCase(), color: "#fff" })),
  }) as unknown as IndicatorRegistryEntry;

describe("study sources", () => {
  it("refs: <id>$<plot>", () => {
    expect(sourceRef("rsi#2", 1)).toBe("rsi#2$1");
    expect(parseSourceRef("rsi#2$1")).toEqual({ id: "rsi#2", plot: 1 });
    expect(parseSourceRef("close")).toBeNull();
    expect(parseSourceRef("$1")).toBeNull();
    expect(parseSourceRef("a$x")).toBeNull();
  });

  it("parents from the source inputs", () => {
    expect(parentsOf(entry(["p"], ["a", "b"]), { a: "rsi$0", b: "close" })).toEqual(["rsi"]);
    expect(parentsOf(entry(["p"]), { src: "hl2" })).toEqual([]);
  });

  it("a source: not a strategy, with plots", () => {
    expect(canHaveChildren("rsi", entry(["p"]))).toBe(true);
    expect(canHaveChildren("rsi", entry([]))).toBe(false);
    expect(canHaveChildren("x", undefined)).toBe(false);
  });

  it("choices: title alone for one plot, '<title>: <plot>' otherwise", () => {
    expect(plotChoices("vol", "Vol", entry(["v"]))).toEqual([{ value: "vol$0", label: "Vol" }]);
    expect(plotChoices("vol", "Vol", entry(["volume", "ma"]))).toEqual([
      { value: "vol$0", label: "Vol: VOLUME" },
      { value: "vol$1", label: "Vol: MA" },
    ]);
  });

  it("values aligned with the bars by time", () => {
    expect(alignToBars([{ time: 2, value: 5 }, { time: 3, value: null }], [{ time: 1 }, { time: 2 }, { time: 3 }])).toEqual([NaN, 5, NaN]);
  });

  it("descendants go with their source", () => {
    const e = entry(["p"]);
    const settings = { b: { inputs: { src: "a$0" } }, c: { inputs: { src: "b$0" } }, d: { inputs: { src: "close" } } };
    expect(withDescendants(["a", "b", "c", "d"], settings, ["a"], () => e)).toEqual(["a", "b", "c"]);
    expect(withDescendants(["b", "c"], settings, ["cmp-1"], () => e)).toEqual(["cmp-1"]);
  });
});
