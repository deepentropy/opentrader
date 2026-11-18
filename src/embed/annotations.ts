/*
 * The marks and shaded periods a page puts on an embedded chart (#366), and
 * the bars they land on.
 *
 * A page's time is read on each chart in that chart's terms, in the exchange's
 * zone: on daily, weekly and monthly bars as a date (the bar of that date, or
 * the week or month holding it); on intraday bars a date is the whole day and
 * a time the bar holding it.
 */
import { createSignal } from "solid-js";
import type { EmbedConfig, EmbedHighlight, EmbedMarker, EmbedTime } from "./config";
import { utcToWall, wallTimeToUtc } from "../window/chart/day-key";
import { lastAtOrBefore } from "../window/chart/time-search";
import { isIntradayResolution, isSecondResolution } from "../data/datafeed";
import { cachedSymbolSessions } from "../data/session";
import { intervalSeconds } from "../data/interval";

const [markers, setMarkers] = createSignal<EmbedMarker[]>([]);
const [highlights, setHighlights] = createSignal<EmbedHighlight[]>([]);

/** The page's marks and periods, as last set. */
export const embedMarkers = markers;
export const embedHighlights = highlights;

/** Takes the page's marks and periods (the settings at start, or changed in place). */
export function setEmbedAnnotations(c: Pick<EmbedConfig, "markers" | "highlights">): void {
  setMarkers(c.markers);
  setHighlights(c.highlights);
}

/** Whether a mark or period with this `symbol` belongs on the chart of `chartSymbol`. */
export const onChart = (symbol: string | undefined, chartSymbol: string): boolean =>
  !symbol || symbol.toUpperCase() === chartSymbol.toUpperCase();

/** How a chart reads a page's time. */
export type TimeContext = {
  /** Daily, weekly or monthly bars. */
  dwm: boolean;
  /** The symbol's exchange time zone. */
  zone: string;
  /** One bar's length in seconds. */
  barSec: number;
};

/** How the chart of `symbol` at `interval` reads a page's time. */
export function chartTimeContext(symbol: string, interval: string): TimeContext {
  return {
    dwm: !isIntradayResolution(interval) && !isSecondResolution(interval),
    zone: cachedSymbolSessions(symbol)?.timeZone ?? "UTC",
    barSec: intervalSeconds(interval) ?? 86400,
  };
}

/** The span a page's time covers on a chart: [start, end) in UNIX seconds; `point` for a time, not a day. */
type Span = { start: number; end: number; point: boolean };

function spanOf(t: EmbedTime, cx: TimeContext): Span {
  // Daily, weekly and monthly bars are stamped at the exchange's midnight: any time there is its day.
  if ("date" in t || cx.dwm) {
    const { y, m, d } = "date" in t ? t.date : "wall" in t ? t.wall : utcToWall(cx.zone, t.sec);
    return { start: wallTimeToUtc(cx.zone, y, m, d, 0, 0), end: wallTimeToUtc(cx.zone, y, m, d + 1, 0, 0), point: false };
  }
  const sec = "wall" in t ? wallTimeToUtc(cx.zone, t.wall.y, t.wall.m, t.wall.d, Math.floor(t.wall.minutes / 60), t.wall.minutes % 60) : t.sec;
  return { start: sec, end: sec + 1, point: true };
}

type Bars = ReadonlyArray<{ time: unknown }>;
const timeAt = (bars: Bars, i: number) => bars[i].time as number;

/** Index of the first bar holding or after `span`'s start, or -1 past the last bar. */
function firstBar(bars: Bars, span: Span, barSec: number): number {
  const i = lastAtOrBefore(bars, span.start);
  if (i >= 0 && timeAt(bars, i) + barSec > span.start) return i;
  return i + 1 < bars.length ? i + 1 : -1;
}

/** Index of the bar a mark at `t` sits on, or -1 when the loaded bars do not hold it. */
export function markerBar(bars: Bars, t: EmbedTime, cx: TimeContext): number {
  if (bars.length === 0) return -1;
  const span = spanOf(t, cx);
  if (span.point) {
    // The bar holding the time; between sessions, the bar before it. Past the last bar's end: not loaded yet.
    const i = lastAtOrBefore(bars, span.start);
    if (i < 0 || (i === bars.length - 1 && timeAt(bars, i) + cx.barSec <= span.start)) return -1;
    return i;
  }
  // A date: its first bar (a day without bars has none), or the week or month holding it.
  const i = firstBar(bars, span, cx.barSec);
  return i >= 0 && timeAt(bars, i) < span.end ? i : -1;
}

/** First and last bar indexes a period covers, or null when no loaded bar is in it. */
export function highlightBars(bars: Bars, h: Pick<EmbedHighlight, "from" | "to">, cx: TimeContext): { first: number; last: number } | null {
  if (bars.length === 0) return null;
  let a = spanOf(h.from, cx);
  let b = spanOf(h.to, cx);
  if (b.end < a.start) [a, b] = [b, a];
  const first = firstBar(bars, a, cx.barSec);
  const last = lastAtOrBefore(bars, b.end - 1);
  return first >= 0 && last >= first ? { first, last } : null;
}

/** The span `from`–`to` frames on a chart, in UNIX seconds (the last second of `to`). */
export function frameSpan(from: EmbedTime, to: EmbedTime, cx: TimeContext): { from: number; to: number } {
  const a = spanOf(from, cx);
  const b = spanOf(to, cx);
  return { from: Math.min(a.start, b.start), to: Math.max(a.end, b.end) - 1 };
}
