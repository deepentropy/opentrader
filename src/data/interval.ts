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
export function isDailyInterval(iv: Interval): boolean {
  return iv.unit === "day" || iv.unit === "week" || iv.unit === "month";
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
