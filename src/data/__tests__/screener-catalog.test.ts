import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  COLUMN_BY_ID,
  COLUMN_SETS,
  DEFAULT_SCREEN_TITLE,
  POPULAR_SCREENS,
  configuredLong,
  configuredShort,
  defaultRef,
  defaultScreen,
  emptyFilter,
  fieldOf,
  fullParams,
  isOffered,
  newFilterId,
  offeredParams,
  paramShorts,
  sameColumn,
  visibleParams,
  type ColumnRef,
} from "../screener-catalog";

const C = (id: string, params: Record<string, string> = {}): ColumnRef => ({ id, params });
const has = (...fields: string[]) => (f: string) => fields.includes(f);

describe("catalog shape", () => {
  it("has unique column ids, all indexed", () => {
    expect(new Set(COLUMNS.map((c) => c.id)).size).toBe(COLUMNS.length);
    expect(Object.keys(COLUMN_BY_ID)).toHaveLength(COLUMNS.length);
  });

  it("every column has a field (directly or through its default params)", () => {
    for (const c of COLUMNS) expect(fieldOf(C(c.id)), c.id).not.toBeNull();
  });

  it("every condition filter's default operation is one of its operations", () => {
    for (const c of COLUMNS) {
      if (c.filter?.type === "Condition") expect(c.filter.operations, c.id).toContain(c.filter.defaultOperation);
    }
  });

  it("column sets only hold catalog columns", () => {
    for (const s of COLUMN_SETS) for (const col of s.columns) expect(COLUMN_BY_ID[col.id], `${s.id}/${col.id}`).toBeDefined();
  });
});

describe("fullParams / fieldOf", () => {
  it("fills missing params with their defaults", () => {
    expect(fullParams(COLUMN_BY_ID.Ema, {})).toEqual({ length: "50", resolution: "TimeResolution1D" });
    expect(fullParams(COLUMN_BY_ID.Ema, { length: "200" })).toEqual({ length: "200", resolution: "TimeResolution1D" });
    expect(fullParams(COLUMN_BY_ID.Price, { stray: "x" })).toEqual({});
  });

  it("maps a column ref to its backend field", () => {
    expect(fieldOf(C("Price"))).toBe("close");
    expect(fieldOf(C("Ema"))).toBe("EMA50");
    expect(fieldOf(C("Ema", { length: "200" }))).toBe("EMA200");
    expect(fieldOf(C("Ma", { length: "9" }))).toBe("SMA9");
    expect(fieldOf(C("AverageVolume"))).toBe("average_volume_10d_calc");
    expect(fieldOf(C("High", { timebased: "Interval52Weeks" }))).toBe("price_52_week_high");
    expect(fieldOf(C("RelativeStrengthIndex", { length: "7" }))).toBe("RSI7");
    expect(fieldOf(C("Performance"))).toBe("Perf.YTD");
  });

  it("gives null for an unknown column or option", () => {
    expect(fieldOf(C("Nope"))).toBeNull();
    expect(fieldOf(C("Ema", { length: "7" }))).toBeNull();
  });
});

describe("offered params", () => {
  it("keeps only the options the backend has, moving the default when it is missing", () => {
    const p = offeredParams(COLUMN_BY_ID.AverageVolume, has("average_volume_30d_calc", "average_volume_90d_calc"))!;
    expect(p).toHaveLength(1);
    expect(p[0].options.map((o) => o.value)).toEqual(["Interval30D", "Interval90D"]);
    expect(p[0].default).toBe("Interval30D");
    expect(offeredParams(COLUMN_BY_ID.AverageVolume, has())).toBeNull();
  });

  it("keeps a param without fields (fixed interval) as is", () => {
    const p = offeredParams(COLUMN_BY_ID.Ema, has("EMA50", "EMA200"))!;
    expect(p.map((x) => x.key)).toEqual(["length", "resolution"]);
    expect(p[0].options.map((o) => o.value)).toEqual(["50", "200"]);
    expect(p[0].default).toBe("50");
    expect(p[1].options).toHaveLength(1);
  });

  it("a param-less column has no params", () => {
    expect(offeredParams(COLUMN_BY_ID.Price, has())).toEqual([]);
  });

  it("isOffered checks the field or the params", () => {
    expect(isOffered(COLUMN_BY_ID.Price, has("close"))).toBe(true);
    expect(isOffered(COLUMN_BY_ID.Price, has())).toBe(false);
    expect(isOffered(COLUMN_BY_ID.Ema, has("EMA9"))).toBe(true);
    expect(isOffered(COLUMN_BY_ID.Ema, has("close"))).toBe(false);
  });

  it("visibleParams lists params with a choice", () => {
    expect(visibleParams(COLUMN_BY_ID.Ema, has("EMA50", "EMA200")).map((p) => p.key)).toEqual(["length"]);
    expect(visibleParams(COLUMN_BY_ID.Ema, has("EMA50"))).toEqual([]);
    expect(visibleParams(COLUMN_BY_ID.Ema, has())).toEqual([]);
  });

  it("defaultRef uses the offered defaults", () => {
    expect(defaultRef(COLUMN_BY_ID.AverageVolume, has("average_volume_30d_calc"))).toEqual(C("AverageVolume", { interval: "Interval30D" }));
    expect(defaultRef(COLUMN_BY_ID.Price, has("close"))).toEqual(C("Price"));
  });
});

describe("titles", () => {
  it("paramShorts skips the one-day resolution", () => {
    expect(paramShorts(C("Ema"))).toEqual(["50"]);
    expect(paramShorts(C("High", { timebased: "Interval1M" }))).toEqual(["1M"]);
    expect(paramShorts(C("Change"))).toEqual([]);
    expect(paramShorts(C("Price"))).toEqual([]);
    expect(paramShorts(C("Nope"))).toEqual([]);
  });

  it("configuredShort / configuredLong", () => {
    expect(configuredShort(C("Ema", { length: "50" }))).toBe("EMA, 50");
    expect(configuredShort(C("High", { timebased: "Interval1M" }))).toBe("High, 1M");
    expect(configuredShort(C("Change"))).toBe("Chg %");
    expect(configuredShort(C("Nope"))).toBe("Nope");
    expect(configuredLong(C("Change"))).toBe("Price change %, 1 day");
    expect(configuredLong(C("Ema"))).toBe("Exponential moving average, 50, 1 day");
    expect(configuredLong(C("Price"))).toBe("Price");
    expect(configuredLong(C("Nope"))).toBe("Nope");
  });
});

describe("sameColumn", () => {
  it("compares ids and params with defaults filled in", () => {
    expect(sameColumn(C("Ema"), C("Ema", { length: "50" }))).toBe(true);
    expect(sameColumn(C("Ema", { length: "20" }), C("Ema", { length: "50" }))).toBe(false);
    expect(sameColumn(C("Ema"), C("Ma"))).toBe(false);
    expect(sameColumn(C("Nope", { a: "1" }), C("Nope", { a: "2" }))).toBe(true);
  });
});

describe("filters and screens", () => {
  it("emptyFilter starts inactive with the column's default operation", () => {
    expect(emptyFilter(C("Price"))).toMatchObject({ type: "Condition", operation: "aboveOrEqual", target: "value", right: { value: null } });
    expect(emptyFilter(C("MarketCap"))).toMatchObject({ type: "Condition", operation: "between", right: { left: null, right: null } });
    expect(emptyFilter(C("Index"))).toMatchObject({ type: "CheckboxGroup", values: [] });
    expect(emptyFilter(C("Exchange"))).toBeNull();
    expect(emptyFilter(C("Nope"))).toBeNull();
  });

  it("filter ids are unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newFilterId()));
    expect(ids.size).toBe(50);
  });

  it("the default screen: 8 pills, Overview columns, market cap descending", () => {
    const s = defaultScreen();
    expect(s.title).toBe(DEFAULT_SCREEN_TITLE);
    expect(s.filters.map((f) => f.left.id)).toEqual(["Index", "Price", "Change", "MarketCap", "DividendsYield", "Sector", "Performance", "Beta"]);
    expect(s.activeColumnSetId).toBe("overview");
    expect(s.customColumns).toBeNull();
    expect(s.sort).toEqual({ sortBy: C("MarketCap"), sortOrder: "desc" });
    expect(s.watchlistId).toBeNull();
    expect(defaultScreen("Mine", [C("Price"), C("Exchange")]).filters).toHaveLength(1);
  });

  it("popular screens: 'Most capitalized' sets the market cap pill to 10 B and above", () => {
    const s = POPULAR_SCREENS.find((p) => p.id === "1")!.screen();
    const mc = s.filters.find((f) => f.left.id === "MarketCap");
    expect(mc).toMatchObject({ operation: "aboveOrEqual", right: { value: 1e10 } });
    expect(s.filters.filter((f) => f.left.id !== "MarketCap").every((f) => f.type === "CheckboxGroup" ? f.values.length === 0 : "value" in f.right ? f.right.value === null : true)).toBe(true);
    expect(POPULAR_SCREENS.find((p) => p.id === "14")!.screen().title).toBe("All stocks");
  });
});
