/*
 * Per-study display options: the study properties behind the indicator
 * Settings "Style" sections and "Visibility" tab:
 *   Output values : Precision (Default, 0..8), Labels on price scale,
 *                   Values in status line
 *   Input values  : Inputs in status line
 *   Visibility    : intervalsVisibilities (same matrix as drawings; a study
 *                   outside its intervals is not drawn and its status-line row
 *                   shows as hidden).
 * Stored per study with its inputs / styles (PaneIndicatorSettings.options).
 */
import { DEFAULT_VISIBILITY, type IntervalVisibility, type UnitVisibility } from "lightweight-charts-drawing/core/types";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

export type IndicatorOptions = {
  /** "Default" or "0".."8" decimals (precision select). */
  precision: string;
  labelsOnScale: boolean;
  valuesInStatusLine: boolean;
  inputsInStatusLine: boolean;
  visibility: IntervalVisibility;
  /** An overlay study moved to its own pane (Object tree "Move to"). */
  ownPane: boolean;
};

/** Precision select options. */
export const PRECISION_OPTIONS = ["Default", "0", "1", "2", "3", "4", "5", "6", "7", "8"];

const cloneVisibility = (v: IntervalVisibility): IntervalVisibility => ({
  ticks: v.ticks,
  seconds: { ...v.seconds },
  minutes: { ...v.minutes },
  hours: { ...v.hours },
  days: { ...v.days },
  weeks: { ...v.weeks },
  months: { ...v.months },
  ranges: v.ranges,
});

/** Defaults: every option on, precision Default, visible on all intervals. */
export function defaultIndicatorOptions(): IndicatorOptions {
  return {
    precision: "Default",
    labelsOnScale: true,
    valuesInStatusLine: true,
    inputsInStatusLine: true,
    visibility: cloneVisibility(DEFAULT_VISIBILITY),
    ownPane: false,
  };
}

export function cloneIndicatorOptions(o: IndicatorOptions): IndicatorOptions {
  return { ...o, visibility: cloneVisibility(o.visibility) };
}

/** Stored (possibly partial / older) options merged over the defaults. */
export function reviveIndicatorOptions(raw: unknown): IndicatorOptions {
  const d = defaultIndicatorOptions();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<Record<keyof IndicatorOptions, unknown>>;
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const unit = (v: unknown, def: UnitVisibility): UnitVisibility => {
    if (!v || typeof v !== "object") return def;
    const u = v as Partial<UnitVisibility>;
    return {
      on: bool(u.on, def.on),
      from: typeof u.from === "number" ? u.from : def.from,
      to: typeof u.to === "number" ? u.to : def.to,
    };
  };
  const vis = (r.visibility && typeof r.visibility === "object" ? r.visibility : {}) as Partial<IntervalVisibility>;
  return {
    precision: typeof r.precision === "string" && PRECISION_OPTIONS.includes(r.precision) ? r.precision : d.precision,
    labelsOnScale: bool(r.labelsOnScale, d.labelsOnScale),
    valuesInStatusLine: bool(r.valuesInStatusLine, d.valuesInStatusLine),
    inputsInStatusLine: bool(r.inputsInStatusLine, d.inputsInStatusLine),
    ownPane: bool(r.ownPane, d.ownPane),
    visibility: {
      ticks: bool(vis.ticks, d.visibility.ticks),
      seconds: unit(vis.seconds, d.visibility.seconds),
      minutes: unit(vis.minutes, d.visibility.minutes),
      hours: unit(vis.hours, d.visibility.hours),
      days: unit(vis.days, d.visibility.days),
      weeks: unit(vis.weeks, d.visibility.weeks),
      months: unit(vis.months, d.visibility.months),
      ranges: bool(vis.ranges, d.visibility.ranges),
    },
  };
}

/** Decimals for "0".."8", null for "Default". */
export function precisionDigits(p: string): number | null {
  const n = Number(p);
  return p !== "Default" && Number.isInteger(n) && n >= 0 && n <= 8 ? n : null;
}

// One formatter: the status line is rebuilt on every crosshair move.
const inputNumberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 });

/** The input values shown after a study title in the status line: every
 *  input except bool / colour (bool, color, time and text_area inputs are
 *  hidden by default), numbers formatted, others as text,
 *  space-separated (titleInParts). */
export function statusLineInputs(entry: IndicatorRegistryEntry, inputs: Record<string, unknown>, separator = " "): string {
  const out: string[] = [];
  for (const cfg of entry.inputConfig ?? []) {
    if (cfg.type === "bool" || cfg.type === "color") continue;
    const v = inputs[cfg.id];
    if (v === undefined || v === null || v === "") continue;
    out.push(typeof v === "number" ? inputNumberFormat.format(v) : String(v));
  }
  return out.join(separator);
}
