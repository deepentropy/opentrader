/**
 * Pine built-ins used by the strategy ports, on plain arrays (NaN = na).
 * Each follows the Pine reference implementation, including how na values
 * start a series, so signals land on the same bars as in TradingView.
 * (oakscriptjs `ta.tr` returns high - low on bar 0, where Pine returns na.)
 */
import type { Bar } from './types';

export type Num = number[];

export const closeOf = (bars: Bar[]): Num => bars.map((b) => b.close);
export const highOf = (bars: Bar[]): Num => bars.map((b) => b.high);
export const lowOf = (bars: Bar[]): Num => bars.map((b) => b.low);
export const hlc3Of = (bars: Bar[]): Num => bars.map((b) => (b.high + b.low + b.close) / 3);

/** x[k] of series x at bar i (na before the first bar). */
export const at = (x: Num, i: number, k = 0): number => (i - k >= 0 ? x[i - k] : NaN);

export const nz = (v: number, r = 0): number => (Number.isNaN(v) ? r : v);

/**
 * Pine's float comparison operators (<, >, <=, >=) treat values closer than
 * 1e-10 as equal; builtins such as ta.crossover compare exactly. Seen on
 * TradingView: 489.2914285714285 < 489.2914285714286 is false in a script
 * expression, while ta.crossunder fires on the same two values.
 * Comparisons with na are false.
 */
const CMP_EPS = 1e-10;
export const gt = (a: number, b: number): boolean => a - b > CMP_EPS;
export const lt = (a: number, b: number): boolean => b - a > CMP_EPS;
export const ge = (a: number, b: number): boolean => a - b >= -CMP_EPS;
export const le = (a: number, b: number): boolean => b - a >= -CMP_EPS;

/** math.sum(x, n): na until n bars, na if the window holds na. */
export function sum(x: Num, n: number): Num {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += x[i - k];
    out[i] = s;
  }
  return out;
}

export function sma(x: Num, n: number): Num {
  return sum(x, n).map((s) => s / n);
}

/** Recursive average seeded with the SMA of the first n values (ta.rma / ta.ema). */
function recursiveMa(x: Num, n: number, alpha: number): Num {
  const seed = sma(x, n);
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const prev = at(out, i, 1);
    out[i] = Number.isNaN(prev) ? seed[i] : alpha * x[i] + (1 - alpha) * prev;
  }
  return out;
}

export const rma = (x: Num, n: number): Num => recursiveMa(x, n, 1 / n);
export const ema = (x: Num, n: number): Num => recursiveMa(x, n, 2 / (n + 1));

export function rsi(x: Num, n: number): Num {
  const up = x.map((v, i) => Math.max(v - at(x, i, 1), 0));
  const down = x.map((v, i) => Math.max(at(x, i, 1) - v, 0));
  // Math.max(NaN, 0) is NaN, like Pine's math.max(na, 0).
  const u = rma(up, n);
  const d = rma(down, n);
  return u.map((uu, i) => {
    const dd = d[i];
    if (Number.isNaN(uu) || Number.isNaN(dd)) return NaN;
    if (dd === 0) return 100;
    if (uu === 0) return 0;
    return 100 - 100 / (1 + uu / dd);
  });
}

/** ta.stdev, with Pine's near-zero correction of each deviation; biased = divide by n, else by n - 1. */
export function stdev(x: Num, n: number, biased = true): Num {
  const avg = sma(x, n);
  const isZero = (v: number) => Math.abs(v) <= 1e-10;
  return avg.map((a, i) => {
    if (Number.isNaN(a)) return NaN;
    let s = 0;
    for (let k = 0; k < n; k++) {
      let d = x[i - k] + -a;
      if (isZero(d)) d = 0;
      s += d * d;
    }
    return Math.sqrt(s / (biased ? n : n - 1));
  });
}

export function highest(x: Num, n: number): Num {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let m = -Infinity;
    for (let k = 0; k < n; k++) if (x[i - k] > m) m = x[i - k];
    out[i] = m;
  }
  return out;
}

export function lowest(x: Num, n: number): Num {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let m = Infinity;
    for (let k = 0; k < n; k++) if (x[i - k] < m) m = x[i - k];
    out[i] = m;
  }
  return out;
}

/** ta.tr (= ta.tr(false)): na when the previous close is na, so on bar 0. */
export function tr(bars: Bar[]): Num {
  return bars.map((b, i) => {
    if (i === 0) return NaN;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** ta.mfi(src, n): money flow over bar volume, as the Pine reference code. */
export function mfi(bars: Bar[], src: Num, n: number): Num {
  const change = src.map((v, i) => v - at(src, i, 1));
  const vol = bars.map((b) => b.volume ?? NaN);
  // `change <= 0 ? 0 : src` keeps src when change is na (na comparisons are false).
  // Pine comparisons: a 5.7e-14 change (hlc3 of equal decimal prices) counts as 0.
  const upper = sum(src.map((v, i) => vol[i] * (le(change[i], 0) ? 0 : v)), n);
  const lower = sum(src.map((v, i) => vol[i] * (ge(change[i], 0) ? 0 : v)), n);
  return upper.map((u, i) => 100 - 100 / (1 + u / lower[i]));
}

/** ta.crossover at bar i. `first` = first call of this ta.crossover instance (its history is na). */
export function crossover(a: Num | number, b: Num | number, i: number, first = false): boolean {
  if (first) return false;
  const va = (k: number) => (typeof a === 'number' ? a : at(a, i, k));
  const vb = (k: number) => (typeof b === 'number' ? b : at(b, i, k));
  return va(0) > vb(0) && va(1) <= vb(1);
}

export function crossunder(a: Num | number, b: Num | number, i: number, first = false): boolean {
  if (first) return false;
  const va = (k: number) => (typeof a === 'number' ? a : at(a, i, k));
  const vb = (k: number) => (typeof b === 'number' ? b : at(b, i, k));
  return va(0) < vb(0) && va(1) >= vb(1);
}

/** Bar open time in milliseconds (Pine `time`). */
export const timeMs = (bars: Bar[], i: number): number => bars[i].time * 1000;

/** math.round: half away from zero, on the exact binary value. */
export function round(x: number): number {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/** Pine division: x / 0 is na. */
export const div = (a: number, b: number): number => (b === 0 ? NaN : a / b);

/** ta.change(x, 1). */
export const change = (x: Num): Num => x.map((v, i) => v - at(x, i, 1));

/** ta.atr: RMA of the true range, where bar 0 uses high - low (ta.tr(true)). */
export function atr(bars: Bar[], n: number): Num {
  const t = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  return rma(t, n);
}

/** ta.macd: [macd, signal, histogram]. */
export function macd(x: Num, fast: number, slow: number, signal: number): [Num, Num, Num] {
  const f = ema(x, fast);
  const sl = ema(x, slow);
  const m = f.map((v, i) => v - sl[i]);
  const sg = ema(m, signal);
  return [m, sg, m.map((v, i) => v - sg[i])];
}

/** ta.stoch(source, high, low, length). */
export function stoch(src: Num, high: Num, low: Num, n: number): Num {
  const hh = highest(high, n);
  const ll = lowest(low, n);
  return src.map((v, i) => div(100 * (v - ll[i]), hh[i] - ll[i]));
}

/** Session day of each bar in the exchange time zone (YYYY-MM-DD). */
export function sessionDays(bars: Bar[], timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return bars.map((b) => fmt.format(new Date(b.time * 1000)));
}

/** ta.vwap(source): anchored at each new session day. */
export function vwap(bars: Bar[], src: Num, timeZone: string): Num {
  const days = sessionDays(bars, timeZone);
  const out = new Array<number>(bars.length).fill(NaN);
  let pv = 0;
  let v = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === 0 || days[i] !== days[i - 1]) {
      pv = 0;
      v = 0;
    }
    const vol = bars[i].volume ?? NaN;
    pv += src[i] * vol;
    v += vol;
    out[i] = div(pv, v);
  }
  return out;
}

export const volumeOf = (bars: Bar[]): Num => bars.map((b) => b.volume ?? NaN);
export const openOf = (bars: Bar[]): Num => bars.map((b) => b.open);

/** Pine price sources (input.source options) -> series. */
export type SourceName = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'hlcc4' | 'ohlc4';
export function sourceOf(bars: Bar[], name: SourceName | string): Num {
  switch (name) {
    case 'open': return openOf(bars);
    case 'high': return highOf(bars);
    case 'low': return lowOf(bars);
    case 'hl2': return bars.map((b) => (b.high + b.low) / 2);
    case 'hlc3': return hlc3Of(bars);
    case 'hlcc4': return bars.map((b) => (b.high + b.low + 2 * b.close) / 4);
    case 'ohlc4': return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    default: return closeOf(bars);
  }
}

/** Offset of a time zone at a UTC instant, ms (local - UTC). */
function zoneOffset(timeZone: string, utcMs: number): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** timestamp(timezone, year, month, day, hour, minute): UNIX ms. */
export function timestamp(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0): number {
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const guess = local - zoneOffset(timeZone, local);
  return local - zoneOffset(timeZone, guess);
}
