/*
 * Per-study display options — TV study properties behind the indicator
 * Settings "Style" sections and "Visibility" tab (TV 3.4.1, read 26/09/2026):
 *   Output values : Precision (Default, 0..8), Labels on price scale,
 *                   Values in status line
 *   Input values  : Inputs in status line
 *   Visibility    : intervalsVisibilities (same matrix as drawings; a study
 *                   outside its intervals is not drawn and its status-line row
 *                   shows as hidden — TV `isActualInterval`, modules 880101 /
 *                   663945).
 * Stored per study with its inputs / styles (PaneIndicatorSettings.options).
 */
import { DEFAULT_VISIBILITY, type IntervalVisibility, type UnitVisibility } from "lightweight-charts-drawing/tv/types";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

export type IndicatorOptions = {
  /** "Default" or "0".."8" decimals (TV precision select). */
  precision: string;
  labelsOnScale: boolean;
  valuesInStatusLine: boolean;
  inputsInStatusLine: boolean;
  visibility: IntervalVisibility;
};

/** TV Precision select, read from the live dialog. */
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

/** TV defaults: every option on, precision Default, visible on all intervals. */
export function defaultIndicatorOptions(): IndicatorOptions {
  return {
    precision: "Default",
    labelsOnScale: true,
    valuesInStatusLine: true,
    inputsInStatusLine: true,
    visibility: cloneVisibility(DEFAULT_VISIBILITY),
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

/** The input values TV shows after a study title in the status line: every
 *  input except bool / colour (TV hides bool, color, time and text_area
 *  inputs by default, module 514571), numbers formatted, others as text,
 *  space-separated (titleInParts). */
export function statusLineInputs(entry: IndicatorRegistryEntry, inputs: Record<string, unknown>): string {
  const out: string[] = [];
  for (const cfg of entry.inputConfig ?? []) {
    if (cfg.type === "bool" || cfg.type === "color") continue;
    const v = inputs[cfg.id];
    if (v === undefined || v === null || v === "") continue;
    out.push(typeof v === "number" ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 }).format(v) : String(v));
  }
  return out.join(" ");
}
