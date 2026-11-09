/*
 * The alert dialog's form as plain values: the condition its fields describe,
 * whether it can be saved, and what the dialog remembers between two
 * openings. The dialog (AlertDialog.tsx) holds the fields in signals and reads
 * them through here.
 */
import type { AlertCondition, AlertOperator, Operand, StudyConditionRef } from "../../data/alert-store";
import { drawingOperand, indicatorOperand, studyConditionOperand, symbolOperand, type StudyChoice } from "../../data/alert-operands";
import { isBandOperator, isMovingOperator, isStrategyOperator, type DrawingOption } from "../../data/alert-condition";
import { parseAmountText } from "../../data/study-format";
import * as kv from "../../data/kv";

export type SideKind = "value" | "drawing" | "indicator" | "price" | "symbol";

/** The fields of the condition editor. A bound's select: "value", "price", "ind:<study id>" or "sym:<symbol>". */
export type ConditionFields = {
  leftKind: "price" | "indicator" | "symbol";
  leftIndicator: string;
  leftPlot: number;
  leftSymbol: string;
  op: AlertOperator;
  rightKind: SideKind;
  rightValue: string;
  rightDrawing: string;
  rightIndicator: string;
  rightPlot: number;
  rightSymbol: string;
  /** A fib tool's level (and its second one for a channel condition); an anchored VWAP's line. */
  rightLevel: number;
  rightLevel2: number | null;
  rightVwapPlot: number;
  /** Moving conditions: the amount or percentage. */
  pct: string;
  upperSel: string;
  upperValue: string;
  upperPlot: number;
  lowerSel: string;
  lowerValue: string;
  lowerPlot: number;
};

/** What the fields are read against: the choices the dialog offers and the condition it started from. */
export type ConditionChoices = {
  studies: readonly StudyChoice[];
  compares: readonly { symbol: string; label: string }[];
  drawings: readonly DrawingOption[];
  /** The condition the editor started from: its operands keep their saved inputs and labels. */
  seed?: AlertCondition;
  /** The study's condition chosen (a study's own condition). */
  studyCondition?: StudyConditionRef;
  /** The drawing is a fib tool and the condition a channel: its second level is read. */
  fibChannel: boolean;
};

/** A condition of the study itself: no plot, nothing compared. */
export const isOwnCondition = (op: AlertOperator) => op === "alert_condition" || op === "alert_function" || isStrategyOperator(op);

/** A channel between two bounds (not a drawing's). */
export const isValueBand = (f: Pick<ConditionFields, "op" | "rightKind">) => isBandOperator(f.op) && f.rightKind !== "drawing";

/** The source of the condition: a study's plot (or its own condition), a compared symbol, else the price. */
export function buildLeft(f: ConditionFields, c: ConditionChoices): Operand {
  if (f.leftKind === "indicator" && f.leftIndicator) {
    if (!isOwnCondition(f.op)) return indicatorOperand(c.studies, f.leftIndicator, f.leftPlot, c.seed?.left);
    // A condition reads no plot: the study's label without a plot title.
    return studyConditionOperand(c.studies, f.leftIndicator, f.op, c.studyCondition, c.seed?.left);
  }
  if (f.leftKind === "symbol" && f.leftSymbol) return symbolOperand(c.compares, f.leftSymbol);
  return { kind: "price" };
}

/** A bound of a channel: a value, the price or a study's plot. */
function boundOperand(c: ConditionChoices, sel: string, text: string, plot: number, was: Operand | undefined): Operand {
  if (sel === "price") return { kind: "price" };
  if (sel.startsWith("ind:")) return indicatorOperand(c.studies, sel.slice(4), plot, was);
  if (sel.startsWith("sym:")) return symbolOperand(c.compares, sel.slice(4));
  return { kind: "value", value: parseAmountText(text) || 0 };
}

/** What the source is compared with. */
export function buildRight(f: ConditionFields, c: ConditionChoices): Operand {
  // A study's condition compares nothing.
  if (isOwnCondition(f.op)) return { kind: "value", value: 0 };
  if (isMovingOperator(f.op)) return { kind: "value", value: parseFloat(f.pct) || 0 };
  if (isValueBand(f)) return boundOperand(c, f.upperSel, f.upperValue, f.upperPlot, c.seed?.right);
  switch (f.rightKind) {
    case "drawing":
      return drawingOperand(f.rightDrawing, c.drawings.find((x) => x.id === f.rightDrawing), { level: f.rightLevel, level2: c.fibChannel ? f.rightLevel2 : null, plot: f.rightVwapPlot });
    case "indicator":
      return indicatorOperand(c.studies, f.rightIndicator, f.rightPlot, c.seed?.right);
    case "price":
      return { kind: "price" };
    case "symbol":
      return symbolOperand(c.compares, f.rightSymbol);
    default:
      return { kind: "value", value: parseAmountText(f.rightValue) || 0 };
  }
}

/** The lower bound of a channel between two bounds, else none. */
export function buildRight2(f: ConditionFields, c: ConditionChoices): Operand | undefined {
  return isValueBand(f) ? boundOperand(c, f.lowerSel, f.lowerValue, f.lowerPlot, c.seed?.right2) : undefined;
}

/** The condition in the editor. `bars`: a moving condition's bar count; `resolution`: the interval it reads. */
export function conditionOf(f: ConditionFields, c: ConditionChoices, bars: number, resolution: string): AlertCondition {
  const right2 = buildRight2(f, c);
  return {
    left: buildLeft(f, c),
    op: f.op,
    right: buildRight(f, c),
    ...(right2 ? { right2 } : {}),
    ...(isMovingOperator(f.op) ? { bars } : {}),
    resolution,
  };
}

/** The condition in the editor can be saved. `strategy` / `calls`: the source is a strategy / calls alert(). */
export function conditionValid(f: ConditionFields, c: ConditionChoices, source: { strategy: boolean; calls: boolean }): boolean {
  if (f.op === "alert_condition") return !!c.studyCondition;
  if (isStrategyOperator(f.op)) return source.strategy && (f.op === "strategy_orders" || source.calls);
  if (f.op === "alert_function") return source.calls;
  if (isMovingOperator(f.op)) return Number.isFinite(parseFloat(f.pct));
  if (isValueBand(f)) {
    const ok = (sel: string, text: string) =>
      sel === "value" ? Number.isFinite(parseAmountText(text)) : sel === "price" || c.studies.some((o) => `ind:${o.id}` === sel) || c.compares.some((x) => `sym:${x.symbol}` === sel);
    return ok(f.upperSel, f.upperValue) && ok(f.lowerSel, f.lowerValue);
  }
  if (f.rightKind === "value") return Number.isFinite(parseAmountText(f.rightValue));
  if (f.rightKind === "drawing") return c.drawings.some((o) => o.id === f.rightDrawing);
  if (f.rightKind === "indicator") return c.studies.some((o) => o.id === f.rightIndicator);
  if (f.rightKind === "symbol") return c.compares.some((x) => x.symbol === f.rightSymbol);
  return true;
}

/** A deliverable webhook target: parses as a URL with an http(s) scheme. */
export function isValidWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** A formatted amount as a number field holds it: no thousands separator, a plain minus sign. */
export const fieldText = (t: string) => t.replace(/,/g, "").replace(/−/g, "-");

/** Groups of the placeholder menu shown open; General only until the user opens or closes one (remembered). */
const PLACEHOLDER_GROUPS_KEY = "alerts.placeholder-groups.v1";

export function openPlaceholderGroups(): Record<string, boolean> {
  try {
    return { general: true, ...JSON.parse(kv.getItem(PLACEHOLDER_GROUPS_KEY) ?? "{}") };
  } catch {
    return { general: true };
  }
}

export function saveOpenPlaceholderGroups(groups: Record<string, boolean>): void {
  try {
    kv.setItem(PLACEHOLDER_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    /* best-effort */
  }
}
