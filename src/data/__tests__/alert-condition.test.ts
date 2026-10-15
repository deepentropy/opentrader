import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { AlertOperator, AlertRule, Operand } from "../alert-store";
import type { ChartBar } from "../chart-state-registry";

const mocks = vi.hoisted(() => ({
  drawings: new Map<string, unknown[]>(),
  sessions: new Map<string, { formatPrice: (v: number) => string; mintick: number }>(),
  chartBars: vi.fn((): ChartBar[] | null => null),
  indicatorPlotValue: vi.fn((): number | null => null),
}));

vi.mock("../../window/drawings/persistence", () => ({ loadDrawings: (symbol: string) => mocks.drawings.get(symbol) ?? [] }));
vi.mock("../session", () => ({ cachedSymbolSessions: (symbol: string) => mocks.sessions.get(symbol) ?? null }));
vi.mock("../chart-state-registry", () => ({ chartBars: mocks.chartBars, indicatorPlotValue: mocks.indicatorPlotValue }));
vi.mock("../../window/chart/profiles/tpo", () => ({ isTpoEntry: () => false }));
vi.mock("../providers", () => ({ defaultExchange: () => "NASDAQ" }));

import {
  BAND_OPERATORS,
  OPERATOR_LABELS,
  VALUE_OPERATORS,
  VWAP_PLOTS,
  alertAmountText,
  alertIntervalText,
  bandOperatorLabel,
  conditionHasInterval,
  conditionHasIntervalRow,
  defaultAlertMessage,
  describeCondition,
  drawingBand,
  drawingBandType,
  drawingCanAlert,
  drawingFibLevels,
  drawingPositionLevels,
  drawingPriceLevel,
  drawingSelectLabel,
  drawingTime,
  drawingValues,
  drawingVwapValue,
  isBandOperator,
  isMovingOperator,
  isPercentOperator,
  operandLabel,
  operandValue,
  priceableDrawings,
  ruleDrawingIds,
  ruleDrawingMissing,
  ruleQuoteSymbol,
  rulesOfDrawing,
  shapeOperators,
  positionHit,
  type EvalContext,
} from "../alert-condition";

const SYM = "NASDAQ:AZO";
let seq = 0;
function mk(kind: string, points: { time: unknown; price: number }[], style: Record<string, unknown> = {}, id = `d${++seq}`): Drawing {
  return { id, kind, points, style } as unknown as Drawing;
}
function put(...ds: Drawing[]): void {
  mocks.drawings.set(SYM, ds);
}
const price: Operand = { kind: "price" };
const val = (value: number): Operand => ({ kind: "value", value });
const drw = (drawingId: string, extra: Partial<Extract<Operand, { kind: "drawing" }>> = {}): Operand => ({ kind: "drawing", drawingId, ...extra });
const ind = (extra: Partial<Extract<Operand, { kind: "indicator" }>> = {}): Operand => ({ kind: "indicator", indicatorId: "i1", ...extra });

beforeEach(() => {
  mocks.drawings.clear();
  mocks.sessions.clear();
  mocks.chartBars.mockReset().mockReturnValue(null);
  mocks.indicatorPlotValue.mockReset().mockReturnValue(null);
});

describe("operator sets", () => {
  it("band, percent and moving operators", () => {
    expect(BAND_OPERATORS).toEqual(["entering", "exiting", "inside", "outside"]);
    expect(isBandOperator("inside")).toBe(true);
    expect(isBandOperator("crossing")).toBe(false);
    expect(isPercentOperator("moving_up_pct")).toBe(true);
    expect(isPercentOperator("moving_up")).toBe(false);
    expect(isMovingOperator("moving_down")).toBe(true);
    expect(isMovingOperator("moving_down_pct")).toBe(true);
    expect(isMovingOperator("greater")).toBe(false);
    expect(VALUE_OPERATORS).toHaveLength(13);
    expect(new Set(VALUE_OPERATORS).size).toBe(13);
  });

  it("band labels", () => {
    expect(bandOperatorLabel("entering", "channel")).toBe("Entering Channel");
    expect(bandOperatorLabel("inside", "rectangle")).toBe("Inside rectangle");
    expect(OPERATOR_LABELS.crossing_up).toBe("Crossing Up");
  });

  it("the operators each drawing shape offers", () => {
    expect(shapeOperators(null)).toBeNull();
    expect(shapeOperators("channel")).toEqual(BAND_OPERATORS);
    expect(shapeOperators("rectangle")).toEqual([...BAND_OPERATORS, "greater", "less"]);
    expect(shapeOperators("time")).toEqual(["crossing"]);
    expect(shapeOperators("position")).toEqual(["hits_level"]);
    expect(shapeOperators(null, true)).toEqual(["crossing", "crossing_up", "crossing_down", "greater", "less", ...BAND_OPERATORS]);
  });
});

describe("drawing kinds", () => {
  it("drawingBandType", () => {
    expect(drawingBandType("parallel-channel")).toBe("channel");
    expect(drawingBandType("disjoint-channel")).toBe("channel");
    expect(drawingBandType("flat-top-bottom")).toBe("channel");
    expect(drawingBandType("rectangle")).toBe("rectangle");
    expect(drawingBandType("vertical-line")).toBe("time");
    expect(drawingBandType("short-position")).toBe("position");
    expect(drawingBandType("horizontal-line")).toBeNull();
  });

  it("drawingCanAlert", () => {
    for (const k of ["horizontal-line", "horizontal-ray", "trend-line", "ray", "extended-line", "arrow", "fib-retracement", "trend-based-fib-extension", "anchored-vwap", "rectangle", "vertical-line", "long-position", "parallel-channel"]) {
      expect(drawingCanAlert(k), k).toBe(true);
    }
    for (const k of ["brush", "text", "fib-channel", "ellipse"]) expect(drawingCanAlert(k), k).toBe(false);
  });

  it("drawingSelectLabel capitalises the first letter", () => {
    expect(drawingSelectLabel("horizontal line")).toBe("Horizontal line");
    expect(drawingSelectLabel("")).toBe("");
  });
});

describe("fib levels", () => {
  it("retracement: 0 at the second point, 1 at the first; visible levels sorted", () => {
    const d = mk("fib-retracement", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }]);
    const lv = drawingFibLevels(d);
    expect(lv.map((l) => l.coeff)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236]);
    const at = (c: number) => lv.find((l) => l.coeff === c)!.price;
    expect(at(0)).toBe(200);
    expect(at(1)).toBe(100);
    expect(at(0.5)).toBe(150);
    expect(at(0.618)).toBeCloseTo(138.2, 10);
  });

  it("reverse swaps the ends", () => {
    const d = mk("fib-retracement", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }], { reverse: true });
    const lv = drawingFibLevels(d);
    expect(lv[0]).toEqual({ coeff: 0, price: 100 });
    expect(lv.find((l) => l.coeff === 1)!.price).toBe(200);
  });

  it("trend-based extension: the p0-p1 move times the coefficient, from p2", () => {
    const d = mk("trend-based-fib-extension", [{ time: 1, price: 100 }, { time: 2, price: 150 }, { time: 3, price: 120 }]);
    const lv = drawingFibLevels(d);
    expect(lv.find((l) => l.coeff === 0)!.price).toBe(120);
    expect(lv.find((l) => l.coeff === 1)!.price).toBe(170);
    expect(lv.find((l) => l.coeff === 1.618)!.price).toBeCloseTo(200.9, 10);
    // Without its third point it has no level.
    expect(drawingFibLevels(mk("trend-based-fib-extension", [{ time: 1, price: 100 }, { time: 2, price: 150 }]))).toEqual([]);
  });

  it("custom levels: only the visible ones; other kinds have none", () => {
    const levels = [{ coeff: 1, visible: true }, { coeff: 0, visible: true }, { coeff: 0.5, visible: false }];
    const d = mk("fib-retracement", [{ time: 1, price: 10 }, { time: 2, price: 20 }], { levels });
    expect(drawingFibLevels(d)).toEqual([{ coeff: 0, price: 20 }, { coeff: 1, price: 10 }]);
    expect(drawingFibLevels(mk("trend-line", [{ time: 1, price: 10 }]))).toEqual([]);
  });
});

describe("drawingPriceLevel", () => {
  it("a horizontal line is flat", () => {
    const d = mk("horizontal-line", [{ time: 1000, price: 50 }]);
    put(d);
    expect(drawingPriceLevel(SYM, d.id, 99999)).toBe(50);
  });

  it("a trend line is interpolated and followed past its ends", () => {
    const d = mk("trend-line", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }]);
    put(d);
    expect(drawingPriceLevel(SYM, d.id, 1500)).toBe(150);
    expect(drawingPriceLevel(SYM, d.id, 3000)).toBe(300);
    expect(drawingPriceLevel(SYM, d.id, 500)).toBe(50);
  });

  it("vertical or non-numeric times: the later point's price", () => {
    const v = mk("trend-line", [{ time: 1000, price: 100 }, { time: 1000, price: 120 }]);
    const s = mk("trend-line", [{ time: "2026-10-14", price: 100 }, { time: "2026-10-15", price: 130 }]);
    put(v, s);
    expect(drawingPriceLevel(SYM, v.id, 5000)).toBe(120);
    expect(drawingPriceLevel(SYM, s.id, 5000)).toBe(130);
  });

  it("a fib level only within the tool's dates (unless extended)", () => {
    const f = mk("fib-retracement", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }]);
    const fx = mk("fib-retracement", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }], { extendRight: true });
    put(f, fx);
    expect(drawingPriceLevel(SYM, f.id, 1500)).toBe(150); // level 0.5 by default
    expect(drawingPriceLevel(SYM, f.id, 1500, 1)).toBe(100);
    expect(drawingPriceLevel(SYM, f.id, 2500)).toBeNull();
    expect(drawingPriceLevel(SYM, f.id, 500)).toBeNull();
    expect(drawingPriceLevel(SYM, fx.id, 2500)).toBe(150);
  });

  it("null for a missing drawing or one without points", () => {
    const e = mk("horizontal-line", []);
    put(e);
    expect(drawingPriceLevel(SYM, "gone", 0)).toBeNull();
    expect(drawingPriceLevel(SYM, e.id, 0)).toBeNull();
  });
});

describe("drawingBand", () => {
  it("rectangle: its prices, within its dates", () => {
    const r = mk("rectangle", [{ time: 1000, price: 110 }, { time: 2000, price: 90 }]);
    const rl = mk("rectangle", [{ time: 1000, price: 110 }, { time: 2000, price: 90 }], { extendLeft: true });
    put(r, rl);
    expect(drawingBand(SYM, r.id, 1500)).toEqual({ lower: 90, upper: 110 });
    expect(drawingBand(SYM, r.id, 500)).toBeNull();
    expect(drawingBand(SYM, r.id, 2500)).toBeNull();
    expect(drawingBand(SYM, rl.id, 500)).toEqual({ lower: 90, upper: 110 });
    expect(drawingBand(SYM, rl.id, 2500)).toBeNull();
  });

  it("parallel channel: the edge through p2, parallel to p0-p1", () => {
    const c = mk("parallel-channel", [{ time: 1000, price: 100 }, { time: 2000, price: 110 }, { time: 1000, price: 90 }]);
    put(c);
    expect(drawingBand(SYM, c.id, 1500)).toEqual({ lower: 95, upper: 105 });
    expect(drawingBand(SYM, c.id, 3000)).toEqual({ lower: 110, upper: 120 });
  });

  it("flat top/bottom: the p2 price", () => {
    const c = mk("flat-top-bottom", [{ time: 1000, price: 100 }, { time: 2000, price: 110 }, { time: 1500, price: 80 }]);
    put(c);
    expect(drawingBand(SYM, c.id, 1500)).toEqual({ lower: 80, upper: 105 });
  });

  it("disjoint channel: the mirrored edge", () => {
    const c = mk("disjoint-channel", [{ time: 1000, price: 100 }, { time: 2000, price: 110 }, { time: 2000, price: 90 }]);
    put(c);
    expect(drawingBand(SYM, c.id, 1500)).toEqual({ lower: 95, upper: 105 });
    expect(drawingBand(SYM, c.id, 2000)).toEqual({ lower: 90, upper: 110 });
  });

  it("fib tool: two levels (0.5 and 0.618 by default)", () => {
    const f = mk("fib-retracement", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }]);
    put(f);
    const b = drawingBand(SYM, f.id, 1500)!;
    expect(b.upper).toBe(150);
    expect(b.lower).toBeCloseTo(138.2, 10);
    expect(drawingBand(SYM, f.id, 1500, 0, 1)).toEqual({ lower: 100, upper: 200 });
    expect(drawingBand(SYM, f.id, 2500)).toBeNull();
  });

  it("null for missing points, other kinds, or a missing drawing", () => {
    const c = mk("parallel-channel", [{ time: 1000, price: 100 }, { time: 2000, price: 110 }]);
    const h = mk("horizontal-line", [{ time: 1000, price: 100 }]);
    put(c, h);
    expect(drawingBand(SYM, c.id, 1500)).toBeNull();
    expect(drawingBand(SYM, h.id, 1500)).toBeNull();
    expect(drawingBand(SYM, "gone", 1500)).toBeNull();
  });
});

describe("positions and vertical lines", () => {
  it("long and short positions: entry, stop and target from the style's offsets", () => {
    const long = mk("long-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 5, profitLevel: 10 });
    const short = mk("short-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 5, profitLevel: 10 });
    put(long, short);
    expect(drawingPositionLevels(SYM, long.id)).toEqual({ entry: 100, stop: 95, target: 110 });
    expect(drawingPositionLevels(SYM, short.id)).toEqual({ entry: 100, stop: 105, target: 90 });
    expect(drawingPositionLevels(SYM, long.id, 1500)).not.toBeNull();
    expect(drawingPositionLevels(SYM, long.id, 2500)).toBeNull();
  });

  it("legacy offsets from the second point, else 100 ticks", () => {
    const legacy = mk("long-position", [{ time: 1000, price: 100 }, { time: 2000, price: 103 }]);
    const lone = mk("long-position", [{ time: 1000, price: 100 }]);
    put(legacy, lone);
    expect(drawingPositionLevels(SYM, legacy.id)).toEqual({ entry: 100, stop: 97, target: 103 });
    expect(drawingPositionLevels(SYM, lone.id)).toEqual({ entry: 100, stop: 99, target: 101 }); // mintick 0.01 until known
    mocks.sessions.set(SYM, { formatPrice: (v) => v.toFixed(2), mintick: 0.05 });
    expect(drawingPositionLevels(SYM, lone.id)).toEqual({ entry: 100, stop: 95, target: 105 });
  });

  it("other kinds and missing drawings have no position levels", () => {
    const h = mk("horizontal-line", [{ time: 1000, price: 100 }]);
    put(h);
    expect(drawingPositionLevels(SYM, h.id)).toBeNull();
    expect(drawingPositionLevels(SYM, "gone")).toBeNull();
  });

  it("drawingTime: the vertical line's time", () => {
    const v = mk("vertical-line", [{ time: 1234, price: 0 }]);
    const s = mk("vertical-line", [{ time: "2026-10-14", price: 0 }]);
    put(v, s);
    expect(drawingTime(SYM, v.id)).toBe(1234);
    expect(drawingTime(SYM, s.id)).toBeNull();
    expect(drawingTime(SYM, "gone")).toBeNull();
  });
});

describe("drawingValues", () => {
  const line = mk("trend-line", [{ time: 1000, price: 100 }, { time: 2000, price: 200 }]);
  const rect = mk("rectangle", [{ time: 1000, price: 110 }, { time: 2000, price: 90 }]);
  const pos = mk("long-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 5, profitLevel: 10 });
  const vert = mk("vertical-line", [{ time: 1500, price: 0 }]);
  const o = (id: string, extra: Partial<Extract<Operand, { kind: "drawing" }>> = {}) => drw(id, extra) as Extract<Operand, { kind: "drawing" }>;

  it("what the backend reads per shape", () => {
    expect(drawingValues(vert, o(vert.id, { band: "time" }), "crossing", 0, undefined, 0.01)).toEqual([1500]);
    expect(drawingValues(pos, o(pos.id, { band: "position" }), "hits_level", 1500, undefined, 0.01)).toEqual([100, 95, 110]);
    expect(drawingValues(pos, o(pos.id, { band: "position" }), "hits_level", 2500, undefined, 0.01)).toBeNull();
    expect(drawingValues(rect, o(rect.id, { band: "rectangle" }), "greater", 1500, undefined, 0.01)).toEqual([90, 110]);
    expect(drawingValues(rect, o(rect.id, { band: "rectangle" }), "greater", 2500, undefined, 0.01)).toBeNull();
    expect(drawingValues(line, o(line.id), "crossing", 1500, undefined, 0.01)).toEqual([150]);
    expect(drawingValues(line, o(line.id), "entering", 1500, undefined, 0.01)).toBeNull(); // not a band kind
  });

  it("follows a line on the given time axis (bar index)", () => {
    // 3000 is one bar and a half after 1000 on a chart that skips a weekend.
    const axis = (sec: number) => (sec === 3000 ? 1.5 : (sec - 1000) / 1000);
    expect(drawingValues(line, o(line.id), "crossing", 3000, axis, 0.01)).toEqual([250]);
    expect(drawingValues(line, o(line.id), "crossing", 3000, undefined, 0.01)).toEqual([300]);
  });
});

describe("rules and drawings", () => {
  const rule = (left: Operand, right: Operand) => ({ id: "r", symbol: SYM, left, right }) as unknown as AlertRule;

  it("ruleDrawingIds / rulesOfDrawing", () => {
    expect(ruleDrawingIds({ left: drw("a"), right: drw("b") })).toEqual(["a", "b"]);
    expect(ruleDrawingIds({ left: price, right: val(1) })).toEqual([]);
    const r1 = rule(price, drw("a"));
    const r2 = rule(price, drw("b"));
    expect(rulesOfDrawing([r1, r2], "b")).toEqual([r2]);
    expect(rulesOfDrawing([r1, r2], "c")).toEqual([]);
  });

  it("ruleDrawingMissing", () => {
    const d = mk("horizontal-line", [{ time: 1, price: 1 }]);
    put(d);
    expect(ruleDrawingMissing({ symbol: SYM, left: price, right: drw(d.id) })).toBe(false);
    expect(ruleDrawingMissing({ symbol: SYM, left: price, right: drw("gone") })).toBe(true);
    expect(ruleDrawingMissing({ symbol: SYM, left: drw("gone"), right: val(1) })).toBe(true);
    expect(ruleDrawingMissing({ symbol: SYM, left: price, right: val(1) })).toBe(false);
  });

  it("priceableDrawings: alertable drawings with their labels, shapes, levels and plots", () => {
    const h = mk("horizontal-line", [{ time: 1, price: 1 }]);
    const b = mk("brush", [{ time: 1, price: 1 }]);
    const f = mk("fib-retracement", [{ time: 1, price: 1 }, { time: 2, price: 2 }]);
    const v = mk("anchored-vwap", [{ time: 1, price: 1 }]);
    const c = mk("parallel-channel", [{ time: 1, price: 1 }, { time: 2, price: 2 }, { time: 1, price: 0 }]);
    const t = mk("trend-line", [{ time: 1, price: 1 }, { time: 2, price: 2 }]);
    put(h, b, f, v, c, t);
    const opts = priceableDrawings(SYM);
    expect(opts.map((o) => o.id)).toEqual([h.id, f.id, v.id, c.id, t.id]);
    expect(opts[0]).toEqual({ id: h.id, label: "horizontal line", band: null });
    expect(opts[1].label).toBe("Fib retracement");
    expect(opts[1].levels).toHaveLength(11);
    expect(opts[2]).toMatchObject({ label: "anchored VWAP", plots: VWAP_PLOTS });
    expect(opts[3]).toMatchObject({ label: "parallel channel", band: "channel" });
    expect(opts[4].label).toBe("trendline");
  });
});

describe("anchored VWAP values", () => {
  // hlc3 = 10 then 12 with equal volumes after the anchor: VWAP 11, standard deviation 1.
  const flat = (time: number, p: number): ChartBar => ({ time, open: p, high: p, low: p, close: p, volume: 1 });
  const bars = [flat(500, 50), flat(1000, 10), flat(1060, 12)];

  it("the VWAP and its bands (standard deviation)", () => {
    const v = mk("anchored-vwap", [{ time: 1000, price: 0 }]);
    put(v);
    expect(drawingVwapValue(SYM, v.id, 0, bars)).toBeCloseTo(11, 10);
    expect(drawingVwapValue(SYM, v.id, 1, bars)).toBeCloseTo(10, 10); // Lower Band
    expect(drawingVwapValue(SYM, v.id, 4, bars)).toBeCloseTo(12, 10); // Upper Band
    expect(drawingVwapValue(SYM, v.id, 2, bars)).toBeNull(); // band #2 is off by default
    expect(drawingVwapValue(SYM, v.id, 6, bars)).toBeNull();
  });

  it("percentage bands and custom multipliers", () => {
    const levels = [{ coeff: 1, visible: true }, { coeff: 2, visible: true }, { coeff: 3, visible: true }];
    const v = mk("anchored-vwap", [{ time: 1000, price: 0 }], { vwapBandsMode: "percent", levels });
    put(v);
    expect(drawingVwapValue(SYM, v.id, 1, bars)).toBeCloseTo(10.89, 10);
    expect(drawingVwapValue(SYM, v.id, 6, bars)).toBeCloseTo(11.33, 10);
    expect(drawingVwapValue(SYM, v.id, 3, bars)).toBeCloseTo(10.67, 10);
  });

  it("null for another kind, a missing drawing or no bars", () => {
    const h = mk("horizontal-line", [{ time: 1000, price: 1 }]);
    const v = mk("anchored-vwap", [{ time: 1000, price: 0 }]);
    put(h, v);
    expect(drawingVwapValue(SYM, h.id, 0, bars)).toBeNull();
    expect(drawingVwapValue(SYM, "gone", 0, bars)).toBeNull();
    expect(drawingVwapValue(SYM, v.id, 0, [])).toBeNull();
  });
});

describe("operandValue / operandLabel", () => {
  const ctx: EvalContext = { price: 123, changePercent: null, timeSec: 1500 };

  it("price, value and drawing levels", () => {
    const h = mk("horizontal-line", [{ time: 1, price: 77 }]);
    put(h);
    expect(operandValue(SYM, price, ctx)).toBe(123);
    expect(operandValue(SYM, val(5), ctx)).toBe(5);
    expect(operandValue(SYM, drw(h.id), ctx)).toBe(77);
    expect(operandValue(SYM, drw("gone"), ctx)).toBeNull();
  });

  it("an anchored VWAP line on the rule's interval: the chart's bars, else the fetched ones", () => {
    const v = mk("anchored-vwap", [{ time: 1000, price: 0 }]);
    put(v);
    const bars = [{ time: 1000, open: 10, high: 10, low: 10, close: 10, volume: 1 }];
    expect(operandValue(SYM, drw(v.id, { plot: 0 }), ctx)).toBeNull(); // no interval
    mocks.chartBars.mockReturnValueOnce(bars);
    expect(operandValue(SYM, drw(v.id, { plot: 0 }), ctx, "60", "RTH")).toBeCloseTo(10, 10);
    expect(mocks.chartBars).toHaveBeenCalledWith(SYM, "60", "RTH");
    const fallback = vi.fn(() => bars);
    expect(operandValue(SYM, drw(v.id, { plot: 0 }), { ...ctx, barsFallback: fallback }, "60")).toBeCloseTo(10, 10);
    expect(fallback).toHaveBeenCalledWith("60", undefined);
    expect(operandValue(SYM, drw(v.id, { plot: 0 }), ctx, "60")).toBeNull();
  });

  it("a study: the engine's value on the interval, else the charted value", () => {
    const engine = vi.fn(() => 42);
    expect(operandValue(SYM, ind(), { ...ctx, indicatorValue: engine }, "1D", "ETH")).toBe(42);
    expect(engine).toHaveBeenCalledWith(ind(), "1D", "ETH");
    mocks.indicatorPlotValue.mockReturnValueOnce(7);
    expect(operandValue(SYM, ind({ plot: 2 }), { ...ctx, indicatorValue: engine })).toBe(7);
    expect(mocks.indicatorPlotValue).toHaveBeenCalledWith(SYM, "i1", 2);
  });

  it("operandLabel", () => {
    expect(operandLabel(price)).toBe("Price");
    expect(operandLabel(val(150.5))).toBe("150.5");
    expect(operandLabel(drw("a"))).toBe("drawing");
    expect(operandLabel(drw("a", { label: "trendline" }))).toBe("trendline");
    expect(operandLabel(ind())).toBe("indicator");
    expect(operandLabel(ind({ label: "RSI" }))).toBe("RSI");
  });
});

describe("compared symbol operand", () => {
  const msft: Operand = { kind: "symbol", symbol: "NASDAQ:MSFT", label: "Microsoft Corp. (NASDAQ)" };
  it("reads the price of the quotes it is evaluated on, or the given symbol price", () => {
    expect(operandValue(SYM, msft, { price: 543.2, changePercent: null, timeSec: 0 })).toBe(543.2);
    const symbolPrice = vi.fn(() => 400);
    expect(operandValue(SYM, msft, { price: 1, changePercent: null, timeSec: 0, symbolPrice })).toBe(400);
    expect(symbolPrice).toHaveBeenCalledWith("NASDAQ:MSFT");
  });
  it("is named by its description and exchange, else its ticker", () => {
    expect(operandLabel(msft)).toBe("Microsoft Corp. (NASDAQ)");
    expect(operandLabel({ kind: "symbol", symbol: "NASDAQ:MSFT" })).toBe("MSFT");
  });
  it("a rule on it is evaluated on the compared symbol's quotes", () => {
    expect(ruleQuoteSymbol({ symbol: SYM, left: msft })).toBe("NASDAQ:MSFT");
    expect(ruleQuoteSymbol({ symbol: SYM, left: price })).toBe(SYM);
  });
  it("its amounts are written in the compared symbol's price format", () => {
    mocks.sessions.set("NASDAQ:MSFT", { formatPrice: (v) => v.toFixed(3), mintick: 0.001 });
    expect(alertAmountText(SYM, msft, 543.5)).toBe("543.500");
  });
});

describe("alertAmountText", () => {
  it("the study's decimals, else the symbol's price format, else 2 decimals; thousands grouped", () => {
    expect(alertAmountText(undefined, price, 1234.5)).toBe("1,234.50");
    expect(alertAmountText(undefined, ind({ precision: 0 }), 1234.5)).toBe("1,235");
    expect(alertAmountText(undefined, ind({ precision: 4 }), 0.5)).toBe("0.5000");
    mocks.sessions.set(SYM, { formatPrice: (v) => v.toFixed(4), mintick: 0.0001 });
    expect(alertAmountText(SYM, price, 0.5)).toBe("0.5000");
    expect(alertAmountText(SYM, price, -1234567)).toBe("−1,234,567.0000");
  });
});

describe("describeCondition", () => {
  const d = (left: Operand, op: AlertOperator, right: Operand, extra: { bars?: number; right2?: Operand; symbol?: string } = {}) =>
    describeCondition({ left, op, right, ...extra });

  it("level conditions", () => {
    expect(d(price, "crossing", val(150))).toBe("Price Crossing 150.00");
    expect(d(price, "crossing_up", val(1234.5))).toBe("Price Crossing Up 1,234.50");
    expect(d(price, "greater", ind({ title: "MA (9, close)", label: "MA" }))).toBe("Price Greater Than MA (9, close)");
    expect(d(ind({ title: "RSI (14, close)", label: "RSI", precision: 0 }), "less", val(30))).toBe("RSI (14, close) Less Than 30");
    expect(d(ind({ label: "RSI" }), "less", val(30))).toBe("RSI Less Than 30.00");
  });

  it("drops the price kept in older drawing labels", () => {
    expect(d(price, "crossing", drw("a", { label: "horizontal line @ 123.45" }))).toBe("Price Crossing horizontal line");
    expect(d(price, "crossing", drw("a", { label: "trendline" }))).toBe("Price Crossing trendline");
  });

  it("moving conditions: amount or percentage in N bars", () => {
    expect(d(price, "moving_up_pct", val(5))).toBe("Price Moving Up 5% in 1 bar");
    expect(d(price, "moving_down_pct", val(2.5), { bars: 3 })).toBe("Price Moving Down 2.5% in 3 bars");
    expect(d(price, "moving_down", val(2.5), { bars: 3 })).toBe("Price Moving Down 2.50 in 3 bars");
    expect(d(price, "moving_up", price)).toBe("Price Moving Up 0.00 in 1 bar");
  });

  it("channel conditions", () => {
    expect(d(price, "entering", drw("r", { band: "rectangle", label: "rectangle" }))).toBe("Price Entering rectangle");
    expect(d(price, "exiting", drw("c", { band: "channel", label: "parallel channel" }))).toBe(
      "Price Exiting Channel (Upper Bound: parallel channel, Lower Bound: parallel channel)",
    );
    expect(d(price, "inside", drw("f", { label: "Fib retracement", level: 0.5 }))).toBe(
      "Price Inside Channel Fib retracement (Upper Bound: Fib level 0.5, Lower Bound: Fib level 0.618)",
    );
    expect(d(price, "outside", drw("f", { label: "Fib retracement", level: 1, level2: 0 }))).toBe(
      "Price Outside Channel Fib retracement (Upper Bound: Fib level 1, Lower Bound: Fib level 0)",
    );
    expect(d(price, "entering", val(110), { right2: val(90) })).toBe("Price Entering Channel (Upper Bound: 110.00, Lower Bound: 90.00)");
    expect(d(price, "inside", val(110))).toBe("Price Inside Channel (Upper Bound: 110.00, Lower Bound: 110.00)");
  });

  it("a vertical line is crossed by the time", () => {
    expect(d(price, "crossing", drw("v", { band: "time", label: "vertical line" }))).toBe("Crossing vertical line");
  });

  it("a study's own condition and its alert() calls", () => {
    const cond = { id: "x", title: "Rising to falling" };
    expect(d(ind({ label: "MACD (close, 12, 26, 9)", condition: cond }), "alert_condition", val(0))).toBe("MACD (close, 12, 26, 9): Rising to falling");
    expect(d(ind({ label: "MACD" }), "alert_condition", val(0))).toBe("MACD: Alert condition");
    expect(d(ind({ label: "Auto fib retracement (3, 10)" }), "alert_function", val(0))).toBe("Auto fib retracement (3, 10): Any alert() function call");
  });

  it("writes numbers with the symbol's price format", () => {
    mocks.sessions.set(SYM, { formatPrice: (v) => v.toFixed(4), mintick: 0.0001 });
    expect(d(price, "crossing", val(0.5), { symbol: SYM })).toBe("Price Crossing 0.5000");
  });
});

describe("alertIntervalText", () => {
  it("seconds, minutes, hours, days, weeks, months", () => {
    expect(alertIntervalText("10S")).toBe("10s");
    expect(alertIntervalText("10s")).toBe("10s");
    expect(alertIntervalText("1D")).toBe("1D");
    expect(alertIntervalText("1w")).toBe("1W");
    expect(alertIntervalText("3M")).toBe("3M");
    expect(alertIntervalText("60")).toBe("1h");
    expect(alertIntervalText("240")).toBe("4h");
    expect(alertIntervalText("5")).toBe("5");
    expect(alertIntervalText("5", true)).toBe("5m");
    expect(alertIntervalText("90")).toBe("90");
    expect(alertIntervalText("120", true)).toBe("2h");
  });

  it("returns anything else as is", () => {
    expect(alertIntervalText("0")).toBe("0");
    expect(alertIntervalText("1.5")).toBe("1.5");
    expect(alertIntervalText("abc")).toBe("abc");
    expect(alertIntervalText("")).toBe("");
  });
});

describe("compared symbol and the interval", () => {
  const msft: Operand = { kind: "symbol", symbol: "NASDAQ:MSFT" };
  it("reads the bars of an interval on either side", () => {
    expect(conditionHasInterval({ left: msft, op: "crossing", right: val(1) })).toBe(true);
    expect(conditionHasInterval({ left: price, op: "crossing", right: msft })).toBe(true);
    expect(conditionHasInterval({ left: price, op: "entering", right: val(1), right2: msft })).toBe(true);
    expect(conditionHasIntervalRow({ left: msft, op: "crossing", right: val(1) })).toBe(true);
  });
});

describe("conditionHasInterval / conditionHasIntervalRow", () => {
  it("a price against a number reads no bars", () => {
    expect(conditionHasInterval({ left: price, op: "crossing", right: val(1) })).toBe(false);
    expect(conditionHasIntervalRow({ left: price, op: "crossing", right: val(1) })).toBe(false);
  });

  it("studies, moving conditions and drawings read the bars", () => {
    expect(conditionHasInterval({ left: ind(), op: "crossing", right: val(1) })).toBe(true);
    expect(conditionHasInterval({ left: price, op: "moving_up_pct", right: val(1) })).toBe(true);
    expect(conditionHasInterval({ left: price, op: "crossing", right: ind() })).toBe(true);
    expect(conditionHasInterval({ left: price, op: "entering", right: val(2), right2: ind() })).toBe(true);
    expect(conditionHasInterval({ left: price, op: "crossing", right: drw("a") })).toBe(true);
  });

  it("the Interval row is hidden when a drawing gives the level", () => {
    expect(conditionHasIntervalRow({ left: price, op: "crossing", right: drw("a") })).toBe(false);
    expect(conditionHasIntervalRow({ left: ind(), op: "crossing", right: drw("a") })).toBe(false);
    expect(conditionHasIntervalRow({ left: ind(), op: "crossing", right: val(1) })).toBe(true);
  });
});

describe("defaultAlertMessage", () => {
  const m = (left: Operand, op: AlertOperator, right: Operand, extra: { resolution?: string; symbol?: string; bars?: number } = {}) =>
    defaultAlertMessage({ symbol: SYM, resolution: "1D", left, op, right, ...extra });

  it("the ticker and the condition, without 'Price'", () => {
    expect(m(price, "crossing", val(150))).toBe("AZO Crossing 150.00");
    expect(m(price, "greater", val(150), { symbol: "NYSE:BRK.B" })).toBe("BRK.B Greater Than 150.00");
  });

  it("the ticker with the interval when the condition reads bars", () => {
    expect(m(price, "moving_up_pct", val(5))).toBe("AZO, 1D Moving Up 5% in 1 bar");
    expect(m(price, "crossing", drw("t", { label: "trendline" }), { resolution: "60" })).toBe("AZO, 1h Crossing trendline");
    expect(m(price, "moving_up_pct", val(5), { resolution: "" })).toBe("AZO Moving Up 5% in 1 bar");
  });

  it("a study's condition is followed by the symbol", () => {
    expect(m(ind({ title: "MA (9, close)" }), "crossing", val(150), { resolution: "60" })).toBe("MA (9, close) Crossing 150.00 on AZO, 1h");
  });

  it("the study's own message, or the alert() calls condition", () => {
    expect(m(ind({ condition: { id: "x", title: "X", message: "Go {{ticker}}" } }), "alert_condition", val(0))).toBe("Go {{ticker}}");
    expect(m(ind({ condition: { id: "x", title: "X" } }), "alert_condition", val(0))).toBe("Alert Fired!");
    expect(m(ind({ label: "Auto fib" }), "alert_function", val(0))).toBe("Auto fib: Any alert() function call");
  });

  it("a compared symbol is named like a study (reference messages)", () => {
    const msft: Operand = { kind: "symbol", symbol: "NASDAQ:MSFT", label: "Microsoft Corp. (NASDAQ)" };
    mocks.sessions.set("NASDAQ:MSFT", { formatPrice: (v) => (Math.abs(v) <= 1 ? v.toFixed(4) : v.toFixed(2)), mintick: 0.01 });
    expect(m(msft, "crossing", val(533.69))).toBe("Microsoft Corp. (NASDAQ) Crossing 533.69 on AZO, 1D");
    expect(m(msft, "moving_up", val(1), { bars: 2 })).toBe("Microsoft Corp. (NASDAQ) Moving Up 1.0000 in 2 bars on AZO, 1D");
    expect(m(price, "crossing", msft)).toBe("AZO, 1D Crossing Microsoft Corp. (NASDAQ)");
    expect(defaultAlertMessage({ symbol: SYM, resolution: "1D", left: price, op: "entering", right: val(61.13), right2: msft })).toBe(
      "AZO, 1D Entering Channel (Upper Bound: 61.13, Lower Bound: Microsoft Corp. (NASDAQ))",
    );
  });

  it("a dash for a rule without a ticker", () => {
    expect(m(price, "crossing", val(1), { symbol: "" })).toBe("— Crossing 1.00");
  });

  it("a strategy: the order-fill message with its placeholders; the calls only: the condition", () => {
    const s = ind({ title: "Momentum strategy (12)", label: "Momentum strategy (12)" });
    const fill = "Momentum strategy (12): order {{strategy.order.action}} @ {{strategy.order.contracts}} filled on {{ticker}}. New strategy position is {{strategy.position_size}}";
    expect(m(s, "strategy_orders", val(0))).toBe(fill);
    expect(m(s, "strategy_orders_and_alerts", val(0))).toBe(fill);
    expect(m(s, "strategy_alerts", val(0))).toBe("Momentum strategy (12): alert() function calls only");
    expect(describeCondition({ left: s, op: "strategy_orders", right: val(0) })).toBe("Momentum strategy (12): Order fills only");
  });

  it("a long / short position: the level placeholders and the quantity the drawing shows", () => {
    // Risk 25 % of 1,000 over a 3.00 stop: 83.33 shares, shown floored.
    const long = mk("long-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 3, profitLevel: 10, accountSize: 1000, riskPercent: 25 });
    const short = mk("short-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 3, profitLevel: 10 });
    put(long, short);
    expect(m(price, "hits_level", drw(long.id, { band: "position" }), { resolution: "1" })).toBe("AZO, 1 long position, price hits {{position.level}} at {{position.price}}. Qty: 83. PnL: {{position.pnl}}");
    expect(m(price, "hits_level", drw(short.id, { band: "position" }), { resolution: "60" })).toBe("AZO, 1h short position, price hits {{position.level}} at {{position.price}}. Qty: 83. PnL: {{position.pnl}}");
  });
});

describe("positionHit", () => {
  it("names the level a fire hit, with its price and the profit or loss for the shown quantity", () => {
    const long = mk("long-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 3, profitLevel: 10, accountSize: 1000, riskPercent: 25 });
    const short = mk("short-position", [{ time: 1000, price: 100 }, { time: 2000, price: 100 }], { stopLevel: 3, profitLevel: 10, accountSize: 1000, riskPercent: 25 });
    put(long, short);
    expect(positionHit(SYM, long.id, 100)).toEqual({ level: "Entry", price: 100, pnl: null });
    expect(positionHit(SYM, long.id, 110)).toEqual({ level: "Profit level", price: 110, pnl: 830 });
    expect(positionHit(SYM, long.id, 97)).toEqual({ level: "Stop level", price: 97, pnl: -249 });
    expect(positionHit(SYM, short.id, 90)).toEqual({ level: "Profit level", price: 90, pnl: 830 });
    expect(positionHit(SYM, short.id, 103.2)).toEqual({ level: "Stop level", price: 103, pnl: -249 });
    expect(positionHit(SYM, "gone", 100)).toBeNull();
  });
});
