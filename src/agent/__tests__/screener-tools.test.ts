import { describe, expect, it } from "vitest";
import type { FieldInfo } from "../../bindings";
import { agentFields, clauseOf } from "../screener-tools";

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
