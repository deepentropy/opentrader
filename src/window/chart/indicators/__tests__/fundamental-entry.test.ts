import { describe, expect, it } from "vitest";
import { abbreviate, formatMetricValue, fundamentalId, getFundamentalEntry } from "../fundamental-entry";
import type { Fundamentals } from "../../../../data/fundamentals";

const F: Fundamentals = {
  ticker: "TEST",
  currency: "USD",
  quarterly: {
    end: ["2025-03-31", "2025-06-30"], fy: [2025, 2025], fp: ["Q1", "Q2"], date: ["2025-04-24", "2025-07-24"],
    items: { revenue: [20_723_000, 22_134_000], cogs: [15_271_000, 14_701_000] },
  },
  annual: { end: [], fy: [], fp: [], date: [], items: {} },
  earnings: [],
};

const day = (d: string) => Date.parse(`${d}T13:30:00Z`) / 1000;
const bars = ["2025-04-01", "2025-04-24", "2025-05-01", "2025-07-24", "2025-08-01"].map((d) => ({ time: day(d), open: 1, high: 1, low: 1, close: 1, volume: 0 }));

describe("fundamental metric studies", () => {
  it("writes values as the reference labels do", () => {
    expect(abbreviate(22_134_000)).toBe("22.134M");
    expect(abbreviate(18_410_000)).toBe("18.41M");
    expect(abbreviate(143_756_000_000)).toBe("143.756B");
    expect(formatMetricValue(22_134_000, "money", "USD")).toBe("$22.134M");
    expect(formatMetricValue(-1_061_000, "money", "USD")).toBe("$-1.061M");
    expect(formatMetricValue(12.3456, "percent", "USD")).toBe("12.35%");
    expect(formatMetricValue(34.3, "percent", "USD")).toBe("34.30%");
    expect(formatMetricValue(-5.28, "percent", "USD")).toBe("-5.28%");
  });

  it("builds entries for the offered periods only", () => {
    expect(getFundamentalEntry(fundamentalId("revenue", "FQ"))?.name).toBe("Total revenue");
    expect(getFundamentalEntry("fund:revenue:XX")).toBeUndefined();
    expect(getFundamentalEntry("fund:depreciation:FQ")).toBeUndefined();
    expect(getFundamentalEntry("fund:marketCap")?.name).toBe("Market capitalization");
    expect(getFundamentalEntry("fund:nope:FQ")).toBeUndefined();
  });

  it("steps on the release day with a label per step", () => {
    const entry = getFundamentalEntry("fund:revenue:FQ")!;
    const calc = entry.calculate as unknown as (b: unknown[], i: Record<string, unknown>, ctx: unknown) => any;
    const pending = calc(bars, {}, { fundamentals: () => undefined });
    expect(pending.pending).toBe(true);
    const r = calc(bars, { showChange: true, changeMode: "Percentage", showDate: true }, { fundamentals: () => F });
    expect(r.plots.value.map((p: { value: number }) => (Number.isNaN(p.value) ? null : p.value))).toEqual([null, 20_723_000, 20_723_000, 22_134_000, 22_134_000]);
    expect(r.fundamentalLabels.value.map((l: { lines: string[] }) => l.lines)).toEqual([
      ["$20.723M", "Mar '25"],
      ["$22.134M", "(+6.81%)", "Jun '25"],
    ]);
  });

  it("labels a percentage metric's change in points (reference: 26.31% → 33.13% is \"(+6.82%)\")", () => {
    const entry = getFundamentalEntry("fund:grossMargin:FQ")!;
    const calc = entry.calculate as unknown as (b: unknown[], i: Record<string, unknown>, ctx: unknown) => any;
    const r = calc(bars, { showChange: true, changeMode: "Percentage", showDate: true }, { fundamentals: () => F });
    expect(r.fundamentalLabels.value.map((l: { lines: string[] }) => l.lines)).toEqual([
      ["26.31%", "Mar '25"],
      ["33.58%", "(+7.27%)", "Jun '25"],
    ]);
  });
});
