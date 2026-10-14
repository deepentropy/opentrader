/*
 * Conditions a study declares for alerts (operator `alert_condition`): the
 * alertcondition() calls of a script (user scripts, the candlestick
 * patterns) and the extended levels of the TPO studies.
 *
 * - A script's conditions come with its entry (`alertConditions`: id, title,
 *   default message); its result gives, per condition, the times of the bars
 *   on which it is true (`alerts[].times`).
 * - A TPO study offers "Price crossed extended POC / VAH / VAL / poor high /
 *   poor low / singleprint" for the levels set to Extend only (a study with
 *   no extended level offers none). A condition is true on the bar that
 *   reaches an extended level of an earlier profile: the bar where its
 *   extension stops on the chart.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { StudyConditionRef } from "./alert-store";
import { isTpoEntry } from "../window/chart/profiles/tpo";
import type { TpoDraw, TpoProfile } from "../window/chart/profiles/tpo-engine";

/** Message of a condition that declares none. */
export const ALERT_CONDITION_DEFAULT_TEXT = "Alert Fired!";
/** Title of a condition that declares none. */
export const ALERT_CONDITION_DEFAULT_TITLE = "Alert";

/** TPO conditions: id, title, message, the input that extends the level and how to read the level's stops. */
const TPO_CONDITIONS: { id: string; title: string; message: string; input: string; stops: (p: TpoProfile) => (number | null | undefined)[] }[] = [
  { id: "cross_extended_POC", title: "Price crossed extended POC", message: "{{ticker}} Crossing TPO POC", input: "extendPOC", stops: (p) => [p.extend.poc] },
  { id: "cross_extended_VAH", title: "Price crossed extended VAH", message: "{{ticker}} Crossing TPO VAH", input: "extendTpoVah", stops: (p) => [p.extend.vah] },
  { id: "cross_extended_VAL", title: "Price crossed extended VAL", message: "{{ticker}} Crossing TPO VAL", input: "extendTpoVal", stops: (p) => [p.extend.val] },
  { id: "cross_extended_poor_high", title: "Price crossed extended poor high", message: "{{ticker}} Crossing TPO poor high", input: "extendPoorHigh", stops: (p) => [p.extend.poorHigh] },
  { id: "cross_extended_poor_low", title: "Price crossed extended poor low", message: "{{ticker}} Crossing TPO poor low", input: "extendPoorLow", stops: (p) => [p.extend.poorLow] },
  { id: "cross_extended_singleprint", title: "Price crossed extended singleprint", message: "{{ticker}} Crossing TPO singleprint", input: "extendSingleprints", stops: (p) => p.singleExtend },
];

type WithConditions = { alertConditions?: { id: string; title?: string; message?: string }[] };

/** The conditions `entry` offers with `inputs` (the study's inputs on the chart, else its defaults). */
export function studyConditions(entry: IndicatorRegistryEntry | null | undefined, inputs?: Record<string, unknown>): StudyConditionRef[] {
  if (!entry) return [];
  if (isTpoEntry(entry)) {
    const values = { ...entry.defaultInputs, ...inputs };
    return TPO_CONDITIONS.filter((c) => values[c.input] === true).map(({ id, title, message }) => ({ id, title, message }));
  }
  return ((entry as WithConditions).alertConditions ?? []).map((c) => ({
    id: c.id,
    title: c.title || ALERT_CONDITION_DEFAULT_TITLE,
    ...(c.message ? { message: c.message } : {}),
  }));
}

/** A script that calls alert(): an alert can watch "Any alert() function call" (listed before its conditions). */
export function hasAlertFunction(entry: IndicatorRegistryEntry | null | undefined): boolean {
  return !!(entry as { hasAlertFunction?: boolean } | null | undefined)?.hasAlertFunction;
}

/** How often an alert() call may trigger the alert. */
export type AlertCallFrequency = "all" | "once_per_bar" | "once_per_bar_close";
/** An alert() call of a script: the time of its bar (as given to the study), its message and frequency. */
export type StudyAlertCall = { time: number; message: string; freq: AlertCallFrequency };

/** The alert() calls in a study's result, in call order; null when the result does not tell (still loading). */
export function alertCallsOf(result: unknown): StudyAlertCall[] | null {
  const r = result as { pending?: boolean; alertCalls?: StudyAlertCall[] } | null;
  if (!r || r.pending) return null;
  return r.alertCalls ?? [];
}

/** Default message of an alert on a condition. */
export function conditionMessage(c: StudyConditionRef | undefined): string {
  return c?.message || ALERT_CONDITION_DEFAULT_TEXT;
}

/**
 * Per bar of `bars` (the bars the study was calculated on), whether condition `id` is true; null when the result
 * does not tell (still loading, no such condition).
 */
export function conditionBars(entry: IndicatorRegistryEntry, result: unknown, id: string, bars: readonly { time: number }[]): boolean[] | null {
  const r = result as { pending?: boolean; tpo?: TpoDraw; alerts?: { id: string; triggered?: boolean; times?: number[] }[] } | null;
  if (!r || r.pending) return null;
  const out = bars.map(() => false);
  if (isTpoEntry(entry)) {
    const c = TPO_CONDITIONS.find((x) => x.id === id);
    if (!c || !r.tpo) return null;
    for (const p of r.tpo.profiles) {
      for (const j of c.stops(p)) if (j != null && j >= 0 && j < out.length) out[j] = true;
    }
    return out;
  }
  const a = r.alerts?.find((x) => x.id === id);
  if (!a) return null;
  if (a.times) {
    const at = new Map(bars.map((b, i) => [b.time, i]));
    for (const t of a.times) {
      const i = at.get(t);
      if (i !== undefined) out[i] = true;
    }
  } else if (a.triggered && out.length) {
    out[out.length - 1] = true;
  }
  return out;
}
