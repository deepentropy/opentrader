/*
 * Tick charts (#376): bars of N ticks, built from the ticks a data plugin serves (`data.ticks`, live `data.tick`).
 *
 * A bar holds the next N ticks; it is stamped at its first tick, in seconds with the milliseconds as decimals. Bars
 * of one millisecond are kept apart by a microsecond: the chart needs every bar at its own time.
 */
import type { Candle } from "../bindings";

/** A tick: UNIX milliseconds, price, volume (the backend keeps finite ones only). */
export type TickRow = { timeMs: number; price: number; volume: number };

/** Tick counts offered at most in an interval id. */
const MAX_TICKS_PER_BAR = 1000;
/** Ticks asked at most in one request (the plugin's limit too). */
const MAX_TICKS_PER_PAGE = 100_000;
/** Bars one request aims at (fewer for big tick counts, see MAX_TICKS_PER_PAGE). */
const BARS_PER_PAGE = 1500;
/** The gap between bars of one millisecond, in seconds. */
export const TICK_BAR_GAP = 1e-6;

/** N of an "NT" interval id; null for other ids. */
export function tickCount(resolution: string): number | null {
  const m = /^([1-9]\d*)T$/.exec(resolution.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n <= MAX_TICKS_PER_BAR ? n : null;
}

export function isTickResolution(resolution: string): boolean {
  return tickCount(resolution) !== null;
}

/** Ticks to ask for one page of `n`-tick bars: whole bars only, so a page boundary never cuts a bar. */
export function ticksPerPage(n: number): number {
  const bars = Math.max(1, Math.min(BARS_PER_PAGE, Math.floor(MAX_TICKS_PER_PAGE / n)));
  return bars * n;
}

/** The bars of `n` ticks each, oldest first, the ticks grouped from the oldest. Their times stay after `after`
 *  (the bar before them, if any). */
export function tickBars(ticks: readonly TickRow[], n: number, after = -Infinity): Candle[] {
  const bars: Candle[] = [];
  let prev = after;
  for (let i = 0; i < ticks.length; i += n) {
    const group = ticks.slice(i, i + n);
    const first = group[0];
    const time = Math.max(first.timeMs / 1000, prev + TICK_BAR_GAP);
    let high = first.price;
    let low = first.price;
    let volume = 0;
    for (const t of group) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      volume += t.volume;
    }
    bars.push({ time, open: first.price, high, low, close: group[group.length - 1].price, volume });
    prev = time;
  }
  return bars;
}

/** The time of a new live bar starting with a tick at `timeMs`, after the bar at `lastTime`. */
export function nextTickBarTime(timeMs: number, lastTime: number): number {
  return Math.max(timeMs / 1000, lastTime + TICK_BAR_GAP);
}

/** The milliseconds of a bar's first tick: the time to ask older ticks before. Seconds near 2e9 carry about
 *  0.0003 ms of rounding, under the 0.001 ms a bar is moved by. */
export function tickBarMs(time: number): number {
  return Math.floor(time * 1000 + 0.01);
}
