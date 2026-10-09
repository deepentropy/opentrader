/*
 * IndicatorLayer — renders ONE indicator-registry entry onto an existing
 * chart, scoped to a single pane.  The library computes the result
 * (`calculate()`) and draws it (`IndicatorRenderer` of
 * lightweight-charts-indicators/render: plots, fills, hlines, markers,
 * arrows, bar / background colours, plotcandle / plotbar, labels, lines,
 * boxes, linefills, polylines, tables).  This layer adds what belongs to the
 * app: the Style tab overrides (palette colours, plot type, price line,
 * diamonds of a step line), the study options (labels on the price scale,
 * precision), Volume's own hidden scale, "Scale price chart only", the
 * selection markers, the legend values and the CSV export.
 *
 * One layer == one active indicator instance.  Each layer owns its renderer
 * and (for non-overlay studies) its own pane, so several indicators coexist
 * without clobbering each other.
 */
import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import type { Bar, PlotConfig, IndicatorResult } from 'oakscriptjs';
import type { ChartContext } from 'oakscriptjs/script';
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { IndicatorRenderer, type PlotOverride } from 'lightweight-charts-indicators/render';
import type { OwnScaleMeta, PlotDefaultVisible, PlotPalette } from './volume';
import { applyOpacity } from 'lightweight-charts-drawing/core/color';
import { SelectionMarkers, type BackgroundAt } from '../selection-markers';
import { StepDiamondsPrimitive } from './step-diamonds';

type PlotPoint = { time: number; value: number; color?: string };
type PlotStyle = NonNullable<PlotConfig['style']>;

/** Whether a plot is drawn: the Style tab check box, else the plot's default
 *  (`defaultVisible: false` = hidden until checked, e.g. Volume MA). */
export function plotShown(plotDef: { defaultVisible?: boolean }, ov: PlotStyleOverride | undefined): boolean {
  return ov?.visible ?? plotDef.defaultVisible ?? true;
}

/** Palette plots: each point's colour from its `paletteIndex` (the Style tab
 *  colours, else the palette's) at the palette transparency. Returns a copy of
 *  the result; the study's own result objects are left untouched. */
function withPaletteColors(entry: IndicatorRegistryEntry, result: any, styles: IndicatorStyleOverrides): any {
  let out = result;
  for (const p of entry.plotConfig as (IndicatorRegistryEntry["plotConfig"][number] & PlotPalette)[]) {
    const pts = result?.plots?.[p.id] as (PlotPoint & { paletteIndex?: number })[] | undefined;
    if (!p.palette || !pts) continue;
    const colors = p.palette.map((c, i) => styles[p.id]?.palette?.[i] ?? c.color);
    const opacity = 100 - (p.paletteTransparency ?? 0);
    const shaded = colors.map((c) => (c.startsWith("#") && c.length === 7 ? applyOpacity(c, opacity) : c));
    if (out === result) out = { ...result, plots: { ...result.plots } };
    out.plots[p.id] = pts.map((d) => (d.paletteIndex != null && shaded[d.paletteIndex] ? { ...d, color: shaded[d.paletteIndex] } : d));
  }
  return out;
}
/** Third argument of `calculate` (ignored by the library indicators). */
/** `heikinAshi`: the chart shows Heikin Ashi bars (strategies run on them); `lastBarOpen`: the newest bar is
 *  still forming (a realtime bar for strategies). */
export type StudyCalcContext = { chartId: string; chart?: ChartContext; studyId?: string; heikinAshi?: boolean; lastBarOpen?: boolean };
/** Chart type and forming-bar state, read at each calculation. */
export type StudyChartState = () => { heikinAshi: boolean; lastBarOpen: boolean };
/**
 * Plot points with an na point at each skipped bar: OakScript plot() output leaves the na bars out, and a
 * line-break plot must break there.
 */
function withGaps(data: PlotPoint[], bars: Bar[]): PlotPoint[] {
  const index = new Map(bars.map((b, i) => [b.time as unknown as number, i]));
  const out: PlotPoint[] = [];
  let prev = -1;
  for (const p of data) {
    const i = index.get(p.time);
    if (i !== undefined && prev >= 0 && i > prev + 1) out.push({ time: bars[prev + 1].time as unknown as number, value: NaN });
    out.push(p);
    if (i !== undefined) prev = i;
  }
  return out;
}

/** Plot type of the Style tab (its ids) as a PineScript plot style. */
function pineStyle(plotType: string | undefined): PlotStyle | undefined {
  if (plotType === undefined) return undefined;
  return (plotType === 'steplinediamond' ? 'stepline_diamond' : plotType) as PlotStyle;
}

/** Plot styles the renderer draws with a primitive on an anchor series, not with a plot series. */
const ANCHOR_STYLES = new Set<string>(['cross', 'linebr', 'steplinebr']);

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
/** `index`: the plot's position in the entry's plotConfig (alert operands
 *  name a plot by it; the legend skips hidden plots). */
export type IndicatorLegendPlot = { color: string; value: number; index: number };

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
  /** Palette plots (PlotPalette): the colour of each palette entry. */
  palette?: string[];
};
/** Per-plot style overrides for a study, keyed by plot id. */
export type IndicatorStyleOverrides = Record<string, PlotStyleOverride>;

export class IndicatorLayer {
  private chart: IChartApi;
  private paneIndex: number;
  private detachedScale: string | null = null;
  /** Draws the study's result; re-created when the chart's main series changes. */
  private renderer: IndicatorRenderer | null = null;
  private rendererMain: ISeriesApi<SeriesType> | null = null;
  private mainSeries: () => ISeriesApi<SeriesType> | null = () => null;
  /** Series this layer adds itself (the pane holder of a hidden study). */
  private extraSeries: ISeriesApi<SeriesType>[] = [];
  private detachers: Array<() => void> = [];
  /** Plot series of each drawn plot with the plot's points (selection
   *  markers sit on the plot values). */
  private plotSeries: { series: ISeriesApi<SeriesType>; data: PlotPoint[] }[] = [];
  /** Selection markers while the study is selected (null = not selected). */
  private selectionBg: BackgroundAt | null = null;
  private markerDetachers: Array<() => void> = [];
  /** "Scale price chart only": id of the main series' price scale whose
   *  auto-scale leaves this study out (null = included). */
  private seriesOnlyScale: string | null = null;
  // Retained so the legend can read per-plot values at the crosshair time even
  // when the study isn't (re)drawing (e.g. hidden), and so the study can be
  // redrawn without recomputing it.
  private entry: IndicatorRegistryEntry | null = null;
  private lastResult: any = null;
  private lastInputs: Record<string, unknown> = {};
  private lastBars: Bar[] = [];
  private lastDraw = false;
  // Retained so the legend reflects per-plot colour/visibility overrides even
  // between redraws.
  private lastStyles: IndicatorStyleOverrides = {};
  // Scales → "Indicators and financials": last-value axis labels on the PLOT
  // series (hlines / fills / anchors stay unlabeled — they aren't study
  // values). Applied at series creation; render() re-creates the series, so a
  // change takes effect on the next render.
  private lastValueVisible = true;
  private nameLabelsVisible = false;
  // Per-study Style options (indicator-options.ts): "Labels on price scale"
  // (ANDed with the global flag above) and "Precision" (null = Default).
  private labelsOnScale = true;
  private precision: number | null = null;

  /** Passed to `calculate` as a third argument ({ chartId, chart }): the chart id for studies with
   *  per-chart state, the chart context (timeframe, session...) for OakScript scripts. */
  private chartId: string;
  private scriptChart: ChartContext | undefined;
  private chartState: StudyChartState = () => ({ heikinAshi: false, lastBarOpen: false });
  /** Study instance id ("rsi#2"): studies with run state keep one per instance. */
  private studyId: string | undefined;

  constructor(chart: IChartApi, paneIndex: number, chartId = "", studyId?: string) {
    this.chart = chart;
    this.paneIndex = paneIndex;
    this.chartId = chartId;
    this.studyId = studyId;
  }

  setLastValueVisible(v: boolean): void {
    this.lastValueVisible = v;
  }

  /** Plot-name labels next to the price labels (the global "Name" option AND
   *  the study's "Labels on price scale"). */
  setNameLabelsVisible(v: boolean): void {
    this.nameLabelsVisible = v;
  }

  setScriptChart(chart: ChartContext | undefined): void {
    this.scriptChart = chart;
  }

  setChartState(state: StudyChartState): void {
    this.chartState = state;
  }

  /** The chart's main price series (markers next to the bars, bar colours). */
  setMainSeries(get: () => ISeriesApi<SeriesType> | null): void {
    this.mainSeries = get;
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

  /** Scale of its own (hidden, over the whole pane) for a study that shares
   *  a pane whose scale shows other values; null = the pane's scale. */
  setDetachedScale(id: string | null): void {
    this.detachedScale = id;
  }

  /** The pane moved (Settings pane controls: move up / down). */
  setPaneIndex(i: number): void {
    this.paneIndex = i;
    this.renderer?.setPaneIndex(i);
  }

  /** Recompute the study and (when `draw`) redraw it for the given bars.
   *  `styles` carries the user's per-plot colour/width/visibility overrides
   *  (Settings → Style); empty = registry defaults. `live`: only the newest
   *  bars changed, the drawn series are kept and take the new points (a full
   *  redraw of every series per live update was 10-200 ms on long histories). */
  render(
    entry: IndicatorRegistryEntry,
    bars: Bar[],
    inputs: Record<string, unknown>,
    draw = true,
    styles: IndicatorStyleOverrides = {},
    live = false,
  ): void {
    this.inPreservedPane(() => {
      this.entry = entry;
      this.lastInputs = inputs;
      this.lastStyles = styles;
      this.lastBars = bars;
      this.lastDraw = draw;
      this.lastResult = bars.length ? this.calculate(entry, bars, inputs, styles) : null;
      this.draw(live);
    });
  }

  /** Redraw the last result without recomputing it (main series replaced,
   *  "Scale price chart only" changed). */
  redraw(): void {
    if (!this.entry) return;
    this.inPreservedPane(() => this.draw());
  }

  /** The library deletes a pane left empty while other panes exist: clearing
   *  the study before its redraw would delete its pane and the redraw would
   *  open a new one at the default height, losing the user's pane size. Keep
   *  the pane alive across the redraw. */
  private inPreservedPane(fn: () => void): void {
    const pane = this.paneIndex > 0 ? this.chart.panes()[this.paneIndex] : undefined;
    const preserved = pane?.preserveEmptyPane() ?? false;
    pane?.setPreserveEmptyPane(true);
    try {
      fn();
    } finally {
      pane?.setPreserveEmptyPane(preserved);
    }
  }

  private calculate(entry: IndicatorRegistryEntry, bars: Bar[], inputs: Record<string, unknown>, styles: IndicatorStyleOverrides): any {
    try {
      const result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, ctx: StudyCalcContext) => unknown)(bars, inputs, {
        chartId: this.chartId,
        chart: this.scriptChart,
        studyId: this.studyId,
        ...this.chartState(),
      });
      return withPaletteColors(entry, result, styles);
    } catch (err) {
      // A single indicator throwing must not break the chart or its siblings.
      // eslint-disable-next-line no-console
      console.warn(`[indicators] ${entry.id} failed to calculate`, err);
      return null;
    }
  }

  /** Draw the last result (nothing when not drawn or when it failed).
   *  `reuseSeries`: keep the series of the previous draw (live update). */
  private draw(reuseSeries = false): void {
    this.detachMarkers();
    this.removeExtras();
    this.plotSeries = [];
    const entry = this.entry;
    const result = this.lastResult;
    const renderer = this.rendererFor();
    if (!entry || !result || !this.lastDraw) {
      renderer.clear();
      // A study in its own pane that draws nothing (eye off, or off its
      // Visibility intervals) keeps its pane and status line. The library
      // drops a pane once its last series goes, so hold it with an
      // empty, invisible series.
      if (this.paneIndex > 0 && entry && this.lastBars.length) {
        this.extraSeries.push(this.chart.addSeries(LineSeries, { visible: false, lastValueVisible: false, priceLineVisible: false }, this.paneIndex));
      }
      return;
    }

    const bars = this.lastBars;
    const styles = this.lastStyles;
    const ownScale = !!(entry.metadata as OwnScaleMeta | undefined)?.ownScaleId;
    const overrides: Record<string, PlotOverride> = {};
    let plots: Record<string, PlotPoint[]> = result.plots ?? {};
    for (const def of entry.plotConfig) {
      const ov = styles[def.id];
      const style = pineStyle(ov?.plotType);
      overrides[def.id] = {
        ...(plotShown(def as PlotDefaultVisible, ov) ? {} : { visible: false }),
        ...(ov?.color !== undefined && { color: ov.color }),
        ...(ov?.lineWidth !== undefined && { lineWidth: ov.lineWidth }),
        ...(style && { style }),
      };
      const effective = style ?? def.style ?? 'line';
      if ((effective === 'linebr' || effective === 'steplinebr') && plots[def.id]?.length) {
        if (plots === result.plots) plots = { ...plots };
        plots[def.id] = withGaps(plots[def.id], bars);
      }
    }

    renderer.setPaneIndex(this.paneIndex);
    renderer.render(
      {
        overlay: this.paneIndex === 0,
        plotConfig: entry.plotConfig,
        hlineConfig: entry.hlineConfig,
        fillConfig: entry.fillConfig,
        arrowConfig: (entry as { arrowConfig?: never }).arrowConfig,
      },
      { ...result, plots } as IndicatorResult,
      bars,
      {
        inputs: this.lastInputs,
        plots: overrides,
        lastValueVisible: this.plotLabel,
        titleVisible: this.nameLabelsVisible && this.labelsOnScale,
        precision: this.precision,
        // Volume's own hidden scale keeps its auto-scale.
        autoscale: !(this.seriesOnlyScale !== null && !ownScale && !this.detachedScale),
        reuseSeries,
      },
    );
    this.afterRender(entry, result, plots, overrides, ownScale);
  }

  /** The renderer of the current main series (a new one when it changed). */
  private rendererFor(): IndicatorRenderer {
    const main = this.mainSeries();
    if (!this.renderer || main !== this.rendererMain) {
      try { this.renderer?.clear(); } catch { /* the old main series is gone */ }
      this.renderer = new IndicatorRenderer(this.chart, { paneIndex: this.paneIndex, mainSeries: main ?? undefined });
      this.rendererMain = main;
    }
    return this.renderer;
  }

  /** The series the renderer drew each plot with, then the app's additions
   *  to them. series() lists the plot series first (plotConfig order), then
   *  the other series, which start with the anchor series of the plots drawn
   *  by a primitive (cross, line with breaks), also in plotConfig order. */
  private afterRender(
    entry: IndicatorRegistryEntry,
    result: any,
    plots: Record<string, PlotPoint[]>,
    overrides: Record<string, PlotOverride>,
    ownScale: boolean,
  ): void {
    const series = this.renderer!.series();
    const drawn = entry.plotConfig
      .filter((def) => plots[def.id]?.length && this.drawnByRenderer(def, overrides[def.id], result))
      .map((def) => ({ def, style: overrides[def.id].style ?? def.style ?? 'line' }));
    const plotCount = drawn.filter((d) => !ANCHOR_STYLES.has(d.style)).length;
    // A study on the symbol's price scale with the default precision writes
    // its values like the symbol (thousands separators, tick decimals): the
    // scale takes its number format from one of its series, so a second
    // format on it would change the labels and the scale width.
    const mainFormat = this.paneIndex === 0 && !ownScale && !this.detachedScale && this.precision === null ? this.mainSeries()?.options().priceFormat : undefined;
    if (mainFormat) for (const s of series) (s as ISeriesApi<SeriesType>).applyOptions({ priceFormat: mainFormat });
    if (this.detachedScale && !ownScale) {
      // No axis for this scale: no value label either.
      for (const s of series) (s as ISeriesApi<SeriesType>).applyOptions({ priceScaleId: this.detachedScale, lastValueVisible: false });
      (series[0] as ISeriesApi<SeriesType> | undefined)?.priceScale().applyOptions({ visible: false });
    }
    let k = 0;
    let a = plotCount;
    for (const { def, style } of drawn) {
      const anchored = ANCHOR_STYLES.has(style);
      const s = series[anchored ? a++ : k++] as ISeriesApi<SeriesType> | undefined;
      if (!s) continue;
      const data = plots[def.id];
      // Selection markers: the plot's own points (one per bar, no gap points).
      this.plotSeries.push({ series: s, data: result.plots?.[def.id] ?? data });
      const color = overrides[def.id].color ?? def.color ?? '#2962FF';
      // Plot-type menu "Price line".
      if (this.lastStyles[def.id]?.priceLine) s.applyOptions({ priceLineVisible: true, priceLineColor: color });
      if (anchored) continue;
      if (ownScale) this.applyOwnScale(s, entry);
      if (style === 'stepline_diamond') {
        const points = data.filter((d) => d.value != null && !Number.isNaN(d.value));
        const primitive = new StepDiamondsPrimitive(points, color);
        s.attachPrimitive(primitive as ISeriesPrimitive<Time>);
        this.detachers.push(() => s.detachPrimitive(primitive as ISeriesPrimitive<Time>));
      }
    }
    if (this.selectionBg) this.attachMarkers();
  }

  /** The renderer's plot visibility rule (with the overrides passed to it). */
  private drawnByRenderer(def: PlotConfig, ov: PlotOverride, result: any): boolean {
    if (ov.visible !== undefined) return ov.visible;
    if (def.display === 'none' || def.display === 'data_window' || def.display === 'status_line') return false;
    if (def.visible === undefined || typeof def.visible === 'boolean') return def.visible ?? true;
    if (this.lastInputs[def.visible] !== undefined) return Boolean(this.lastInputs[def.visible]);
    if (result.visibility?.[def.visible] !== undefined) return Boolean(result.visibility[def.visible]);
    return (result.plots?.[def.id] ?? []).some((p: PlotPoint) => p.value != null && !Number.isNaN(p.value));
  }

  /** Pin a plot series to the entry's dedicated hidden scale when its
   *  metadata asks for one (`ownScaleId`) — Volume draws inside the
   *  price pane but on its own axis pinned to the bottom quarter, never on
   *  the symbol scale. */
  private applyOwnScale(series: ISeriesApi<SeriesType>, entry: IndicatorRegistryEntry): void {
    const md = entry.metadata as OwnScaleMeta | undefined;
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

  /** True when `s` is one of this study's series. */
  ownsSeries(s: ISeriesApi<SeriesType>): boolean {
    return this.allSeries().includes(s);
  }

  private allSeries(): ISeriesApi<SeriesType>[] {
    return [...(this.renderer?.series() ?? []), ...this.extraSeries] as ISeriesApi<SeriesType>[];
  }

  /** "Scale price chart only" on the main series' scale `scaleId` (null =
   *  off): series of this study on that scale leave its auto-scale. */
  setSeriesOnlyScale(scaleId: string | null): void {
    if (scaleId === this.seriesOnlyScale) return;
    this.seriesOnlyScale = scaleId;
    this.redraw();
  }

  /** Study selected (markers on every drawn plot) or not (null). */
  setSelected(bgAt: BackgroundAt | null): void {
    this.detachMarkers();
    this.selectionBg = bgAt;
    if (bgAt) this.attachMarkers();
  }

  private attachMarkers(): void {
    const bgAt = this.selectionBg;
    if (!bgAt) return;
    for (const { series, data } of this.plotSeries) {
      const valueAt = (i: number): number | null => {
        // Plot points are one per bar in bar order: point i is bar i when
        // its time maps back to index i.
        const pt = data[i];
        if (!pt || pt.value == null || Number.isNaN(pt.value)) return null;
        return this.chart.timeScale().timeToIndex(pt.time as unknown as Time) === i ? pt.value : null;
      };
      const m = new SelectionMarkers(valueAt, bgAt);
      series.attachPrimitive(m);
      this.markerDetachers.push(() => series.detachPrimitive(m));
    }
  }

  private detachMarkers(): void {
    for (const d of this.markerDetachers.splice(0)) {
      try { d(); } catch { /* series already gone */ }
    }
  }

  /** First series this layer drew in its pane (its plots' price scale), or
   *  null. Price-pane series of a study in its own pane (force_overlay
   *  output) are skipped. */
  firstSeries(): ISeriesApi<SeriesType> | null {
    return this.allSeries().find((s) => s.getPane().paneIndex() === this.paneIndex) ?? null;
  }

  /** The study's drawn plots for "Download chart data": plot title and
   *  values by bar time (the plots the chart shows; hidden ones excluded). */
  exportPlots(): { title: string; values: Map<number, number> }[] {
    const entry = this.entry;
    const result = this.lastResult;
    if (!entry || !result?.plots) return [];
    const out: { title: string; values: Map<number, number> }[] = [];
    for (const plotDef of entry.plotConfig) {
      const data: PlotPoint[] | undefined = result.plots[plotDef.id];
      if (!data || data.length === 0) continue;
      if (!this.isPlotVisible(plotDef, result, this.lastInputs)) continue;
      if (!plotShown(plotDef as PlotDefaultVisible, this.lastStyles[plotDef.id])) continue;
      const values = new Map<number, number>();
      for (const p of data) {
        const v = (p as { value?: number }).value;
        if (v != null) values.set(p.time as number, v);
      }
      out.push({ title: plotDef.title || plotDef.id, values });
    }
    return out;
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
    for (const [index, p] of entry.plotConfig.entries()) {
      const style = this.lastStyles[p.id]?.plotType ?? p.style ?? 'line';
      if (style === 'cross') continue;
      if (!this.isPlotVisible(p, result, this.lastInputs)) continue;
      const ov = this.lastStyles[p.id];
      if (!plotShown(p as PlotDefaultVisible, ov)) continue; // hidden via the Style tab
      const pt = result.plots[p.id]?.[idx];
      if (!pt || pt.value == null || Number.isNaN(pt.value)) continue;
      // The value takes the bar's own plot colour (palette / per-point
      // colorer) with its transparency reset. Per-point colours also win on
      // the canvas, so the legend matches the drawn column.
      const color = (pt as { color?: string }).color ?? ov?.color ?? p.color ?? '#787b86';
      out.push({ color: resetTransparency(color), value: pt.value, index });
    }
    return out;
  }

  /** Tear down every series + primitive this layer owns. */
  clear(): void {
    this.detachMarkers();
    this.plotSeries = [];
    this.removeExtras();
    try { this.renderer?.clear(); } catch { /* chart already torn down */ }
  }

  private removeExtras(): void {
    for (const detach of this.detachers.splice(0)) {
      try { detach(); } catch { /* series already gone */ }
    }
    for (const s of this.extraSeries.splice(0)) {
      try { this.chart.removeSeries(s); } catch { /* already removed */ }
    }
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
