/*
 * Session specification of a symbol: when it trades, in exchange-local time.
 *
 * The data provider describes each symbol's sessions with spec strings (the
 * common datafeed format), read here into a schedule that answers "is this
 * time inside a session", "which trading day does this bar belong to" and
 * "when is the next open / close" in UNIX seconds.
 *
 * Spec grammar (exchange-local wall time):
 *   • "24x7"                 always open, one session per calendar day.
 *   • "0930-1600"            one interval, Monday to Friday (the default days).
 *   • "0930-1600:23456"      explicit days, 1 = Sunday … 7 = Saturday.
 *   • "0900-1130,1230-1530"  several intervals in one trading day.
 *   • "1700-1600"            an end at or before the start opens on the
 *                            previous calendar day (overnight): the session
 *                            belongs to the day where it ENDS.
 *   • "a:23456|b:7"          sections with their own days ("|").
 *   • "2;spec"               first day of the week (read, not used here).
 *   • "specA#20251201/specB" history: specA for trading days before
 *                            01/12/2025, specB from that day on.
 *   • Markers inside an interval: "F<n>" on a bound moves it n days back;
 *     "E…" adds a data-extension interval, "A…" a bar offset (both ignored:
 *     the main interval is the session); "U" / "S" join intervals that build
 *     one bar day (each part is kept as its own interval).
 * Holidays: "YYYYMMDD,YYYYMMDD,…" (no session that day).
 * Corrections: "spec:YYYYMMDD,…;dayoff:YYYYMMDD,…" (a different session, or
 * none, on the listed days; they win over the holiday list).
 */
import { localDay, localToUtc } from "./zone";

/** A session interval in UNIX seconds, [start, end). */
export type SessionInterval = { day: number; start: number; end: number };

/** Interval in minutes relative to the trading day's local midnight (start
 *  may be negative: opened on an earlier calendar day). */
type MinuteRange = { from: number; to: number };

/** Weekday schedule: index 1..7 (1 = Sunday) → intervals of that trading day. */
type WeekSchedule = Array<MinuteRange[] | undefined>;

type HistoryEntry = { until: number | null; week: WeekSchedule };

const MINUTES_PER_DAY = 1440;
const DEFAULT_DAYS = [2, 3, 4, 5, 6]; // Monday … Friday
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** Weekday of a local day number, 1 = Sunday … 7 = Saturday (01/01/1970 was
 *  a Thursday). */
export function weekdayOf(day: number): number {
  return ((((day + 4) % 7) + 7) % 7) + 1;
}

/** Local day number of a "YYYYMMDD" date. */
function parseDate(s: string): number {
  if (!/^\d{8}$/.test(s)) throw new Error(`bad session date: ${s}`);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 86400000;
}

/** "HHMM" (optionally "HHMMF<n>") → minutes and days moved back. */
function parseBound(s: string): { min: number; daysBack: number } {
  let daysBack = 0;
  const f = s.indexOf("F");
  if (f >= 0) {
    daysBack = f + 1 < s.length ? parseInt(s.slice(f + 1), 10) : 1;
    s = s.slice(0, f);
  }
  if (!/^\d{4}$/.test(s)) throw new Error(`bad session time: ${s}`);
  const v = parseInt(s, 10);
  return { min: Math.trunc(v / 100) * 60 + (v % 100), daysBack };
}

/** One "HHMM-HHMM" interval (markers stripped) → minute range. */
function parseInterval(s: string): MinuteRange {
  const main = s.split("E")[0].split("A")[0];
  const [a, b, extra] = main.split("-");
  if (a === undefined || b === undefined || extra !== undefined) throw new Error(`bad session: ${s}`);
  const start = parseBound(a);
  const end = parseBound(b);
  const to = end.min === 0 ? MINUTES_PER_DAY : end.min;
  let startBack = start.daysBack;
  if (startBack === end.daysBack && to <= start.min) startBack += 1;
  return { from: start.min - startBack * MINUTES_PER_DAY, to: to - end.daysBack * MINUTES_PER_DAY };
}

/** Intervals of one day's section ("0900-1130,1230-1530", "…U…"). */
function parseDayIntervals(s: string): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const part of s.split(",")) {
    if (!part) continue;
    for (const piece of part.split(/[US]/)) if (piece) out.push(parseInterval(piece));
  }
  return out.sort((x, y) => x.from - y.from);
}

function parseWeek(spec: string): WeekSchedule {
  const semi = spec.split(";");
  if (semi.length === 2) spec = semi[0].includes("-") ? semi[0] : semi[1];
  const week: WeekSchedule = new Array(8);
  if (spec.toLowerCase() === "24x7") {
    for (const d of ALL_DAYS) week[d] = [{ from: 0, to: MINUTES_PER_DAY }];
    return week;
  }
  const byDay = new Map<number, string>();
  for (const section of spec.split("|")) {
    const [ranges, days] = section.split(":").filter(Boolean);
    if (ranges === undefined) continue;
    const explicit = days !== undefined;
    const list = explicit ? [...days].map((c) => c.charCodeAt(0) - 48) : DEFAULT_DAYS;
    for (const d of list) {
      if (d < 1 || d > 7) throw new Error(`bad session days: ${section}`);
      // An explicit day list wins over the default section.
      if (explicit || !byDay.has(d)) byDay.set(d, ranges);
    }
  }
  for (const [d, ranges] of byDay) week[d] = parseDayIntervals(ranges);
  return week;
}

/** A parsed session schedule in one time zone. Day intervals are cached, so
 *  per-bar calls cost a few Map lookups. */
export class SessionSpec {
  readonly timeZone: string;
  /** Open every minute of every day (24x7). */
  readonly always: boolean;
  private readonly _history: HistoryEntry[];
  private readonly _overrides = new Map<number, MinuteRange[]>();
  private readonly _cache = new Map<number, SessionInterval[]>();

  constructor(timeZone: string, spec: string, holidays = "", corrections = "") {
    this.timeZone = timeZone;
    this.always = spec.trim().toLowerCase() === "24x7" && !holidays && !corrections;
    const entries = spec.trim().split("/");
    this._history = entries.map((e, i) => {
      const [body, until] = e.split("#");
      const last = i === entries.length - 1;
      if (last === (until !== undefined)) throw new Error(`bad session history entry: ${e}`);
      return { until: until === undefined ? null : parseDate(until), week: parseWeek(body) };
    });
    for (const h of holidays.split(",")) if (h) this._overrides.set(parseDate(h), []);
    for (const section of corrections.split(";")) {
      if (!section) continue;
      const [ranges, dates] = section.split(":");
      if (dates === undefined) throw new Error(`bad session correction: ${section}`);
      const value = ranges === "dayoff" ? [] : parseDayIntervals(ranges);
      for (const d of dates.split(",")) if (d) this._overrides.set(parseDate(d), value);
    }
  }

  /** Session intervals of trading day `day` (local day number), ascending;
   *  empty when the market does not trade that day. */
  dayIntervals(day: number): SessionInterval[] {
    let out = this._cache.get(day);
    if (out) return out;
    let ranges = this._overrides.get(day);
    if (ranges === undefined) {
      const entry = this._history.find((h) => h.until === null || day < h.until)!;
      ranges = entry.week[weekdayOf(day)] ?? [];
    }
    out = ranges.map((r) => ({
      day,
      start: localToUtc(this.timeZone, day, r.from),
      end: localToUtc(this.timeZone, day, r.to),
    }));
    this._cache.set(day, out);
    return out;
  }

  /** The interval containing `sec`, or null outside every session. */
  at(sec: number): SessionInterval | null {
    const d = localDay(this.timeZone, sec);
    // A trading day's intervals lie within [day - 2, day + 1): look at the
    // calendar day and the two days after (overnight sessions).
    for (let day = d; day <= d + 2; day++) {
      for (const iv of this.dayIntervals(day)) if (sec >= iv.start && sec < iv.end) return iv;
    }
    return null;
  }

  contains(sec: number): boolean {
    return this.at(sec) !== null;
  }

  /** The interval containing `sec`, else the next one to open (searched up to
   *  `maxDays` ahead), or null. */
  currentOrNext(sec: number, maxDays = 40): SessionInterval | null {
    const d = localDay(this.timeZone, sec);
    for (let day = d; day <= d + maxDays; day++) {
      for (const iv of this.dayIntervals(day)) if (iv.end > sec) return iv;
    }
    return null;
  }

  /** The last interval that closed at or before `sec` (searched up to
   *  `maxDays` back), or null. */
  previous(sec: number, maxDays = 40): SessionInterval | null {
    const d = localDay(this.timeZone, sec);
    for (let day = d + 2; day >= d - maxDays; day--) {
      const ivs = this.dayIntervals(day);
      for (let i = ivs.length - 1; i >= 0; i--) if (ivs[i].end <= sec) return ivs[i];
    }
    return null;
  }

  /** The interval containing `sec`, else the last one that closed before it. */
  currentOrPrevious(sec: number, maxDays = 40): SessionInterval | null {
    return this.at(sec) ?? this.previous(sec, maxDays);
  }

  /** Trading day of `sec`: the day of the session containing it, else of the
   *  next session. Falls back to the local calendar day. */
  tradingDay(sec: number): number {
    return this.currentOrNext(sec)?.day ?? localDay(this.timeZone, sec);
  }

  /** First open and last close of trading day `day`, or null when closed. */
  dayBounds(day: number): { start: number; end: number } | null {
    const ivs = this.dayIntervals(day);
    if (ivs.length === 0) return null;
    return { start: ivs[0].start, end: ivs[ivs.length - 1].end };
  }

  /** True when trading day `day` has a session. */
  isTradingDay(day: number): boolean {
    return this.dayIntervals(day).length > 0;
  }
}
