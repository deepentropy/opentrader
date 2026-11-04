import { describe, expect, it } from "vitest";
import type { FieldInfo } from "../../bindings";
import { agentFields, clauseOf, columnOfField, matchName, pillOf, screenOf } from "../screener-tools";

const fi = (id: string, kind = "number", available = true): FieldInfo => ({ id, kind, source: "live", available });

describe("agentFields", () => {
  it("titles the screener's fields, one per param option, then the others; leaves out what is not loaded", () => {
    const out = agentFields([fi("close"), fi("EMA50"), fi("EMA200"), fi("sector", "text"), fi("session_day"), fi("RSI", "number", false)]);
    const by = Object.fromEntries(out.map((f) => [f.field, f]));
    expect(by.close.title).toBe("Price");
    expect(by.EMA50.title).toBe("Exponential moving average (50)");
    expect(by.sector).toMatchObject({ title: "Sector", kind: "text" });
    // A backend field the screener does not show is still offered, by id.
    expect(by.session_day.title).toBe("session_day");
    expect(by.RSI).toBeUndefined();
  });
});

describe("clauseOf", () => {
  const known = (f: string) => ["close", "EMA200", "sector", "change"].includes(f);
  it("maps the operations and values", () => {
    expect(clauseOf({ field: "close", op: ">", value: 10 }, known)).toEqual({ left: "close", operation: "greater", right: 10 });
    expect(clauseOf({ field: "close", op: ">", value: { field: "EMA200" } }, known)).toEqual({ left: "close", operation: "greater", right: "EMA200" });
    expect(clauseOf({ field: "change", op: "between", value: [5, -5] }, known)).toEqual({ left: "change", operation: "in_range", right: [-5, 5] });
    expect(clauseOf({ field: "change", op: "outside", value: [-1, 1] }, known).operation).toBe("not_in_range");
    expect(clauseOf({ field: "sector", op: "in", value: ["Finance"] }, known)).toEqual({ left: "sector", operation: "in_range", right: ["Finance"] });
  });
  it("refuses unknown fields, operations and malformed values", () => {
    expect(() => clauseOf({ field: "nope", op: ">", value: 1 }, known)).toThrow(/Unknown filter field/);
    expect(() => clauseOf({ field: "close", op: "~", value: 1 }, known)).toThrow(/op must be/);
    expect(() => clauseOf({ field: "close", op: "between", value: 3 }, known)).toThrow(/low, high/);
    expect(() => clauseOf({ field: "close", op: ">", value: { field: "nope" } }, known)).toThrow(/Unknown field/);
  });
});

describe("saved screens from run_screen filters", () => {
  it("finds the column of a field, with its params", () => {
    expect(columnOfField("close")).toEqual({ id: "Price", params: {} });
    expect(columnOfField("EMA50")).toEqual({ id: "Ema", params: { length: "50", resolution: "TimeResolution1D" } });
    // A custom length is a column too.
    expect(columnOfField("EMA137")).toEqual({ id: "Ema", params: { length: "137", resolution: "TimeResolution1D" } });
    expect(columnOfField("nope")).toBeNull();
  });
  it("writes the filters as the screener's pills", () => {
    expect(pillOf({ field: "close", op: ">", value: 10 })).toMatchObject({ type: "Condition", left: { id: "Price" }, operation: "above", right: { value: 10 } });
    // At least: an open range, as the presets write it.
    expect(pillOf({ field: "market_cap_basic", op: ">=", value: 1e10 })).toMatchObject({ operation: "between", right: { left: 1e10, right: null } });
    expect(pillOf({ field: "change", op: "between", value: [5, -5] })).toMatchObject({ operation: "between", right: { left: -5, right: 5 } });
    expect(pillOf({ field: "close", op: ">", value: { field: "EMA200" } })).toMatchObject({
      operation: "above",
      target: "Ema",
      right: { column: { id: "Ema", params: { length: "200" } } },
    });
    expect(pillOf({ field: "sector", op: "in", value: ["Finance"] })).toMatchObject({ type: "CheckboxGroup", left: { id: "Sector" }, values: ["Finance"] });
  });
  it("refuses what a saved screen cannot hold", () => {
    expect(() => pillOf({ field: "exchange", op: "in", value: ["NASDAQ"] })).toThrow(/cannot be a filter/);
    expect(() => pillOf({ field: "close", op: "!=", value: 1 })).toThrow(/op is one of/);
    expect(() => pillOf({ field: "sector", op: ">", value: 1 })).toThrow(/"in"/);
  });
  it("puts the filters on the default pills, then the scope, columns and sort", () => {
    const s = screenOf(
      { filters: [{ field: "close", op: ">", value: 5 }, { field: "RSI", op: "<", value: 30 }], scope: { index: "ndx" }, columns: ["close", "RSI"], sort: { field: "RSI", order: "asc" } },
      "Oversold NDX",
      null,
    );
    expect(s.title).toBe("Oversold NDX");
    const price = s.filters.filter((f) => f.left.id === "Price");
    expect(price).toHaveLength(1);
    expect(price[0]).toMatchObject({ operation: "above", right: { value: 5 } });
    expect(s.filters.find((f) => f.left.id === "Index")).toMatchObject({ values: ["NDX"] });
    expect(s.filters.some((f) => f.left.id === "RelativeStrengthIndex")).toBe(true);
    expect(s.activeColumnSetId).toBe("custom");
    expect(s.customColumns?.map((c) => c.id)).toEqual(["Price", "RelativeStrengthIndex"]);
    expect(s.sort).toMatchObject({ sortBy: { id: "RelativeStrengthIndex" }, sortOrder: "asc" });
  });
});

describe("sector and industry names", () => {
  const industries = ["Semiconductors & Related Devices", "Electronic Computers", "National Commercial Banks", "State Commercial Banks"];
  it("takes the name as the data writes it, any case, or the one name that starts with it", () => {
    expect(matchName("electronic computers", industries, "industry")).toBe("Electronic Computers");
    expect(matchName("Semiconductors", industries, "industry")).toBe("Semiconductors & Related Devices");
  });
  it("names the choices when it is ambiguous or unknown, and points from sector to industry", () => {
    expect(() => matchName("Commercial Banks", industries, "industry")).toThrow(/Close industry names: "National Commercial Banks", "State Commercial Banks"/);
    expect(() => matchName("Semiconductors", ["Manufacturing", "Services"], "sector")).toThrow(/The sector names: "Manufacturing", "Services"\. For a line of business/);
    // A word found inside another name is not taken as that name.
    expect(() => matchName("Electronics", [...industries, "Retail-Radio, Tv & Consumer Electronics Stores"], "industry")).toThrow(/Close industry names: "Retail-Radio/);
  });
});
