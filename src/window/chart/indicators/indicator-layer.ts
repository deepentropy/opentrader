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
import type { StudyChart } from './script-chart';
import type { ChartContext as IndicatorChartContext, IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { IndicatorRenderer, type PlotOverride } from 'lightweight-charts-indicators/render';
import type { OwnScaleMeta, PlotDefaultVisible, PlotPalette } from './volume';
import { applyOpacity } from 'lightweight-charts-drawing/core/color';
import { SelectionMarkers, type BackgroundAt } from '../selection-markers';
import { StepDiamondsPrimitive } from './step-diamonds';
import { restoreTimes, scriptBars } from '../../../backtester/oakscript';
import { isStrategyId } from './strategy-entries';
import type { OtherSymbolBars } from './other-symbols';
import { MissingSymbolDataError } from 'lightweight-charts-indicators';
import type { ChartEvent } from '../../../data/datafeed';
import { VbpPrimitive } from '../profiles/vbp-primitive';
import type { VbpDraw } from '../profiles/vbp-studies';
import { TpoPrimitive, type TpoBlockHit } from '../profiles/tpo-primitive';
import type { TpoDraw } from '../profiles/tpo-engine';
import { uiTheme } from '../../header/chart-settings';
import { cachedSymbolSessions } from '../../../data/session';
import { sessionFutureSlots } from './future-slots';

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
/** Third argument of `calculate`: the chart context (what the library indicators and the OakScript scripts
 *  read) with the state of the newest bar, plus what the app's own entries need. `heikinAshi`: the chart shows
 *  Heikin Ashi bars (strategies run on them). */
export type StudyCalcContext = StudyChart & Pick<IndicatorChartContext, 'leftVisibleBarTime' | 'rightVisibleBarTime'> & {
  chartId: string;
  studyId?: string;
  heikinAshi?: boolean;
  /** Bars of the chart symbol on a lower timeframe in the chart's session, loaded back to `from` (seconds; the
   *  profile studies); undefined while they load. */
  lowerBars?: (resolution: string, from: number) => Bar[] | undefined;
  /** Dividends and splits of the chart symbol; undefined while they load. */
  chartEvents?: () => ChartEvent[] | undefined;
};
/** Chart type and state of the newest bar, read at each calculation. `realtime`: it is still forming;
 *  `lastBarNew`: this is its first update. */
export type StudyChartState = () => { heikinAshi: boolean; realtime: boolean; lastBarConfirmed: boolean; lastBarNew: boolean };
/** Times (chart bar times) of the first and last bars visible on the chart; null = not known. */
export type StudyVisibleRange = () => { from: number; to: number } | null;
/** A study that failed, shown with it in the legend: another symbol it reads cannot be loaded (`invalidSymbol`), or
 *  its calculation stopped on an error (`error`). `title`: the status tooltip and the panel title; `message`: the
 *  panel text. */
export type StudyError = { kind: 'invalidSymbol' | 'error'; title: string; message: string };

const INVALID_SYMBOL: StudyError = { kind: 'invalidSymbol', title: 'Invalid symbol', message: "This symbol doesn't exist, please pick another one." };

/** The legend status of an error thrown by a study. */
function studyErrorOf(err: unknown): StudyError {
  const message = err instanceof Error ? err.message : String(err);
  if (/^Invalid symbol\b/.test(message)) return INVALID_SYMBOL;
  return { kind: 'error', title: 'Runtime error', message };
}

/** Results already put back on the chart's bar times: a user script returns its cached result again. */
const restored = new WeakSet<object>();

/** Index of the first bar at or after `time` (`after`), else of the last bar at or before it; -1 = none. */
function barIndexAt(bars: Bar[], time: number, after: boolean): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid].time as unknown as number) < time) lo = mid + 1;
    else hi = mid - 1;
  }
  // lo = first bar with time >= `time`
  if (after) return lo < bars.length ? lo : -1;
  return lo < bars.length && (bars[lo].time as unknown as number) === time ? lo : lo - 1;
}
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
  /** The detached scale is a side scale with its axis (a study pinned to
   *  the other side's scale), not a hidden one. */
  private detachedAxis = false;
  /** Pinned to a scale ("Pin to scale"): a study with a scale of its own in
   *  its metadata (Volume) takes the pinned one instead. */
  private scalePinned = false;
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

  /** Passed to `calculate` as a third argument: the chart context (timeframe, session...) and the chart id
   *  for studies with per-chart state. */
  private chartId: string;
  private scriptChart: StudyChart | undefined;
  private chartState: StudyChartState = () => ({ heikinAshi: false, realtime: false, lastBarConfirmed: true, lastBarNew: true });
  private visibleRange: StudyVisibleRange = () => null;
  /** Bars of other symbols (`bars` / `symbolInfo` of the chart context) and the ones the last calculation read. */
  private otherSymbols: OtherSymbolBars | null = null;
  private usedSymbols = new Set<string>();
  /** Why the last calculation failed (null = it did not). */
  private error: StudyError | null = null;
  /** The study waits for data (other symbols' bars, its first script run): the legend shows it loading. */
  private loading = false;
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

  setScriptChart(chart: StudyChart | undefined): void {
    this.scriptChart = chart;
  }

  setChartState(state: StudyChartState): void {
    this.chartState = state;
  }

  setVisibleRange(range: StudyVisibleRange): void {
    this.visibleRange = range;
  }

  setOtherSymbols(store: OtherSymbolBars | null): void {
    this.otherSymbols = store;
  }

  /** Why the study's last calculation failed (legend status), null when it did not. */
  studyError(): StudyError | null {
    return this.error;
  }

  /** The study waits for its data (legend status: loading eye, values not available). */
  studyLoading(): boolean {
    return this.loading;
  }

  /** Keys (`symbol|interval`) of the other symbols the last calculation read. */
  symbolsUsed(): ReadonlySet<string> {
    return this.usedSymbols;
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
   *  a pane whose scale shows other values; null = the pane's scale. `axis`:
   *  a side scale with its axis ("left" / "right"). `pinned`: the study is
   *  pinned to a scale (its metadata's own scale is not used). */
  setDetachedScale(id: string | null, axis = false, pinned = false): void {
    this.detachedScale = id;
    this.detachedAxis = axis && !!id;
    this.scalePinned = pinned;
  }

  /** The pane moved (Settings pane controls: move up / down). */
  setPaneIndex(i: number): void {
    this.paneIndex = i;
    this.renderer?.setPaneIndex(i);
  }

  /** Drawn in the price pane (over the main series, on its scale) or in a
   *  study pane; `scaleIds` reads the main series' scale and the side of the
   *  study panes' own scales. */
  private pricePane = false;
  private scaleIds: () => { price: string; pane: string } = () => ({ price: 'right', pane: 'right' });
  setPricePane(on: boolean, scaleIds: () => { price: string; pane: string }): void {
    this.pricePane = on;
    this.scaleIds = scaleIds;
  }

  /** The renderer's price pane is pane 0: an indicator over the series is
   *  drawn as an overlay there only (elsewhere it is drawn in its pane). */
  private get rendererOverlay(): boolean {
    return this.pricePane && this.paneIndex === 0;
  }

  /** "Scale price chart only" leaves the study out of the series' scale
   *  autoscale (a study over the series on that scale; Volume's own hidden
   *  scale and a detached scale keep theirs). */
  private leftOutOfAutoscale(ownScale: boolean): boolean {
    return this.pricePane && this.seriesOnlyScale !== null && !ownScale && !this.detachedScale;
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
    const pane = this.chart.panes()[this.paneIndex];
    const preserved = pane?.preserveEmptyPane() ?? false;
    pane?.setPreserveEmptyPane(true);
    try {
      fn();
    } finally {
      pane?.setPreserveEmptyPane(preserved);
    }
  }

  private calculate(entry: IndicatorRegistryEntry, bars: Bar[], inputs: Record<string, unknown>, styles: IndicatorStyleOverrides): any {
    this.error = null;
    this.loading = false;
    try {
      const ctx: StudyCalcContext = { ...this.scriptChart, ...this.chartState(), chartId: this.chartId, studyId: this.studyId };
      const store = this.otherSymbols;
      const used = new Set<string>();
      this.usedSymbols = used;
      if (store) {
        const interval = ctx.timeframe ?? '1D';
        ctx.bars = (symbol, timeframe) => {
          used.add(store.key(symbol, timeframe, interval));
          return store.bars(symbol, timeframe, interval);
        };
        ctx.symbolInfo = (symbol) => store.symbolInfo(symbol);
        const ticker = ctx.tickerid;
        if (ticker) {
          const session = ctx.sessionType === 'extended' ? 'ETH' : 'RTH';
          ctx.lowerBars = (resolution, from) => {
            used.add(store.lowerKey(ticker, resolution, session));
            return store.lowerBars(ticker, resolution, session, from);
          };
          ctx.chartEvents = () => {
            used.add(store.eventsKey(ticker));
            return store.events(ticker);
          };
        }
      }
      // Daily and longer bars at the session open, as studies read them (strategies restamp their own bars: the
      // broker and the report keep the chart's bar times).
      const seen = isStrategyId(entry.id) ? bars : scriptBars(bars, ctx);
      const range = this.visibleRange();
      if (range) {
        const left = barIndexAt(bars, range.from, true);
        const right = barIndexAt(bars, range.to, false);
        if (left >= 0 && right >= left) {
          ctx.leftVisibleBarTime = (seen[left].time as unknown as number) * 1000;
          ctx.rightVisibleBarTime = (seen[right].time as unknown as number) * 1000;
        }
      }
      const result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, ctx: StudyCalcContext) => unknown)(seen, inputs, ctx);
      if ((result as { pending?: boolean } | null)?.pending) this.loading = true;
      // Another symbol it reads cannot be loaded: the study fails and draws nothing.
      if (store && [...used].some((k) => store.failed(k))) {
        this.error = INVALID_SYMBOL;
        return null;
      }
      if (seen !== bars && result && typeof result === 'object' && !restored.has(result)) {
        restoreTimes(result, seen, bars);
        restored.add(result);
      }
      return withPaletteColors(entry, result, styles);
    } catch (err) {
      // Bars of other symbols still loading: the chart calculates the study again when they arrive.
      if (err instanceof MissingSymbolDataError) {
        this.loading = true;
        return null;
      }
      // A single indicator throwing must not break the chart or its siblings; the legend shows the error.
      this.error = studyErrorOf(err);
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
      if (!this.pricePane && entry && this.lastBars.length) {
        this.extraSeries.push(this.chart.addSeries(LineSeries, { visible: false, lastValueVisible: false, priceLineVisible: false }, this.paneIndex));
      }
      return;
    }

    const bars = this.lastBars;
    const styles = this.lastStyles;
    const ownScale = !!(entry.metadata as OwnScaleMeta | undefined)?.ownScaleId && !this.scalePinned;
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
    renderer.setFutureSlots(this.futureSlots());
    renderer.render(
      {
        overlay: this.rendererOverlay,
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
        autoscale: !this.leftOutOfAutoscale(ownScale),
        reuseSeries,
      },
    );
    this.afterRender(entry, result, plots, overrides, ownScale);
  }

  /** Slots after the last bar of the times a drawing gives (xloc.bar_time) on the symbol's trading calendar, as the
   *  reference app's time scale continues after the last bar; null (calendar time) until the sessions are known. */
  private futureSlots() {
    const chart = this.scriptChart;
    const sessions = chart?.tickerid ? cachedSymbolSessions(chart.tickerid) : null;
    if (!sessions || !chart?.timeframe) return null;
    return sessionFutureSlots(chart.timeframe, chart.sessionType === 'extended' ? sessions.extended : sessions.regular);
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
    const mainFormat = this.pricePane && !ownScale && !this.detachedScale && this.precision === null ? this.mainSeries()?.options().priceFormat : undefined;
    if (mainFormat) for (const s of series) (s as ISeriesApi<SeriesType>).applyOptions({ priceFormat: mainFormat });
    if (this.detachedScale && !ownScale && this.detachedAxis) {
      // A side scale: shown by the chart (side scales are chart options).
      for (const s of series) (s as ISeriesApi<SeriesType>).applyOptions({ priceScaleId: this.detachedScale });
    } else if (this.detachedScale && !ownScale) {
      // No axis for this scale: no value label either.
      for (const s of series) (s as ISeriesApi<SeriesType>).applyOptions({ priceScaleId: this.detachedScale, lastValueVisible: false });
      (series[0] as ISeriesApi<SeriesType> | undefined)?.priceScale().applyOptions({ visible: false });
    } else if (!ownScale) {
      // Over the series: on the series' scale (in a pane it shares with
      // another study the series has the other side); a study pane: on the
      // study panes' side.
      const ids = this.scaleIds();
      const id = this.pricePane ? ids.price : ids.pane;
      for (const s of series) {
        if ((s as ISeriesApi<SeriesType>).options().priceScaleId !== id) (s as ISeriesApi<SeriesType>).applyOptions({ priceScaleId: id });
      }
    }
    // "Scale price chart only": the renderer leaves its pane 0 out of the
    // price autoscale; the price pane may be another pane.
    if (this.leftOutOfAutoscale(ownScale) && !this.rendererOverlay) {
      for (const s of series) (s as ISeriesApi<SeriesType>).applyOptions({ autoscaleInfoProvider: () => null });
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
    // Volume profile studies: their profiles on the price pane, with the main series.
    const vbp = (result as { vbp?: VbpDraw }).vbp;
    const main = this.mainSeries();
    if (vbp && main) {
      const primitive = new VbpPrimitive(vbp, this.lastBars.map((b) => b.time as unknown as number), this.plotLabel);
      main.attachPrimitive(primitive as ISeriesPrimitive<Time>);
      this.detachers.push(() => main.detachPrimitive(primitive as ISeriesPrimitive<Time>));
    }
    // Time price opportunity studies.
    const tpo = (result as { tpo?: TpoDraw }).tpo;
    if (tpo && main) {
      const primitive = new TpoPrimitive(tpo, this.lastBars.map((b) => b.time as unknown as number), uiTheme() !== 'light');
      main.attachPrimitive(primitive as ISeriesPrimitive<Time>);
      this.tpoPrimitive = primitive;
      this.detachers.push(() => {
        main.detachPrimitive(primitive as ISeriesPrimitive<Time>);
        if (this.tpoPrimitive === primitive) this.tpoPrimitive = null;
      });
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

  /** Time price opportunity study: its drawn profiles. */
  private tpoPrimitive: TpoPrimitive | null = null;

  /** The TPO block at media point (x, y) of the price pane, or null. */
  tpoBlockAt(x: number, y: number): TpoBlockHit | null {
    return this.tpoPrimitive?.blockAt(x, y) ?? null;
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
    // A series being removed has no pane any more: removing a series fires a
    // crosshair move (the hover handlers come here) while the others still
    // wait for their removal; throwing there would stop the removal halfway.
    return this.allSeries().find((s) => {
      try { return s.getPane().paneIndex() === this.paneIndex; } catch { return false; }
    }) ?? null;
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
  legendPlots(time?: number, withNa = false): IndicatorLegendPlot[] {
    const entry = this.entry;
    const result = this.lastResult;
    // Loading without values yet (legend): every shown plot, its value not available.
    const loadingPlots = (): IndicatorLegendPlot[] =>
      withNa && entry && this.loading
        ? entry.plotConfig.flatMap((p, index) =>
            p.display !== 'none' && (p.style ?? 'line') !== 'cross' && plotShown(p as PlotDefaultVisible, this.lastStyles[p.id]) ? [{ color: p.color ?? '#787b86', value: NaN, index }] : [],
          )
        : [];
    if (!entry || !result?.plots) return loadingPlots();
    // Plot arrays are one point per bar in the same order, so resolve the bar
    // index once from the first plot that has data.
    let sample: Array<{ time: number; value: number }> | undefined;
    for (const p of entry.plotConfig) {
      const a = result.plots[p.id];
      if (a?.length) { sample = a; break; }
    }
    if (!sample) return loadingPlots();
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
      if (!pt || pt.value == null || Number.isNaN(pt.value)) {
        // The legend shows a value that is not available on this bar for a plot that has values (the other users
        // take values only); a plot without any value (a switched-off option) stays out.
        if (withNa && this.plotHasValues(result, p.id)) out.push({ color: ov?.color ?? p.color ?? '#787b86', value: NaN, index });
        continue;
      }
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
  /** Plot ids of a result that have at least one value (computed once per result). */
  private valuedPlots = new WeakMap<object, Set<string>>();
  private plotHasValues(result: any, id: string): boolean {
    let set = this.valuedPlots.get(result);
    if (!set) {
      set = new Set<string>();
      for (const [pid, pts] of Object.entries((result.plots ?? {}) as Record<string, Array<{ value?: number | null }>>)) {
        if (Array.isArray(pts) && pts.some((q) => q && q.value != null && !Number.isNaN(q.value))) set.add(pid);
      }
      this.valuedPlots.set(result, set);
    }
    return set.has(id);
  }

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
