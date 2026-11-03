import { describe, expect, it, vi } from "vitest";
import type { Bar } from "oakscriptjs";
import { indicatorRegistry, type IndicatorRegistryEntry } from "lightweight-charts-indicators";

// The TPO module pulls the chart's theme and session stores; only its entry test is needed here.
vi.mock("../../window/chart/profiles/tpo", () => ({ isTpoEntry: () => false }));

import { barsSince, declaredColumns, markKind, readRun, screenRows, withSession } from "../script-screen";

const entryOf = (id: string) => indicatorRegistry.find((e) => e.id === id) as IndicatorRegistryEntry;
const DAY = 86400;
const T0 = 1_767_330_000; // a New York midnight (05:00 UTC)

/** `n` daily bars on a zigzag around 100. */
function bars(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + 10 * Math.sin(i / 6) + i * 0.05;
    return { time: T0 + i * DAY, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1000 + i } as Bar;
  });
}

describe("withSession", () => {
  const daily = [
    { time: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: T0 + DAY, open: 1.5, high: 2, low: 1, close: 1.8, volume: 12 },
  ];
  it("follows the newest bar with the session in progress", () => {
    const out = withSession(daily, { time: T0 + 2 * DAY, open: 1.8, high: 2.2, low: 1.7, close: 2.1, volume: 5 });
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ time: T0 + 2 * DAY, open: 1.8, high: 2.2, low: 1.7, close: 2.1, volume: 5 });
  });
  it("replaces the bar of the same day", () => {
    const out = withSession(daily, { time: T0 + DAY, open: 1.5, high: 2.5, low: 1, close: 2.4, volume: 20 });
    expect(out).toHaveLength(2);
    expect(out[1].close).toBe(2.4);
  });
  it("keeps the history without a session or with an older one", () => {
    expect(withSession(daily, null)).toEqual(daily);
    expect(withSession(daily, { time: T0, open: 9, high: 9, low: 9, close: 9, volume: 1 })).toEqual(daily);
    // A row with no trade yet (zero prices) is not a bar.
    expect(withSession(daily, { time: T0 + 2 * DAY, open: 0, high: 0, low: 0, close: 0, volume: 0 })).toEqual(daily);
  });
});

describe("barsSince / markKind", () => {
  it("counts from the newest bar", () => {
    expect(barsSince([false, true, false, false])).toBe(2);
    expect(barsSince([false, false, true])).toBe(0);
    expect(barsSince([false, false])).toBeNull();
  });
  it("names a mark by id, else text, else shape", () => {
    expect(markKind({ time: 1, id: "buy", text: "Buy" })).toEqual({ key: "mark:buy", title: "Buy" });
    expect(markKind({ time: 1, text: "Bull\n12.5" })).toEqual({ key: "mark:t:Bull", title: "Bull" });
    expect(markKind({ time: 1, shape: "arrowUp" })).toEqual({ key: "mark:s:arrowUp", title: "arrowUp" });
    expect(markKind({ time: 1 })).toBeNull();
  });
});

describe("declaredColumns / readRun", () => {
  it("RSI: its line on the newest bar and the bar before", () => {
    const rsi = entryOf("rsi");
    const cols = declaredColumns(rsi);
    expect(cols[0]).toMatchObject({ kind: "value", title: expect.any(String) });
    const b = bars(120);
    const result = rsi.calculate(b, rsi.defaultInputs);
    const cells = readRun(rsi, result, b, b.map((x) => x.time as number), rsi.defaultInputs, new Map());
    const first = cells[cols[0].key];
    const plot = (result as { plots: Record<string, { value: number }[]> }).plots[rsi.plotConfig[0].id];
    expect(first.value).toBeCloseTo(plot[plot.length - 1].value, 10);
    expect(first.prev).toBeCloseTo(plot[plot.length - 2].value, 10);
  });

  it("RSI Divergence: its conditions and marks as bars since they happened", () => {
    const div = entryOf("rsi-divergence-indicator");
    const cols = declaredColumns(div);
    expect(cols.some((c) => c.kind === "signal" && c.key.startsWith("cond:"))).toBe(true);
    const b = bars(400);
    const result = div.calculate(b, div.defaultInputs) as { markers: { time: number }[] };
    const marks = new Map<string, string>();
    const cells = readRun(div, result, b, b.map((x) => x.time as number), div.defaultInputs, marks);
    expect(result.markers.length).toBeGreaterThan(0);
    // Every mark kind met is a column whose value is the age of its newest mark.
    expect(marks.size).toBeGreaterThan(0);
    for (const [key] of marks) {
      const newest = Math.max(...result.markers.filter((m) => markKind(m as never)?.key === key).map((m) => m.time));
      expect(cells[key].value).toBe((b[b.length - 1].time as number - newest) / DAY);
    }
  });
});

describe("filters and sort", () => {
  const row = (symbol: string, cells: Record<string, { value: number | null; prev?: number | null }>, error?: string) => ({ symbol, cells, ...(error ? { error } : {}) });
  const rows = [
    row("NASDAQ:AAA", { "out:rsi": { value: 25, prev: 35 }, "out:ma": { value: 30, prev: 30 }, "cond:x": { value: 0 } }),
    row("NYSE:BBB", { "out:rsi": { value: 55, prev: 45 }, "out:ma": { value: 50, prev: 50 }, "cond:x": { value: 4 } }),
    row("NASDAQ:CCC", { "out:rsi": { value: null }, "cond:x": { value: null } }),
    row("NASDAQ:DDD", {}, "No data"),
  ];
  const f = (x: Partial<import("../script-screen").ScriptFilter>) => ({ id: "f", key: "out:rsi", op: "above" as const, ...x });

  it("compares with a value, a range, another column and the bar before", () => {
    const syms = (fs: import("../script-screen").ScriptFilter[]) => screenRows(rows, fs, null).map((r) => r.symbol);
    expect(syms([f({ op: "below", value: 30 })])).toEqual(["NASDAQ:AAA"]);
    expect(syms([f({ op: "between", value: 60, value2: 50 })])).toEqual(["NYSE:BBB"]);
    expect(syms([f({ op: "outside", value: 20, value2: 30 })])).toEqual(["NYSE:BBB"]);
    expect(syms([f({ op: "crossesUp", value: 50 })])).toEqual(["NYSE:BBB"]);
    expect(syms([f({ op: "crossesDown", value: 30 })])).toEqual(["NASDAQ:AAA"]);
    expect(syms([f({ op: "crosses", value: 30 })])).toEqual(["NASDAQ:AAA"]);
    expect(syms([f({ op: "crosses", value: 50 })])).toEqual(["NYSE:BBB"]);
    expect(syms([f({ op: "crossesDown", other: "out:ma" })])).toEqual(["NASDAQ:AAA"]);
    expect(syms([f({ op: "above", other: "out:ma" })])).toEqual(["NYSE:BBB"]);
    expect(syms([f({ op: "aboveOrEqual", value: 55 })])).toEqual(["NYSE:BBB"]);
    expect(syms([f({ op: "belowOrEqual", value: 25 })])).toEqual(["NASDAQ:AAA"]);
    expect(syms([f({ key: "cond:x", op: "true" })])).toEqual(["NASDAQ:AAA"]);
    expect(syms([f({ key: "cond:x", op: "trueWithin", value: 5 })])).toEqual(["NASDAQ:AAA", "NYSE:BBB"]);
  });

  it("an incomplete filter keeps every row; errors are listed last only without filters", () => {
    expect(screenRows(rows, [f({ op: "between", value: 1, value2: null })], null).map((r) => r.symbol)).toEqual(["NASDAQ:AAA", "NYSE:BBB", "NASDAQ:CCC", "NASDAQ:DDD"]);
    expect(screenRows(rows, [f({ value: 0 })], null).map((r) => r.symbol)).toEqual(["NASDAQ:AAA", "NYSE:BBB"]);
  });

  it("sorts by a column with missing values last, or by ticker", () => {
    expect(screenRows(rows, [], { key: "out:rsi", order: "desc" }).map((r) => r.symbol)).toEqual(["NYSE:BBB", "NASDAQ:AAA", "NASDAQ:CCC", "NASDAQ:DDD"]);
    expect(screenRows(rows, [], { key: "out:rsi", order: "asc" }).map((r) => r.symbol)).toEqual(["NASDAQ:AAA", "NYSE:BBB", "NASDAQ:CCC", "NASDAQ:DDD"]);
    expect(screenRows(rows, [], { key: "symbol", order: "desc" }).map((r) => r.symbol)).toEqual(["NASDAQ:CCC", "NYSE:BBB", "NASDAQ:AAA", "NASDAQ:DDD"]);
  });
});
