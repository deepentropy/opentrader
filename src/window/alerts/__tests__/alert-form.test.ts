import { describe, expect, it, vi } from "vitest";
import type { DrawingOption } from "../../../data/alert-condition";

const mocks = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  entries: {
    rsi: { metadata: { title: "Relative Strength Index" }, plotConfig: [{ id: "rsi", title: "RSI" }], inputConfig: [{ id: "length", type: "int" }] },
  } as Record<string, unknown>,
}));
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => mocks.kv.get(k) ?? null,
  setItem: (k: string, v: string) => void mocks.kv.set(k, v),
  removeItem: (k: string) => void mocks.kv.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../../chart/indicators/registry", () => ({ getIndicatorEntry: (id: string) => mocks.entries[id] }));

import {
  buildLeft,
  buildRight,
  buildRight2,
  conditionOf,
  conditionValid,
  isValidWebhookUrl,
  openPlaceholderGroups,
  saveOpenPlaceholderGroups,
  type ConditionChoices,
  type ConditionFields,
} from "../alert-form";

const fields = (over: Partial<ConditionFields> = {}): ConditionFields => ({
  leftKind: "price",
  leftIndicator: "",
  leftPlot: 0,
  leftSymbol: "",
  op: "crossing",
  rightKind: "value",
  rightValue: "150.25",
  rightDrawing: "",
  rightIndicator: "",
  rightPlot: 0,
  rightSymbol: "",
  rightLevel: 0.5,
  rightLevel2: null,
  rightVwapPlot: 0,
  pct: "1.00",
  upperSel: "value",
  upperValue: "",
  upperPlot: 0,
  lowerSel: "value",
  lowerValue: "",
  lowerPlot: 0,
  ...over,
});
const line: DrawingOption = { id: "d1", label: "Horizontal Line", band: null } as DrawingOption;
const choices = (over: Partial<ConditionChoices> = {}): ConditionChoices => ({
  studies: [{ id: "rsi", label: "RSI", inputs: { length: 14 } }],
  compares: [{ symbol: "NASDAQ:MSFT", label: "Microsoft Corp. (NASDAQ)" }],
  drawings: [line],
  fibChannel: false,
  ...over,
});

describe("alert form: the condition its fields describe", () => {
  it("the price against a value written as the field holds it", () => {
    expect(conditionOf(fields(), choices(), 1, "5")).toEqual({ left: { kind: "price" }, op: "crossing", right: { kind: "value", value: 150.25 }, resolution: "5" });
    // An empty field reads 0.
    expect(buildRight(fields({ rightValue: "" }), choices())).toEqual({ kind: "value", value: 0 });
  });

  it("a study's plot, a compared symbol, a drawing", () => {
    expect(buildLeft(fields({ leftKind: "indicator", leftIndicator: "rsi" }), choices())).toMatchObject({ kind: "indicator", indicatorId: "rsi", plot: 0, inputs: { length: 14 } });
    expect(buildLeft(fields({ leftKind: "symbol", leftSymbol: "NASDAQ:MSFT" }), choices())).toMatchObject({ kind: "symbol", symbol: "NASDAQ:MSFT" });
    // No study or symbol chosen: the price.
    expect(buildLeft(fields({ leftKind: "indicator" }), choices())).toEqual({ kind: "price" });
    expect(buildRight(fields({ rightKind: "drawing", rightDrawing: "d1" }), choices())).toMatchObject({ kind: "drawing", drawingId: "d1" });
    expect(buildRight(fields({ rightKind: "price" }), choices())).toEqual({ kind: "price" });
    expect(buildRight(fields({ rightKind: "symbol", rightSymbol: "NASDAQ:MSFT" }), choices())).toMatchObject({ kind: "symbol", symbol: "NASDAQ:MSFT" });
  });

  it("a moving condition: the amount, with its bar count", () => {
    const c = conditionOf(fields({ op: "moving_up_pct", pct: "2.50" }), choices(), 3, "1D");
    expect(c).toEqual({ left: { kind: "price" }, op: "moving_up_pct", right: { kind: "value", value: 2.5 }, bars: 3, resolution: "1D" });
  });

  it("a channel between two bounds: the upper one, then the lower one", () => {
    const f = fields({ op: "entering", upperSel: "value", upperValue: "110", lowerSel: "ind:rsi" });
    expect(buildRight(f, choices())).toEqual({ kind: "value", value: 110 });
    expect(buildRight2(f, choices())).toMatchObject({ kind: "indicator", indicatorId: "rsi" });
    // A drawing's channel has no second bound.
    expect(buildRight2(fields({ op: "entering", rightKind: "drawing", rightDrawing: "d1" }), choices())).toBeUndefined();
    expect(buildRight2(fields(), choices())).toBeUndefined();
  });

  it("a condition of the study itself compares nothing", () => {
    expect(buildRight(fields({ op: "alert_function", leftKind: "indicator", leftIndicator: "rsi" }), choices())).toEqual({ kind: "value", value: 0 });
  });
});

describe("alert form: can it be saved", () => {
  const ok = (f: Partial<ConditionFields>, c: Partial<ConditionChoices> = {}, source = { strategy: false, calls: false }) => conditionValid(fields(f), choices(c), source);

  it("a value must be a number; a drawing, a study, a symbol one of the choices", () => {
    expect(ok({})).toBe(true);
    expect(ok({ rightValue: "abc" })).toBe(false);
    expect(ok({ rightKind: "drawing", rightDrawing: "d1" })).toBe(true);
    expect(ok({ rightKind: "drawing", rightDrawing: "gone" })).toBe(false);
    expect(ok({ rightKind: "indicator", rightIndicator: "rsi" })).toBe(true);
    expect(ok({ rightKind: "indicator", rightIndicator: "macd" })).toBe(false);
    expect(ok({ rightKind: "symbol", rightSymbol: "NYSE:IBM" })).toBe(false);
  });

  it("a channel's two bounds, a moving amount", () => {
    expect(ok({ op: "inside", upperValue: "2", lowerValue: "1" })).toBe(true);
    expect(ok({ op: "inside", upperValue: "2", lowerSel: "ind:macd" })).toBe(false);
    expect(ok({ op: "inside", upperSel: "price", lowerSel: "sym:NASDAQ:MSFT" })).toBe(true);
    expect(ok({ op: "moving_up", pct: "x" })).toBe(false);
  });

  it("a study's condition, its alert() calls, a strategy", () => {
    expect(ok({ op: "alert_condition" })).toBe(false);
    expect(ok({ op: "alert_condition" }, { studyCondition: { id: "c1", title: "Breakout" } })).toBe(true);
    expect(ok({ op: "alert_function" })).toBe(false);
    expect(ok({ op: "alert_function" }, {}, { strategy: false, calls: true })).toBe(true);
    expect(ok({ op: "strategy_orders" }, {}, { strategy: true, calls: false })).toBe(true);
    expect(ok({ op: "strategy_alerts" }, {}, { strategy: true, calls: false })).toBe(false);
  });
});

describe("alert form: webhook and remembered menus", () => {
  it("a webhook needs an http(s) URL", () => {
    expect(isValidWebhookUrl(" https://example.com/hook ")).toBe(true);
    expect(isValidWebhookUrl("http://localhost:8080")).toBe(true);
    expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
    expect(isValidWebhookUrl("example.com")).toBe(false);
  });

  it("the placeholder groups shown open: General until the user chooses, then as left", () => {
    expect(openPlaceholderGroups()).toEqual({ general: true });
    saveOpenPlaceholderGroups({ general: false, plots: true });
    expect(openPlaceholderGroups()).toEqual({ general: false, plots: true });
    mocks.kv.set("alerts.placeholder-groups.v1", "not json");
    expect(openPlaceholderGroups()).toEqual({ general: true });
  });
});
