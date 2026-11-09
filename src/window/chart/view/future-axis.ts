/*
 * Future bars on the symbol's trading calendar after the last bar: the axis
 * for the drawings and markers placed there (the time scale continues with the
 * bars the symbol would open), and the hidden series of whitespace that makes
 * the time scale label them as it labels the bars. Null on the brick / line
 * types (synthetic times) and until the sessions are known.
 */
import { LineSeries, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { isTransformType } from "../chart-types";
import { cachedSymbolSessions } from "../../../data/session";
import { sessionFutureAxis, sessionFutureTimes } from "../indicators/future-slots";
import type { FutureAxis } from "../../drawings/coords";
import { upperBound } from "../time-search";
import { type ChartCx } from "./context";

/** Spare future bars past the view (a chart with a wide right margin, a window made wider). */
const FUTURE_BARS_SPARE = 500;

/** What createFutureAxis adds to the chart context. */
export interface FutureAxisApi {
  /** The future bars after the last bar, null when there are none to place things on. */
  futureAxis: () => FutureAxis | null;
  /** Build the future bars of the time scale for the current bars and view (nothing when they still cover it). */
  syncFutureBars: () => void;
  /** Remove the future bars' series (the main series is built again). */
  dropFutureSeries: () => void;
  /** The view moved: more future bars once it reaches past the built ones (queued: not from inside the library's
   *  range callback). */
  extendFutureBars: () => void;
}

export function createFutureAxis(cx: ChartCx): FutureAxisApi {
  const { props } = cx;
  // Rebuilt only when the symbol, interval, session or sessions change.
  let futureKey = "";
  let futureSpec: unknown = null;
  let futureValue: FutureAxis | null = null;
  function futureAxis(): FutureAxis | null {
    if (isTransformType(cx.activeType)) return null;
    const sessions = cachedSymbolSessions(props.symbol ?? "");
    if (!sessions) return null;
    const interval = props.interval ?? "1D";
    const session = props.session ?? "RTH";
    const spec = sessions.spec(session);
    const key = `${props.symbol}|${interval}|${session}`;
    if (key !== futureKey || futureSpec !== spec) {
      futureKey = key;
      futureSpec = spec;
      futureValue = sessionFutureAxis(interval, spec, sessions.regular);
    }
    return futureValue;
  }
  cx.eventMarkers.setFutureAccessor(futureAxis);

  // The time scale's bars after the last bar, on a hidden series of whitespace: the axis then labels the future as it
  // labels the bars. Whitespace leaves the last bar and the right margin where they are (the library counts them from
  // the last bar with data). Built again for another calendar, or when the view gets near the end of them.
  let futureSeries: ISeriesApi<"Line"> | null = null;
  let futureBuilt: { key: string; spec: unknown; last: number; times: number[] } | null = null;
  let futureQueued = false;
  function dropFutureSeries() {
    if (futureSeries) cx.chart?.removeSeries(futureSeries);
    futureSeries = null;
    futureBuilt = null;
  }
  /** Future bars the view needs after the last bar. */
  function futureBarsNeeded(): number {
    const to = cx.chart?.timeScale().getVisibleLogicalRange()?.to ?? 0;
    return Math.max(0, Math.ceil(to - (cx.mainLastIndex() ?? 0))) + FUTURE_BARS_SPARE;
  }
  /** Built future bars after the last bar. */
  function futureBarsLeft(times: number[], last: number): number {
    return times.length - upperBound(times, last);
  }
  function syncFutureBars() {
    const { chart, raw } = cx;
    if (!chart || !cx.series) return;
    const spec = raw.length > 0 ? cachedSymbolSessions(props.symbol ?? "")?.spec(props.session ?? "RTH") : null;
    if (!spec) {
      if (futureBuilt) {
        futureSeries?.setData([]);
        futureBuilt = null;
      }
      return;
    }
    const last = raw[raw.length - 1].time as number;
    const needed = futureBarsNeeded();
    const key = `${props.symbol}|${props.interval}|${props.session}`;
    if (futureBuilt && futureBuilt.key === key && futureBuilt.spec === spec && last >= futureBuilt.last && futureBarsLeft(futureBuilt.times, last) >= needed) return;
    const times = sessionFutureTimes(props.interval ?? "1D", spec, last, needed * 2);
    if (times.length === 0) return;
    futureSeries ??= chart.addSeries(LineSeries, { visible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, priceScaleId: "future-bars" }, cx.mainPane());
    futureSeries.setData(times.map((t) => ({ time: t as UTCTimestamp })));
    futureBuilt = { key, spec, last, times };
  }
  function extendFutureBars() {
    const { raw } = cx;
    if (futureBuilt && raw.length > 0 && !futureQueued && futureBarsLeft(futureBuilt.times, raw[raw.length - 1].time as number) < futureBarsNeeded()) {
      futureQueued = true;
      queueMicrotask(() => {
        futureQueued = false;
        syncFutureBars();
      });
    }
  }

  return { futureAxis, syncFutureBars, dropFutureSeries, extendFutureBars };
}
