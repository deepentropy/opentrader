/*
 * Timeframe inputs of scripts (`input.timeframe`): the choices of their settings drop-down and the names shown.
 *
 * The reference list: "Chart" (the empty value, the chart's interval), then the standard intervals, the seconds and
 * the user's custom intervals in menu order. A script's `options` replace the list (the ones that are intervals, in
 * the script's order).
 */
import { parseInterval } from "../../data/interval";
import { compareIntervals, longIntervalLabel } from "./interval-favorites";
import { customIntervals } from "./custom-intervals";

const STANDARD = ["1", "3", "5", "15", "30", "45", "60", "120", "180", "240", "1D", "1W", "1M", "3M", "6M", "12M"];
const SECONDS = ["1S", "5S", "10S", "15S", "30S", "45S"];

/** A timeframe in the interval menu's form ("D" → "1D", "1H" → "60", "5s" → "5S"); "" (the chart) stays ""; a value
 *  that is not an interval is kept as it is. */
export function timeframeValue(v: string): string {
  if (v.trim() === "") return "";
  const iv = parseInterval(v);
  if (!iv) return v;
  const n = iv.count;
  switch (iv.unit) {
    case "second": return `${n}S`;
    case "minute": return String(n);
    case "hour": return String(n * 60);
    case "day": return `${n}D`;
    case "week": return `${n}W`;
    case "month": return `${n}M`;
  }
}

/** The drop-down's values: the script's `options` when it has some, else "Chart" and the intervals. Reactive (the
 *  custom intervals). */
export function timeframeChoices(options?: string[]): string[] {
  if (options?.length) {
    return [...new Set(options.filter((o) => o.trim() === "" || parseInterval(o)).map(timeframeValue))];
  }
  return ["", ...[...new Set([...STANDARD, ...SECONDS, ...customIntervals()])].sort(compareIntervals)];
}

/** The name of a choice: "Chart" for the chart's interval, else the interval's long name ("1 hour", "5 seconds"). */
export function timeframeLabel(v: string): string {
  return v === "" ? "Chart" : longIntervalLabel(v);
}
