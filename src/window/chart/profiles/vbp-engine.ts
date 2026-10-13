/*
 * Volume-by-price engine of the profile studies (Technicals > Profiles), the
 * reference rules measured on its own outputs (#48):
 *
 * - Prices in ticks: each bar's high / low rounded half-up to the tick (open
 *   and close are not rounded, they only give the direction).
 * - Rows, "Number Of Rows": ticks per row = floor or ceil of range / rows,
 *   whichever gives the row count (ceil(range / ticks per row)) closer to the
 *   requested one; rows from the low, the last row may pass the high.
 *   "Ticks Per Row": rows on multiples of the row size (absolute grid).
 * - Each bar's volume spread over its low..high in proportion to the overlap
 *   with each row (a bar without range goes to its row).
 * - Direction: close > open up, close < open down; close = open: against the
 *   previous close (higher up, lower down, equal = the previous direction).
 * - POC: row with the most volume (equal rows: the one closest to the middle
 *   of the profile, then the higher). Value area: from the POC, the larger of
 *   the next row above / below (equal: closer to the POC, then the higher) is
 *   added while it fits in VA % of the total; the first that does not fit ends it.
 */

export type LtfBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

export type RowsLayout = "Number Of Rows" | "Ticks Per Row";

/** A profile: rows from `start` (ticks) of `tpr` ticks each. */
export type VbpProfile = {
  /** Price of the grid start (bottom of row 0) and row height, in price. */
  lo: number;
  step: number;
  up: number[];
  down: number[];
  poc: number;
  vaLo: number;
  vaHi: number;
  /** Lowest low / highest high (rounded to the tick): the histogram box. */
  boxLo: number;
  boxHi: number;
};

/** Price → ticks, rounded half-up. */
export function toTicks(price: number, tick: number): number {
  return Math.floor(price / tick + 0.5 + 1e-7);
}

/** Up (true) / down direction of every bar of a series (in order). */
export function barDirections(bars: readonly LtfBar[]): boolean[] {
  const out = new Array<boolean>(bars.length);
  let prevClose = NaN;
  let prevUp = true;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let up: boolean;
    if (b.close > b.open) up = true;
    else if (b.close < b.open) up = false;
    else if (b.close > prevClose) up = true;
    else if (b.close < prevClose) up = false;
    else up = prevUp;
    out[i] = up;
    prevClose = b.close;
    prevUp = up;
  }
  return out;
}

/** Row grid over [lowTicks, highTicks]: start (ticks), ticks per row, count. */
export function rowGrid(lowTicks: number, highTicks: number, layout: RowsLayout, rowSize: number): { start: number; tpr: number; count: number } {
  const size = Math.max(1, Math.round(rowSize));
  const span = Math.max(0, highTicks - lowTicks);
  if (layout === "Ticks Per Row") {
    const start = Math.floor(lowTicks / size) * size;
    return { start, tpr: size, count: Math.max(1, Math.ceil((highTicks - start) / size)) };
  }
  return { start: lowTicks, ...closestRows(span, size) };
}

/** Ticks per row giving the row count closest to `rows` over `span` ticks. */
export function closestRows(span: number, rows: number): { tpr: number; count: number } {
  const count = (t: number) => Math.max(1, Math.ceil(span / t));
  const f = Math.max(1, Math.floor(span / rows));
  const c = Math.max(1, Math.ceil(span / rows));
  const tpr = Math.abs(count(f) - rows) <= Math.abs(count(c) - rows) ? f : c;
  return { tpr, count: count(tpr) };
}

/** POC row: most volume, equal rows → closest to the middle, then higher. */
export function pocOf(total: readonly number[]): number {
  let poc = 0;
  const mid = (total.length - 1) / 2;
  for (let i = 1; i < total.length; i++) {
    if (total[i] > total[poc]) poc = i;
    else if (total[i] === total[poc] && Math.abs(i - mid) <= Math.abs(poc - mid)) poc = i;
  }
  return poc;
}

/** Value area rows [lo, hi] around `poc` holding up to `pct` % of the total. */
export function valueArea(total: readonly number[], poc: number, pct: number): [number, number] {
  let sum = 0;
  for (const v of total) sum += v;
  const target = (sum * Math.max(0, Math.min(100, pct))) / 100;
  let lo = poc;
  let hi = poc;
  let acc = total[poc] ?? 0;
  const n = total.length;
  while (lo > 0 || hi < n - 1) {
    const above = hi < n - 1 ? total[hi + 1] : -1;
    const below = lo > 0 ? total[lo - 1] : -1;
    let takeAbove: boolean;
    if (above !== below) takeAbove = above > below;
    else takeAbove = hi + 1 - poc <= poc - (lo - 1);
    const v = takeAbove ? above : below;
    if (acc + v > target) break;
    acc += v;
    if (takeAbove) hi++;
    else lo--;
  }
  return [lo, hi];
}

export type GridOptions = { layout: RowsLayout; rowSize: number } | { fixedTpr: number };

/** Profile of bars[from..to] (inclusive). `dirs`: barDirections of `bars`. */
export function buildProfile(
  bars: readonly LtfBar[],
  dirs: readonly boolean[],
  from: number,
  to: number,
  tick: number,
  grid: GridOptions,
  vaPct: number,
): VbpProfile | null {
  if (to < from) return null;
  let lowT = Infinity;
  let highT = -Infinity;
  for (let i = from; i <= to; i++) {
    const l = toTicks(bars[i].low, tick);
    const h = toTicks(bars[i].high, tick);
    if (l < lowT) lowT = l;
    if (h > highT) highT = h;
  }
  if (!Number.isFinite(lowT) || !Number.isFinite(highT)) return null;
  let start: number;
  let tpr: number;
  let count: number;
  if ("fixedTpr" in grid) {
    tpr = Math.max(1, grid.fixedTpr);
    start = Math.floor(lowT / tpr) * tpr;
    count = Math.max(1, Math.ceil((highT - start) / tpr));
  } else {
    ({ start, tpr, count } = rowGrid(lowT, highT, grid.layout, grid.rowSize));
  }
  const up = new Array<number>(count).fill(0);
  const down = new Array<number>(count).fill(0);
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const v = b.volume ?? 0;
    if (!(v > 0)) continue;
    const into = dirs[i] ? up : down;
    const l = toTicks(b.low, tick) - start;
    const h = toTicks(b.high, tick) - start;
    if (h <= l) {
      into[Math.min(count - 1, Math.max(0, Math.floor(l / tpr)))] += v;
      continue;
    }
    const span = h - l;
    const r0 = Math.max(0, Math.floor(l / tpr));
    const r1 = Math.min(count - 1, Math.ceil(h / tpr) - 1);
    for (let r = r0; r <= r1; r++) {
      const a = Math.max(l, r * tpr);
      const c = Math.min(h, (r + 1) * tpr);
      if (c > a) into[r] += (v * (c - a)) / span;
    }
  }
  const total = up.map((u, i) => u + down[i]);
  const poc = pocOf(total);
  const [vaLo, vaHi] = valueArea(total, poc, vaPct);
  return { lo: start * tick, step: tpr * tick, up, down, poc, vaLo, vaHi, boxLo: lowT * tick, boxHi: highT * tick };
}

/** POC / VAH / VAL prices of a profile. */
export function profileLevels(p: VbpProfile): { poc: number; vah: number; val: number } {
  return { poc: p.lo + (p.poc + 0.5) * p.step, vah: p.lo + (p.vaHi + 1) * p.step, val: p.lo + p.vaLo * p.step };
}

// ── Lower timeframe ────────────────────────────────────────────────────────

/** Calculation timeframes of a range (fixed / visible / anchored), in order:
 *  the first giving fewer than 5000 bars over the span is used. */
const SPAN_STEPS: [string, number][] = [["1", 60], ["5", 300], ["15", 900], ["30", 1800], ["60", 3600], ["240", 14400], ["1D", 86400]];

/** Lower timeframe of a range of `spanSec` seconds (seconds charts and spans
 *  up to 5 minutes: 1 second). */
export function ltfForSpan(spanSec: number, chartIsSeconds: boolean): string {
  if (chartIsSeconds || spanSec <= 300) return "1S";
  for (const [res, sec] of SPAN_STEPS) if (spanSec / sec < 5000) return res;
  return "1D";
}

/** Lower timeframe and depth ratio of the session / periodic profiles, by
 *  chart interval (seconds). */
export function ltfForChart(chartSec: number): { res: string; depth: number } {
  if (chartSec < 60) {
    if (chartSec <= 10) return { res: "1S", depth: 1 };
    if (chartSec <= 15) return { res: "5S", depth: 3 };
    return { res: "15S", depth: 2 };
  }
  const m = chartSec / 60;
  if (m <= 4) return { res: "1", depth: 1 };
  if (m <= 15) return { res: "1", depth: 3 };
  if (m <= 30) return { res: "5", depth: 3 };
  if (m <= 60) return { res: "10", depth: 3 };
  if (m <= 120) return { res: "15", depth: 4 };
  if (m <= 240) return { res: "30", depth: 4 };
  return { res: "60", depth: 4 };
}

/** Largest number of rows the session / periodic profiles draw together. */
export const MAX_TOTAL_ROWS = 6000;

/** Index of the first bar with time >= t (bars ascending); bars.length when none. */
export function lowerBound(bars: readonly { time: number }[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
