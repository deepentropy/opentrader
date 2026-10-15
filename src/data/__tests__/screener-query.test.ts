import { describe, expect, it } from "vitest";
import {
  EXTRA_FIELDS,
  UNIVERSE_CLAUSE,
  activeColumns,
  filterClauses,
  isActive,
  pillOperation,
  pillTexts,
  planScreen,
  presetFilter,
  presetTitle,
} from "../screener-query";
import {
  COLUMN_BY_ID,
  COLUMN_SETS,
  type CheckboxFilter,
  type ColumnRef,
  type ConditionFilter,
  type Filter,
  type Preset,
  type Screen,
  defaultScreen,
} from "../screener-catalog";

const NNBSP = " ";
const C = (id: string, params: Record<string, string> = {}): ColumnRef => ({ id, params });
const EMA = (length: string) => C("Ema", { length, resolution: "TimeResolution1D" });

function cond(left: ColumnRef, operation: ConditionFilter["operation"], right: ConditionFilter["right"], extra: Partial<ConditionFilter> = {}): ConditionFilter {
  return { id: "f1", type: "Condition", left, operation, target: "value", right, ...extra };
}
const box = (left: ColumnRef, values: string[]): CheckboxFilter => ({ id: "f2", type: "CheckboxGroup", left, values });

describe("isActive", () => {
  it("checkbox filters are active with at least one value", () => {
    expect(isActive(box(C("Index"), []))).toBe(false);
    expect(isActive(box(C("Index"), ["SPX"]))).toBe(true);
  });

  it("condition filters need a value, a column, or the bounds their operation needs", () => {
    expect(isActive(cond(C("Price"), "above", { value: null }))).toBe(false);
    expect(isActive(cond(C("Price"), "above", { value: 0 }))).toBe(true);
    expect(isActive(cond(C("Price"), "above", { column: EMA("50") }))).toBe(true);
    expect(isActive(cond(C("Price"), "between", { left: null, right: null }))).toBe(false);
    expect(isActive(cond(C("Price"), "between", { left: 1, right: null }))).toBe(true);
    expect(isActive(cond(C("Price"), "between", { left: null, right: 1 }))).toBe(true);
    expect(isActive(cond(C("Price"), "outside", { left: 1, right: null }))).toBe(false);
    expect(isActive(cond(C("Price"), "outside", { left: 1, right: 2 }))).toBe(true);
  });
});

describe("pillOperation", () => {
  it("shows an open range as >= or <=", () => {
    expect(pillOperation(cond(C("MarketCap"), "between", { left: 1, right: null }))).toBe("aboveOrEqual");
    expect(pillOperation(cond(C("MarketCap"), "between", { left: null, right: 1 }))).toBe("belowOrEqual");
    expect(pillOperation(cond(C("MarketCap"), "between", { left: 1, right: 2 }))).toBe("between");
    expect(pillOperation(cond(C("MarketCap"), "between", { left: null, right: null }))).toBe("between");
  });

  it("shows the % offset operations as above / below", () => {
    expect(pillOperation(cond(C("Ema"), "abovePercent", { column: C("Price") }))).toBe("above");
    expect(pillOperation(cond(C("Ema"), "belowPercent", { column: C("Price") }))).toBe("below");
    expect(pillOperation(cond(C("Price"), "outside", { left: 1, right: 2 }))).toBe("outside");
  });
});

describe("pillTexts", () => {
  it("unknown and inactive columns", () => {
    expect(pillTexts(cond(C("Nope"), "above", { value: 1 }))).toEqual({ primary: "Nope", value: null });
    expect(pillTexts(cond(C("Price"), "above", { value: null }))).toEqual({ primary: "Price", value: null });
  });

  it("an adaptive checkbox filter with one value shows that value only", () => {
    expect(pillTexts(box(C("Index"), ["SPX"]))).toEqual({ primary: "", value: "S&P 500" });
    expect(pillTexts(box(C("Index"), ["SPX", "NDX"]))).toEqual({ primary: "Index", value: null });
    // Not adaptive (options from the data).
    expect(pillTexts(box(C("Sector"), ["Technology"]))).toEqual({ primary: "Sector", value: null });
  });

  it("price-like values carry the USD unit", () => {
    expect(pillTexts(cond(C("Price"), "aboveOrEqual", { value: 5 }))).toEqual({ primary: "Price", value: "5 USD", icon: "aboveOrEqual" });
    expect(pillTexts(cond(C("Price"), "between", { left: null, right: 10 }))).toEqual({ primary: "Price", value: "10 USD", icon: "belowOrEqual" });
    expect(pillTexts(cond(C("MarketCap"), "between", { left: 2e9, right: 1e10 }))).toEqual({
      primary: "Mkt cap",
      value: `2${NNBSP}B to 10${NNBSP}B USD`,
    });
    expect(pillTexts(cond(C("Volume", { resolution: "TimeResolution1D" }), "above", { value: 1e6 }))).toEqual({ primary: "Vol", value: `1${NNBSP}M`, icon: "above" });
  });

  it("moves a trailing ' %' of the title into the value", () => {
    expect(pillTexts(cond(C("AverageDayRangePercent"), "between", { left: 5, right: null }))).toEqual({ primary: "ADR", value: "5%", icon: "aboveOrEqual" });
    expect(pillTexts(cond(C("Change", { resolution: "TimeResolution1D" }), "above", { value: 5 }))).toEqual({ primary: "Chg", value: "5%", icon: "above" });
    expect(pillTexts(cond(C("Performance", { interval: "IntervalYTD" }), "above", { value: 10 }))).toEqual({ primary: "Perf, YTD", value: "10%", icon: "above" });
  });

  it("names the right column", () => {
    expect(pillTexts(cond(C("Price"), "above", { column: EMA("50") }))).toEqual({ primary: "Price", value: "EMA, 50", icon: "above" });
    expect(pillTexts(cond(C("Price"), "below", { column: C("Ma", { length: "200" }) }))).toEqual({ primary: "Price", value: "SMA, 200", icon: "below" });
  });

  // Reference pill: operation word (shown lower-case) + "<target> by <range>", no icon.
  it("shows a % offset filter as operation + target by range", () => {
    expect(pillTexts({ ...cond(C("Price"), "abovePercent", { column: C("Ma", { length: "50" }) }), offsetRangeId: "offset_range_10" } as Filter))
      .toEqual({ primary: "Price", value: "SMA, 50 by 10% or more", operation: "Above" });
    expect(pillTexts({ ...cond(C("Price"), "belowPercent", { column: C("Ma", { length: "50" }) }), offsetRangeId: "offset_range_0_10" } as Filter))
      .toEqual({ primary: "Price", value: "SMA, 50 by 0% to 10%", operation: "Below" });
  });

  it("a closed range has no icon; outside shows its name; equal has no icon", () => {
    expect(pillTexts(cond(C("Price"), "between", { left: 10, right: 20 }))).toEqual({ primary: "Price", value: "10 to 20 USD" });
    expect(pillTexts(cond(C("Price"), "outside", { left: 10, right: 20 }))).toEqual({ primary: "Price", value: "10 to 20 USD", operation: "Outside" });
    expect(pillTexts(cond(C("Price"), "equal", { value: 5 }))).toEqual({ primary: "Price", value: "5 USD" });
  });
});

describe("presetTitle", () => {
  const p = (x: Preset) => x;
  it("value presets", () => {
    expect(presetTitle("Change", p({ operation: "above", target: "value", right: { value: 30 } }))).toBe("Above 30%");
    expect(presetTitle("Change", p({ operation: "below", target: "value", right: { value: -5 } }))).toBe("Below −5%");
    expect(presetTitle("Price", p({ operation: "belowOrEqual", target: "value", right: { value: 10 } }))).toBe("10 and below");
    expect(presetTitle("Price", p({ operation: "aboveOrEqual", target: "value", right: { value: 5 } }))).toBe("5 and above");
    expect(presetTitle("DividendsYield", p({ operation: "equal", target: "value", right: { value: 0 } }))).toBe("0%");
    expect(presetTitle("VolumePrice", p({ operation: "above", target: "value", right: { value: 1e9 } }))).toBe(`Above 1${NNBSP}B`);
  });

  it("range presets", () => {
    expect(presetTitle("Change", p({ operation: "between", target: "value", right: { left: 0, right: 5 } }))).toBe("0% to 5%");
    expect(presetTitle("ChangeAbs", p({ operation: "between", target: "value", right: { left: 10, right: 100 } }))).toBe("10 to 100");
    expect(presetTitle("MarketCap", p({ operation: "between", target: "value", right: { left: 200e9, right: null } }))).toBe(`200${NNBSP}B and above`);
    expect(presetTitle("MarketCap", p({ operation: "between", target: "value", right: { left: null, right: 50e6 } }))).toBe(`50${NNBSP}M and below`);
    // Unknown column: plain numbers.
    expect(presetTitle("Nope", p({ operation: "between", target: "value", right: { left: 1.5, right: 2 } }))).toBe("1.5 to 2");
  });

  it("column presets", () => {
    expect(presetTitle("Price", p({ operation: "above", target: "Ema", right: { column: EMA("50") } }))).toBe("Above EMA, 50");
    expect(presetTitle("Price", p({ operation: "below", target: "Ema", right: { column: EMA("200") } }))).toBe("Below EMA, 200");
    expect(presetTitle("Ema", p({ operation: "belowPercent", offsetRangeId: "offset_range_0_10", target: "Price", right: { column: C("Price") } }))).toBe(
      "Below Price by 0% to 10%",
    );
    expect(presetTitle("Ema", p({ operation: "abovePercent", offsetRangeId: "offset_range_20", target: "Price", right: { column: C("Price") } }))).toBe(
      "Above Price by 20% or more",
    );
    expect(presetTitle("Ema", p({ operation: "above", target: "Ema", leftParams: { length: "50" }, right: { column: EMA("100") } }))).toBe("50 above EMA, 100");
    expect(presetTitle("Ma", p({ operation: "below", target: "Ma", leftParams: { length: "50" }, right: { column: C("Ma", { length: "100" }) } }))).toBe(
      "50 below SMA, 100",
    );
  });

  it("titles every catalog preset without throwing", () => {
    for (const def of Object.values(COLUMN_BY_ID)) {
      const f = def.filter;
      if (f?.type !== "Condition") continue;
      for (const preset of f.presets ?? []) expect(presetTitle(def.id, preset).length).toBeGreaterThan(0);
    }
  });
});

describe("presetFilter", () => {
  it("keeps the base id and params, applies the preset's left params and right side", () => {
    const base = cond(C("Ema", { length: "20", resolution: "TimeResolution1D" }), "above", { value: null }, { id: "keep" });
    const f = presetFilter(base, { operation: "above", target: "Ema", leftParams: { length: "50" }, right: { column: EMA("100") } });
    expect(f).toEqual({
      id: "keep",
      type: "Condition",
      left: { id: "Ema", params: { length: "50", resolution: "TimeResolution1D" } },
      operation: "above",
      offsetRangeId: undefined,
      target: "Ema",
      right: { column: EMA("100") },
    });
    expect(base.left.params.length).toBe("20"); // base untouched
  });

  it("copies value and range right sides", () => {
    const base = cond(C("Price"), "above", { value: null });
    expect(presetFilter(base, { operation: "below", target: "value", right: { value: 10 } }).right).toEqual({ value: 10 });
    expect(presetFilter(base, { operation: "between", target: "value", right: { left: 1, right: null } }).right).toEqual({ left: 1, right: null });
    expect(presetFilter(box(C("Index"), []), { operation: "above", target: "value", right: { value: 1 } }).type).toBe("Condition");
  });
});

describe("filterClauses", () => {
  it("compiles the comparison operations", () => {
    const ops = { above: "greater", aboveOrEqual: "egreater", below: "less", belowOrEqual: "eless", equal: "equal", nequal: "nequal" } as const;
    for (const [op, clause] of Object.entries(ops)) {
      expect(filterClauses(cond(C("Price"), op as keyof typeof ops, { value: 5 }))).toEqual([{ left: "close", operation: clause, right: 5 }]);
    }
  });

  it("compiles checkbox groups to in_range", () => {
    expect(filterClauses(box(C("Index"), ["SPX", "NDX"]))).toEqual([{ left: "indexes", operation: "in_range", right: ["SPX", "NDX"] }]);
  });

  it("compiles ranges", () => {
    const mc = C("MarketCap");
    expect(filterClauses(cond(mc, "between", { left: 1, right: 2 }))).toEqual([{ left: "market_cap_basic", operation: "in_range", right: [1, 2] }]);
    expect(filterClauses(cond(mc, "between", { left: 1, right: null }))).toEqual([{ left: "market_cap_basic", operation: "egreater", right: 1 }]);
    expect(filterClauses(cond(mc, "between", { left: null, right: 2 }))).toEqual([{ left: "market_cap_basic", operation: "eless", right: 2 }]);
    expect(filterClauses(cond(mc, "between", { left: null, right: null }))).toEqual([]);
    expect(filterClauses(cond(mc, "outside", { left: 1, right: 2 }))).toEqual([{ left: "market_cap_basic", operation: "not_in_range", right: [1, 2] }]);
    expect(filterClauses(cond(mc, "outside", { left: 1, right: null }))).toEqual([]);
  });

  it("compiles a column on the right to its field", () => {
    expect(filterClauses(cond(C("Price"), "above", { column: EMA("200") }))).toEqual([{ left: "close", operation: "greater", right: "EMA200" }]);
    expect(filterClauses(cond(C("Price"), "above", { column: C("Nope") }))).toBeNull();
  });

  it("compiles the % offset ranges", () => {
    const up = (r: "offset_range_0_10" | "offset_range_10" | "offset_range_20") => filterClauses(cond(EMA("50"), "abovePercent", { column: C("Price") }, { offsetRangeId: r }));
    const down = (r: "offset_range_0_10" | "offset_range_10" | "offset_range_20") => filterClauses(cond(EMA("50"), "belowPercent", { column: C("Price") }, { offsetRangeId: r }));
    expect(up("offset_range_0_10")).toEqual([{ left: "EMA50", operation: "in_range%", right: ["close", 1, 1.1] }]);
    expect(down("offset_range_0_10")).toEqual([{ left: "EMA50", operation: "in_range%", right: ["close", 0.9, 1] }]);
    expect(up("offset_range_10")).toEqual([{ left: "EMA50", operation: "above%", right: ["close", 10] }]);
    expect(down("offset_range_20")).toEqual([{ left: "EMA50", operation: "below%", right: ["close", 20] }]);
    expect(filterClauses(cond(EMA("50"), "abovePercent", { column: C("Price") }))).toEqual([]);
  });

  it("gives nothing for an empty value, null for an unknown column", () => {
    expect(filterClauses(cond(C("Price"), "above", { value: null }))).toEqual([]);
    expect(filterClauses(cond(C("Nope"), "above", { value: 1 }))).toBeNull();
    expect(filterClauses(cond(C("Ema", { length: "7" }), "above", { value: 1 }))).toBeNull();
    // A range operation with a single value cannot be compiled.
    expect(filterClauses(cond(C("Price"), "between", { value: 1 }))).toEqual([]);
  });
});

describe("activeColumns", () => {
  const screen = (activeColumnSetId: string, customColumns: ColumnRef[] | null = null): Screen => ({ ...defaultScreen(), activeColumnSetId, customColumns });
  it("custom columns, a preset set, or the first set", () => {
    expect(activeColumns(screen("custom", [C("Price")]))).toEqual([C("Price")]);
    expect(activeColumns(screen("custom", null))).toBe(COLUMN_SETS[0].columns);
    expect(activeColumns(screen("performance"))).toBe(COLUMN_SETS.find((s) => s.id === "performance")!.columns);
    expect(activeColumns(screen("nope"))).toBe(COLUMN_SETS[0].columns);
  });
});

describe("planScreen", () => {
  const all = (_f: string) => true;
  const without = (...missing: string[]) => (f: string) => !missing.includes(f);

  it("plans the default screen: overview columns, extra fields, universe clause, market cap sort", () => {
    const plan = planScreen(defaultScreen(), all, null);
    expect(plan.columns.map((c) => c.id)).toEqual(["Price", "Change", "Volume", "RelativeVolume", "MarketCap", "DividendsYield", "Sector"]);
    expect(plan.fields).toEqual(["close", "change", "volume", "relative_volume_10d_calc", "market_cap_basic", "dividends_yield_current", "sector", ...EXTRA_FIELDS]);
    expect(plan.filter).toEqual([UNIVERSE_CLAUSE]);
    expect(plan.sort).toEqual({ sortBy: "market_cap_basic", sortOrder: "desc" });
    expect(plan.tickers).toBeNull();
  });

  it("never sends fields the backend does not have", () => {
    const plan = planScreen(defaultScreen(), without("dividends_yield_current", "type", "currency", "market_cap_basic"), ["AAPL"]);
    expect(plan.fields).not.toContain("dividends_yield_current");
    expect(plan.fields).toContain("description");
    expect(plan.fields).not.toContain("currency");
    expect(plan.columns.some((c) => c.id === "DividendsYield")).toBe(false);
    expect(plan.filter).toEqual([]);
    expect(plan.sort).toBeNull();
    expect(plan.tickers).toEqual(["AAPL"]);
  });

  it("adds the clauses of active filters whose fields exist", () => {
    const s = defaultScreen();
    s.filters = [
      cond(C("Price"), "aboveOrEqual", { value: 5 }),
      cond(C("Price"), "above", { value: null }), // inactive
      cond(C("Price"), "above", { column: EMA("50") }),
      cond(EMA("50"), "abovePercent", { column: C("Price") }, { offsetRangeId: "offset_range_10" }),
      box(C("Sector"), ["Technology"]),
      cond(C("Nope"), "above", { value: 1 }), // unknown column
    ];
    const plan = planScreen(s, without("EMA50"), null);
    expect(plan.filter).toEqual([UNIVERSE_CLAUSE, { left: "close", operation: "egreater", right: 5 }, { left: "sector", operation: "in_range", right: ["Technology"] }]);
    const full = planScreen(s, all, null);
    expect(full.filter).toHaveLength(5);
    expect(full.filter).toContainEqual({ left: "EMA50", operation: "above%", right: ["close", 10] });
  });

  it("drops a % offset filter whose right field is missing", () => {
    const s = defaultScreen();
    s.filters = [cond(EMA("50"), "abovePercent", { column: C("Price") }, { offsetRangeId: "offset_range_0_10" })];
    expect(planScreen(s, without("close", "type"), null).filter).toEqual([]);
  });

  it("sorts by ticker with the name field", () => {
    const s: Screen = { ...defaultScreen(), sort: { sortBy: C("TickerUniversal"), sortOrder: "asc" } };
    expect(planScreen(s, without("name"), null).sort).toEqual({ sortBy: "name", sortOrder: "asc" });
  });

  it("returns filters typed as the catalog's", () => {
    const f: Filter[] = defaultScreen().filters;
    expect(f.every((x) => !isActive(x))).toBe(true);
  });
});
