/*
 * Time-zone offsets without an Intl call per bar. Formatting a time with Intl
 * costs ~20µs, which made 100k-bar scans spend seconds on dates. Zone offsets
 * only change on quarter-hour UTC instants (every real DST rule and fractional
 * zone lands on :00/:15/:30/:45), so Intl is asked once per 15-minute UTC slot
 * and each later lookup is one Map read. One finder per zone for the app.
 */

const SLOT_SEC = 900;

const finders = new Map<string, (sec: number) => number>();

/** Returns `offsetFor(sec)`: the local-minus-UTC offset (seconds) of
 *  UNIX-seconds `sec` in `timeZone`. Shared per zone, so its slot cache is
 *  reused by every caller. */
export function zoneOffsetFinder(timeZone: string): (sec: number) => number {
  let f = finders.get(timeZone);
  if (f) return f;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offsets = new Map<number, number>();
  f = (sec: number): number => {
    const slot = Math.floor(sec / SLOT_SEC);
    let off = offsets.get(slot);
    if (off === undefined) {
      const utc = slot * SLOT_SEC;
      const parts = fmt.formatToParts(new Date(utc * 1000));
      const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) / 1000;
      off = local - utc;
      offsets.set(slot, off);
    }
    return off;
  };
  finders.set(timeZone, f);
  return f;
}

/** Local day number (days since 1970-01-01) of UNIX-seconds `sec`. */
export function localDay(timeZone: string, sec: number): number {
  return Math.floor((sec + zoneOffsetFinder(timeZone)(sec)) / 86400);
}

/** UNIX seconds of local wall time `minutes` after the start of local day
 *  `day`. A time skipped by a DST jump resolves one offset step later. */
export function localToUtc(timeZone: string, day: number, minutes: number): number {
  const offsetFor = zoneOffsetFinder(timeZone);
  const wall = day * 86400 + minutes * 60;
  const guess = wall - offsetFor(wall);
  return wall - offsetFor(guess);
}
