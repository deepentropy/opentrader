/*
 * A script's `confirm` inputs, asked when it is added to a chart (reference "Confirm Inputs"):
 *
 * 1. its time and price inputs are given on the chart, one point after another (point-request.ts); on a chart that
 *    cannot take them (not shown, brick types), in the dialog's fields;
 * 2. when it has other confirm inputs, the "Confirm Inputs" dialog lists every confirm input (the points just given
 *    included) with Apply;
 * 3. the study is added with those values. Cancelling a point or the dialog adds nothing.
 *
 * "Reset points…" (the study's menu) asks every time and price input again on its chart.
 */
import { createSignal } from "solid-js";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { DialogInput } from "./IndicatorSettingsDialog";
import { askPoints, canPickOn, isPointInput, pointSteps, type PointTarget } from "./point-request";

export type ConfirmDialogRequest = {
  title: string;
  inputConfig: DialogInput[];
  inputs: Record<string, unknown>;
  /** The charted symbol's exchange zone: time inputs are shown in it (as in the study's settings). */
  timeZone?: string;
  resolve: (inputs: Record<string, unknown> | null) => void;
};

const [dialog, setDialog] = createSignal<ConfirmDialogRequest | null>(null);
/** The "Confirm Inputs" dialog asked now (ConfirmInputsHost shows it). */
export const confirmDialog = dialog;
/** Close the dialog with the inputs to add the study with, or null (cancelled). */
export function closeConfirmDialog(req: ConfirmDialogRequest, inputs: Record<string, unknown> | null): void {
  if (dialog() === req) setDialog(null);
  req.resolve(inputs);
}

const configOf = (entry: IndicatorRegistryEntry): DialogInput[] => (entry.inputConfig ?? []) as DialogInput[];

/** The inputs a study asks for when it is added. */
export const confirmInputsOf = (entry: IndicatorRegistryEntry): DialogInput[] => configOf(entry).filter((c) => c.confirm && !c.hidden);

/** The time and price inputs given on the chart by "Reset points…" (none: no menu row). */
export const pointInputsOf = (entry: IndicatorRegistryEntry): DialogInput[] => configOf(entry).filter(isPointInput);

/**
 * Ask the confirm inputs of `entry` (its points on the chart `target`, then the dialog when it has other ones),
 * starting from `inputs`; the inputs to add the study with, or null when the user cancels.
 */
export async function confirmStudyInputs(
  target: PointTarget,
  entry: IndicatorRegistryEntry,
  inputs: Record<string, unknown>,
  timeZone?: string,
): Promise<Record<string, unknown> | null> {
  const confirm = confirmInputsOf(entry);
  let values = { ...inputs };
  // A chart that cannot take the points: every confirm input in the dialog.
  const points = canPickOn(target) ? confirm.filter(isPointInput) : [];
  if (points.length) {
    const got = await askPoints(target, pointSteps(points, configOf(entry), entry.shortName || entry.name));
    if (!got) return null;
    values = { ...values, ...got };
  }
  if (points.length === confirm.length) return values;
  return new Promise((resolve) => {
    setDialog({ title: "Confirm Inputs", inputConfig: confirm, inputs: values, timeZone, resolve });
  });
}

/** "Reset points…": every time and price input of the study given again on the chart; the changed inputs, or null. */
export async function resetStudyPoints(target: PointTarget, entry: IndicatorRegistryEntry): Promise<Record<string, number> | null> {
  const points = pointInputsOf(entry);
  if (!points.length || !canPickOn(target)) return null;
  return askPoints(target, pointSteps(points, configOf(entry), entry.shortName || entry.name));
}
