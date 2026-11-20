/*
 * The time axis and what follows the trading days of the bars: the label
 * formats, the year / month / day ticks in the zone the labels are read in,
 * the session breaks, the pre / post-market tint, the periods a page shades on
 * an embedded chart (#366) and the previous day's close of every bar (the
 * legend's "Last day change").
 */
import { createEffect } from "solid-js";
import { LineSeries, type TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";
import { isIntradayInterval, isIntradayResolution, isSecondResolution, isTickResolution } from "../../../data/datafeed";
import { cachedSymbolSessions } from "../../../data/session";
import { SessionBreaksPrimitive, computeSessionBoundaries } from "../session-breaks";
import { SessionBackgroundsPrimitive, computeSessionRuns } from "../session-backgrounds";
import { EmbedHighlightsPrimitive, type HighlightBand } from "../embed-highlights";
import { chartTimeContext, embedHighlights as pageHighlights, highlightBars, onChart } from "../../../embed/annotations";
import { readFontFamily } from "../chart-tokens";
import { dayKeyer } from "../day-key";
import { zonedTimeScale } from "./zoned-time-scale";
import { barTimeZone, formatAxisTime, formatTick, type AxisFmt } from "./helpers";
import { type ChartCx } from "./context";

/** What createTimeAxis adds to the chart context. */
export interface TimeAxisApi {
  /** Per-bar close of the previous trading day (tz-aware), for the legend's "Last day change". */
  readonly prevDayClose: (number | null)[];
  /** Session-breaks separators and the pre / post-market tint, attached to the main series. */
  sessionBreaks: SessionBreaksPrimitive;
  sessionBackgrounds: SessionBackgroundsPrimitive;
  /** An embedded chart's shaded periods, attached to the main series. */
  embedHighlights: EmbedHighlightsPrimitive;
  /** The chart's time scale behaviour (ticks weighed in the labels' zone). */
  timeScaleBehavior: ReturnType<typeof zonedTimeScale>["behavior"];
  /** Recompute what follows the trading days from the current bars and appearance. */
  updateSessionBreaks: () => void;
}

export function createTimeAxis(cx: ChartCx): TimeAxisApi {
  const { appearance, currentTokens, props } = cx;
  // One instance per chart, re-attached to the price series whenever it's rebuilt (chart-type change).
  const sessionBreaks = new SessionBreaksPrimitive();
  const sessionBackgrounds = new SessionBackgroundsPrimitive();
  const embedHighlights = new EmbedHighlightsPrimitive();
  let prevDayClose: (number | null)[] = [];

  // Year / month / day ticks in the zone the axis labels are read in (#270).
  const tickZone = () => {
    const id = props.interval ?? "1D";
    return {
      tz: props.timeZone ?? "UTC",
      intraday: isSecondResolution(id) || isIntradayResolution(id) || isTickResolution(id),
      exchange: cachedSymbolSessions(props.symbol ?? "")?.timeZone ?? "UTC",
    };
  };
  const timeScale = zonedTimeScale({
    zoneOf: (sec) => {
      const z = tickZone();
      return barTimeZone(z.tz, z.intraday, sec, z.exchange);
    },
    realTime: (t) => cx.realTimeOf(t as Time),
    key: () => {
      const z = tickZone();
      return `${z.tz}|${z.intraday}|${z.exchange}`;
    },
  });
  /** The library weighs the bars only when the time points change: after a
   *  zone change (time zone, interval with the same first bars, sessions
   *  resolved late) a placeholder point before the first bar, added and
   *  removed, makes it weigh them all again. */
  function refreshTickWeights() {
    const { chart } = cx;
    if (!chart || !timeScale.stale()) return;
    const s = chart.addSeries(LineSeries, { visible: false, lastValueVisible: false, priceLineVisible: false });
    s.setData([{ time: 1 as UTCTimestamp }]);
    chart.removeSeries(s);
  }

  /** Rebuild {@link prevDayClose}: for each bar, the close of the last bar of the
   *  PREVIOUS trading day (in the chart timezone). O(n) per data change, so the
   *  legend's "Last day change" is an O(1) lookup per crosshair move. On daily+
   *  frames the day always changes, so it equals the prior bar's close. */
  function recomputePrevDayClose() {
    const { raw } = cx;
    const n = raw.length;
    prevDayClose = new Array(n).fill(null);
    if (n === 0) return;
    const dayOf = dayKeyer(props.timeZone ?? "UTC");
    let curDay = dayOf(raw[0].time as number);
    let lastClosePrevDay: number | null = null;
    for (let i = 0; i < n; i++) {
      const day = dayOf(raw[i].time as number);
      if (day !== curDay) { lastClosePrevDay = raw[i - 1].close; curDay = day; }
      prevDayClose[i] = lastClosePrevDay;
    }
  }

  /** Recompute session-break boundaries from the current bars and push the
   *  committed appearance (on/off + colour) onto the primitive. Cheap and
   *  idempotent — safe to call after every data load / appearance change. */
  function updateSessionBreaks() {
    refreshTickWeights();
    cx.syncFutureBars();
    const t = currentTokens();
    const raw = cx.raw as readonly { time: number }[];
    const intraday = isIntradayInterval(props.interval ?? "1D");
    const sessions = cachedSymbolSessions(props.symbol ?? "");
    const times = t.sessionBreaksVisible && sessions
      ? computeSessionBoundaries(raw, intraday, sessions.spec(props.session ?? "RTH"))
      : [];
    sessionBreaks.setData(times, t.sessionBreaksColor, t.sessionBreaksVisible, t.sessionBreaksStyle, t.sessionBreaksWidth);
    // Pre/post-market tint: only when the chart draws extended-hours bars.
    sessionBackgrounds.setColors(t.preMarketBgColor, t.postMarketBgColor);
    sessionBackgrounds.setRuns(
      intraday && sessions && (props.session ?? "RTH") === "ETH"
        ? computeSessionRuns(raw, sessions)
        : [],
    );
    updateEmbedHighlights();
    recomputePrevDayClose();
    cx.updatePrevClosePriceLine();
    cx.updateHighLowLines();
  }

  /** The page's periods on this chart's symbol, placed on the current bars. */
  function updateEmbedHighlights() {
    const list = pageHighlights().filter((h) => onChart(h.symbol, props.symbol ?? ""));
    const raw = cx.raw as readonly { time: number }[];
    const bands: HighlightBand[] = [];
    if (list.length && raw.length) {
      const tc = chartTimeContext(props.symbol ?? "", props.interval ?? "1D");
      for (const h of list) {
        const r = highlightBars(raw, h, tc);
        if (r) bands.push({ from: raw[r.first].time, to: raw[r.last].time, color: h.color, label: h.label });
      }
    }
    const t = currentTokens();
    embedHighlights.setBands(bands, t.text, t.bg, readFontFamily());
  }
  createEffect(() => {
    pageHighlights();
    updateEmbedHighlights();
  });

  // Time-axis precision: seconds show "14:30:05", intraday "Apr 22 14:30",
  // daily/weekly/monthly just "Apr 22".
  createEffect(() => {
    const { chart } = cx;
    if (!chart) return;
    const id = props.interval ?? "1D";
    // Tick bars show seconds on the axis and milliseconds on the crosshair (#376).
    const ticks = isTickResolution(id);
    const second = isSecondResolution(id) || ticks;
    const intraday = isIntradayResolution(id);
    const tz = props.timeZone ?? "UTC";
    // Scales → Date / Time format (per pane). Reading appearance() here re-runs
    // the effect — and re-applies the formatters — when the settings change.
    const a = appearance();
    const axisFmt: AxisFmt = { dateFormat: a.dateFormat, timeFormat: a.timeFormat, dayOfWeek: a.dayOfWeek };
    // Daily bars read their date in the exchange zone they are stamped in. Looked up per label: the
    // symbol's sessions resolve before its first bars, possibly after this effect ran.
    const exchangeZone = () => cachedSymbolSessions(props.symbol ?? "")?.timeZone ?? "UTC";
    chart.applyOptions({
      timeScale: {
        timeVisible: second || intraday,
        secondsVisible: second,
        tickMarkFormatter: (t: Time, tt: TickMarkType) =>
          formatTick(cx.realTimeOf(t), tt, tz, axisFmt, second || intraday, exchangeZone()),
      },
      localization: {
        timeFormatter: (t: Time) =>
          formatAxisTime(cx.realTimeOf(t), tz, isIntradayInterval(id), /[ST]$/.test(id.toUpperCase()), axisFmt, exchangeZone(), ticks),
      },
    });
    // Day rollover (and thus session-break placement) depends on the timezone,
    // so recompute when interval / timezone changes even without a data reload.
    updateSessionBreaks();
  });

  return {
    get prevDayClose() {
      return prevDayClose;
    },
    sessionBreaks,
    sessionBackgrounds,
    embedHighlights,
    timeScaleBehavior: timeScale.behavior,
    updateSessionBreaks,
  };
}
