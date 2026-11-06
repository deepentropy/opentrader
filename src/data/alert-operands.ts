/*
 * Alert operands — how an alert condition names and reads a study, a study's own conditions, a drawing and a
 * compared symbol.
 *
 * The alert dialog (window/alerts/AlertDialog.tsx) and the agent's create_alert tool (agent/alert-tools.ts) build
 * their operands here, so an alert made either way reads the same plot, keeps the same inputs and writes the same
 * messages.
 */
import type { AlertCondition, AlertFrequency, AlertOperator, DrawingShape, Operand, StudyConditionRef } from "./alert-store";
import { LEVEL_OPERATORS, STRATEGY_OPERATORS, conditionReadsStudy, isStrategyOperator, shapeOperators, type DrawingOption } from "./alert-condition";
import { choiceIndex, outputChoices } from "./alert-outputs";
import { indicatorLegendFor } from "./chart-state-registry";
import type { StudyFormat } from "./study-format";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { statusLineInputs } from "../window/chart/indicators/indicator-options";
import { sourceSpecsOf } from "../window/chart/indicators/study-sources";

/** A study an alert can read: its id, its legend title and its inputs on the chart. */
export type StudyChoice = { id: string; label: string; inputs?: Record<string, unknown> };

export type IndicatorOperand = Extract<Operand, { kind: "indicator" }>;

/** An operand on a symbol compared on the chart, named as the dialog's selects name it ("Microsoft Corp. (NASDAQ)");
 *  `compares`: the chart's compared symbols (a symbol no longer there keeps its own name). */
export function symbolOperand(compares: readonly { symbol: string; label: string }[], sym: string): Operand {
  const s = sym.toUpperCase();
  const c = compares.find((x) => x.symbol.toUpperCase() === s);
  return { kind: "symbol", symbol: s, label: c?.label ?? s };
}

/** The studies of the chart showing `symbol`, as alert sources. */
export function chartStudies(symbol: string): StudyChoice[] {
  return indicatorLegendFor(symbol).map((r) => ({ id: r.id, label: r.title, inputs: r.inputValues }));
}

/** The outputs of a study in message order (line plots, shapes, characters, arrows, candle prices): the rows of its
 *  plot select. */
export function studyPlots(indicatorId: string) {
  return outputChoices(getIndicatorEntry(indicatorId));
}

/** The row of a study's plot select an operand reads (0 for any other operand). */
export function choiceOf(o: Operand | undefined): number {
  return o?.kind === "indicator" ? choiceIndex(getIndicatorEntry(o.indicatorId), o) : 0;
}

/** The inputs a study shows after its title ("close, 12, 26, 9"), "" for none. */
function inputsText(indicatorId: string, inputs: Record<string, unknown> | undefined): string {
  const entry = getIndicatorEntry(indicatorId);
  return entry && inputs ? statusLineInputs(entry, inputs, ", ", (v) => sourceSpecsOf(inputs)?.[v]?.label ?? null) : "";
}

/** A study as the selects name it: its legend title with its inputs ("MACD (close, 12, 26, 9)"). */
export function studyLabel(studies: readonly StudyChoice[], id: string): string {
  const o = studies.find((x) => x.id === id);
  if (!o) return "indicator";
  const shown = inputsText(id, o.inputs);
  return shown ? `${o.label} (${shown})` : o.label;
}

/** Operand label: the study title with its inputs, and the plot title for a study with several plots
 *  ("BB (20, 2): Upper"). */
export function plotLabel(title: string | undefined, indicatorId: string, plot: number, inputs?: Record<string, unknown>): string | undefined {
  const plots = studyPlots(indicatorId);
  const shown = inputsText(indicatorId, inputs);
  const name = title && shown ? `${title} (${shown})` : title;
  return plots.length >= 2 && name ? `${name}: ${plots[plot]?.title ?? ""}` : name;
}

/** An operand on row `plot` of a study's plot select. It carries the study's inputs as they are now on the chart;
 *  an alert being edited (`was`) keeps the ones it was made with. */
export function indicatorOperand(studies: readonly StudyChoice[], indicatorId: string, plot: number, was: Operand | undefined): IndicatorOperand {
  const o = studies.find((x) => x.id === indicatorId);
  const kept = was?.kind === "indicator" && was.indicatorId === indicatorId ? was : undefined;
  const inputs = kept?.inputs ?? (o?.inputs ? { ...o.inputs } : undefined);
  const label = kept?.inputs && choiceOf(kept) === plot && kept.label ? kept.label : plotLabel(kept?.inputs ? kept.label?.replace(/ \(.*$/, "") ?? o?.label : o?.label, indicatorId, plot, inputs);
  // `plot`: the row of the plot select; a line plot by its index, another output by its key.
  const choice = studyPlots(indicatorId)[plot];
  // Messages name the study by its full title with its inputs.
  const entry = getIndicatorEntry(indicatorId);
  const shown = inputsText(indicatorId, inputs);
  const full = entry?.metadata.title;
  const title = kept?.title ?? (full ? (shown ? `${full} (${shown})` : full) : undefined);
  const precision = (entry?.metadata as { precision?: number } | undefined)?.precision;
  const format = (entry as { format?: StudyFormat } | undefined)?.format;
  const read = choice?.output ? { output: choice.output } : { plot: choice?.plot ?? 0 };
  return { kind: "indicator", indicatorId, ...read, label, ...(title ? { title } : {}), ...(precision != null ? { precision } : {}), ...(format ? { format } : {}), ...(inputs ? { inputs } : {}) };
}

/** The study on the left of one of its own conditions (`alert_condition` with `condition`, its alert() calls, a
 *  strategy's order fills): it reads no plot, so its label has no plot title. */
export function studyConditionOperand(studies: readonly StudyChoice[], indicatorId: string, op: AlertOperator, condition: StudyConditionRef | undefined, was: Operand | undefined): IndicatorOperand {
  const o = indicatorOperand(studies, indicatorId, 0, was);
  const plots = studyPlots(indicatorId);
  const label = plots.length >= 2 && o.label ? o.label.slice(0, o.label.length - `: ${plots[0]?.title ?? ""}`.length) : o.label;
  if (op === "alert_function" || isStrategyOperator(op)) {
    const { condition: _condition, ...rest } = o;
    return { ...rest, label };
  }
  if (!condition) return o;
  return { ...o, label, condition };
}

/** A strategy's conditions: its order fills, with its alert() calls and the calls only when it calls alert(). */
export function strategyOperators(callsAlert: boolean): AlertOperator[] {
  return callsAlert ? STRATEGY_OPERATORS : ["strategy_orders"];
}

/** The conditions a drawing fixes: the level ones on an anchored VWAP's line, else its shape's (a fib tool adds the
 *  channel ones between two levels); null = a single level, which takes the operators of a value. */
export function drawingOperators(o: DrawingOption | undefined): AlertOperator[] | null {
  return (o?.plots?.length ?? 0) > 0 ? LEVEL_OPERATORS : shapeOperators(o?.band ?? null, (o?.levels?.length ?? 0) > 0);
}

/** A fib level as the selects show it: "0.618 (152.40)". */
export function fibLevelText(l: { coeff: number; price: number }): string {
  return `${l.coeff} (${l.price.toFixed(2)})`;
}

/** The level a fib alert starts on: 0.5, else the first. */
export function defaultFibLevel(levels: readonly { coeff: number }[]): number {
  return (levels.find((l) => l.coeff === 0.5) ?? levels[0]).coeff;
}

/** The lower bound a fib channel condition starts on: the level after `level`, else the one before. */
export function defaultFibLevel2(levels: readonly { coeff: number }[], level: number): number {
  const i = levels.findIndex((l) => l.coeff === level);
  return (levels[i + 1] ?? levels[i - 1] ?? levels[0]).coeff;
}

/** The drawing `id` (its option `o`) as the right side: the fib level `level` (with `level2` as the lower bound of a
 *  channel condition), the anchored VWAP line `plot`. */
export function drawingOperand(id: string, o: DrawingOption | undefined, pick: { level: number; level2?: number | null; plot: number }): Operand {
  const lv = o?.levels?.find((l) => l.coeff === pick.level);
  const lv2 = pick.level2 != null ? o?.levels?.find((l) => l.coeff === pick.level2) : undefined;
  return {
    kind: "drawing",
    drawingId: id,
    label: lv && lv2 ? `${o?.label} (upper bound: level ${lv.coeff}, lower bound: level ${lv2.coeff})` : lv ? `${o?.label} level ${fibLevelText(lv)}` : o?.label,
    ...(o?.band ? { band: o.band } : {}),
    ...(lv ? { level: lv.coeff } : {}),
    ...(lv2 ? { level2: lv2.coeff } : {}),
    ...(o?.plots ? { plot: pick.plot } : {}),
  };
}

/** A strategy's order fills fire every time an order fills (the rule stays active). */
export const STRATEGY_FREQUENCY: AlertFrequency = "every_time";

/** The trigger a condition sets, null when the user picks it: a script's alert() calls fire as each call allows (per
 *  bar at most), order fills on every fill, a vertical line or a position once. `band`: the shape of the drawing the
 *  condition compares with. */
export function fixedFrequency(op: AlertOperator, band: DrawingShape | null): AlertFrequency | null {
  if (op === "alert_function") return "once_per_bar";
  if (isStrategyOperator(op)) return STRATEGY_FREQUENCY;
  if (band === "time" || band === "position") return "only_once";
  return null;
}

/** The script's alert() calls give the messages: "Any alert() function call", a strategy's "alert() function calls
 *  only". */
export function callsGiveMessages(op: AlertOperator): boolean {
  return op === "alert_function" || op === "strategy_alerts";
}

/** The fewest bars of a moving condition: 1 on the price, 2 on a study or a compared symbol. */
export function movingBarsMin(left: Operand["kind"]): number {
  return left !== "price" ? 2 : 1;
}

/** The interval the conditions read on bars share, else null. */
export function sharedBarInterval(list: readonly AlertCondition[]): string | null {
  const bars = list.filter(conditionReadsStudy);
  return bars.length > 0 && bars.every((c) => c.resolution === bars[0].resolution) ? bars[0].resolution : null;
}

/** The conditions of a multi-condition alert as saved: a condition read on every update takes the interval the
 *  others read on bars, so the per-bar triggers count those bars. */
export function savedConditions(list: readonly AlertCondition[]): AlertCondition[] {
  const shared = sharedBarInterval(list);
  return list.map((c) => (shared && !conditionReadsStudy(c) ? { ...c, resolution: shared } : c));
}

/** The per-bar triggers ("Once per bar", "Once per bar close") are offered: a condition that reads bars; several
 *  conditions when the ones on bars share an interval. */
export function perBarTriggers(list: readonly AlertCondition[]): boolean {
  return list.length >= 2 ? sharedBarInterval(list) !== null : list.length === 1 && conditionReadsStudy(list[0]);
}
