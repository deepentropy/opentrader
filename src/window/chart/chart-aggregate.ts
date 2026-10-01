/*
 * Client-side daily → multi-day / weekly / monthly aggregation.
 *
 * The Rust backend only serves daily + minute aggregates, so N-day, N-week
 * and N-month candles are built here by bucketing the daily series. OHLC
 * reduce: open = first bar's open, high = max, low = min, close = last bar's
 * close, volume = sum.
 *
 * A daily candle is stamped at local midnight of its trading day in the
 * symbol's exchange time zone, so its date is read in that zone (a zone east
 * of UTC stamps the previous UTC day). Bucket keys are 00:00 UTC of a date,
 * which lightweight-charts renders as a date (no intraday precision).
 *
 * Periods of N > 1 follow the reference app's bar builder: the period index
 * restarts every calendar year and bars group the indexes by N
 * (index - index % N):
 *   • days   → trading-day index from 1 January (the session's weekends and
 *              holidays are not counted); key = the group's first trading day.
 *   • weeks  → weeks start on Monday; index = weeks since the year's first
 *              Monday; the days before it belong to the previous year's last
 *              group; key = the group's first Monday.
 *   • months → month index 0-11; key = the 1st of the group's first month.
 * With N = 1 these are the plain day / week / month buckets.
 */
import type { Candle } from "../../bindings";
import { localDay } from "../../data/session";
import type { SessionSpec } from "../../data/session";

export type AggregateUnit = "week" | "month";

/** N trading days, weeks or months per bar. */
export type AggregatePeriod = { unit: "day" | AggregateUnit; n: number };

/** Bucket-start (UNIX seconds, UTC) for the period containing the daily bar
 *  stamped `sec`, its date read in `timeZone` (the exchange zone).
 *  Exported so the live-tick path (datafeed bucketLiveTick) lands its
 *  weekly/monthly updates on exactly the keys this module aggregates to. */
export function bucketStart(sec: number, unit: AggregateUnit, timeZone: string): number {
  const d = new Date(localDay(timeZone, sec) * 86400000);
  if (unit === "month") {
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }
  // Week — back up to Monday. getUTCDay(): 0=Sun … 6=Sat.
  const dow = d.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor(midnight / 1000) - daysSinceMonday * 86400;
}

/** Day number (days since 1970-01-01) of 1 January of `year`. */
function yearStart(year: number): number {
  return Date.UTC(year, 0, 1) / 86400000;
}

/** Day number of the first Monday on or after 1 January of `year`. */
function firstMonday(year: number): number {
  const d = yearStart(year);
  const sinceMonday = (new Date(d * 86400000).getUTCDay() + 6) % 7;
  return sinceMonday === 0 ? d : d + 7 - sinceMonday;
}

/** Trading days of `year` per spec, ascending (cached per spec and year). */
const tradingDaysCache = new WeakMap<SessionSpec, Map<number, number[]>>();
function tradingDaysOf(spec: SessionSpec, year: number): number[] {
  let byYear = tradingDaysCache.get(spec);
  if (!byYear) tradingDaysCache.set(spec, (byYear = new Map()));
  let days = byYear.get(year);
  if (!days) {
    days = [];
    for (let d = yearStart(year), end = yearStart(year + 1); d < end; d++) if (spec.isTradingDay(d)) days.push(d);
    byYear.set(year, days);
  }
  return days;
}

/** Bucket-start (UNIX seconds, UTC) of the `p` period containing the daily
 *  bar stamped `sec`; trading days and the date come from `spec` (the
 *  symbol's session and exchange zone). */
export function periodStart(sec: number, p: AggregatePeriod, spec: SessionSpec): number {
  const day = localDay(spec.timeZone, sec);
  if (p.n <= 1 && p.unit !== "day") return bucketStart(sec, p.unit, spec.timeZone);
  const year = new Date(day * 86400000).getUTCFullYear();
  if (p.unit === "month") {
    const month = new Date(day * 86400000).getUTCMonth();
    return Date.UTC(year, month - (month % p.n), 1) / 1000;
  }
  if (p.unit === "week") {
    let y = year;
    let first = firstMonday(y);
    if (day < first) first = firstMonday(--y);
    const index = Math.floor((day - first) / 7);
    return (first + 7 * (index - (index % p.n))) * 86400;
  }
  // Days: index of the day among the year's trading days (a bar on a day the
  // spec calls closed takes the index of the next trading day).
  const days = tradingDaysOf(spec, year);
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  const group = lo - (lo % p.n);
  return (days[group] ?? day) * 86400;
}

/**
 * Aggregate a sorted-ascending daily candle series into `p` buckets. Candles
 * with any null OHLC field are skipped. Input is assumed time-ordered (the
 * backend returns sorted); a defensive sort is applied regardless so
 * out-of-order ticks don't corrupt the reduce.
 */
export function aggregateCandles(daily: Candle[], p: AggregatePeriod, spec: SessionSpec): Candle[] {
  const clean = daily
    .filter(
      (c) =>
        c.time != null &&
        c.open != null &&
        c.high != null &&
        c.low != null &&
        c.close != null,
    )
    .sort((a, b) => (a.time as number) - (b.time as number));

  const out: Candle[] = [];
  let curKey = Number.NaN;
  let cur: Candle | null = null;

  for (const c of clean) {
    const key = periodStart(c.time as number, p, spec);
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = {
        time: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      };
      curKey = key;
    } else if (cur) {
      cur.high = Math.max(cur.high as number, c.high as number);
      cur.low = Math.min(cur.low as number, c.low as number);
      cur.close = c.close;
      cur.volume = (cur.volume ?? 0) + (c.volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}
