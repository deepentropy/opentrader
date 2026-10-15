/*
 * "Visibility on intervals" submenu of a source (study, compared symbol):
 * the four quick settings of its Visibility tab, built from the chart's
 * current interval.
 *
 *   All intervals              every unit on, full ranges (the defaults);
 *   Current interval only      only the current interval's unit, from = to =
 *                              the interval;
 *   Current interval and above the current unit from the interval up, every
 *                              larger unit (and Ranges) on;
 *   Current interval and below the current unit up to the interval, every
 *                              smaller unit (and Ticks) on.
 *
 * Units in order: ticks, seconds, minutes, hours, days, weeks, months,
 * ranges; a 60-second multiple counts as minutes and a 60-minute multiple as
 * hours. "And above" on ticks and "and below" on ranges are all intervals.
 */
import { DEFAULT_VISIBILITY, type IntervalVisibility, type UnitVisibility } from "lightweight-charts-drawing/core/types";

export type IntervalsVisibilityMode = "all" | "current" | "currentAndAbove" | "currentAndBelow";

type UnitKey = "ticks" | "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "ranges";
const UNITS: UnitKey[] = ["ticks", "seconds", "minutes", "hours", "days", "weeks", "months", "ranges"];

/** Unit and value of an interval id ("1T", "10S", "5", "60", "1D", "1W",
 *  "1M", "100R"); null for an unknown form. Minute ids of an hour or more
 *  read as hours (rounded like the visibility check), seconds of a minute or
 *  more as minutes. */
export function intervalUnit(interval: string): { unit: UnitKey; n: number } | null {
  const m = /^(\d+)([A-Z]+)?$/.exec(interval.trim().toUpperCase());
  if (!m) return null;
  const n = Math.max(1, parseInt(m[1], 10));
  switch (m[2]) {
    case "T": return { unit: "ticks", n };
    case "R": return { unit: "ranges", n };
    case "S": return n < 60 ? { unit: "seconds", n } : minutes(Math.floor(n / 60));
    case "D": return { unit: "days", n };
    case "W": return { unit: "weeks", n };
    case "M": return { unit: "months", n };
    case undefined: return minutes(n);
    default: return null;
  }
}

function minutes(n: number): { unit: UnitKey; n: number } {
  if (n < 60) return { unit: "minutes", n };
  return { unit: "hours", n: n % 60 === 0 ? n / 60 : Math.round(n / 60) };
}

const clone = (v: IntervalVisibility): IntervalVisibility => JSON.parse(JSON.stringify(v)) as IntervalVisibility;

/** The Visibility matrix of `mode` on the chart interval `interval`. */
export function visibilityForMode(interval: string, mode: IntervalsVisibilityMode): IntervalVisibility {
  const cur = intervalUnit(interval);
  if (!cur || mode === "all" || (cur.unit === "ticks" && mode === "currentAndAbove") || (cur.unit === "ranges" && mode === "currentAndBelow")) {
    return clone(DEFAULT_VISIBILITY);
  }
  const out = clone(DEFAULT_VISIBILITY);
  out.ticks = false;
  out.ranges = false;
  for (const k of UNITS) if (k !== "ticks" && k !== "ranges") (out[k] as UnitVisibility).on = false;
  /** Unit `k` on, with its range (an absent bound keeps the full range). */
  const mark = (k: UnitKey, from?: number, to?: number) => {
    if (k === "ticks" || k === "ranges") { out[k] = true; return; }
    const u = out[k] as UnitVisibility;
    u.on = true;
    if (from !== undefined) u.from = from;
    if (to !== undefined) u.to = to;
  };
  let passed = false;
  for (const k of UNITS) {
    if (k === cur.unit) {
      passed = true;
      if (mode === "current") mark(k, cur.n, cur.n);
      else if (mode === "currentAndAbove") mark(k, cur.n, undefined);
      else mark(k, undefined, cur.n);
    } else if ((!passed && mode === "currentAndBelow") || (passed && mode === "currentAndAbove")) {
      mark(k);
    }
  }
  return out;
}
