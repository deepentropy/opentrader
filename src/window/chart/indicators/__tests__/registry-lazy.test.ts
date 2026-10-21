import { describe, expect, it } from "vitest";
import { indicatorRegistry } from "lightweight-charts-indicators";
import {
  STANDARD_ROWS,
  COMMUNITY_ROWS,
  getIndicatorEntry,
  indicatorLibraryLoaded,
  indicatorName,
  isKnownIndicatorId,
  isLibraryIndicatorId,
  loadIndicatorLibrary,
} from "../registry";

describe("indicator registry: the library loads on first use", () => {
  it("lists every library entry from its names, before the library is loaded", () => {
    expect(indicatorLibraryLoaded()).toBe(false);
    const listed = new Set([...STANDARD_ROWS, ...COMMUNITY_ROWS].map((r) => r.id));
    for (const e of indicatorRegistry.filter((x) => x.group !== "candlestick" && x.id !== "auto-trend-detector")) expect(listed.has(e.id)).toBe(true);
    expect(indicatorName("rsi#2")).toBe(indicatorRegistry.find((e) => e.id === "rsi")!.name);
    expect(isLibraryIndicatorId("rsi")).toBe(true);
    expect(isKnownIndicatorId("rsi")).toBe(true);
    // The app's own built-ins are there at once.
    expect(getIndicatorEntry("volume")?.id).toBe("volume");
  });

  it("gives a library entry once loaded (the first read starts the load)", async () => {
    expect(getIndicatorEntry("rsi")).toBeUndefined();
    await loadIndicatorLibrary();
    expect(indicatorLibraryLoaded()).toBe(true);
    expect(getIndicatorEntry("rsi#3")).toBe(indicatorRegistry.find((e) => e.id === "rsi"));
  });
});
