/*
 * Fast local-calendar-day keys for per-bar day-rollover scans (session
 * breaks, previous-day close). Formatting every bar with Intl costs ~20µs a
 * call, which made a 100k-bar intraday prepend spend seconds on day strings.
 * Zone offsets only change on quarter-hour UTC instants (every real DST rule
 * and fractional zone lands on :00/:15/:30/:45), so Intl is asked once per
 * 15-minute UTC slot and each bar then costs one Map lookup + arithmetic.
 */

const SLOT_SEC = 900;

/** Returns `dayKey(sec)`: the day number (days since 1970-01-01) of the local
 *  calendar date of UNIX-seconds `sec` in `timeZone`. Two times share a key iff
 *  they fall on the same local date, so it is a drop-in for comparing
 *  `Intl.DateTimeFormat` date strings. */
/** Local-minus-UTC offset (seconds) of UNIX-seconds `sec` in `timeZone`,
 *  cached per 15-minute UTC slot. */
function offsetFinder(timeZone: string): (sec: number) => number {
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
  return (sec: number): number => {
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
}

/** Returns `dayKey(sec)`: the day number (days since 1970-01-01) of the local
 *  calendar date of UNIX-seconds `sec` in `timeZone`. Two times share a key iff
 *  they fall on the same local date, so it is a drop-in for comparing
 *  `Intl.DateTimeFormat` date strings. */
export function dayKeyer(timeZone: string): (sec: number) => number {
  const offsetFor = offsetFinder(timeZone);
  return (sec: number) => Math.floor((sec + offsetFor(sec)) / 86400);
}

/** Returns `minuteOfDay(sec)`: minutes since local midnight in `timeZone`. */
export function minuteOfDayer(timeZone: string): (sec: number) => number {
  const offsetFor = offsetFinder(timeZone);
  return (sec: number) => {
    const local = sec + offsetFor(sec);
    return Math.floor((((local % 86400) + 86400) % 86400) / 60);
  };
}
