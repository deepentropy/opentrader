/*
 * Alert-condition helpers — operand/operator resolution and human-readable
 * labels, shared by the engine (data/alert-engine.ts) and the Create/Edit
 * dialog (window/alerts/AlertDialog.tsx).
 *
 * Kept separate from the store so both the evaluator and the UI can describe a
 * condition the same way without importing each other.
 */
import type { AlertOperator, AlertRule, DrawingShape, Operand } from "./alert-store";
import { cachedSymbolSessions } from "./session";
import { FIB_LEVEL_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { VWAP_BAND_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { positionLevels } from "lightweight-charts-drawing/core/kinds/position";
import { vwapLast } from "lightweight-charts-drawing/core/kinds/data-series";
import type { OHLC } from "lightweight-charts-drawing/core/coords";
import { chartBars, indicatorPlotValue, type ChartBar } from "./chart-state-registry";
import { loadDrawings } from "../window/drawings/persistence";
import type { Drawing } from "lightweight-charts-drawing/core/types";

export const OPERATOR_LABELS: Record<AlertOperator, string> = {
  crossing: "Crossing",
  crossing_up: "Crossing up",
  crossing_down: "Crossing down",
  greater: "Greater than",
  less: "Less than",
  moving_up_pct: "Moving up %",
  moving_down_pct: "Moving down %",
  entering: "Entering",
  exiting: "Exiting",
  inside: "Inside",
  outside: "Outside",
  hits_level: "Hits entry, stop, or target level",
};

/** Operators of a drawing with two bounds (channel, rectangle). */
export const BAND_OPERATORS: AlertOperator[] = ["entering", "exiting", "inside", "outside"];
export function isBandOperator(op: AlertOperator): boolean {
  return BAND_OPERATORS.includes(op);
}
/** Dialog label of a band operator: "Entering channel", "Inside rectangle". */
export function bandOperatorLabel(op: AlertOperator, band: DrawingShape): string {
  return `${OPERATOR_LABELS[op]} ${band}`;
}

export const LEVEL_OPERATORS: AlertOperator[] = ["crossing", "crossing_up", "crossing_down", "greater", "less"];

/** The operators a drawing offers; null = the level operators of the
 *  dialog. A rectangle adds Greater / Less than (above its top, below its
 *  bottom); a vertical line only has "Crossing" (the time reaches it); a
 *  position has its one fixed condition; a fib tool (`fib`) has the level
 *  conditions on one level and the channel ones between two levels. */
export function shapeOperators(shape: DrawingShape | null, fib = false): AlertOperator[] | null {
  if (fib) return [...LEVEL_OPERATORS, ...BAND_OPERATORS];
  if (shape === "channel") return BAND_OPERATORS;
  if (shape === "rectangle") return [...BAND_OPERATORS, "greater", "less"];
  if (shape === "time") return ["crossing"];
  if (shape === "position") return ["hits_level"];
  return null;
}

/** Operators whose right operand is a plain percentage threshold (value). */
export function isPercentOperator(op: AlertOperator): boolean {
  return op === "moving_up_pct" || op === "moving_down_pct";
}

/** Drawing kinds whose price level an alert can reference. */
const PRICEABLE_KINDS = new Set(["horizontal-line", "horizontal-ray", "trend-line", "ray", "extended-line"]);
/** Drawing kinds with two bounds: the channel conditions. */
const CHANNEL_KINDS = new Set(["parallel-channel", "disjoint-channel", "flat-top-bottom"]);

/** Fib tools: one price level per coefficient. */
const FIB_KINDS = new Set(["fib-retracement", "trend-based-fib-extension"]);
const POSITION_KINDS = new Set(["long-position", "short-position"]);

/** Shape of a drawing kind (null: a single level, or not alertable). */
export function drawingBandType(kind: string): DrawingShape | null {
  if (CHANNEL_KINDS.has(kind)) return "channel";
  if (kind === "rectangle") return "rectangle";
  if (kind === "vertical-line") return "time";
  if (POSITION_KINDS.has(kind)) return "position";
  return null;
}

/** True for a drawing kind an alert can be set on. */
export function drawingCanAlert(kind: string): boolean {
  return PRICEABLE_KINDS.has(kind) || FIB_KINDS.has(kind) || kind === VWAP_KIND || drawingBandType(kind) !== null;
}

/** Anchored VWAP: its value comes from the bars since the anchor, not from
 *  its points. */
const VWAP_KIND = "anchored-vwap";
/** The lines of an anchored VWAP an alert can read, in the order of the
 *  dialog's select (`Operand.plot` is the index). */
export const VWAP_PLOTS = ["VWAP", "Lower Band", "Lower Band_2", "Lower Band_3", "Upper Band", "Upper Band_2", "Upper Band_3"];

/** Value of line `plot` of an anchored VWAP at the last bar of `bars`; null
 *  when the drawing is gone, the anchor is past the bars, or the band is
 *  not calculated (switched off in the drawing's settings). Bands: the VWAP
 *  plus / minus the band's multiplier times the standard deviation (or 1 %
 *  of the VWAP in percentage mode), as drawn. */
export function drawingVwapValue(symbol: string, drawingId: string, plot: number, bars: ChartBar[]): number | null {
  const d = loadDrawings(symbol).find((x) => x.id === drawingId);
  if (!d || d.kind !== VWAP_KIND) return null;
  const last = vwapLast(d, bars as OHLC[]);
  if (!last) return null;
  if (plot <= 0) return last.vwap;
  const band = (d.style.levels ?? VWAP_BAND_DEFAULTS)[(plot - 1) % 3];
  if (!band?.visible) return null;
  const unit = d.style.vwapBandsMode === "percent" ? last.vwap * 0.01 : last.sd;
  return last.vwap + (plot <= 3 ? -1 : 1) * band.coeff * unit;
}

/** Price of a fib level (linear prices). Retracement: 0 at the second
 *  point, 1 at the first (the other way round with "reverse"). Trend-based
 *  extension: the p0-p1 move times the coefficient, from p2. */
function fibLevelPrice(d: Drawing, coeff: number): number | null {
  const [p0, p1, p2] = d.points;
  if (!p0 || !p1) return null;
  const rev = !!d.style.reverse;
  if (d.kind === "trend-based-fib-extension") return p2 ? p2.price + (rev ? p0.price - p1.price : p1.price - p0.price) * coeff : null;
  const end = rev ? p0.price : p1.price;
  const start = rev ? p1.price : p0.price;
  return end + coeff * (start - end);
}

/** True when `atTimeSec` is within the dates a fib tool or a position
 *  covers: a retracement between its two points, a trend-based extension
 *  between its second and third points (where its levels are drawn), a
 *  position between its entry and its end. A side with "extend" on has no
 *  limit. Points without a numeric time: no limit. */
function withinDrawingSpan(d: Drawing, atTimeSec: number): boolean {
  const [a, b] = d.kind === "trend-based-fib-extension" ? [d.points[1], d.points[2]] : [d.points[0], d.points[1]];
  if (!a || !b || typeof a.time !== "number" || typeof b.time !== "number") return true;
  if (!d.style.extendLeft && atTimeSec < Math.min(a.time, b.time)) return false;
  if (!d.style.extendRight && atTimeSec > Math.max(a.time, b.time)) return false;
  return true;
}

/** Visible levels of a fib drawing, by coefficient, with their prices. */
export function drawingFibLevels(d: Drawing): { coeff: number; price: number }[] {
  if (!FIB_KINDS.has(d.kind)) return [];
  return (d.style.levels ?? FIB_LEVEL_DEFAULTS)
    .filter((l) => l.visible)
    .map((l) => ({ coeff: l.coeff, price: fibLevelPrice(d, l.coeff) }))
    .filter((l): l is { coeff: number; price: number } => l.price != null)
    .sort((a, b) => a.coeff - b.coeff);
}

/** Time of a vertical line (epoch seconds), or null. */
export function drawingTime(symbol: string, drawingId: string): number | null {
  const t = loadDrawings(symbol).find((x) => x.id === drawingId)?.points[0]?.time;
  return typeof t === "number" ? t : null;
}

/** Entry, stop and target prices of a long / short position drawing; null
 *  outside the dates of the position when `atTimeSec` is given. */
export function drawingPositionLevels(symbol: string, drawingId: string, atTimeSec?: number): { entry: number; stop: number; target: number } | null {
  const d = loadDrawings(symbol).find((x) => x.id === drawingId);
  if (!d || !POSITION_KINDS.has(d.kind) || !d.points[0]) return null;
  if (atTimeSec !== undefined && !withinDrawingSpan(d, atTimeSec)) return null;
  const entry = d.points[0].price;
  const side = d.kind === "long-position" ? 1 : -1;
  const { stop, profit } = positionLevels(d, cachedSymbolSessions(symbol)?.mintick ?? 0.01);
  return { entry, stop: entry - side * stop, target: entry + side * profit };
}

/** Rules that read the drawing `id`. */
export function rulesOfDrawing(rules: readonly AlertRule[], id: string): AlertRule[] {
  return rules.filter((r) => ruleDrawingIds(r).includes(id));
}

/** Ids of the drawings a rule reads. */
export function ruleDrawingIds(rule: Pick<AlertRule, "left" | "right">): string[] {
  return [rule.left, rule.right].flatMap((o) => (o.kind === "drawing" ? [o.drawingId] : []));
}

export type DrawingOption = {
  id: string;
  label: string;
  band: DrawingShape | null;
  /** Fib tools: the levels to choose from. */
  levels?: { coeff: number; price: number }[];
  /** Anchored VWAP: the lines to choose from. */
  plots?: string[];
};

/** Drawings on `symbol` that expose a usable price level, for the dialog's
 *  "drawing" operand picker. */
export function priceableDrawings(symbol: string): DrawingOption[] {
  return loadDrawings(symbol)
    .filter((d) => drawingCanAlert(d.kind))
    .map((d) => ({
      id: d.id,
      label: drawingLabel(d),
      band: drawingBandType(d.kind),
      ...(FIB_KINDS.has(d.kind) ? { levels: drawingFibLevels(d) } : {}),
      ...(d.kind === VWAP_KIND ? { plots: VWAP_PLOTS } : {}),
    }));
}

function drawingLabel(d: Drawing): string {
  if (d.kind === VWAP_KIND) return "anchored VWAP";
  const kind = d.kind.replace(/-/g, " ");
  if (drawingBandType(d.kind) || FIB_KINDS.has(d.kind)) return kind;
  const p = d.points[0]?.price;
  return typeof p === "number" ? `${kind} @ ${+p.toFixed(4)}` : kind;
}

/** Price of the line through two points at `atTimeSec` (time-interpolated,
 *  not limited to the segment); the later point's price when the times are
 *  not numeric or equal. */
function lineAt(p0: { time: unknown; price: number }, p1: { time: unknown; price: number }, atTimeSec: number): number {
  const t0 = typeof p0.time === "number" ? p0.time : null;
  const t1 = typeof p1.time === "number" ? p1.time : null;
  if (t0 == null || t1 == null || t0 === t1) return p1.price;
  return p0.price + ((p1.price - p0.price) / (t1 - t0)) * (atTimeSec - t0);
}

/** The two bounds of a channel or rectangle drawing at `atTimeSec`, or null
 *  (drawing gone, not a band kind, or a rectangle outside its time span).
 *  Channels: the p0-p1 edge and the other edge, both followed past their
 *  ends. Parallel: the other edge is the same line through p2. Disjoint:
 *  the mirrored edge (the price of p2 at the time of p1, that price plus
 *  p1 - p0 at the time of p0). Flat top/bottom: the price of p2.
 *  Rectangle: its price range, only between its two times (a side with
 *  "extend" on has no time limit). Fib tools: the prices of the two levels
 *  `level` and `level2`, within the dates the tool covers. */
export function drawingBand(symbol: string, drawingId: string, atTimeSec: number, level?: number, level2?: number): { lower: number; upper: number } | null {
  const d = loadDrawings(symbol).find((x) => x.id === drawingId);
  if (!d) return null;
  const [p0, p1, p2] = d.points;
  let a: number;
  let b: number;
  if (FIB_KINDS.has(d.kind)) {
    if (!withinDrawingSpan(d, atTimeSec)) return null;
    const u = fibLevelPrice(d, level ?? 0.5);
    const l = fibLevelPrice(d, level2 ?? 0.618);
    if (u == null || l == null) return null;
    a = u;
    b = l;
  } else if (d.kind === "rectangle") {
    if (!p0 || !p1) return null;
    if (typeof p0.time === "number" && typeof p1.time === "number") {
      if (!d.style.extendLeft && atTimeSec < Math.min(p0.time, p1.time)) return null;
      if (!d.style.extendRight && atTimeSec > Math.max(p0.time, p1.time)) return null;
    }
    a = p0.price;
    b = p1.price;
  } else if (CHANNEL_KINDS.has(d.kind)) {
    if (!p0 || !p1 || !p2) return null;
    a = lineAt(p0, p1, atTimeSec);
    if (d.kind === "flat-top-bottom") b = p2.price;
    else if (d.kind === "disjoint-channel") b = lineAt({ time: p0.time, price: p2.price + (p1.price - p0.price) }, { time: p1.time, price: p2.price }, atTimeSec);
    else b = a + (p2.price - lineAt(p0, p1, typeof p2.time === "number" ? p2.time : atTimeSec));
  } else {
    return null;
  }
  return { lower: Math.min(a, b), upper: Math.max(a, b) };
}

/** Resolve a drawing's current price level. Horizontal kinds are a flat level;
 *  sloped kinds (trend-line/ray/extended-line) interpolate at `atTimeSec` when
 *  both endpoints carry numeric times, else fall back to the latest endpoint. */
export function drawingPriceLevel(symbol: string, drawingId: string, atTimeSec: number, level?: number): number | null {
  const d = loadDrawings(symbol).find((x) => x.id === drawingId);
  if (!d || d.points.length === 0) return null;
  // A fib level only counts within the dates the tool covers.
  if (FIB_KINDS.has(d.kind)) return withinDrawingSpan(d, atTimeSec) ? fibLevelPrice(d, level ?? 0.5) : null;
  const p0 = d.points[0];
  if (d.points.length === 1) return p0.price;
  const p1 = d.points[1];
  if (!p1) return p0.price;
  const t0 = typeof p0.time === "number" ? p0.time : null;
  const t1 = typeof p1.time === "number" ? p1.time : null;
  if (t0 == null || t1 == null || t0 === t1) {
    // Non-numeric (business-day) times or vertical — use the later endpoint.
    return p1.price;
  }
  const slope = (p1.price - p0.price) / (t1 - t0);
  return p0.price + slope * (atTimeSec - t0);
}

/** True when the rule references a drawing operand whose drawing no longer
 *  exists (deleted after the alert was created) — the rule stays enabled but
 *  its condition can never resolve. The alerts panel surfaces this as a
 *  warning; the rule is NOT auto-disabled (re-creating the drawing revives it). */
export function ruleDrawingMissing(rule: Pick<AlertRule, "symbol" | "left" | "right">): boolean {
  for (const o of [rule.left, rule.right]) {
    if (o.kind !== "drawing") continue;
    if (!loadDrawings(rule.symbol).some((d) => d.id === o.drawingId)) return true;
  }
  return false;
}

export type EvalContext = {
  /** Current last price for the symbol. */
  price: number;
  /** Session change% from the tick (for moving_*_pct), or null. */
  changePercent: number | null;
  /** Evaluation time, epoch seconds. */
  timeSec: number;
  /** Indicator value source used when the symbol isn't charted (the chart
   *  registry has no provider) — the engine's fetched-bars poll cache. */
  indicatorFallback?: (indicatorId: string, plot: number) => number | null;
  /** Bars of the symbol on an interval no chart shows (the engine's
   *  fetched-bars poll cache), for the drawings computed from bars. */
  barsFallback?: (resolution: string) => ChartBar[] | null;
};

/** Resolve an operand to a number, or null when unavailable. `resolution`:
 *  the interval of the rule, for the operands computed from bars. */
export function operandValue(symbol: string, op: Operand, ctx: EvalContext, resolution?: string): number | null {
  switch (op.kind) {
    case "price":
      return ctx.price;
    case "value":
      return op.value;
    case "drawing": {
      if (op.plot == null) return drawingPriceLevel(symbol, op.drawingId, ctx.timeSec, op.level);
      // Anchored VWAP, on the rule's interval: the chart's bars when a chart
      // shows the symbol on it (live), the fetched bars otherwise.
      const bars = resolution == null ? null : (chartBars(symbol, resolution) ?? ctx.barsFallback?.(resolution) ?? null);
      return bars ? drawingVwapValue(symbol, op.drawingId, op.plot, bars) : null;
    }
    case "indicator": {
      // Charted value first (live, honours the chart's configured inputs);
      // engine poll cache second (default inputs, ~60s stale) so the alert
      // still evaluates while the symbol isn't charted.
      const live = indicatorPlotValue(symbol, op.indicatorId, op.plot ?? 0);
      return live ?? ctx.indicatorFallback?.(op.indicatorId, op.plot ?? 0) ?? null;
    }
  }
}

export function operandLabel(op: Operand): string {
  switch (op.kind) {
    case "price":
      return "Price";
    case "value":
      return String(op.value);
    case "drawing":
      return op.label ?? "drawing";
    case "indicator":
      return op.label ?? "indicator";
  }
}

/** Human-readable condition, e.g. "Price Crossing up 150", "Price Moving up
 *  % 5% in 3 bars". */
export function describeCondition(rule: Pick<AlertRule, "left" | "op" | "right" | "bars">): string {
  if (isPercentOperator(rule.op)) {
    const pct = rule.right.kind === "value" ? rule.right.value : 0;
    const n = rule.bars ?? 1;
    return `${operandLabel(rule.left)} ${OPERATOR_LABELS[rule.op]} ${pct}% in ${n} ${n === 1 ? "bar" : "bars"}`;
  }
  if (isBandOperator(rule.op) && rule.right.kind === "drawing" && rule.right.band) {
    return `${operandLabel(rule.left)} ${bandOperatorLabel(rule.op, rule.right.band)}`;
  }
  // Fib tool, channel condition: the label names the two levels.
  if (isBandOperator(rule.op) && rule.right.kind === "drawing") {
    return `${operandLabel(rule.left)} ${bandOperatorLabel(rule.op, "channel")} ${operandLabel(rule.right)}`;
  }
  // A vertical line is crossed by the time, not by a value.
  if (rule.right.kind === "drawing" && rule.right.band === "time") return `${OPERATOR_LABELS[rule.op]} ${operandLabel(rule.right)}`;
  return `${operandLabel(rule.left)} ${OPERATOR_LABELS[rule.op]} ${operandLabel(rule.right)}`;
}
