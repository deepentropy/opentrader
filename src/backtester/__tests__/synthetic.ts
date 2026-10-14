/**
 * Deterministic synthetic OHLCV series for the backtester golden tests (no market data in the repo): a seeded PRNG
 * drives a regime-switching random walk, stamped on a US-equity calendar (weekdays, a few fixed holidays, the
 * regular session 09:30-16:00 New York for intraday bars, across the DST changes).
 */
import { localDay, localToUtc } from "../../data/session/zone";
import type { Bar } from "../types";

export const NEW_YORK = "America/New_York";

/** mulberry32: a small, fast, seeded PRNG with a uniform output in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box-Muller) from a uniform PRNG. */
function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Local day number (days since 1970-01-01) of a calendar date. */
export function dayOf(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Fixed US market holidays used by the synthetic calendar (a subset is enough: it puts gaps in the weekdays). */
function isHoliday(day: number): boolean {
  const date = new Date(day * 86_400_000);
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return (m === 1 && d === 1) || (m === 7 && d === 4) || (m === 12 && d === 25);
}

/** Trading days (local day numbers) from `from` on: weekdays that are not holidays, `count` of them. */
export function tradingDays(from: number, count: number, extraHolidays: number[] = []): number[] {
  const out: number[] = [];
  const extra = new Set(extraHolidays);
  for (let day = from; out.length < count; day++) {
    const wd = (day + 4) % 7; // 1970-01-01 was a Thursday: 0 = Sunday
    if (wd === 0 || wd === 6 || isHoliday(day) || extra.has(day)) continue;
    out.push(day);
  }
  return out;
}

interface WalkOptions {
  seed: number;
  start: number;
  /** Volatility of one bar's log return. */
  vol: number;
  /** Drift of one bar's log return. */
  drift?: number;
  /** Decimals of the prices (the datafeed's precision). */
  decimals: number;
  /** Probability of a gap at the bar's open (a new day for daily bars, a session open for intraday ones). */
  gapAt?: (i: number) => number;
  volume: number;
}

/** OHLCV values of a regime-switching random walk, one per time. */
function walk(times: number[], o: WalkOptions): Bar[] {
  const rand = prng(o.seed);
  const norm = gaussian(rand);
  const round = (x: number) => Number(x.toFixed(o.decimals));
  const floor = 10 ** -o.decimals;
  const bars: Bar[] = [];
  let prev = o.start;
  let regimeDrift = o.drift ?? 0;
  let regimeVol = o.vol;
  for (let i = 0; i < times.length; i++) {
    // A new regime about every 120 bars: trend up, trend down, quiet range or a volatile chop.
    if (i % 120 === 0) {
      const r = rand();
      regimeDrift = (o.drift ?? 0) + (r < 0.3 ? 1 : r < 0.6 ? -1 : 0) * o.vol * 0.25;
      regimeVol = o.vol * (r > 0.85 ? 2.2 : r > 0.6 ? 0.6 : 1);
    }
    const gap = rand() < (o.gapAt?.(i) ?? 0) ? norm() * regimeVol * 1.5 : norm() * regimeVol * 0.1;
    const open = Math.max(floor, round(prev * Math.exp(gap)));
    const close = Math.max(floor, round(open * Math.exp(regimeDrift + norm() * regimeVol)));
    const high = round(Math.max(open, close) * Math.exp(Math.abs(norm()) * regimeVol * 0.5));
    const low = Math.max(floor, round(Math.min(open, close) * Math.exp(-Math.abs(norm()) * regimeVol * 0.5)));
    const volume = Math.round(o.volume * Math.exp(norm() * 0.4) * (1 + Math.abs(close - open) / open / regimeVol));
    bars.push({ time: times[i], open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume });
    prev = close;
  }
  return bars;
}

/** Daily bars stamped at local midnight in New York (the datafeed's daily bars). */
export function dailySeries(): Bar[] {
  const days = tradingDays(dayOf(2019, 1, 2), 1500);
  const times = days.map((d) => localToUtc(NEW_YORK, d, 0));
  return walk(times, { seed: 20190102, start: 150, vol: 0.017, drift: 0.0003, decimals: 2, gapAt: () => 0.25, volume: 30_000_000 });
}

/** 5-minute bars of the regular session (09:30-16:00 New York, 78 bars a day) from 20/02/2024 to 30/04/2024: the
 *  US DST change of 10/03/2024 and the Good Friday holiday of 29/03/2024 are inside. */
export function intradaySeries(): Bar[] {
  const days = tradingDays(dayOf(2024, 2, 20), 49, [dayOf(2024, 3, 29)]);
  const times: number[] = [];
  for (const d of days) for (let k = 0; k < 78; k++) times.push(localToUtc(NEW_YORK, d, 9 * 60 + 30 + 5 * k));
  return walk(times, { seed: 5_2024, start: 480, vol: 0.0018, decimals: 2, gapAt: (i) => (i % 78 === 0 ? 1 : 0), volume: 400_000 });
}

/** A penny stock: daily bars from about 1.5 USD down to a few cents, then back to about 0.40 (4 decimals): the
 *  funds and margin edge cases of huge quantities at tiny prices. */
export function pennySeries(): Bar[] {
  const days = tradingDays(dayOf(2001, 1, 2), 900);
  const times = days.map((d) => localToUtc(NEW_YORK, d, 0));
  const bars = walk(times, { seed: 424242, start: 1, vol: 0.045, decimals: 6, gapAt: () => 0.3, volume: 80_000_000 });
  // The walk's own trend (a centred 61-bar mean of its log closes) is replaced by a deterministic envelope:
  // log-linear from 1.5 to 0.03 over the first 60 %, then up to 0.40. The swings around the trend stay.
  const turn = Math.floor(bars.length * 0.6);
  const envelope = (i: number) =>
    i <= turn
      ? Math.log(1.5) + ((Math.log(0.03) - Math.log(1.5)) * i) / turn
      : Math.log(0.03) + ((Math.log(0.4) - Math.log(0.03)) * (i - turn)) / (bars.length - 1 - turn);
  const logs = bars.map((b) => Math.log(b.close));
  const trend = (i: number) => {
    const from = Math.max(0, i - 30);
    const to = Math.min(logs.length - 1, i + 30);
    let s = 0;
    for (let k = from; k <= to; k++) s += logs[k];
    return s / (to - from + 1);
  };
  return bars.map((b, i) => {
    const f = Math.exp(envelope(i) - trend(i));
    const px = (x: number) => Math.max(0.0001, Number((x * f).toFixed(4)));
    return { ...b, open: px(b.open), high: px(b.high), low: px(b.low), close: px(b.close) };
  });
}

/** Checks the calendar the series are stamped on (used by the tests of this helper). */
export function sessionMinutes(bar: Bar): { day: number; minutes: number } {
  const day = localDay(NEW_YORK, bar.time);
  return { day, minutes: Math.round((bar.time - localToUtc(NEW_YORK, day, 0)) / 60) };
}
