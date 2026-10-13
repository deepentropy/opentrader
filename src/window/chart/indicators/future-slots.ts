/*
 * Bar slots after the last bar on the symbol's trading calendar, for the times a study drawing gives after the last
 * bar (xloc.bar_time). The reference app's time scale continues after the last bar with the bars the symbol would
 * open: the next bars of the session, then the next sessions (nights, weekends and holidays skipped). A time is drawn
 * on the future bar that holds it: the count of future bars that open after the last bar and at or before the time
 * (its Pivot Points Standard ends the current period there: on a daily chart a month after 01/10/2026 is 21 bars
 * after 01/10, on a 5 minute chart the next day's open is 78 bars after the day's open).
 */
import type { FutureSlots } from "lightweight-charts-indicators/render";
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
