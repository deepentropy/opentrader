/*
 * Chart-type mapping for lightweight-charts (v5).
 *
 * Ported from the reference mock.
 * Every id in the union renders for real. The types without a built-in series
 * (kagi, pnf, svp, tpo, volFootprint, hlcArea, volCandles, hilo) are
 * lightweight-charts CUSTOM series — transforms + pane renderers live in
 * ./custom-series.ts.
 *
 * Every type reads its Symbol-tab style rows from `tokens.styles`
 * (chart-settings SeriesStyles, factory defaults when uncommitted).
 *
 * Notes on specific types:
 *   • renko / pb / kagi / pnf / range — series-transforms.ts (box-size
 *                    methods, projection bars from the forming bar).
 *   • line family  — Solid = library line; Gradient = GradientLinePaneView.
 *   • column       — ColumnPaneView (columns stand on the pane bottom).
 *   • volCandles   — candle BODY WIDTH scales with volume/max-volume.
 *   • hlcArea      — high/low/close lines + two band fills.
 *   • hilo         — high→low body + value labels.
 *   • volFootprint — per-bar buy/sell cells need 1-minute sub-bars; ChartView
 *                    passes them via setDataForType's `extras` (intraday only;
 *                    bars without sub-data render as plain candles).
 */
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  LineType,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import type { ChartTokens } from "./chart-tokens";
import type { CandleStyleS } from "../header/chart-settings";
import {
  FootprintPaneView,
  HiLoPaneView,
  HlcAreaPaneView,
  KagiPaneView,
  PnfPaneView,
  ProfilePaneView,
  VolCandlePaneView,
  toFootprint,
  toHiLo,
  toHlcArea,
  toProfile,
  toVolCandles,
} from "./custom-series";
import { ColumnPaneView, GradientLinePaneView, type ColumnItem } from "./series-views";
import {
  boxSize,
  priceOf,
  rangeSize,
  toHeikinAshi,
  toKagi,
  toLineBreak,
  toPnf,
  toRangeBars,
  toRenko,
  type Brick,
  type Candle,
} from "./series-transforms";

// v5 moved markers off the series API into the createSeriesMarkers plugin. One
// plugin per series (cached), reused across setDataForType calls. Used for the
// lineWithMarkers chart type's per-point circles. (Reference: mock chart-types.)
const markersPlugins = new WeakMap<AnySeries, ISeriesMarkersPluginApi<Time>>();
function ensureMarkers(series: AnySeries): ISeriesMarkersPluginApi<Time> {
  let plugin = markersPlugins.get(series);
  if (!plugin) {
    plugin = createSeriesMarkers(series, []);
    markersPlugins.set(series, plugin);
  }
  return plugin;
}

export type ChartTypeId =
  | "bar" | "candle" | "hollowCandle" | "volCandles"
  | "line" | "lineWithMarkers" | "stepline"
  | "area" | "hlcArea" | "baseline"
  | "column" | "hilo"
  | "volFootprint" | "tpo" | "svp"
  | "ha" | "renko" | "pb" | "kagi" | "pnf" | "range";

export const DEFAULT_CHART_TYPE: ChartTypeId = "candle";

export const CHART_TYPE_IDS: ReadonlySet<ChartTypeId> = new Set<ChartTypeId>([
  "bar", "candle", "hollowCandle", "volCandles",
  "line", "lineWithMarkers", "stepline",
  "area", "hlcArea", "baseline",
  "column", "hilo",
  "volFootprint", "tpo", "svp",
  "ha", "renko", "pb", "kagi", "pnf", "range",
]);

/** Icon name (in src/assets/icons) for each chart type. Only the 9 we ship
 *  actually have icons on disk; the rest reference a name Icon will no-op
 *  on, so the header button stays usable but icon-less for unsupported types. */
export const CHART_TYPE_ICON: Record<ChartTypeId, string> = {
  bar: "menu-candles-bars",
  candle: "menu-candles-candles",
  hollowCandle: "menu-candles-hollow-candles",
  volCandles: "menu-candles-volume-candles",
  line: "menu-candles-line",
  lineWithMarkers: "menu-candles-line-with-markers",
  stepline: "menu-candles-step-line",
  area: "menu-candles-area",
  hlcArea: "menu-candles-hlc-area",
  baseline: "menu-candles-baseline",
  column: "menu-candles-columns",
  hilo: "menu-candles-high-low",
  volFootprint: "menu-candles-volume-footprint",
  tpo: "menu-candles-time-price-opportunity",
  svp: "menu-candles-session-volume-profile",
  ha: "menu-candles-heikin-ashi",
  renko: "menu-candles-renko",
  pb: "menu-candles-line-break",
  kagi: "menu-candles-kagi",
  pnf: "menu-candles-point-figure",
  range: "menu-candles-range",
};

export type { OHLC } from "lightweight-charts-drawing/core/coords";
import type { OHLC } from "lightweight-charts-drawing/core/coords";
import type { SymbolSessions } from "../../data/session";

export type AnySeries = ISeriesApi<
  "Candlestick" | "Bar" | "Line" | "Area" | "Baseline" | "Histogram" | "Custom"
>;

/** TRUE when the top-left legend collapses to a single value instead of the
 *  full O/H/L/C row. The line/area/baseline/column family is built
 *  from one price per bar (the close), so its legend shows just that value;
 *  the bar/candle family (and the algorithmic candle transforms) show all
 *  four. */
export function legendShowsSingleValue(type: ChartTypeId): boolean {
  switch (type) {
    case "line":
    case "lineWithMarkers":
    case "stepline":
    case "area":
    case "hlcArea":
    case "baseline":
    case "column":
      return true;
    default:
      return false;
  }
}

/** Library line style of the picker enum (0 solid, 1 dashed, 2 dotted). */
export function libLineStyle(style: number): LineStyle {
  return style === 1 ? LineStyle.Dashed : style === 2 ? LineStyle.Dotted : LineStyle.Solid;
}
const width4 = (w: number) => Math.max(1, Math.min(4, Math.round(w))) as 1 | 2 | 3 | 4;
const TRANSPARENT = "rgba(0,0,0,0)";

/** Candlestick options of a Body / Borders / Wick style (candle rows). */
function candleOptions(c: CandleStyleS) {
  return {
    upColor: c.body ? c.bodyUp : TRANSPARENT,
    downColor: c.body ? c.bodyDown : TRANSPARENT,
    wickVisible: c.wick,
    wickUpColor: c.wickUp,
    wickDownColor: c.wickDown,
    borderVisible: c.border,
    borderUpColor: c.borderUp,
    borderDownColor: c.borderDown,
  };
}

/** Types whose series is rebuilt from the whole history on every live bar
 *  (price-based transforms and the full-width profile / gradient renderers). */
export function isTransformType(type: ChartTypeId): boolean {
  return type === "renko" || type === "pb" || type === "kagi" || type === "pnf" || type === "range";
}

export function createSeriesForType(
  chart: IChartApi,
  type: ChartTypeId,
  tokens: ChartTokens,
): AnySeries {
  const st = tokens.styles;
  switch (type) {
    case "bar":
      // Bars: up / down colours, "HLC bars" hides the open tick, thin bars.
      return chart.addSeries(BarSeries, {
        upColor: st.bar.up,
        downColor: st.bar.down,
        openVisible: !st.bar.hlc,
        thinBars: st.bar.thin,
      });
    case "hollowCandle":
      // Per-bar colours in setDataForType (hollow rule).
      return chart.addSeries(CandlestickSeries, candleOptions(st.hollowCandle));
    case "line":
    case "lineWithMarkers":
    case "stepline": {
      const s = st[type];
      if (s.type === "Gradient") {
        return chart.addCustomSeries(
          new GradientLinePaneView({ start: s.start, end: s.end, width: s.width, style: s.style, step: type === "stepline", markers: type === "lineWithMarkers" }),
          { priceLineVisible: true, color: s.end, priceLineStyle: LineStyle.Dotted },
        );
      }
      return chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: width4(s.width),
        lineStyle: libLineStyle(s.style),
        lineType: type === "stepline" ? LineType.WithSteps : LineType.Simple,
      });
    }
    case "area":
      return chart.addSeries(AreaSeries, {
        lineColor: st.area.line.color,
        lineWidth: width4(st.area.line.width),
        lineStyle: libLineStyle(st.area.line.style),
        topColor: st.area.top,
        bottomColor: st.area.bottom,
      });
    case "hlcArea":
      return chart.addCustomSeries(new HlcAreaPaneView(tokens), {
        priceLineVisible: true,
        color: st.hlcArea.close.color,
      });
    case "hilo":
      return chart.addCustomSeries(new HiLoPaneView(tokens), {
        priceLineVisible: true,
        color: st.hilo.bodyColor,
      });
    case "baseline": {
      const b = st.baseline;
      // baseValue follows the Base level % of the pane (ChartView keeps it
      // in sync with the visible price range).
      return chart.addSeries(BaselineSeries, {
        // The library draws both halves with ONE width / style: the Top
        // line's (the settings keep them separate).
        topLineColor: b.top.color,
        bottomLineColor: b.bottom.color,
        lineWidth: width4(b.top.width),
        lineStyle: libLineStyle(b.top.style),
        topFillColor1: b.topFill1,
        topFillColor2: b.topFill2,
        bottomFillColor1: b.bottomFill1,
        bottomFillColor2: b.bottomFill2,
      });
    }
    case "column":
      return chart.addCustomSeries(new ColumnPaneView(), { priceLineVisible: true, color: st.column.up });
    case "kagi":
      return chart.addCustomSeries(new KagiPaneView(tokens), { priceLineVisible: true });
    case "pnf":
      return chart.addCustomSeries(new PnfPaneView(tokens), { priceLineVisible: true });
    case "svp":
      return chart.addCustomSeries(new ProfilePaneView(tokens, "svp"), { priceLineVisible: true });
    case "tpo":
      return chart.addCustomSeries(new ProfilePaneView(tokens, "tpo"), { priceLineVisible: true });
    case "volFootprint":
      return chart.addCustomSeries(new FootprintPaneView(tokens), { priceLineVisible: true });
    case "volCandles":
      return chart.addCustomSeries(new VolCandlePaneView(tokens), {
        priceLineVisible: true,
        color: st.volCandles.bodyUp,
      });
    case "range":
      if (st.range.style === "Bars") {
        return chart.addSeries(BarSeries, {
          upColor: st.range.up,
          downColor: st.range.down,
          openVisible: true,
          thinBars: st.range.thin,
        });
      }
      return chart.addSeries(CandlestickSeries, {
        upColor: st.range.body.up,
        downColor: st.range.body.down,
        borderUpColor: st.range.border.up,
        borderDownColor: st.range.border.down,
        wickUpColor: st.range.wick.up,
        wickDownColor: st.range.wick.down,
        borderVisible: true,
        wickVisible: true,
      });
    case "renko":
    case "pb": {
      // Up / Down bars = fill + border; per-brick colours (incl. projection)
      // in setDataForType. Renko wicks follow the Wick row.
      const s = st[type];
      return chart.addSeries(CandlestickSeries, {
        upColor: s.up.fill,
        downColor: s.down.fill,
        borderUpColor: s.up.border,
        borderDownColor: s.down.border,
        borderVisible: true,
        wickVisible: type === "renko" && st.renko.wick,
        wickUpColor: type === "renko" ? st.renko.wickUp : s.up.border,
        wickDownColor: type === "renko" ? st.renko.wickDown : s.down.border,
      });
    }
    case "ha":
      return chart.addSeries(CandlestickSeries, candleOptions(st.ha));
    default:
      return chart.addSeries(CandlestickSeries, candleOptions(st.candle));
  }
}

/** Series data for a chart type. `lastForming`: the newest bar is still
 *  forming (drives projection bars of the price-based types). */
export function setDataForType(
  series: AnySeries,
  type: ChartTypeId,
  raw: OHLC[],
  tokens: ChartTokens,
  extras?: { subMinute?: OHLC[]; lastForming?: boolean; sessions?: SymbolSessions | null },
): void {
  const st = tokens.styles;
  const forming = !!extras?.lastForming;
  const custom = series as ISeriesApi<"Custom">;
  switch (type) {
    case "kagi": {
      const box = boxSize(raw, st.kagi.box);
      custom.setData(toKagi(raw, box, forming));
      return;
    }
    case "pnf": {
      const box = boxSize(raw, st.pnf.box);
      custom.setData(toPnf(raw, box, st.pnf.reversal, st.pnf.source, st.pnf.oneStepBack, forming));
      return;
    }
    case "svp":
    case "tpo":
      custom.setData(toProfile(raw, type, st.svp, extras?.sessions ?? null));
      return;
    case "volFootprint":
      custom.setData(toFootprint(raw, extras?.subMinute));
      return;
    case "hlcArea":
      custom.setData(toHlcArea(raw));
      return;
    case "volCandles": {
      const items = toVolCandles(raw);
      custom.setData(items);
      const last = items[items.length - 1];
      if (last) {
        const c = st.volCandles;
        const up = c.prevClose && last.prevClose != null ? last.close >= last.prevClose : last.close >= last.open;
        custom.applyOptions({ color: up ? c.bodyUp : c.bodyDown });
      }
      return;
    }
    case "hilo":
      custom.setData(toHiLo(raw));
      return;
    case "column": {
      const c = st.column;
      const items: ColumnItem[] = raw.map((r, i) => {
        const v = priceOf(r, c.source);
        const ref = c.prevClose ? (i > 0 ? priceOf(raw[i - 1], c.source) : r.open) : r.open;
        return { time: r.time, value: v, fill: (c.prevClose ? v >= ref : r.close >= r.open) ? c.up : c.down };
      });
      custom.setData(items);
      const last = items[items.length - 1];
      if (last) custom.applyOptions({ color: last.fill });
      return;
    }
    case "line":
    case "lineWithMarkers":
    case "stepline": {
      const s = st[type];
      const d = raw.map((r) => ({ time: r.time, value: priceOf(r, s.source) }));
      if (s.type === "Gradient") {
        custom.setData(d);
        return;
      }
      (series as ISeriesApi<"Line">).setData(d);
      if (type === "lineWithMarkers") {
        // Markers: filled circles in the line colour, radius width + 2,
        // only while they fit the bar spacing (library markers size to the
        // bar spacing).
        ensureMarkers(series).setMarkers(
          raw.map((r) => ({ time: r.time, position: "inBar" as const, color: s.color, shape: "circle" as const, size: 0.6 })),
        );
      } else {
        markersPlugins.get(series)?.setMarkers([]);
      }
      return;
    }
    case "area":
    case "baseline": {
      const src = type === "area" ? st.area.source : st.baseline.source;
      (series as ISeriesApi<"Area">).setData(raw.map((r) => ({ time: r.time, value: priceOf(r, src) })));
      return;
    }
    case "bar": {
      const b = st.bar;
      (series as ISeriesApi<"Bar">).setData(
        raw.map((r, i) => {
          const ref = b.prevClose ? (i > 0 ? raw[i - 1].close : r.open) : r.open;
          const bar = { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close };
          return b.prevClose ? { ...bar, color: r.close >= ref ? b.up : b.down } : bar;
        }),
      );
      return;
    }
    case "hollowCandle": {
      // Hollow candles: colour = close vs the PREVIOUS close, fill = close
      // vs the bar's own open (close > open → hollow).
      const c = st.hollowCandle;
      const data: CandlestickData[] = raw.map((r, i) => {
        const up = r.close >= (i > 0 ? raw[i - 1].close : r.open);
        const hollow = r.close > r.open;
        return {
          time: r.time, open: r.open, high: r.high, low: r.low, close: r.close,
          color: hollow || !c.body ? TRANSPARENT : up ? c.bodyUp : c.bodyDown,
          borderColor: up ? c.borderUp : c.borderDown,
          wickColor: up ? c.wickUp : c.wickDown,
        };
      });
      (series as ISeriesApi<"Candlestick">).setData(data);
      return;
    }
    case "renko":
    case "pb":
    case "range": {
      let bricks: Brick[];
      if (type === "renko") bricks = toRenko(raw, boxSize(raw, st.renko.box), st.renko.source, forming);
      else if (type === "pb") bricks = toLineBreak(raw, st.pb.lines, forming);
      else bricks = toRangeBars(raw, rangeSize(raw), st.range.phantom, forming);
      const data = bricks.map((b) => {
        const base = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
        if (type === "range") {
          const r = st.range;
          if (r.style === "Bars") return { ...base, color: b.proj ? (b.up ? r.projUp : r.projDown) : (b.up ? r.up : r.down) };
          if (!b.proj) return base;
          const c = b.up ? r.projCandles.up : r.projCandles.down;
          return { ...base, color: c, borderColor: c, wickColor: c };
        }
        const s = st[type];
        const fb = b.proj ? (b.up ? s.projUp : s.projDown) : (b.up ? s.up : s.down);
        return { ...base, color: fb.fill, borderColor: fb.border, ...(type === "renko" ? { wickColor: b.up ? st.renko.wickUp : st.renko.wickDown } : {}) };
      });
      (series as ISeriesApi<"Candlestick">).setData(data);
      return;
    }
    case "ha": {
      const c = st.ha;
      const ha = toHeikinAshi(raw);
      (series as ISeriesApi<"Candlestick">).setData(c.prevClose ? prevCloseColored(ha, c) : ha);
      return;
    }
    default: {
      // candle
      const c = st.candle;
      const bars = raw.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close }));
      (series as ISeriesApi<"Candlestick">).setData(c.prevClose ? prevCloseColored(bars, c) : bars);
    }
  }
}

/** "Color bars based on previous close": each bar's colours compare its close
 *  to the PREVIOUS bar's close (first bar: its own open). */
function prevCloseColored(bars: Candle[], c: CandleStyleS): CandlestickData[] {
  return bars.map((b, i) => {
    const up = b.close >= (i > 0 ? bars[i - 1].close : b.open);
    return {
      ...b,
      color: c.body ? (up ? c.bodyUp : c.bodyDown) : TRANSPARENT,
      borderColor: up ? c.borderUp : c.borderDown,
      wickColor: up ? c.wickUp : c.wickDown,
    };
  });
}

/** Last Heikin-Ashi bar (the value the HA series' own label shows). */
export function heikinAshiLast(raw: OHLC[]): Candle | null {
  const ha = toHeikinAshi(raw);
  return ha.length ? ha[ha.length - 1] : null;
}
