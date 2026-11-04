import { describe, expect, it, vi } from "vitest";
import type { AlertCondition } from "../alert-store";
import type { DrawingOption } from "../alert-condition";

const mocks = vi.hoisted(() => ({
  entries: {
    bb: { metadata: { title: "Bollinger Bands" }, plotConfig: [{ id: "basis", title: "Basis" }, { id: "upper", title: "Upper" }, { id: "lower", title: "Lower" }], inputConfig: [{ id: "length", type: "int" }, { id: "src", type: "source" }, { id: "fill", type: "bool" }] },
    rsi: { metadata: { title: "Relative Strength Index", precision: 2 }, format: { type: "price", precision: 2 }, plotConfig: [{ id: "rsi", title: "RSI" }], inputConfig: [{ id: "length", type: "int" }] },
    // A script with a line plot and a shape output: the shape is read by its key.
    "user:s1": { metadata: { title: "Breakout" }, plotConfig: [{ id: "p", title: "Level" }], inputConfig: [], outputs: [{ kind: "plot", id: "p" }, { kind: "shape", id: "sig", title: "Signal" }] },
  } as Record<string, unknown>,
}));
vi.mock("../../window/chart/indicators/registry", () => ({ getIndicatorEntry: (id: string) => mocks.entries[id] }));
vi.mock("../chart-state-registry", async (orig) => ({
  ...(await orig<typeof import("../chart-state-registry")>()),
  indicatorLegendFor: () => [
    { id: "bb", title: "BB", inputValues: { length: 20, src: "close", fill: true }, plots: [] },
    { id: "rsi", title: "RSI", inputValues: { length: 14 }, plots: [] },
  ],
}));

import {
  callsGiveMessages,
  chartStudies,
  choiceOf,
  defaultFibLevel,
  defaultFibLevel2,
  drawingOperand,
  drawingOperators,
  fibLevelText,
  fixedFrequency,
  indicatorOperand,
  movingBarsMin,
  perBarTriggers,
  plotLabel,
  savedConditions,
  sharedBarInterval,
  strategyOperators,
  studyConditionOperand,
  studyLabel,
  studyPlots,
} from "../alert-operands";

const studies = [...chartStudies("NASDAQ:AAPL"), { id: "user:s1", label: "Breakout", inputs: {} }];

describe("alert operands", () => {
  it("names a study with its inputs and its plot", () => {
    expect(chartStudies("NASDAQ:AAPL")[0]).toEqual({ id: "bb", label: "BB", inputs: { length: 20, src: "close", fill: true } });
    expect(studyLabel(studies, "bb")).toBe("BB (20, close)");
    expect(studyLabel(studies, "gone")).toBe("indicator");
    expect(plotLabel("BB", "bb", 2, { length: 20, src: "close" })).toBe("BB (20, close): Lower");
    // One plot: no plot title.
    expect(plotLabel("RSI", "rsi", 0, { length: 14 })).toBe("RSI (14)");
    expect(studyPlots("user:s1")).toEqual([{ index: 0, title: "Level", plot: 0 }, { index: 1, title: "Signal", output: "sig" }]);
  });

  it("builds a study operand with its title, precision, format and inputs", () => {
    const bb = indicatorOperand(studies, "bb", 1, undefined);
    expect(bb).toEqual({ kind: "indicator", indicatorId: "bb", plot: 1, label: "BB (20, close): Upper", title: "Bollinger Bands (20, close)", inputs: { length: 20, src: "close", fill: true } });
    expect(bb.inputs).not.toBe(studies[0].inputs);
    expect(indicatorOperand(studies, "rsi", 0, undefined)).toMatchObject({ precision: 2, format: { type: "price", precision: 2 } });
    expect(indicatorOperand(studies, "user:s1", 1, undefined)).toMatchObject({ output: "sig", label: "Breakout: Signal" });
    expect(choiceOf(indicatorOperand(studies, "user:s1", 1, undefined))).toBe(1);
    expect(choiceOf({ kind: "price" })).toBe(0);
  });

  it("keeps the inputs, label and title an edited alert was made with", () => {
    const was = { kind: "indicator" as const, indicatorId: "rsi", plot: 0, label: "RSI (10)", title: "Relative Strength Index (10)", inputs: { length: 10 } };
    expect(indicatorOperand(studies, "rsi", 0, was)).toMatchObject({ label: "RSI (10)", title: "Relative Strength Index (10)", inputs: { length: 10 } });
    // Another plot of it: its title stays, the inputs it was made with too.
    const bbWas = { ...indicatorOperand(studies, "bb", 0, undefined), inputs: { length: 50, src: "close" } };
    expect(indicatorOperand(studies, "bb", 2, bbWas)).toMatchObject({ plot: 2, label: "BB (50, close): Lower", inputs: { length: 50, src: "close" } });
  });

  it("drops the plot title for a study's own conditions", () => {
    const cond = { id: "c1", title: "Long", message: "Go long" };
    expect(studyConditionOperand(studies, "bb", "alert_condition", cond, undefined)).toMatchObject({ label: "BB (20, close)", condition: cond });
    expect(studyConditionOperand(studies, "bb", "alert_function", cond, undefined)).not.toHaveProperty("condition");
    expect(studyConditionOperand(studies, "bb", "strategy_orders", undefined, undefined)).toMatchObject({ label: "BB (20, close)" });
    // No condition picked: the operand on its first plot.
    expect(studyConditionOperand(studies, "bb", "alert_condition", undefined, undefined).label).toBe("BB (20, close): Basis");
    expect(strategyOperators(true)).toEqual(["strategy_orders_and_alerts", "strategy_orders", "strategy_alerts"]);
    expect(strategyOperators(false)).toEqual(["strategy_orders"]);
  });

  it("builds drawing operands: fib levels, VWAP lines, shapes", () => {
    const levels = [{ coeff: 0, price: 160 }, { coeff: 0.382, price: 156.18 }, { coeff: 0.5, price: 155 }, { coeff: 1, price: 150 }];
    const fib: DrawingOption = { id: "f", label: "Fib retracement", band: null, levels };
    expect(drawingOperators(fib)).toContain("entering");
    expect(drawingOperators({ id: "v", label: "anchored VWAP", band: null, plots: ["VWAP"] })).toEqual(["crossing", "crossing_up", "crossing_down", "greater", "less"]);
    expect(drawingOperators({ id: "t", label: "vertical line", band: "time" })).toEqual(["crossing"]);
    expect(drawingOperators({ id: "h", label: "horizontal line", band: null })).toBeNull();
    expect(defaultFibLevel(levels)).toBe(0.5);
    expect(defaultFibLevel(levels.filter((l) => l.coeff !== 0.5))).toBe(0);
    expect(defaultFibLevel2(levels, 0.5)).toBe(1);
    expect(defaultFibLevel2(levels, 1)).toBe(0.5);
    expect(fibLevelText(levels[1])).toBe("0.382 (156.18)");
    expect(drawingOperand("f", fib, { level: 0.382, plot: 0 })).toEqual({ kind: "drawing", drawingId: "f", label: "Fib retracement level 0.382 (156.18)", level: 0.382 });
    expect(drawingOperand("f", fib, { level: 0.382, level2: 0.5, plot: 0 })).toMatchObject({ label: "Fib retracement (upper bound: level 0.382, lower bound: level 0.5)", level: 0.382, level2: 0.5 });
    expect(drawingOperand("v", { id: "v", label: "anchored VWAP", band: null, plots: ["VWAP", "Lower Band"] }, { level: 0, plot: 1 })).toEqual({ kind: "drawing", drawingId: "v", label: "anchored VWAP", plot: 1 });
    expect(drawingOperand("p", { id: "p", label: "long position", band: "position" }, { level: 0, plot: 0 })).toEqual({ kind: "drawing", drawingId: "p", label: "long position", band: "position" });
  });

  it("fixes the trigger and the message where the condition sets them", () => {
    expect(fixedFrequency("alert_function", null)).toBe("once_per_bar");
    expect(fixedFrequency("strategy_alerts", null)).toBe("every_time");
    expect(fixedFrequency("crossing", "time")).toBe("only_once");
    expect(fixedFrequency("hits_level", "position")).toBe("only_once");
    expect(fixedFrequency("crossing", null)).toBeNull();
    expect(callsGiveMessages("strategy_alerts")).toBe(true);
    expect(callsGiveMessages("strategy_orders")).toBe(false);
    expect(movingBarsMin("price")).toBe(1);
    expect(movingBarsMin("indicator")).toBe(2);
  });

  it("gives the conditions of a multi-condition alert the interval they read on bars", () => {
    const price: AlertCondition = { left: { kind: "price" }, op: "greater", right: { kind: "value", value: 1 }, resolution: "60" };
    const rsi = (resolution: string): AlertCondition => ({ left: indicatorOperand(studies, "rsi", 0, undefined), op: "greater", right: { kind: "value", value: 50 }, resolution });
    expect(sharedBarInterval([price, rsi("1D")])).toBe("1D");
    expect(sharedBarInterval([price, rsi("1D"), rsi("5")])).toBeNull();
    expect(sharedBarInterval([price])).toBeNull();
    expect(savedConditions([price, rsi("1D")]).map((c) => c.resolution)).toEqual(["1D", "1D"]);
    expect(savedConditions([price, rsi("1D"), rsi("5")]).map((c) => c.resolution)).toEqual(["60", "1D", "5"]);
    expect(perBarTriggers([price])).toBe(false);
    expect(perBarTriggers([rsi("5")])).toBe(true);
    expect(perBarTriggers([price, rsi("1D")])).toBe(true);
    expect(perBarTriggers([rsi("1D"), rsi("5")])).toBe(false);
  });
});
