/*
 * Alert-condition helpers — operand/operator resolution and human-readable
 * labels, shared by the engine (data/alert-engine.ts) and the Create/Edit
 * dialog (window/alerts/AlertDialog.tsx).
 *
 * Kept separate from the store so both the evaluator and the UI can describe a
 * condition the same way without importing each other.
 */
import type { AlertOperator, AlertRule, Operand } from "./alert-store";
import { indicatorPlotValue } from "./chart-state-registry";
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
};

/** Operators whose right operand is a plain percentage threshold (value). */
export function isPercentOperator(op: AlertOperator): boolean {
  return op === "moving_up_pct" || op === "moving_down_pct";
}

/** Drawing kinds whose price level an alert can reference. */
const PRICEABLE_KINDS = new Set(["horizontal-line", "horizontal-ray", "trend-line", "ray", "extended-line"]);

/** True for a drawing kind an alert can be set on. */
export function drawingCanAlert(kind: string): boolean {
  return PRICEABLE_KINDS.has(kind);
}

/** Ids of the drawings a rule reads. */
export function ruleDrawingIds(rule: Pick<AlertRule, "left" | "right">): string[] {
  return [rule.left, rule.right].flatMap((o) => (o.kind === "drawing" ? [o.drawingId] : []));
}

export type DrawingOption = { id: string; label: string };

/** Drawings on `symbol` that expose a usable price level, for the dialog's
 *  "drawing" operand picker. */
export function priceableDrawings(symbol: string): DrawingOption[] {
  return loadDrawings(symbol)
    .filter((d) => PRICEABLE_KINDS.has(d.kind))
    .map((d) => ({ id: d.id, label: drawingLabel(d) }));
}

function drawingLabel(d: Drawing): string {
  const kind = d.kind.replace(/-/g, " ");
  const p = d.points[0]?.price;
  return typeof p === "number" ? `${kind} @ ${+p.toFixed(4)}` : kind;
}

/** Resolve a drawing's current price level. Horizontal kinds are a flat level;
 *  sloped kinds (trend-line/ray/extended-line) interpolate at `atTimeSec` when
 *  both endpoints carry numeric times, else fall back to the latest endpoint. */
export function drawingPriceLevel(symbol: string, drawingId: string, atTimeSec: number): number | null {
  const d = loadDrawings(symbol).find((x) => x.id === drawingId);
  if (!d || d.points.length === 0) return null;
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
};

/** Resolve an operand to a number, or null when unavailable. */
export function operandValue(symbol: string, op: Operand, ctx: EvalContext): number | null {
  switch (op.kind) {
    case "price":
      return ctx.price;
    case "value":
      return op.value;
    case "drawing":
      return drawingPriceLevel(symbol, op.drawingId, ctx.timeSec);
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
  return `${operandLabel(rule.left)} ${OPERATOR_LABELS[rule.op]} ${operandLabel(rule.right)}`;
}
