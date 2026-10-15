/*
 * Bar slots after the last bar on the symbol's trading calendar, for the times a study drawing gives after the last
 * bar (xloc.bar_time). The reference app's time scale continues after the last bar with the bars the symbol would
 * open: the next bars of the session, then the next sessions (nights, weekends and holidays skipped). A time is drawn
 * on the future bar that holds it: the count of future bars that open after the last bar and at or before the time
 * (its Pivot Points Standard ends the current period there: on a daily chart a month after 01/10/2026 is 21 bars
 * after 01/10, on a 5 minute chart the next day's open is 78 bars after the day's open).
 * The drawings use the same future bars both ways (`sessionFutureAxis`): a point placed after the last bar takes the
 * open time of its future bar, a time is drawn on the future bar that holds it.
 */
import type { FutureSlots } from "lightweight-charts-indicators/render";
import type { FutureAxis } from "lightweight-charts-drawing/runtime/coords";
import { localDay, localToUtc, type SessionSpec } from "../../../data/session";

/** Days scanned at most after the last bar (a decade of pivots on a daily chart). */
const MAX_DAYS = 3700;

type Interval = { unit: "s" | "D" | "W" | "M"; n: number };

/** Chart interval ("5", "60", "10S", "1D", "D", "1W", "3M"), null when not a time interval. */
function parseInterval(interval: string): Interval | null {
  const m = /^(\d*)([SDWM]?)$/i.exec(interval.trim());
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  if (!(n > 0)) return null;
  const u = m[2].toUpperCase();
  if (u === "") return { unit: "s", n: n * 60 };
  if (u === "S") return { unit: "s", n };
  return { unit: u as "D" | "W" | "M", n };
}

/** Week number of a local day (weeks from Monday; day 0 = Thursday 01/01/1970). */
const weekOf = (day: number) => Math.floor((day + 3) / 7);
/** Month number of a local day. */
function monthOf(day: number): number {
  const d = new Date(day * 86400000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * Slot counter of a chart: bars of `interval` in the sessions of `spec`, times in UNIX seconds (the chart's bar times:
 * intraday bars at their open, daily and longer bars at the local midnight of their first trading day). null when the
 * interval is not a time interval (the renderer then counts calendar time).
 */
export function sessionFutureSlots(interval: string, spec: SessionSpec): FutureSlots | null {
  const iv = parseInterval(interval);
  if (!iv) return null;
  const tz = spec.timeZone;
  if (iv.unit === "s") {
    const step = iv.n;
    return (time, lastTime) => {
      let k = 0;
      const first = localDay(tz, lastTime) - 2;
      const lastDay = localDay(tz, time) + 2;
      for (let day = first; day <= lastDay && day <= first + MAX_DAYS; day++) {
        for (const s of spec.dayIntervals(day)) {
          if (s.end <= lastTime || s.start > time) continue;
          // bars of the last bar's session follow the last bar; a later session starts its bars at its open
          const from = s.start <= lastTime ? lastTime + step : s.start;
          const to = Math.min(time, s.end - 1);
          const base = s.start <= lastTime ? lastTime : s.start;
          if (to >= from) k += Math.floor((to - base) / step) - Math.ceil((from - base) / step) + 1;
        }
      }
      return k;
    };
  }
  // daily and longer: one bar per n trading days, weeks or months
  const bucket = iv.unit === "D" ? null : iv.unit === "W" ? weekOf : monthOf;
  return (time, lastTime) => {
    const lastDay = localDay(tz, lastTime);
    const lastKey = bucket ? Math.floor(bucket(lastDay) / iv.n) : 0;
    let key = lastKey;
    let days = 0;
    let k = 0;
    for (let day = lastDay + 1; day <= lastDay + MAX_DAYS; day++) {
      if (localToUtc(tz, day, 0) > time) break;
      if (!spec.isTradingDay(day)) continue;
      days++;
      const b = bucket ? Math.floor(bucket(day) / iv.n) : key;
      if (b !== key) {
        key = b;
        k++;
      }
    }
    return bucket ? k : Math.floor(days / iv.n);
  };
}

/**
 * Open time of the k-th future bar (k >= 1) after the bar opening at `lastTime`, the inverse of the slot counter:
 * the next bars of the session, then each later session's bars from its open; daily and longer bars at the local
 * midnight of their first trading day. null past the scanned range or when the interval is not a time interval.
 */
export function sessionFutureTime(interval: string, spec: SessionSpec): ((k: number, lastTime: number) => number | null) | null {
  const iv = parseInterval(interval);
  if (!iv) return null;
  const tz = spec.timeZone;
  if (iv.unit === "s") {
    const step = iv.n;
    return (k, lastTime) => {
      if (!(k >= 1)) return null;
      let left = k;
      const first = localDay(tz, lastTime) - 2;
      for (let day = first; day <= first + MAX_DAYS; day++) {
        for (const s of spec.dayIntervals(day)) {
          if (s.end <= lastTime) continue;
          const from = s.start <= lastTime ? lastTime + step : s.start;
          const base = s.start <= lastTime ? lastTime : s.start;
          if (from > s.end - 1) continue;
          // bars opening in [from, s.end)
          const n = Math.floor((s.end - 1 - base) / step) - Math.ceil((from - base) / step) + 1;
          if (left <= n) return base + (Math.ceil((from - base) / step) + left - 1) * step;
          left -= n;
        }
      }
      return null;
    };
  }
  const bucket = iv.unit === "D" ? null : iv.unit === "W" ? weekOf : monthOf;
  return (k, lastTime) => {
    if (!(k >= 1)) return null;
    const lastDay = localDay(tz, lastTime);
    let key = bucket ? Math.floor(bucket(lastDay) / iv.n) : 0;
    let days = 0;
    let n = 0;
    for (let day = lastDay + 1; day <= lastDay + MAX_DAYS; day++) {
      if (!spec.isTradingDay(day)) continue;
      days++;
      if (bucket) {
        const b = Math.floor(bucket(day) / iv.n);
        if (b === key) continue;
        key = b;
        n++;
      } else if (days % iv.n === 0) n++;
      else continue;
      if (n === k) return localToUtc(tz, day, 0);
    }
    return null;
  };
}

/** Days scanned at most before the first loaded bar (40 years of daily bars). */
const MAX_PAST_DAYS = 15000;

/** Remembers a two-argument count (the drawings ask for the same points on every frame). */
function memo(f: (a: number, b: number) => number): (a: number, b: number) => number {
  const cache = new Map<string, number>();
  return (a, b) => {
    const key = `${a}|${b}`;
    let v = cache.get(key);
    if (v === undefined) {
      if (cache.size > 2000) cache.clear();
      v = f(a, b);
      cache.set(key, v);
    }
    return v;
  };
}

/**
 * Where a time sits when the drawings look for the bar that holds it (`FutureAxis.timeKey`). The reference opens a
 * daily bar at the regular session open (a point drawn on a daily chart is stored at 09:30 New York for a US stock), so
 * the local midnight of a trading day (the chart's daily bar time) stands for that open; any other time for itself.
 * Measured on the reference: a 14/10 05:00 pre-market point is drawn on the 13/10 daily bar, a point drawn on the
 * 12/10 daily bar on the 12/10 09:30 bar of an intraday chart (regular or extended hours).
 */
export function dayOpenKey(regular: SessionSpec): (time: number) => number {
  const tz = regular.timeZone;
  return (time) => {
    const day = localDay(tz, time);
    if (localToUtc(tz, day, 0) !== time) return time;
    return regular.dayBounds(day)?.start ?? time;
  };
}

/**
 * Bars of a chart around its loaded bars for the drawings: after the last bar both ways (time -> bar, bar -> open
 * time), before the first bar the same on the bars the symbol had, and the time key of the bar that holds a time (the
 * last bar opening at or before it, a gap between sessions included: measured on the reference, a 05:00 or 18:00 point
 * of an extended-hours chart is drawn on the 15:55 bar of a regular-hours 5 minute chart). null when the interval is
 * not a time interval (the drawings then count calendar time). `regular` = the symbol's regular session (daily bars
 * open at its open), `spec` = the chart's session.
 */
export function sessionFutureAxis(interval: string, spec: SessionSpec, regular: SessionSpec = spec): FutureAxis | null {
  const iv = parseInterval(interval);
  const slots = sessionFutureSlots(interval, spec);
  const time = sessionFutureTime(interval, spec);
  if (!iv || !slots || !time) return null;
  const tz = spec.timeZone;
  const timeKey = dayOpenKey(regular);
  if (iv.unit === "s") {
    const step = iv.n;
    /** Bars opening strictly after `lo` and before `hi`. */
    const opensBetween = (lo: number, hi: number) => {
      let n = 0;
      const last = localDay(tz, hi) + 1;
      for (let day = Math.max(localDay(tz, lo) - 1, last - MAX_PAST_DAYS); day <= last; day++) {
        for (const s of spec.dayIntervals(day)) {
          const top = Math.min(s.end, hi);
          if (top <= s.start || s.end <= lo) continue;
          const jMin = lo < s.start ? 0 : Math.floor((lo - s.start) / step) + 1;
          const jMax = Math.ceil((top - s.start) / step) - 1;
          if (jMax >= jMin) n += jMax - jMin + 1;
        }
      }
      return n;
    };
    return {
      slots: (t, last) => slots(timeKey(t), last),
      time,
      // the bar that holds the time, then every bar opening after it and before the first bar
      pastSlots: memo((t, first) => 1 + opensBetween(timeKey(t), first)),
      pastTime: (k, first) => {
        if (!(k >= 1)) return null;
        let left = k;
        const d0 = localDay(tz, first) + 1;
        for (let day = d0; day >= d0 - MAX_PAST_DAYS; day--) {
          const ivs = spec.dayIntervals(day);
          for (let i = ivs.length - 1; i >= 0; i--) {
            const s = ivs[i];
            const top = Math.min(s.end, first);
            if (top <= s.start) continue;
            const n = Math.ceil((top - s.start) / step); // bars opening in [s.start, top)
            if (left <= n) return s.start + (n - left) * step;
            left -= n;
          }
        }
        return null;
      },
      timeKey,
    };
  }
  // daily and longer: a time is on the daily bar whose regular open is at or before it
  const open = (day: number) => regular.dayBounds(day)?.start ?? localToUtc(tz, day, 0);
  /** Trading day of the daily bar that holds a time. */
  const holderDay = (t: number) => {
    const k = timeKey(t);
    const d0 = localDay(tz, k);
    for (let day = d0; day >= d0 - 30; day--) if (spec.isTradingDay(day) && open(day) <= k) return day;
    return d0;
  };
  const bucket = iv.unit === "D" ? null : iv.unit === "W" ? weekOf : monthOf;
  const keyOf = (day: number) => (bucket ? Math.floor(bucket(day) / iv.n) : day);
  return {
    // future bars count from the trading day of the holding bar (bar times are its local midnight)
    slots: (t, last) => slots(localToUtc(tz, holderDay(t), 0), last),
    time,
    pastSlots: memo((t, first) => {
      const from = holderDay(t);
      const firstDay = localDay(tz, first);
      let key = keyOf(from);
      let days = 0;
      let k = 0;
      for (let day = Math.max(from + 1, firstDay - MAX_PAST_DAYS); day <= firstDay; day++) {
        if (!spec.isTradingDay(day)) continue;
        days++;
        const b = keyOf(day);
        if (bucket && b !== key) {
          key = b;
          k++;
        }
      }
      return bucket ? Math.max(1, k) : Math.max(1, Math.ceil(days / iv.n));
    }),
    pastTime: (k, first) => {
      if (!(k >= 1)) return null;
      const firstDay = localDay(tz, first);
      let key = keyOf(firstDay);
      let changes = 0;
      let days = 0;
      let found: number | null = null;
      for (let day = firstDay - 1; day >= firstDay - MAX_PAST_DAYS; day--) {
        if (!spec.isTradingDay(day)) continue;
        if (!bucket) {
          days++;
          if (days === k * iv.n) return localToUtc(tz, day, 0);
          continue;
        }
        const b = keyOf(day);
        if (b !== key) {
          key = b;
          changes++;
          if (changes > k) break;
        }
        if (changes === k) found = day;
      }
      return found == null ? null : localToUtc(tz, found, 0);
    },
    timeKey,
  };
}
