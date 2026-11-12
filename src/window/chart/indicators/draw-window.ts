/*
 * The studies draw the bars around the view only. A study's result covers every loaded bar (strategies and
 * values need them all), but drawn whole on a long history its points took most of the window's memory: the
 * chart library keeps every point of every series, and each plot, fill and colour has its own objects
 * (10S with Volume, SMA and RSI: about 2.6 KB per bar, 12/11/2026, .tmp/memory-proto). The draw window is a
 * time range; the result and the bars are cut to it before they are drawn, and it moves as the view nears an
 * edge. Up to DRAW_WINDOW_BARS bars there is no window: everything is drawn, as before.
 */

import { lowerBound, upperBound } from "../time-search";

/** Most bars the studies draw. */
export const DRAW_WINDOW_BARS = 30_000;
/** The window moves once the view is closer than this to one of its ends (and the bars go on past it). */
export const DRAW_WINDOW_MARGIN = 5_000;

/** Times of the first and last bar drawn: -Infinity / Infinity for a window that reaches the first / last bar. */
export type DrawWindow = { from: number; to: number };

type Timed = { time: unknown };
const timeOf = (x: Timed) => x.time as number;

/** Index range [a, b) of `bars` in the window. */
function barRange(bars: readonly Timed[], win: DrawWindow): [number, number] {
  const a = win.from === -Infinity ? 0 : lowerBound(bars, win.from);
  const b = win.to === Infinity ? bars.length : upperBound(bars, win.to);
  return [a, Math.max(a, b)];
}

/**
 * The window for a view on bars [first, last] (indices): null when every bar is drawn, `current` when the view
 * is still well inside it, else a window of DRAW_WINDOW_BARS centred on the view.
 */
export function nextDrawWindow(bars: readonly Timed[], view: { from: number; to: number }, current: DrawWindow | null): DrawWindow | null {
  const n = bars.length;
  if (n <= DRAW_WINDOW_BARS) return null;
  const from = Math.max(0, Math.min(n - 1, Math.floor(view.from)));
  const to = Math.max(from, Math.min(n - 1, Math.ceil(view.to)));
  const size = Math.max(DRAW_WINDOW_BARS, to - from + 1 + 2 * DRAW_WINDOW_MARGIN);
  if (current) {
    const [a, b] = barRange(bars, current);
    const okStart = a === 0 || from - a >= DRAW_WINDOW_MARGIN;
    const okEnd = b === n || b - 1 - to >= DRAW_WINDOW_MARGIN;
    // A window open at an end takes the bars added there (older pages, live bars): one grown past its size is
    // made again.
    if (okStart && okEnd && b - a >= Math.min(n, DRAW_WINDOW_BARS) && b - a <= size + 2 * DRAW_WINDOW_MARGIN) return current;
  }
  const centre = Math.round((from + to) / 2);
  let a = Math.max(0, centre - Math.floor(size / 2));
  const b = Math.min(n, a + size);
  a = Math.max(0, b - size);
  return { from: a === 0 ? -Infinity : timeOf(bars[a]), to: b === n ? Infinity : timeOf(bars[b - 1]) };
}

/** The items of a time-ascending list in the window, with their index range. */
function cutSorted<T extends Timed>(items: readonly T[], from: number, to: number): { items: T[]; a: number; b: number } {
  const a = from === -Infinity ? 0 : lowerBound(items, from);
  const b = to === Infinity ? items.length : upperBound(items, to);
  return { items: items.slice(a, Math.max(a, b)), a, b: Math.max(a, b) };
}

/** The items of a list in the window (any order). */
const filterIn = <T extends Timed>(items: readonly T[], from: number, to: number) => items.filter((x) => timeOf(x) >= from && timeOf(x) <= to);

type Gradient = { topValue: number[]; bottomValue: number[]; topColor: (string | null)[]; bottomColor: (string | null)[] };
type Fill = { plot1: number | string; colors?: string[]; gradient?: Gradient };

/**
 * `bars` and `result` cut to the window. Per-bar outputs keyed by time (plots, markers, arrows, colours,
 * candles) keep the points in it; per-point arrays (a fill's colours, along its first plot; a gradient, along
 * the bars) keep the same positions as the points they go with. Drawings, lines and tables are kept whole.
 * Points after the last bar (a plot offset, a projection) stay when the window reaches the last bar.
 */
export function windowResult<B extends Timed, R extends { plots?: Record<string, readonly Timed[]> }>(
  bars: readonly B[],
  result: R,
  win: DrawWindow,
): { bars: B[]; result: R } {
  const [a, b] = barRange(bars, win);
  const from = a === 0 ? -Infinity : timeOf(bars[a]);
  const to = b === bars.length ? Infinity : timeOf(bars[b - 1]);
  const r = result as R & Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  const plotCuts = new Map<string, { a: number; b: number }>();
  if (r.plots) {
    const plots: Record<string, Timed[]> = {};
    for (const [id, points] of Object.entries(r.plots)) {
      const cut = cutSorted(points, from, to);
      plots[id] = cut.items;
      plotCuts.set(id, cut);
    }
    out.plots = plots;
  }
  const fills = r.fills as Fill[] | undefined;
  if (fills) {
    out.fills = fills.map((f) => {
      const cut = plotCuts.get(String(f.plot1));
      const g = f.gradient;
      return {
        ...f,
        ...(f.colors && cut && { colors: f.colors.slice(cut.a, cut.b) }),
        ...(g && {
          gradient: { topValue: g.topValue.slice(a, b), bottomValue: g.bottomValue.slice(a, b), topColor: g.topColor.slice(a, b), bottomColor: g.bottomColor.slice(a, b) },
        }),
      };
    });
  }
  for (const key of ["markers", "arrows", "barColors", "bgColors"]) {
    const list = r[key] as Timed[] | undefined;
    if (list) out[key] = filterIn(list, from, to);
  }
  for (const key of ["plotCandles", "plotBars"]) {
    const byId = r[key] as Record<string, Timed[]> | undefined;
    if (byId) out[key] = Object.fromEntries(Object.entries(byId).map(([id, list]) => [id, filterIn(list, from, to)]));
  }
  return { bars: bars.slice(a, b), result: out as R };
}
