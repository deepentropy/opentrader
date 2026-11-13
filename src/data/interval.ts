/*
 * Interval ids — the one reader of the app's bar intervals, so every feature
 * agrees on what an id means.
 *
 * An id is an optional count and a unit letter: no letter is minutes ("1",
 * "15", "240"), "S" seconds ("10S"), "H" hours, "D" days, "W" weeks, "M"
 * months. No count means one ("D" = "1D", as scripts write it). Letters read
 * either case except "M" (month) and "m" (minute), which differ.
 */

export type IntervalUnit = "second" | "minute" | "hour" | "day" | "week" | "month";

export type Interval = { count: number; unit: IntervalUnit };

const UNIT_OF_LETTER: Record<string, IntervalUnit> = {
  "": "minute",
  m: "minute",
  s: "second",
  S: "second",
  h: "hour",
  H: "hour",
  d: "day",
  D: "day",
  w: "week",
  W: "week",
  M: "month",
};

/** A month counts 30 days where an interval needs a length (the update
 *  intervals of bar replay, alert bar buckets, chart padding). */
const UNIT_SECONDS: Record<IntervalUnit, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
};

/** The count and unit of `id`; null when it is not an interval (empty, a zero
 *  count, an unknown letter). Spaces around and between are ignored. */
export function parseInterval(id: string): Interval | null {
  const m = /^(\d*)\s*([a-zA-Z]?)$/.exec(id.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  const unit = UNIT_OF_LETTER[m[2]];
  const count = m[1] === "" ? 1 : Number(m[1]);
  return unit && count > 0 ? { count, unit } : null;
}

/** Day, week and month bars: built from daily bars, stamped by trading day. */
export function isDailyInterval(id: string | Interval): boolean {
  const iv = typeof id === "string" ? parseInterval(id) : id;
  return !!iv && (iv.unit === "day" || iv.unit === "week" || iv.unit === "month");
}

/** Bar length of an interval in seconds (a month: 30 days); null when `id` is
 *  not an interval. */
export function intervalSeconds(id: string | Interval): number | null {
  const iv = typeof id === "string" ? parseInterval(id) : id;
  return iv ? iv.count * UNIT_SECONDS[iv.unit] : null;
}

/** Bar length of an interval in milliseconds (a month: 30 days); null when
 *  `id` is not an interval. */
export function intervalMs(id: string | Interval): number | null {
  const sec = intervalSeconds(id);
  return sec === null ? null : sec * 1000;
}

/** Sizes of `unit` among the interval ids a data source serves, as the backend
 *  reads them (src-tauri/src/plugins/data.rs `pick`): minutes "5", seconds
 *  "5S", days only "1D". */
function servedSizes(served: readonly string[], unit: "second" | "minute" | "day"): number[] {
  const re = unit === "second" ? /^(\d+)S$/i : unit === "minute" ? /^(\d+)$/ : /^(1)D$/i;
  return served.flatMap((s) => {
    const m = re.exec(s.trim());
    return m && Number(m[1]) > 0 ? [Number(m[1])] : [];
  });
}

/** Whether a source that serves the interval ids `served` (a data plugin's
 *  `intervals`) has bars on `id`: a served size, a second or minute size built
 *  from a served one of the same unit that divides it, or days, weeks and
 *  months built from served days. */
export function builtFromServed(served: readonly string[], id: string): boolean {
  const iv = parseInterval(id);
  if (!iv) return false;
  if (isDailyInterval(iv)) return servedSizes(served, "day").length > 0;
  const unit = iv.unit === "second" ? "second" : "minute";
  const count = iv.unit === "hour" ? iv.count * 60 : iv.count;
  return servedSizes(served, unit).some((d) => count % d === 0);
}

/** Minute bar sizes among the interval ids a source serves. */
export function servedMinuteSizes(served: readonly string[]): number[] {
  return servedSizes(served, "minute");
}

/** The shortest of the interval ids a source serves (as written), or null when
 *  none is an interval it can serve. */
export function finestServed(served: readonly string[]): string | null {
  let best: string | null = null;
  let bestSec = Infinity;
  for (const s of served) {
    const sec = intervalSeconds(s);
    if (sec !== null && sec < bestSec && builtFromServed(served, s)) {
      best = s.trim();
      bestSec = sec;
    }
  }
  return best;
}
