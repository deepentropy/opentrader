/*
 * The bars the chart library is given: on a long history, a slice of the loaded bars around the view. The library
 * keeps several objects per bar it is given (about 0.6 KB per candle, 12/11/2026, .tmp/memory-proto), so 1M loaded
 * bars held 600 MB for candles nobody looks at. `cx.allBars` holds every loaded bar (the studies, strategies, alerts
 * and the latest values read them), `cx.raw` the chart's bars: the same list up to CHART_BARS, a slice of it past
 * that. The slice moves with the view (no request: the bars are loaded), and the view stays on the same bars.
 *
 * The chart's logical indices are those of `cx.raw`. Price-based types (renko...) and Bar Replay are not sliced:
 * their items come from the whole series.
 */
import { onCleanup } from "solid-js";
import { setDataForType, isTransformType, type OHLC } from "../chart-types";
import { lowerBound } from "../time-search";
import { pendingRange } from "../pending-range";
import { type ChartCx } from "./context";

/** Most bars the chart library is given. */
export const CHART_BARS = 60_000;
/** The slice moves once the view is closer than this to one of its ends (and loaded bars go on past it). */
export const CHART_BARS_MARGIN = 15_000;

export interface BarSliceApi {
  /** Index in `cx.allBars` of the chart's first bar. */
  readonly sliceFrom: number;
  /** The chart shows the newest loaded bar. */
  sliceAtEnd: () => boolean;
  /** The newest loaded bar (in Bar Replay, the newest replayed one). */
  latestBar: () => OHLC | undefined;
  /** A load: every bar, the chart on the newest ones. */
  loadBars: (bars: OHLC[]) => void;
  /** Older bars in front of every loaded one: the chart's bars again; returns the view shift (bars added in front of
   *  the chart's first bar). */
  prependBars: (older: OHLC[]) => number;
  /** Newer bars after every loaded one; returns the view shift (negative: bars dropped in front of the chart). */
  appendBars: (newer: OHLC[]) => number;
  /** Every loaded bar replaced by `bars` (bars put in their place): the chart keeps the same time range. */
  replaceBars: (bars: OHLC[]) => void;
  /** A live bar: the newest bar changed (`appended`: a new one). True when the chart shows it. */
  liveBar: (bar: OHLC, appended: boolean) => boolean;
  /** The view moved: the slice moves once the view nears one of its ends. True when it moved. */
  followSlice: () => boolean;
  /** The slice holds time `sec` (a jump there). True when it moved. */
  sliceAround: (sec: number) => boolean;
  /** The slice ends on the newest bar (realtime, presets, reset). True when it moved. */
  sliceToEnd: () => boolean;
  /** The slice starts on the oldest loaded bar. True when it moved. */
  sliceToStart: () => boolean;
}

export function createBarSlice(cx: ChartCx): BarSliceApi {
  let from = 0;
  const sliceable = () => !isTransformType(cx.activeType) && !cx.replayActive;

  /** The chart's bars [a, b) of `cx.allBars` (the same list when it is all of them). */
  function cut(a: number, b: number): void {
    const all = cx.allBars;
    from = a;
    cx.raw = a === 0 && b === all.length ? all : all.slice(a, b);
  }

  /** A slice of CHART_BARS (or all the bars) centred on index `centre` of `cx.allBars`. */
  function around(centre: number): [number, number] {
    const n = cx.allBars.length;
    if (n <= CHART_BARS || !sliceable()) return [0, n];
    let a = Math.max(0, Math.round(centre - CHART_BARS / 2));
    const b = Math.min(n, a + CHART_BARS);
    a = Math.max(0, b - CHART_BARS);
    return [a, b];
  }

  const view = () => (cx.chart ? (pendingRange(cx.chart) ?? cx.chart.timeScale().getVisibleLogicalRange()) : null);

  /** A move is under way: the view changes it makes do not move the slice again. */
  let moving = false;

  /** Show slice [a, b): the chart's data, its studies drawn there, the view on the same bars. */
  function moveTo(a: number, b: number): boolean {
    if (moving || (a === from && b === from + cx.raw.length)) return false;
    const r = view();
    const shift = from - a;
    moving = true;
    try {
      cut(a, b);
      if (!cx.chart || !cx.series) return true;
      const ts = cx.chart.timeScale();
      const next = r && { from: r.from + shift, to: r.to + shift };
      // Asked before the new data (the chart reports a view change while it takes it) and again after.
      if (next) ts.setVisibleLogicalRange(next);
      setDataForType(cx.series, cx.activeType, cx.raw, cx.currentTokens(), cx.dataExtras());
      cx.afterSeriesData();
      cx.updateSessionBreaks();
      if (next) ts.setVisibleLogicalRange(next);
      // The studies drawn on the new bars keep the view.
      cx.controller?.followChart();
      cx.renderCompareAll();
      if (!cx.crosshairActive) cx.refreshLegend();
    } finally {
      moving = false;
    }
    return true;
  }

  function loadBars(bars: OHLC[]): void {
    cx.allBars = bars;
    const n = bars.length;
    const [a, b] = n > CHART_BARS && sliceable() ? [n - CHART_BARS, n] : [0, n];
    cut(a, b);
  }

  function prependBars(older: OHLC[]): number {
    const k = older.length;
    const end = from + cx.raw.length;
    cx.allBars = older.concat(cx.allBars);
    const n = cx.allBars.length;
    if (n <= CHART_BARS || !sliceable()) {
      const was = from;
      cut(0, n);
      return was + k;
    }
    // The chart showed the oldest bars (the view is at the start): it takes the new ones, up to CHART_BARS.
    if (from === 0) {
      cut(0, Math.min(n, CHART_BARS));
      return k;
    }
    // The chart is elsewhere: the same bars (a jump loaded history in front of them).
    cut(from + k, end + k);
    return 0;
  }

  function appendBars(newer: OHLC[]): number {
    const atEnd = from + cx.raw.length === cx.allBars.length;
    cx.allBars = cx.allBars.concat(newer);
    const n = cx.allBars.length;
    if (!atEnd) {
      cut(from, from + cx.raw.length);
      return 0;
    }
    const a = n <= CHART_BARS || !sliceable() ? 0 : Math.max(from, n - CHART_BARS);
    const shift = from - a;
    cut(a, n);
    return shift;
  }

  function replaceBars(bars: OHLC[]): void {
    const t0 = from > 0 && cx.raw.length ? (cx.raw[0].time as number) : -Infinity;
    const atEnd = from + cx.raw.length === cx.allBars.length;
    cx.allBars = bars;
    const n = bars.length;
    if (n <= CHART_BARS || !sliceable()) return cut(0, n);
    const a = t0 === -Infinity ? 0 : lowerBound(bars, t0);
    const b = atEnd ? n : Math.min(n, a + CHART_BARS);
    cut(atEnd ? Math.max(0, n - CHART_BARS) : a, b);
  }

  function liveBar(bar: OHLC, appended: boolean): boolean {
    const all = cx.allBars;
    const atEnd = from + cx.raw.length === all.length;
    if (appended) all.push(bar);
    else all[all.length - 1] = bar;
    if (cx.raw === all) return true;
    if (!atEnd) return false;
    // The chart's own list (a slice): the same change. It grows past CHART_BARS until it moves.
    if (appended) cx.raw.push(bar);
    else cx.raw[cx.raw.length - 1] = bar;
    return true;
  }

  /** A follow waiting for the next frame. */
  let followFrame = 0;
  /** The view moved (a range change the chart reports): the slice moves on the next frame, once the chart has
   *  applied the view it was asked for (a move inside the report had its view replaced by that one). */
  function followSlice(): boolean {
    if (followFrame || moving || !needsFollow()) return false;
    followFrame = requestAnimationFrame(() => {
      followFrame = 0;
      if (needsFollow()) follow();
    });
    return true;
  }
  onCleanup(() => cancelAnimationFrame(followFrame));

  /** The view is near an end of the slice and loaded bars go on past it. */
  function needsFollow(): boolean {
    if (!sliceable()) return false;
    const n = cx.allBars.length;
    if (cx.raw === cx.allBars && n <= CHART_BARS) return false;
    const r = view();
    if (!r) return false;
    const end = from + cx.raw.length;
    return (from > 0 && r.from < CHART_BARS_MARGIN) || (end < n && r.to > cx.raw.length - CHART_BARS_MARGIN);
  }

  /** A slice centred on the view. */
  function follow(): void {
    const r = view();
    if (r) moveTo(...around(from + (r.from + r.to) / 2));
  }

  function sliceAround(sec: number): boolean {
    if (cx.raw === cx.allBars || cx.raw.length === 0) return false;
    const first = cx.raw[0].time as number;
    const last = cx.raw[cx.raw.length - 1].time as number;
    if (sec >= first && (sec <= last || from + cx.raw.length === cx.allBars.length)) return false;
    return moveTo(...around(lowerBound(cx.allBars, sec)));
  }

  const sliceToEnd = () => cx.raw !== cx.allBars && moveTo(...around(cx.allBars.length));
  const sliceToStart = () => cx.raw !== cx.allBars && moveTo(...around(0));

  return {
    get sliceFrom() {
      return from;
    },
    sliceAtEnd: () => from + cx.raw.length === cx.allBars.length,
    // In Bar Replay the newest bar replayed.
    latestBar: () => (cx.replayActive ? cx.raw[cx.raw.length - 1] : cx.allBars[cx.allBars.length - 1]),
    loadBars,
    prependBars,
    appendBars,
    replaceBars,
    liveBar,
    followSlice,
    sliceAround,
    sliceToEnd,
    sliceToStart,
  };
}
