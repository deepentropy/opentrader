/*
 * IndicatorLayer — renders ONE indicator-registry entry onto an existing
 * chart, scoped to a single pane.  The heavy lifting (computing plots) is the
 * library's; this layer only routes a `calculate()` IndicatorResult onto
 * lightweight-charts series + the canvas primitives in indicator-primitives.ts.
 *
 * One layer == one active indicator instance.  Each layer owns its own series
 * and (for non-overlay studies) its own pane, so several indicators coexist
 * without clobbering each other.  The plot-routing mirrors the reference
 * renderer the library ships in example/src/indicator-ui.ts (recalculate()),
 * trimmed to the plot styles we draw: line / histogram / area / circles /
 * stepline / linebr / cross, plus hlines, hline-fills, plot-to-plot fills,
 * markers, the Tier 1 bgcolor / barcolor outputs (oakscriptjs 0.5.0) and
 * plotarrow arrows (oakscriptjs 0.8.1, main pane only).
 * Facets we don't yet draw (boxes, labels, line drawings, tables, plotcandle)
 * are ignored.
 */
import {
  createSeriesMarkers,
  AreaSeries,
  BaselineSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  type AreaData,
  type BaselineData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesPrimitive,
  type LineData,
  type SeriesMarker,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import type { Bar, HLineConfig, FillConfig, FillData } from 'oakscriptjs';
import type { IndicatorRegistryEntry, MarkerData } from 'lightweight-charts-indicators';
import type { OwnScaleMeta } from './volume';
import { ThinHistogramPaneView } from './histogram-series';
import {
  ArrowPrimitive,
  BarColorPrimitive,
  BgColorPrimitive,
  CrossPlotPrimitive,
  ExtendedMarkerPrimitive,
  LineBrPrimitive,
  PlotFillPrimitive,
  type ArrowSet,
  type BarColorCandle,
  type BarColorPoint,
  type PlotFillBar,
} from './indicator-primitives';

type PlotPoint = { time: number; value: number; color?: string };
/** oakscriptjs plotarrow output (result.arrows) and declaration (arrowConfig). */
type ScriptArrow = { time: number; id: string; value: number; color: string };
type ScriptArrowConfig = { id: string; minheight?: number; maxheight?: number; display?: string };

// Built-in marker shapes that lightweight-charts' createSeriesMarkers renders
// natively; everything else is drawn by ExtendedMarkerPrimitive.
const BUILTIN_MARKER_SHAPES = new Set(['arrowUp', 'arrowDown', 'circle', 'square']);

// Two marker vocabularies reach this layer: lightweight-charts-indicators
// markers already use `shape`/`position` (lightweight-charts terms), while
// oakscriptjs 0.5.0 plotshape/plotchar markers use `style`/`location`/`char`.
// These maps fold the oakscriptjs vocabulary into the internal MarkerData one.
const SHAPE_STYLE_MAP: Record<string, MarkerData['shape']> = {
  triangleup: 'triangleUp',
  triangledown: 'triangleDown',
  arrowup: 'arrowUp',
  arrowdown: 'arrowDown',
  circle: 'circle',
  square: 'square',
  diamond: 'diamond',
  cross: 'cross',
  xcross: 'xcross',
  flag: 'flag',
  labelup: 'labelUp',
  labeldown: 'labelDown',
};
const MARKER_LOCATION_MAP: Record<string, MarkerData['position']> = {
  abovebar: 'aboveBar',
  belowbar: 'belowBar',
  top: 'aboveBar',
  bottom: 'belowBar',
  absolute: 'inBar',
};
// oakscriptjs marker sizes are named; scale them to the numeric size the
// renderers expect (1 == normal).
const MARKER_SIZE_MAP: Record<string, number> = {
  auto: 1,
  tiny: 0.5,
  small: 0.75,
  normal: 1,
  large: 1.5,
  huge: 2,
};

/** Normalize a marker from either vocabulary into the internal MarkerData
 *  shape (lightweight-charts `shape`/`position`, numeric size). */
function normalizeMarker(m: Record<string, unknown>): MarkerData {
  const shape =
    (m.shape as MarkerData['shape']) ??
    SHAPE_STYLE_MAP[m.style as string] ??
    'square';
  const position =
    (m.position as MarkerData['position']) ??
    MARKER_LOCATION_MAP[m.location as string] ??
    'aboveBar';
  const size =
    typeof m.size === 'number'
      ? m.size
      : typeof m.size === 'string'
        ? MARKER_SIZE_MAP[m.size]
        : undefined;
  return {
    time: m.time as number,
    position,
    shape,
    color: (m.color as string) ?? '#2962FF',
    text: (m.text as string) ?? (m.char as string) ?? '',
    size,
  };
}

const LINE_STYLE_MAP: Record<string, LineStyle> = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
};

function clampWidth(w: number | undefined): 1 | 2 | 3 | 4 {
  return (w && w >= 1 && w <= 4 ? w : 2) as 1 | 2 | 3 | 4;
}

/** Index of the point whose `time` equals `time`, or -1.  Arrays are ascending
 *  and one-point-per-bar, so a binary search resolves the crosshair bar. */
function bsearchTime(arr: Array<{ time: number }>, time: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = arr[mid].time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** One legend cell: a plot's current value coloured by the plot's own colour. */
export type IndicatorLegendPlot = { color: string; value: number };

/** Drop a colour's alpha (#rrggbbaa / #rgba / rgba()), keeping its RGB. */
function resetTransparency(color: string): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1];
    if (h.length === 8) return `#${h.slice(0, 6)}`;
    if (h.length === 4) return `#${h.slice(0, 3)}`;
    return c;
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : c;
}

/** A user override for one plot (Settings → Style). Any field left undefined
 *  falls back to the registry's plotConfig default. */
export type PlotStyleOverride = {
  color?: string;
  lineWidth?: number;
  visible?: boolean;
  /** Settings -> Style plot-type button (plot types: line, linebr,
   *  stepline, steplinebr, steplinediamond, histogram, cross, area, areabr,
   *  columns, circles). */
  plotType?: string;
  /** Plot-type menu "Price line": a horizontal line at the plot's last value. */
  priceLine?: boolean;
};
/** Per-plot style overrides for a study, keyed by plot id. */
export type IndicatorStyleOverrides = Record<string, PlotStyleOverride>;

export class IndicatorLayer {
  private chart: IChartApi;
  private paneIndex: number;
  /** Every series this layer created, removed wholesale on clear(). */
  private series: ISeriesApi<'Line' | 'Histogram' | 'Area' | 'Baseline'>[] = [];
  private detachers: Array<() => void> = [];
  // Retained so the legend can read per-plot values at the crosshair time even
  // when the study isn't (re)drawing (e.g. hidden).
  private entry: IndicatorRegistryEntry | null = null;
  private lastResult: any = null;
  private lastInputs: Record<string, unknown> = {};
  // Retained so the legend reflects per-plot colour/visibility overrides even
  // between redraws.
  private lastStyles: IndicatorStyleOverrides = {};
  // Scales → "Indicators and financials": last-value axis labels on the PLOT
  // series (hlines / fills / anchors stay unlabeled — they aren't study
  // values). Applied at series creation; render() re-creates the series, so a
  // change takes effect on the next render.
  private lastValueVisible = true;
  // Per-study Style options (indicator-options.ts): "Labels on price scale"
  // (ANDed with the global flag above) and "Precision" (null = Default).
  private labelsOnScale = true;
  private precision: number | null = null;
  // "Price line" of the plot being built (plot-type menu), read by the
  // series builders.
  private plotPriceLine = false;

  /** Passed to `calculate` as a third argument ({ chartId }), for studies with per-chart state. */
  private chartId: string;

  constructor(chart: IChartApi, paneIndex: number, chartId = "") {
    this.chart = chart;
    this.paneIndex = paneIndex;
    this.chartId = chartId;
  }

  setLastValueVisible(v: boolean): void {
    this.lastValueVisible = v;
  }

  /** Per-study options, applied to the plot series at the next render. */
  setPlotOptions(o: { labelsOnScale: boolean; precision: number | null }): void {
    this.labelsOnScale = o.labelsOnScale;
    this.precision = o.precision;
  }

  /** Last-value label on a plot series: global setting AND the study's. */
  private get plotLabel(): boolean {
    return this.lastValueVisible && this.labelsOnScale;
  }

  /** Study "Precision": fixed decimals on the plot series' axis label. */
  private applyPrecision(series: { applyOptions(o: { priceFormat: { type: 'price'; precision: number; minMove: number } }): void }): void {
    if (this.precision === null) return;
    series.applyOptions({ priceFormat: { type: 'price', precision: this.precision, minMove: 10 ** -this.precision } });
  }

  /** The pane moved (Settings pane controls: move up / down). */
  setPaneIndex(i: number): void {
    this.paneIndex = i;
  }

  /** Recompute the study and (when `draw`) redraw it for the given bars.
   *  `styles` carries the user's per-plot colour/width/visibility overrides
   *  (Settings → Style); empty = registry defaults. */
  render(
    entry: IndicatorRegistryEntry,
    bars: Bar[],
    inputs: Record<string, unknown>,
    draw = true,
    styles: IndicatorStyleOverrides = {},
  ): void {
    this.clear();
    this.entry = entry;
    this.lastInputs = inputs;
    this.lastStyles = styles;
    if (bars.length === 0) { this.lastResult = null; return; }

    let result: any;
    try {
      result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, ctx: { chartId: string }) => unknown)(bars, inputs, { chartId: this.chartId });
    } catch (err) {
      // A single indicator throwing must not break the chart or its siblings.
      // eslint-disable-next-line no-console
      console.warn(`[indicators] ${entry.id} failed to calculate`, err);
      this.lastResult = null;
      return;
    }
    this.lastResult = result;
    if (!draw) {
      // A study in its own pane that draws nothing (eye off, or off its
      // Visibility intervals) keeps its pane and status line. The library
      // drops a pane once its last series goes, so hold it with an
      // empty, invisible series.
      if (this.paneIndex > 0) {
        const holder = this.chart.addSeries(LineSeries, { visible: false, lastValueVisible: false, priceLineVisible: false });
        holder.moveToPane(this.paneIndex);
        this.series.push(holder);
      }
      return;
    }

    // ── Plots ──────────────────────────────────────────────────────────────
    for (const plotDef of entry.plotConfig) {
      const plotData: PlotPoint[] | undefined = result.plots?.[plotDef.id];
      if (!plotData || plotData.length === 0) continue;
      if (!this.isPlotVisible(plotDef, result, inputs)) continue;
      const ov = styles[plotDef.id];
      if (ov?.visible === false) continue; // user unchecked this plot (Style tab)

      const color = ov?.color ?? plotDef.color ?? '#2962FF';
      const lineWidth = ov?.lineWidth ?? plotDef.lineWidth;
      const style = ov?.plotType ?? plotDef.style ?? 'line';
      this.plotPriceLine = ov?.priceLine ?? false;

      switch (style) {
        case 'histogram':
          // Study Histogram: thin bars of the plot's line width from its
          // histogram base (histogram-series.ts).
          this.addThinHistogram(plotData, color, lineWidth, (plotDef as { histbase?: number }).histbase ?? 0);
          break;
        case 'columns':
          this.addHistogram(plotData, color);
          break;
        case 'circles':
          this.addLine(plotData, color, lineWidth, { pointMarkersVisible: true, lineVisible: false });
          break;
        case 'cross':
          this.addCross(plotData, color, lineWidth);
          break;
        case 'stepline':
          this.addLine(plotData, color, lineWidth, { lineType: LineType.WithSteps });
          break;
        case 'steplinebr':
          this.addLineBr(plotData, color, lineWidth, LineType.WithSteps);
          break;
        case 'area':
          this.addArea(plotData, color, lineWidth, false);
          break;
        case 'areabr':
          this.addArea(plotData, color, lineWidth, true);
          break;
        case 'steplinediamond':
          // Pine plot.style_stepline_diamond: a step line whose value
          // changes are marked with diamonds.
          this.addLine(plotData, color, lineWidth, { lineType: LineType.WithSteps });
          this.addDiamonds(plotData, color);
          break;
        case 'linebr':
          this.addLineBr(plotData, color, lineWidth, LineType.Simple);
          break;
        case 'line':
        default:
          this.addLine(plotData, color, lineWidth, {});
          break;
      }
    }

    // ── Horizontal levels + their fills ────────────────────────────────────
    if (entry.hlineConfig?.length) {
      this.addHLines(entry.hlineConfig, bars);
      if (entry.fillConfig?.length) this.addHLineFills(entry.fillConfig, entry.hlineConfig, bars);
    }

    // ── Plot-to-plot fills (clouds/bands) returned by calculate() ──────────
    if (Array.isArray(result.fills) && result.fills.length) {
      this.addPlotFills(result.fills, result.plots);
    }

    // ── Markers (plotshape / plotchar, or library candle-pattern markers) ───
    if (Array.isArray(result.markers) && result.markers.length) {
      this.addMarkers(result.markers.map(normalizeMarker), bars);
    }

    // ── Background color (bgcolor) ─────────────────────────────────────────
    if (Array.isArray(result.bgcolors) && result.bgcolors.length) {
      this.addBgColors(result.bgcolors as BarColorPoint[], bars);
    }

    // ── Bar color (barcolor) — recolors the price candles, so only meaningful
    //    on the main pane where they live. ───────────────────────────────────
    if (this.paneIndex === 0 && Array.isArray(result.barcolors) && result.barcolors.length) {
      this.addBarColors(result.barcolors as BarColorPoint[], bars);
    }

    // ── Arrows (plotarrow) — anchored on the bar high / low, so only on the
    //    main pane with the price bars. ─────────────────────────────────────
    const arrows = (result as { arrows?: ScriptArrow[] }).arrows;
    if (this.paneIndex === 0 && Array.isArray(arrows) && arrows.length) {
      this.addArrows(arrows, (entry as { arrowConfig?: ScriptArrowConfig[] }).arrowConfig ?? [], bars);
    }
  }

  /** The study's legend title (short name preferred), e.g. "RSI", "SMA". */
  get title(): string {
    if (!this.entry) return '';
    return this.entry.metadata?.shortTitle || this.entry.shortName || this.entry.name;
  }

  /** Per-plot current values at `time` (or the latest bar), each coloured by
   *  its plot's configured colour — the study legend's value cells.  Only
   *  visible, finite-valued line/area/histogram plots are returned (crosses and
   *  hidden plots are skipped). */
  legendPlots(time?: number): IndicatorLegendPlot[] {
    const entry = this.entry;
    const result = this.lastResult;
    if (!entry || !result?.plots) return [];
    // Plot arrays are one point per bar in the same order, so resolve the bar
    // index once from the first plot that has data.
    let sample: Array<{ time: number; value: number }> | undefined;
    for (const p of entry.plotConfig) {
      const a = result.plots[p.id];
      if (a?.length) { sample = a; break; }
    }
    if (!sample) return [];
    let idx = sample.length - 1;
    if (time != null) {
      const hit = bsearchTime(sample, time);
      if (hit >= 0) idx = hit;
    }
    const out: IndicatorLegendPlot[] = [];
    for (const p of entry.plotConfig) {
      const style = this.lastStyles[p.id]?.plotType ?? p.style ?? 'line';
      if (style === 'cross') continue;
      if (!this.isPlotVisible(p, result, this.lastInputs)) continue;
      const ov = this.lastStyles[p.id];
      if (ov?.visible === false) continue; // hidden via the Style tab
      const pt = result.plots[p.id]?.[idx];
      if (!pt || pt.value == null || Number.isNaN(pt.value)) continue;
      // The value takes the bar's own plot colour (palette / per-point
      // colorer) with its transparency reset. Per-point colours also win on
      // the canvas, so the legend matches the drawn column.
      const color = (pt as { color?: string }).color ?? ov?.color ?? p.color ?? '#787b86';
      out.push({ color: resetTransparency(color), value: pt.value });
    }
    return out;
  }

  /** Tear down every series + primitive this layer owns. */
  clear(): void {
    for (const detach of this.detachers.splice(0)) {
      try { detach(); } catch { /* series already gone */ }
    }
    for (const s of this.series.splice(0)) {
      try { this.chart.removeSeries(s); } catch { /* already removed */ }
    }
  }

  // ── Series builders ───────────────────────────────────────────────────────

  /** Pin a plot series to the entry's dedicated hidden scale when its
   *  metadata asks for one (`ownScaleId`) — Volume draws inside the
   *  price pane but on its own axis pinned to the bottom quarter, never on
   *  the symbol scale. */
  private applyOwnScale(series: {
    applyOptions(opts: { priceScaleId?: string; lastValueVisible?: boolean }): void;
    priceScale(): { applyOptions(opts: { scaleMargins: { top: number; bottom: number }; visible: boolean }): void };
  }): void {
    const md = this.entry?.metadata as OwnScaleMeta | undefined;
    if (!md?.ownScaleId) return;
    // The scale is hidden, so a last-value badge would print raw volume
    // numbers onto the PRICE axis strip — always off, whatever the
    // "Indicators and financials" setting says.
    series.applyOptions({ priceScaleId: md.ownScaleId, lastValueVisible: false });
    series.priceScale().applyOptions({
      scaleMargins: md.ownScaleMargins ?? { top: 0.75, bottom: 0 },
      visible: false,
    });
  }

  private addLine(
    data: PlotPoint[],
    color: string,
    lineWidth: number | undefined,
    opts: { lineType?: LineType; pointMarkersVisible?: boolean; lineVisible?: boolean },
  ): void {
    const series = this.chart.addSeries(LineSeries, {
      color,
      lineWidth: clampWidth(lineWidth),
      lineType: opts.lineType ?? LineType.Simple,
      pointMarkersVisible: opts.pointMarkersVisible ?? false,
      lineVisible: opts.lineVisible ?? true,
      lastValueVisible: this.plotLabel,
      priceLineVisible: this.plotPriceLine,
    });
    series.moveToPane(this.paneIndex);
    this.applyPrecision(series);
    this.applyOwnScale(series);
    series.setData(this.toLineData(data));
    this.series.push(series);
  }

  private addArea(data: PlotPoint[], color: string, lineWidth: number | undefined, breaks: boolean): void {
    const series = this.chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: color + '40',
      bottomColor: color + '10',
      lineWidth: clampWidth(lineWidth),
      lastValueVisible: this.plotLabel,
      priceLineVisible: this.plotPriceLine,
    });
    series.moveToPane(this.paneIndex);
    this.applyPrecision(series);
    // "Area with breaks": missing values stay gaps (whitespace) instead of
    // being bridged.
    series.setData(
      (breaks
        ? data.map((d) => (d.value != null && !Number.isNaN(d.value) ? { time: d.time as unknown as Time, value: d.value } : { time: d.time as unknown as Time }))
        : data.filter((d) => d.value != null && !Number.isNaN(d.value)).map((d) => ({ time: d.time as unknown as Time, value: d.value }))) as AreaData<Time>[],
    );
    this.series.push(series);
  }

  private addHistogram(data: PlotPoint[], color: string): void {
    const series = this.chart.addSeries(HistogramSeries, {
      color,
      lastValueVisible: this.plotLabel,
      priceLineVisible: this.plotPriceLine,
    });
    series.moveToPane(this.paneIndex);
    this.applyPrecision(series);
    this.applyOwnScale(series);
    series.setData(
      data
        .filter((d) => d.value != null && !Number.isNaN(d.value))
        .map((d) => ({ time: d.time as unknown as Time, value: d.value, ...(d.color ? { color: d.color } : {}) })) as HistogramData<Time>[],
    );
    this.series.push(series);
  }

  private addCross(data: PlotPoint[], color: string, lineWidth: number | undefined): void {
    const anchor = this.addAnchor(this.toLineData(data));
    this.anchorPriceLine(anchor, color);
    const primitive = new CrossPlotPrimitive();
    anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
    primitive.setData(data, color, (lineWidth ?? 2) * 3);
    this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
  }

  private addLineBr(data: PlotPoint[], color: string, lineWidth: number | undefined, lineType: LineType): void {
    const anchor = this.addAnchor(this.toLineData(data));
    this.anchorPriceLine(anchor, color);
    const primitive = new LineBrPrimitive();
    anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
    primitive.setData(data, color, lineWidth ?? 2, 0, lineType === LineType.WithSteps);
    this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
  }

  private addHLines(hlines: HLineConfig[], bars: Bar[]): void {
    const first = bars[0].time as unknown as Time;
    const last = bars[bars.length - 1].time as unknown as Time;
    for (const hline of hlines) {
      const series = this.chart.addSeries(LineSeries, {
        color: hline.color ?? '#787B86',
        lineWidth: clampWidth(hline.linewidth),
        lineStyle: LINE_STYLE_MAP[hline.linestyle ?? 'solid'] ?? LineStyle.Solid,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      series.moveToPane(this.paneIndex);
      series.setData([{ time: first, value: hline.price }, { time: last, value: hline.price }] as LineData<Time>[]);
      this.series.push(series);
    }
  }

  private addHLineFills(fills: FillConfig[], hlines: HLineConfig[], bars: Bar[]): void {
    const first = bars[0].time as unknown as Time;
    const last = bars[bars.length - 1].time as unknown as Time;
    const priceOf = new Map(hlines.map((h) => [h.id, h.price]));
    for (const fill of fills) {
      const p1 = priceOf.get(fill.plot1);
      const p2 = priceOf.get(fill.plot2);
      if (p1 == null || p2 == null) continue;
      const color = fill.color ?? 'rgba(41,98,255,0.1)';
      const series = this.chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: Math.min(p1, p2) },
        topFillColor1: color,
        topFillColor2: color,
        bottomFillColor1: 'transparent',
        bottomFillColor2: 'transparent',
        topLineColor: 'transparent',
        bottomLineColor: 'transparent',
        lineVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      series.moveToPane(this.paneIndex);
      series.setData([{ time: first, value: Math.max(p1, p2) }, { time: last, value: Math.max(p1, p2) }] as BaselineData<Time>[]);
      this.series.push(series);
    }
  }

  private addPlotFills(fills: FillData[], plots: Record<string, PlotPoint[]>): void {
    for (const fill of fills) {
      const p1 = plots[fill.plot1];
      const p2 = plots[fill.plot2];
      if (!p1?.length || !p2?.length) continue;

      let fillColor = '#2962FF40';
      if (fill.options?.color) {
        const transp = fill.options.transp;
        fillColor = transp != null
          ? fill.options.color + Math.round((1 - transp / 100) * 255).toString(16).padStart(2, '0')
          : fill.options.color + '40';
      }

      const p2Map = new Map(p2.map((d) => [d.time, d.value]));
      const bars: PlotFillBar[] = [];
      for (const d1 of p1) {
        const v2 = p2Map.get(d1.time);
        if (d1.value == null || v2 == null || Number.isNaN(d1.value) || Number.isNaN(v2)) continue;
        bars.push({ time: d1.time, upper: Math.max(d1.value, v2), lower: Math.min(d1.value, v2) });
      }
      if (!bars.length) continue;

      const anchor = this.addAnchor(bars.map((b) => ({ time: b.time as unknown as Time, value: b.upper })) as LineData<Time>[]);
      const primitive = new PlotFillPrimitive();
      anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
      primitive.setData(bars, fillColor);
      this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
    }
  }

  private addMarkers(markers: MarkerData[], bars: Bar[]): void {
    // Markers hang off the layer's own invisible anchor (seeded with closes) so
    // they live in this layer's pane and never clobber another indicator's.
    const anchor = this.addAnchor(bars.map((b) => ({ time: b.time as unknown as Time, value: b.close })) as LineData<Time>[]);

    const builtin: SeriesMarker<Time>[] = [];
    const extended: MarkerData[] = [];
    for (const m of markers) {
      if (BUILTIN_MARKER_SHAPES.has(m.shape)) {
        builtin.push({
          time: m.time as unknown as Time,
          position: m.position,
          shape: m.shape as 'arrowUp' | 'arrowDown' | 'circle' | 'square',
          color: m.color,
          text: m.text ?? '',
          size: m.size,
        });
      } else {
        extended.push(m);
      }
    }

    if (builtin.length) createSeriesMarkers(anchor, builtin);
    if (extended.length) {
      const primitive = new ExtendedMarkerPrimitive();
      anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
      primitive.setMarkers(extended);
      this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
    }
  }

  /** Paint bgcolor() output as full-height columns behind this pane's bars. */
  private addBgColors(bgcolors: BarColorPoint[], bars: Bar[]): void {
    const anchor = this.addAnchor(bars.map((b) => ({ time: b.time as unknown as Time, value: b.close })) as LineData<Time>[]);
    const primitive = new BgColorPrimitive();
    anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
    primitive.setData(bgcolors);
    this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
  }

  /** Draw plotarrow() output: one arrow set per plotarrow call (its own height scaling). */
  private addArrows(arrows: ScriptArrow[], configs: ScriptArrowConfig[], bars: Bar[]): void {
    const byTime = new Map(bars.map((b) => [b.time as unknown as number, b]));
    const sets = new Map<string, ArrowSet>();
    for (const a of arrows) {
      const b = byTime.get(a.time);
      if (!b) continue;
      let set = sets.get(a.id);
      if (!set) {
        const cfg = configs.find((c) => c.id === a.id);
        if (cfg?.display === 'none') continue;
        set = { minHeight: cfg?.minheight ?? 5, maxHeight: cfg?.maxheight ?? 100, points: [] };
        sets.set(a.id, set);
      }
      set.points.push({ time: a.time, value: a.value, color: a.color, high: b.high, low: b.low });
    }
    if (!sets.size) return;
    const anchor = this.addAnchor(bars.map((b) => ({ time: b.time as unknown as Time, value: b.close })) as LineData<Time>[]);
    const primitive = new ArrowPrimitive();
    anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
    primitive.setData([...sets.values()]);
    this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
  }

  /** Paint barcolor() output by repainting each colored bar's OHLC candle. */
  private addBarColors(barcolors: BarColorPoint[], bars: Bar[]): void {
    const byTime = new Map(bars.map((b) => [b.time, b]));
    const candles: BarColorCandle[] = [];
    for (const bc of barcolors) {
      const b = byTime.get(bc.time);
      if (!b) continue;
      candles.push({ time: bc.time, open: b.open, high: b.high, low: b.low, close: b.close, color: bc.color });
    }
    if (!candles.length) return;
    const anchor = this.addAnchor(bars.map((b) => ({ time: b.time as unknown as Time, value: b.close })) as LineData<Time>[]);
    const primitive = new BarColorPrimitive();
    anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
    primitive.setData(candles);
    this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
  }

  private addThinHistogram(data: PlotPoint[], color: string, lineWidth: number | undefined, base: number): void {
    const series = this.chart.addCustomSeries(new ThinHistogramPaneView(), {
      histColor: color,
      histWidth: Math.max(1, lineWidth ?? 1),
      histBase: base,
      color,
      lastValueVisible: this.plotLabel,
      priceLineVisible: this.plotPriceLine,
    } as never);
    series.moveToPane(this.paneIndex);
    this.applyPrecision(series as never);
    this.applyOwnScale(series as never);
    series.setData(
      data
        .filter((d) => d.value != null && !Number.isNaN(d.value))
        .map((d) => ({ time: d.time as unknown as Time, value: d.value, ...(d.color ? { fill: d.color } : {}) })) as never,
    );
    this.series.push(series as never);
  }

  /** Diamonds on the value changes of a step line (steplinediamond). */
  private addDiamonds(data: PlotPoint[], color: string): void {
    const points = data.filter((d) => d.value != null && !Number.isNaN(d.value));
    const marks: MarkerData[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i > 0 && points[i].value === points[i - 1].value) continue;
      marks.push({ time: points[i].time, position: 'inBar', shape: 'diamond', color, size: 1 } as MarkerData);
    }
    if (!marks.length) return;
    // Anchored on the plot values, so 'inBar' sits on the step level.
    const anchor = this.addAnchor(this.toLineData(points));
    const primitive = new ExtendedMarkerPrimitive();
    anchor.attachPrimitive(primitive as ISeriesPrimitive<Time>);
    primitive.setMarkers(marks);
    this.detachers.push(() => anchor.detachPrimitive(primitive as ISeriesPrimitive<Time>));
  }

  /** Price line for plots drawn through an invisible anchor series. */
  private anchorPriceLine(anchor: ISeriesApi<'Line'>, color: string): void {
    if (this.plotPriceLine) anchor.applyOptions({ priceLineVisible: true, priceLineColor: color });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** An invisible LineSeries used to anchor a canvas primitive to this pane. */
  private addAnchor(data: (LineData<Time> | WhitespaceData<Time>)[]): ISeriesApi<'Line'> {
    const anchor = this.chart.addSeries(LineSeries, {
      color: 'transparent',
      lineVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    anchor.moveToPane(this.paneIndex);
    anchor.setData(data);
    this.series.push(anchor);
    return anchor;
  }

  private toLineData(data: PlotPoint[]): LineData<Time>[] {
    return data
      .filter((d) => d.value != null && !Number.isNaN(d.value))
      .map((d) => ({ time: d.time as unknown as Time, value: d.value, ...(d.color ? { color: d.color } : {}) })) as LineData<Time>[];
  }

  /** Mirror of the reference renderer's plot-visibility gate. */
  private isPlotVisible(plotDef: any, result: any, inputs: Record<string, unknown>): boolean {
    if (plotDef.display === 'none') return false;
    if (plotDef.visible === undefined) return true;
    if (typeof plotDef.visible === 'boolean') return plotDef.visible;
    if (typeof plotDef.visible === 'string') {
      if (inputs[plotDef.visible] !== undefined) return Boolean(inputs[plotDef.visible]);
      if (result.visibility?.[plotDef.visible] !== undefined) return Boolean(result.visibility[plotDef.visible]);
      const data = result.plots?.[plotDef.id];
      if (Array.isArray(data)) return data.some((p: any) => p.value != null && !Number.isNaN(p.value));
    }
    return true;
  }
}
