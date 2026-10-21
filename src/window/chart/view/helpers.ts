/*
 * ChartView helpers with no chart state: view constants, axis/time text,
 * colour arithmetic, chart options from the appearance tokens, the legend
 * values of a bar and the backend candle mapping.
 */
import { ColorType, LineStyle, TickMarkType, type ISeriesApi, type SeriesType, type UTCTimestamp } from "lightweight-charts";
import { readChartTokens } from "../chart-tokens";
import { formatChartTime, formatTickMark } from "../time-format";
import { type PriceSource } from "../../header/chart-settings";
import { priceOf } from "../series-transforms";
import { type Candle } from "../../../bindings";
import { legendShowsSingleValue, type ChartTypeId, type OHLC } from "../chart-types";
import { type LegendValues } from "../ChartLegend";

/** Scroll-back: when the visible range's left edge comes within this many bars
 *  of index 0, page one older window in and prepend it (mirrors the mock). */
export const LOAD_MORE_THRESHOLD = 12;
/** Length of the logical range that shows bars `spacing` px wide on a
 *  `width` px time scale: a range of length L draws L + 1 bars. */
export const barsSpan = (width: number, spacing: number) => width / spacing - 1;
/** Fewest bars a restored saved view may show. A narrower range is the 1-bar
 *  collapse the old sync path could persist, not a user choice. Same floor as
 *  the wheel zoom (onWheel). */
export const MIN_VISIBLE_BARS = 5;
/** A symbol change keeps the distance to the last bar up to this many bars back
 *  (the reference opens a new symbol on a first window of 300 bars and keeps 2
 *  of them in view: a chart scrolled back 300 or 528 bars lands 298 bars back). */
export const SYMBOL_CHANGE_MAX_BACK = 298;
/** Fewest bars a date-range sync target frames (the time scale's minimum
 *  visible bar count). */
export const SYNC_MIN_BARS = 2;
/** Depth cap for history loaded on behalf of date-range / time sync (display
 *  bars); the user's own scroll-back pager is not capped. Measured 29/09/2026
 *  (.tmp/goto-sync): a 1m pane at ~94k bars blocks the main thread up to
 *  ~190 ms per load, at 250k bars up to 853 ms. 100k = about one year of 1m
 *  regular-session bars (20k reached only ~50 sessions back). */
export const SYNC_LOAD_MAX_BARS = 100_000;
/** Pause after the last landed history page before studies recompute. */
export const INDICATOR_RENDER_DEBOUNCE_MS = 150;
/** Date-range sync: a follower loads missing history once the driving pane
 *  has been still this long. Each load re-sets the whole series and its
 *  studies (05/10/2026, .tmp/scroll-lag: 50-200 ms per load on a 5m pane at
 *  25-43k bars), so loading on every move of a scroll made it lag. */
export const SYNC_LOAD_QUIET_MS = 200;

/** Time-axis formatting from the Settings dialog (Scales tab). */
export type AxisFmt = { dateFormat?: string; timeFormat?: string; dayOfWeek?: boolean };

/** Zone the labels of a chart's bar times are read in. Daily-and-up bars
 *  stand for a date (daily at the exchange's midnight, weekly / monthly at
 *  UTC midnight), the same in any chart time zone: read in UTC, as the time
 *  scale does when it places the year / month / day ticks. Otherwise a weekly
 *  bar of Mon 1 Jan read in New York is Sun 31 Dec and its year tick "2023". */
export const barTimeZone = (timeZone: string, intraday: boolean): string => (intraday ? timeZone : "UTC");

/** Crosshair time-axis label, in the chosen IANA timezone: the chart
 *  date-time text ("Wed 23 Sep '26   14:00"; date only on daily+ bars). */
export function formatAxisTime(time: UTCTimestamp, timeZone: string, intraday: boolean, seconds: boolean, fmt: AxisFmt = {}): string {
  return formatChartTime(time as number, barTimeZone(timeZone, intraday), intraday, seconds, fmt);
}

/** Time-axis tick label in the chosen IANA timezone (tick-mark text). */
export function formatTick(time: UTCTimestamp, type: TickMarkType, timeZone: string, fmt: AxisFmt = {}, intraday = true): string {
  const kind =
    type === TickMarkType.Year ? "Year"
    : type === TickMarkType.Month ? "Month"
    : type === TickMarkType.DayOfMonth ? "DayOfMonth"
    : type === TickMarkType.TimeWithSeconds ? "TimeWithSeconds"
    : "Time";
  return formatTickMark(time as number, kind, barTimeZone(timeZone, intraday), fmt.timeFormat);
}

// Binary-search the (time-ascending) bar array for an exact timestamp match,
// returning its index or -1. Maps a crosshair time back to its bar.
export function indexOfTime(bars: OHLC[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid].time as number;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Non-series chart options derived from this pane's committed appearance tokens
 *  (Canvas tab: background, grid, crosshair, scale text/lines, price margins).
 *  Shared by createChart and the theme/appearance effect so both stay in lockstep.
 *  `rightOffset` is applied only off the initial mount (it nudges the view
 *  framing, so we don't force it at create time). */

/** Colour at fraction `t` (0..1) between two hex / rgb(a) colours. */
export function mixColor(a: string, b: string, t: number): string {
  const parse = (c: string): number[] => {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c.trim());
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    const h = /^#([0-9a-f]{6})/i.exec(c.trim());
    return h ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)] : [0, 0, 0];
  };
  const x = parse(a);
  const y = parse(b);
  const v = x.map((n, i) => Math.round(n + (y[i] - n) * t));
  return `rgb(${v[0]}, ${v[1]}, ${v[2]})`;
}

/** Text colour from background: brightness .199R + .687G + .114B below 150
 *  gets white text, otherwise black. */
export function textColorOn(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  const h = /^#([0-9a-f]{6})/i.exec(color.trim());
  const [r, g, b] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : h
      ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)]
      : [0, 0, 0];
  return 0.199 * r + 0.687 * g + 0.114 * b < 150 ? "#ffffff" : "#000000";
}

export function appearanceOptions(t: ReturnType<typeof readChartTokens>) {
  // Picker enum (0 solid / 1 dashed / 2 dotted) → lightweight-charts LineStyle
  // (Solid 0, Dotted 1, Dashed 2).
  const cross = [LineStyle.Solid, LineStyle.Dashed, LineStyle.Dotted][t.crosshairStyle] ?? LineStyle.Dashed;
  const crossWidth = Math.max(1, Math.min(4, t.crosshairWidth)) as 1 | 2 | 3 | 4;
  const background = t.bgGradient
    ? { type: ColorType.VerticalGradient as const, topColor: t.bg, bottomColor: t.bgBottom }
    : { type: ColorType.Solid as const, color: t.bg };
  // Scales placement: show only the chosen side. A series with no explicit
  // priceScaleId binds to the visible scale ('right' if visible, else 'left'),
  // so toggling visibility before (re)building the series moves the price axis.
  const onLeft = t.scalesPlacement === "left";
  // Scales → "No overlapping labels" = the library's alignLabels (the
  // restacking of colliding labels).
  const scaleOpts = {
    borderColor: t.scaleLinesColor,
    scaleMargins: { top: t.marginTop, bottom: t.marginBottom },
    alignLabels: t.alignLabels,
  };
  return {
    layout: {
      background,
      textColor: t.scaleTextColor,
      fontSize: t.scaleFontSize,
      // No logo on the chart: the library's attribution notice and link are
      // in the README ("Third-party notices"), as its licence allows.
      attributionLogo: false,
      // The library defaults are light-theme (#E0E3EB separator) — theme the
      // stacked-pane divider like the rest of the chrome.
      panes: {
        separatorColor: t.paneSeparator,
        separatorHoverColor: "rgba(178, 181, 189, 0.2)",
        enableResize: true,
      },
    },
    grid: {
      // Grid "dotted" maps to SparseDotted (1px on / 4 off): the target dotted
      // grid is 1 on / 3 off, and the library's Dotted (1 on / 1 off) reads
      // twice as heavy.
      vertLines: {
        color: t.gridVertColor,
        visible: t.gridVertVisible,
        style: [LineStyle.Solid, LineStyle.Dashed, LineStyle.SparseDotted][t.gridVertStyle] ?? LineStyle.Solid,
      },
      horzLines: {
        color: t.gridHorzColor,
        visible: t.gridHorzVisible,
        style: [LineStyle.Solid, LineStyle.Dashed, LineStyle.SparseDotted][t.gridHorzStyle] ?? LineStyle.Solid,
      },
    },
    crosshair: {
      vertLine: { color: t.crosshairColor, style: cross, width: crossWidth, labelBackgroundColor: t.crosshairLabelBg },
      horzLine: { color: t.crosshairColor, style: cross, width: crossWidth, labelBackgroundColor: t.crosshairLabelBg },
    },
    rightPriceScale: { ...scaleOpts, visible: !onLeft },
    leftPriceScale: { ...scaleOpts, visible: onLeft },
    // A series with no scale id takes the chosen side even while the other
    // side is shown too (the series in a study pane, a compared symbol on a
    // new price scale).
    defaultVisiblePriceScaleId: onLeft ? ("left" as const) : ("right" as const),
    timeScale: { borderColor: t.scaleLinesColor },
  };
}

// Resolve the legend's values for the bar at `idx`. Change is close minus the
// previous bar's close; colours follow the bar's direction for O/H/L/C and the
// change sign for the single-line value. (Reference: mock buildLegend.)
export function buildLegend(bars: OHLC[], idx: number, type: ChartTypeId, prevDayClose: number | null, src: PriceSource = "close"): LegendValues {
  const bar = bars[idx];
  const single = legendShowsSingleValue(type);
  // Single-value types show their price source (Symbol tab "Price source").
  const value = (b: OHLC) => (single ? priceOf(b, src) : b.close);
  const prevClose = idx > 0 ? value(bars[idx - 1]) : null;
  const changeAbs = prevClose == null ? 0 : value(bar) - prevClose;
  const changePct = prevClose ? (changeAbs / prevClose) * 100 : 0;
  const ldAbs = prevDayClose == null ? 0 : bar.close - prevDayClose;
  const ldPct = prevDayClose ? (ldAbs / prevDayClose) * 100 : 0;
  return {
    single,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: value(bar),
    changeAbs,
    changePct,
    barDir: bar.close >= bar.open ? "up" : "down",
    changeDir: changeAbs >= 0 ? "up" : "down",
    volume: bar.volume,
    lastDayChangeAbs: ldAbs,
    lastDayChangePct: ldPct,
    lastDayChangeDir: ldAbs >= 0 ? "up" : "down",
  };
}

/** Map backend `Candle[]` → the chart's `OHLC[]`, dropping any null-field
 *  bars. Shared by the initial apply effect, the scroll-back pager and the
 *  compared symbols. */
export function toOHLC(rows: Candle[]): OHLC[] {
    return rows
      .filter((c) => c.time != null && c.open != null && c.high != null && c.low != null && c.close != null)
      .map((c) => ({
        time: c.time as unknown as UTCTimestamp,
        open: c.open as number,
        high: c.high as number,
        low: c.low as number,
        close: c.close as number,
        volume: c.volume ?? undefined,
      }));
  }

/** Price text of the chart menus (same decimals as "Copy price"). */
export const menuPrice = (v: number) => {
    const a = Math.abs(v);
    return v.toFixed(a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
  };

/** Price rounded to what its formatter shows (the alert value). */
export function roundedPrice(p: number, format: (n: number) => string): number {
    const n = Number(format(p).replace(/−/g, "-").replace(/[^0-9.eE+-]/g, ""));
    return Number.isFinite(n) ? n : p;
  }

/** A price rounded as the series writes its values. */
export function roundedOnSeries(s: ISeriesApi<SeriesType>, v: number): number {
    const text = s.priceFormatter().format(v).replace(/,/g, "").replace(/\u2212/g, "-");
    const n = Number(text);
    return Number.isFinite(n) ? n : v;
  }
