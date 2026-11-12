/**
 * Max drawdown and run-up of the equity events (EquityEvent), folded as the broker makes them. The events were kept
 * (about four per bar: on a long history of 10 s bars the largest part of a strategy's memory, held twice by the live
 * run's saved state) to be read once in order by the report: this reads them in the same order as they come.
 *
 * Plain data: the broker's state is copied with structuredClone (live runs save it at each bar's end). The newest
 * event waits for the next one: a price event right before a fill does not count, and a margin call changes the
 * close event it made (margin.ts).
 */
import type { EquityEvent } from './types';

export interface EquityExtremes {
  /** Highest realized equity after a close, lowest after a flat close, a margin call or an entry (null: initial
   *  capital). */
  peak: number | null;
  trough: number | null;
  dd: number;
  ddPct: number;
  ru: number;
  ruPct: number;
  /** The newest event, not counted yet. */
  last: EquityEvent | null;
}

export const newEquityExtremes = (): EquityExtremes => ({ peak: null, trough: null, dd: 0, ddPct: 0, ru: 0, ruPct: 0, last: null });

/** Count event `e`; `beforeFill`: a price event right before a fill (its equity is read after the fill). */
function count(x: EquityExtremes, e: EquityEvent, beforeFill: boolean, initialCapital: number): void {
  const peak = x.peak ?? initialCapital;
  const trough = x.trough ?? initialCapital;
  if (e.t !== 'e' && !beforeFill) {
    // Percent = the largest ratio (drawdown / peak, run-up / equity reached), not the ratio at the largest amount.
    const dd = peak - e.v;
    if (dd > x.dd) x.dd = dd;
    if (peak > 0 && dd / peak > x.ddPct) x.ddPct = dd / peak;
    const ru = e.v - trough;
    if (ru > x.ru) x.ru = ru;
    if (e.v > 0 && ru / e.v > x.ruPct) x.ruPct = ru / e.v;
  }
  if (e.t === 'c') x.peak = Math.max(peak, e.realized);
  if ((e.t === 'c' && (e.flat || e.marginCall)) || e.t === 'e') x.trough = Math.min(trough, e.realized);
}

/** Add the broker's next event (the one before it is counted now). */
export function addEquityEvent(x: EquityExtremes, e: EquityEvent, initialCapital: number): void {
  if (x.last) count(x, x.last, x.last.t === 'p' && e.t !== 'p', initialCapital);
  x.last = e;
}

/** Max drawdown / run-up of every event so far (`x` is not changed). */
export function equityExtremes(x: EquityExtremes, initialCapital: number): { dd: number; ddPct: number; ru: number; ruPct: number } {
  const y = { ...x };
  if (x.last) count(y, x.last, false, initialCapital);
  return { dd: y.dd, ddPct: y.ddPct, ru: y.ru, ruPct: y.ruPct };
}
