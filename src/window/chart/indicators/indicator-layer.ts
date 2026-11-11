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
import { setSourceResolver, type Bar, type PlotConfig, type IndicatorResult } from 'oakscriptjs';
import type { StudyChart } from './script-chart';
import type { ChartContext as IndicatorChartContext, IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { IndicatorRenderer, type PlotOverride } from 'lightweight-charts-indicators/render';
import type { OwnScaleMeta, PlotDefaultVisible, PlotPalette } from './volume';
import { applyOpacity } from 'lightweight-charts-drawing/core/color';
import { SelectionMarkers, type BackgroundAt } from '../selection-markers';
import { labelWanted, setSeriesScale } from '../scales/extra-axes';
import { StepDiamondsPrimitive } from './step-diamonds';
import { VolumeColumnsPrimitive, type ColumnPoint } from './volume-columns';
import { FundamentalLabelsPrimitive, type FundamentalLabel } from './fundamental-labels';
import { restoreTimes, scriptBars } from '../../../backtester/oakscript';
import { isStrategyId } from './strategy-entries';
import type { OtherSymbolBars } from './other-symbols';
// From oakscriptjs (the indicator library re-exports it): this module stays out of the library's chunk.
import { MissingSymbolDataError } from 'oakscriptjs/script';
import type { ChartEvent } from '../../../data/datafeed';
import type { Fundamentals } from '../../../data/fundamentals';
import { VbpPrimitive } from '../profiles/vbp-primitive';
import type { VbpDraw } from '../profiles/vbp-studies';
import { TpoPrimitive, type TpoBlockHit } from '../profiles/tpo-primitive';
import type { TpoDraw } from '../profiles/tpo-engine';
import { uiTheme } from '../../header/chart-settings';
import { studyScaleFormat } from '../price-format';
import { cachedSymbolSessions } from '../../../data/session';
import { sessionFutureSlots } from './future-slots';
import { applyStyleOverrides, type StyleEntry } from './style-outputs';
import { isLibraryEntry } from './registry';
import { translatedPlotConfig, translatedStudyResult } from '../../../i18n/study-text';
import { isUserIndicatorId } from './user-scripts';
import { calculateInWorker, studyWorkersAvailable } from './study-worker-host';
import { ACCESSORS, applyDelta, callKey, jobChanges, type SentState, type StudyCall, type StudyJob } from './study-worker-types';
import { indexOfTime, lastAtOrBefore, lowerBound } from '../time-search';

type PlotPoint = { time: number; value: number; color?: string };
type PlotStyle = NonNullable<PlotConfig['style']>;

/** Whether a plot is drawn: the Style tab check box, else the plot's default
 *  (`defaultVisible: false` = hidden until checked, e.g. Volume MA; a plot with `display: 'none'` is listed unchecked,
 *  as the reference lists a plot hidden by default). */
export function plotShown(plotDef: { defaultVisible?: boolean; display?: string }, ov: PlotStyleOverride | undefined): boolean {
  return ov?.visible ?? plotDef.defaultVisible ?? plotDef.display !== 'none';
}

/** Palette plots: each point's colour from its `paletteIndex` (the Style tab
 *  colours, else the palette's) at the palette transparency. Returns a copy of
 *  the result; the study's own result objects are left untouched. */
function withPaletteColors(entry: IndicatorRegistryEntry, result: any, styles: IndicatorStyleOverrides): any {
  let out = result;
  for (const p of entry.plotConfig as (IndicatorRegistryEntry["plotConfig"][number] & PlotPalette)[]) {
    const pts = result?.plots?.[p.id] as (PlotPoint & { paletteIndex?: number })[] | undefined;
    // a plain colour list (library / script plots) is recoloured by the renderer (plotPaletteOverride)
    if (!p.palette || !pts || typeof p.palette[0] === 'string') continue;
    const colors = (p.palette as { name: string; color: string }[]).map((c, i) => styles[p.id]?.palette?.[i] ?? c.color);
    const opacity = 100 - (p.paletteTransparency ?? 0);
    const shaded = colors.map((c) => (c.startsWith("#") && c.length === 7 ? applyOpacity(c, opacity) : c));
    if (out === result) out = { ...result, plots: { ...result.plots } };
    out.plots[p.id] = pts.map((d) => (d.paletteIndex != null && shaded[d.paletteIndex] ? { ...d, color: shaded[d.paletteIndex] } : d));
  }
  return out;
}
/** A plot with a plain colour list (PlotConfig.palette): the drawn colours the Style tab changed, original -> new
 *  (the renderer replaces the per-point colours). */
function plotPaletteOverride(def: PlotConfig & PlotPalette, ov: PlotStyleOverride | undefined): Record<string, string> | undefined {
  const pal = def.palette;
  if (!pal?.length || typeof pal[0] !== 'string' || !ov?.palette) return undefined;
  const map: Record<string, string> = {};
  (pal as string[]).forEach((c, i) => {
    const next = ov.palette![i];
    if (next && next !== c) map[c] = next;
  });
  return Object.keys(map).length ? map : undefined;
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
  /** Dividends, splits and earnings of the chart symbol; undefined while they load. */
  chartEvents?: () => ChartEvent[] | undefined;
  /** Financial statement items of a symbol (the chart's when empty): undefined while they load, null when it has
   *  none. */
  fundamentals?: (symbol: string) => Fundamentals | null | undefined;
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
  // A study without the data it reads (e.g. volume on a series without volume): its own status title.
  const title = (err as { studyTitle?: unknown } | null)?.studyTitle;
  if (typeof title === 'string') return { kind: 'error', title, message };
  return { kind: 'error', title: 'Runtime error', message };
}

/** What a study shows while its first result is calculated in the worker (or its data loads): loading. */
const PENDING_RESULT = { plots: {}, pending: true };

/** Worker calculations of a study: the result of `key`, the request waiting while one runs, the accessor calls its
 *  runs made. */
type OffThreadRun = {
  key: string | null;
  result: unknown;
  error: StudyError | null;
  /** Symbol, interval and session the result is for. */
  series: string;
  running: boolean;
  queued: { job: StudyWork; key: string; series: string; live: boolean } | null;
  calls: StudyCall[];
  /** Job id of the last whole result the worker gave, and that result (its next one may be the changes from it). */
  version: number | null;
  raw: unknown;
  /** Worker the study's jobs go to (it keeps the study's last result). */
  slot: number | undefined;
  /** A live update does not calculate before this time (performance.now()): see LIVE_PAUSE_FACTOR. */
  liveAfter: number;
  /** Timer that starts the queued live update at `liveAfter`. */
  liveTimer: ReturnType<typeof setTimeout> | null;
  /** What the worker holds for the study: the next job sends the changes only (#255). */
  sent: SentState;
};
/**
 * After a calculation of `ms`, the next live update of the study waits LIVE_PAUSE_FACTOR × ms (at most
 * LIVE_PAUSE_MAX_MS; the newest one is calculated): a study that takes 400 ms recalculates about every 1.6 s and uses
 * a quarter of a worker, instead of calculating without a pause on every tick. A light study is not delayed (its pause
 * is shorter than the time between updates); a change of bars, inputs or symbol calculates at once.
 */
const LIVE_PAUSE_FACTOR = 3;
const LIVE_PAUSE_MAX_MS = 3000;
/** A job before it is sent: the whole bars and accessor values (runOffThread sends what changed). */
type StudyWork = Omit<StudyJob, 'id' | 'kind' | 'prev' | 'barsFrom' | 'data'> & { data: Record<string, unknown> };

/** The last signature of a list of bars, kept while its length and its first and last bar objects are the same (a
 *  live update replaces the last bar, a history load the list): every study calculating on a tick read it again. */
const barsSignatures = new WeakMap<object, { n: number; first: unknown; last: unknown; sig: string }>();

/** Change detector of bars: more history, a live update of the last bar, prices adjusted again (a checksum over
 *  every bar). */
function barsSignature(bars: ArrayLike<Bar>): string {
  const first = bars[0];
  const last = bars[bars.length - 1];
  const kept = barsSignatures.get(bars);
  if (kept && kept.n === bars.length && kept.first === first && kept.last === last) return kept.sig;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    sum += ((i % 13) + 1) * (b.open + 2 * b.high + 3 * b.low + 5 * b.close) + ((i % 7) + 1) * (b.volume ?? 0);
  }
  const sig = `${bars.length}:${first?.time}:${last?.time}:${last?.open}:${last?.high}:${last?.low}:${last?.close}:${last?.volume}:${sum}`;
  barsSignatures.set(bars, { n: bars.length, first, last, sig });
  return sig;
}

/** Checksum of values (NaN counted apart). */
function valuesSignature(list: ArrayLike<unknown>): string {
  let sum = 0;
  let na = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i] as number;
    if (Number.isFinite(v)) sum += ((i % 13) + 1) * v;
    else na += i + 1;
  }
  return `${list.length}:${sum}:${na}`;
}

/**
 * Options applied only when they differ from the target's: applying the same series or scale options again on every
 * draw (a live tick) made the chart lay its panes out again and paint a second time (#259).
 */
function applyChanged(target: { options(): unknown; applyOptions(o: never): void }, patch: Record<string, unknown>): void {
  if (!holds(target.options(), patch)) target.applyOptions(patch as never);
}

/** `current` has the values of `wanted` (the keys of `wanted` only, objects compared key by key). */
function holds(current: unknown, wanted: unknown): boolean {
  if (wanted !== null && typeof wanted === 'object' && !Array.isArray(wanted)) {
    if (current === null || typeof current !== 'object') return false;
    for (const k in wanted as Record<string, unknown>) if (!holds((current as Record<string, unknown>)[k], (wanted as Record<string, unknown>)[k])) return false;
    return true;
  }
  // Functions by identity: the main series' formatter is the same one, an autoscale provider is new on every draw.
  return Object.is(current, wanted);
}

function isBar(v: object): v is Bar {
  return typeof (v as Bar).close === 'number' && typeof (v as Bar).time === 'number';
}

const signatures = new WeakMap<object, string>();
/** Change detector of the data an accessor or a source gives: bars and values by checksum, the other data (symbol
 *  info, events, fundamentals) by content. */
function valueSignature(v: unknown): string {
  if (v === undefined) return '-';
  if (v === null || typeof v !== 'object') return String(v);
  const list = v as ArrayLike<unknown>;
  if (typeof list.length === 'number' && (Array.isArray(v) || ArrayBuffer.isView(v))) {
    const first = list[0];
    return first !== null && typeof first === 'object' ? (isBar(first) ? barsSignature(list as ArrayLike<Bar>) : JSON.stringify(v)) : valuesSignature(list);
  }
  let sig = signatures.get(v);
  if (sig === undefined) signatures.set(v, (sig = JSON.stringify(v)));
  return sig;
}

/** Results already put back on the chart's bar times: a study may return its cached result again. */
const restored = new WeakSet<object>();

/** Index of the first bar at or after `time` (`after`), else of the last bar at or before it; -1 = none. */
function barIndexAt(bars: Bar[], time: number, after: boolean): number {
  if (!after) return lastAtOrBefore(bars, time);
  const i = lowerBound(bars, time);
  return i < bars.length ? i : -1;
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
  /** Palette plots (PlotPalette): the colour of each palette entry. Other outputs with a palette (shapes, background /
   *  bar colours, fills, candle bodies): the colour of each palette entry. */
  palette?: string[];
  // Other outputs than line plots (style-outputs.ts), stored under `<kind>:<id>`:
  /** Shape: its shape (PineScript shape name: triangleup, labeldown, ...). */
  shape?: string;
  /** Shape / character: its location (abovebar, belowbar, top, bottom, absolute). */
  location?: string;
  /** Character: the character. */
  char?: string;
  /** Arrows: up / down colours. */
  colorUp?: string;
  colorDown?: string;
  /** Candles: wick / border colours, or the colours of their palettes. */
  wickColor?: string;
  borderColor?: string;
  wickPalette?: string[];
  borderPalette?: string[];
  /** Hline: value, line style. */
  price?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  /** Gradient fill: top / bottom colours. */
  topColor?: string;
  bottomColor?: string;
};
/** Per-plot style overrides for a study, keyed by plot id (other outputs: `<kind>:<id>`, see style-outputs.ts). */
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

  /** The chart shows Volume Candles: column plots take the widths of the candles (applied at the next draw). */
  private volumeCandles = false;
  setVolumeCandles(on: boolean): void {
    this.volumeCandles = on;
  }

  /** Values of another source of the chart named by a source input (study on study), aligned with the bars;
   *  null = not a source of the chart (the calculation reads close). */
  private sourceValues: ((name: string, bars: Bar[]) => ArrayLike<number> | null) | null = null;
  setSourceValues(fn: ((name: string, bars: Bar[]) => ArrayLike<number> | null) | null): void {
    this.sourceValues = fn;
  }

  setOtherSymbols(store: OtherSymbolBars | null): void {
    this.otherSymbols = store;
  }

  /** Points of plot `index` (plotConfig order) of the last calculation, null before one. */
  plotPoints(index: number): ReadonlyArray<{ time: unknown; value?: number | null }> | null {
    const def = this.entry?.plotConfig[index];
    if (!def || !this.lastResult) return null;
    return (this.lastResult.plots?.[def.id] as { time: unknown; value?: number | null }[] | undefined) ?? [];
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
   *  redraw of every series per live update was 10-200 ms on long histories). `calculate` false: a study that is not
   *  drawn and that nothing reads does not calculate (hidden studies kept the CPU busy on every live update); its
   *  result is calculated when it is read (`ensureResult`) or drawn again. */
  render(
    entry: IndicatorRegistryEntry,
    bars: Bar[],
    inputs: Record<string, unknown>,
    draw = true,
    styles: IndicatorStyleOverrides = {},
    live = false,
    calculate = true,
  ): void {
    this.inPreservedPane(() => {
      const drewBefore = this.lastDraw && this.entry === entry;
      this.entry = entry;
      this.lastInputs = inputs;
      this.lastStyles = styles;
      this.lastBars = bars;
      this.lastDraw = draw;
      this.stale = !calculate;
      this.workerResult = null;
      if (calculate) this.lastResult = bars.length ? this.calculate(entry, bars, inputs, styles, live) : null;
      else { this.lastResult = null; this.error = null; this.loading = false; }
      // A live update while the worker calculates: the result drawn stays as it is.
      if (live && drewBefore && draw && this.workerResult !== null && this.workerResult === this.drawnWorkerResult) return;
      this.draw(live);
      this.drawnWorkerResult = draw ? this.workerResult : null;
    });
  }

  /** The last render did not calculate. */
  private stale = false;
  /** Calculate the result the last render skipped (another study reads it), without drawing. */
  ensureResult(): void {
    if (!this.stale || !this.entry) return;
    this.stale = false;
    this.lastResult = this.lastBars.length ? this.calculate(this.entry, this.lastBars, this.lastInputs, this.lastStyles) : null;
  }

  // ── Off the window's thread (study-calc.ts) ───────────────────────────
  /** Run state of the worker calculations (library studies). */
  private off: OffThreadRun = { key: null, result: null, error: null, series: '', running: false, queued: null, calls: [], version: null, raw: null, slot: undefined, liveAfter: 0, liveTimer: null, sent: { stateId: null, bars: null, data: new Map() } };
  /** The worker's result the last calculation gave (null: not a worker result), and the one drawn. */
  private workerResult: unknown = null;
  private drawnWorkerResult: unknown = null;
  /** The worker's result arrived: the chart draws the study again (`live`: it was asked for a live update). */
  private calculated: ((live: boolean) => void) | null = null;
  setOnCalculated(fn: ((live: boolean) => void) | null): void {
    this.calculated = fn;
  }

  /** A live update starts the study's worker calculation (without drawing): true when one runs now, whose result the
   *  update waits for (IndicatorController.whenLiveCalculated). One that was running already counts: this one runs
   *  after it, and painting at once would draw every study again on each tick that comes meanwhile (#262). */
  startLiveJob(entry: IndicatorRegistryEntry, bars: Bar[], inputs: Record<string, unknown>, styles: IndicatorStyleOverrides): boolean {
    if (!bars.length || !this.calculatesOffThread(entry)) return false;
    this.calculate(entry, bars, inputs, styles, true);
    return this.off.running;
  }

  /** The indicator library's studies calculate in a worker (a strategy runs in the backtester, the app's own studies
   *  read the window's data). */
  private calculatesOffThread(entry: IndicatorRegistryEntry): boolean {
    return !!this.calculated && studyWorkersAvailable() && !isStrategyId(entry.id) && isLibraryEntry(entry);
  }

  /**
   * The study's result for these bars and inputs: the worker's when it calculated them, else it is asked for it (the
   * newest request waits while one runs) and the result before stays meanwhile on the same symbol and interval (a
   * live update, more history), the study shows loading on another one. The accessors the study called in its last
   * run are read here (their loads start, the symbols it reads are kept) and sent with the job.
   */
  private offThreadResult(entry: IndicatorRegistryEntry, bars: Bar[], inputs: Record<string, unknown>, ctx: StudyCalcContext, live: boolean): { result?: unknown; error?: StudyError } {
    const off = this.off;
    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx)) if (typeof v !== 'function') plain[k] = v;
    const fns = ctx as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
    const accessors = ACCESSORS.filter((k) => typeof fns[k] === 'function');
    const data: Record<string, unknown> = {};
    let key = `${barsSignature(bars)}|${JSON.stringify(inputs)}|${JSON.stringify(plain)}`;
    for (const c of off.calls) {
      const fn = fns[c.kind];
      if (!fn) continue;
      let v: unknown;
      try {
        v = fn(...c.args);
      } catch (err) {
        if (!(err instanceof MissingSymbolDataError)) throw err;
      }
      const ck = callKey(c.kind, c.args);
      key += `|${ck}=${valueSignature(v)}`;
      if (v !== undefined) data[ck] = v;
    }
    const sources: Record<string, ArrayLike<number>> = {};
    const values = this.sourceValues;
    if (values) {
      for (const v of Object.values(inputs)) {
        if (typeof v !== 'string' || v in sources) continue;
        const arr = values(v, bars);
        if (!arr) continue;
        sources[v] = arr;
        key += `|${v}=${valueSignature(arr)}`;
      }
    }
    const series = `${ctx.tickerid}|${ctx.timeframe}|${ctx.sessionType}`;
    if (off.key === key) {
      this.workerResult = off.result;
      return off.error ? { error: off.error } : { result: off.result ?? PENDING_RESULT };
    }
    const job: StudyWork = { entryId: entry.id, study: `${this.chartId}|${this.studyId ?? entry.id}`, base: null, bars, restamp: true, inputs, ctx: plain, accessors, data, sources };
    if (off.running) off.queued = { job, key, series, live };
    else if (live && (off.liveTimer || performance.now() < off.liveAfter)) {
      off.queued = { job, key, series, live };
      this.startQueuedLater(off);
    } else {
      // not a live update (bars, inputs, symbol): no pause
      if (off.liveTimer) clearTimeout(off.liveTimer);
      off.liveTimer = null;
      off.queued = null;
      this.runOffThread(job, key, series, live);
    }
    if (off.series !== series || off.result === null) return { result: PENDING_RESULT };
    this.workerResult = off.result;
    return off.error ? { error: off.error } : { result: off.result };
  }

  /**
   * Send a job: the bars and accessor values whole the first time, then only what changed since the job before (the
   * worker holds the rest): a live update sends the forming bar and the new ones (#255). The worker sends the changes
   * from the result held here (`base`) when it has it.
   */
  private runOffThread(job: StudyWork, key: string, series: string, live: boolean): void {
    const off = this.off;
    off.running = true;
    const sent = { ...job, ...jobChanges(off.sent, job.bars, job.data, valueSignature), base: off.version };
    void calculateInWorker(sent, off.slot).then(({ reply, slot }) => {
      if (this.off !== off) return;
      off.running = false;
      off.slot = slot;
      // The worker holds this job's state now, unless it did not take it: the next job sends everything again.
      if (reply.retry) { off.sent.stateId = null; off.version = null; off.raw = null; }
      else off.sent.stateId = reply.id;
      if (reply.base != null) {
        reply.result = reply.base === off.version && off.raw !== null ? applyDelta(reply.result, off.raw) : undefined;
        // The result it changed is not the one held here: ask again for a whole one.
        if (reply.result === undefined) { reply.retry = true; off.version = null; off.raw = null; }
      }
      if (!reply.retry && !reply.error && !reply.pending && reply.result !== undefined) {
        off.version = reply.id;
        off.raw = reply.result;
      }
      for (const m of reply.missing) if (!off.calls.some((c) => c.kind === m.kind && callKey(c.kind, c.args) === callKey(m.kind, m.args))) off.calls.push(m);
      if (reply.retry) off.key = null;
      else if (reply.missing.length && !reply.error) {
        // It read data it was not given: the next calculation reads it and asks again (loading meanwhile).
        off.key = null;
        off.series = series;
        off.result = reply.result ?? PENDING_RESULT;
        off.error = null;
      } else {
        off.key = key;
        off.series = series;
        off.result = reply.error ? null : reply.pending ? PENDING_RESULT : reply.result;
        off.error = reply.error ? studyErrorOf(Object.assign(new Error(reply.error), { studyTitle: reply.errorTitle })) : null;
      }
      off.liveAfter = performance.now() + Math.min(LIVE_PAUSE_MAX_MS, LIVE_PAUSE_FACTOR * (reply.ms || 0));
      const next = off.queued;
      if (next && next.key !== off.key && next.live && performance.now() < off.liveAfter) {
        // the newest live update waits for the pause; the result that came is drawn meanwhile
        this.startQueuedLater(off);
        this.calculated?.(live);
        return;
      }
      off.queued = null;
      if (next && next.key !== off.key) this.runOffThread(next.job, next.key, next.series, next.live);
      else this.calculated?.(live && !next);
    });
  }

  /** The queued job starts at the end of the live pause (a newer one queued meanwhile replaces it). */
  private startQueuedLater(off: OffThreadRun): void {
    if (off.liveTimer) return;
    off.liveTimer = setTimeout(() => {
      off.liveTimer = null;
      if (this.off !== off || off.running) return;
      const next = off.queued;
      off.queued = null;
      if (next && next.key !== off.key) this.runOffThread(next.job, next.key, next.series, next.live);
    }, Math.max(0, off.liveAfter - performance.now()));
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

  private calculate(entry: IndicatorRegistryEntry, bars: Bar[], inputs: Record<string, unknown>, styles: IndicatorStyleOverrides, live = false): any {
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
        ctx.fundamentals = (symbol) => {
          const sym = symbol.trim() || ticker;
          if (!sym) return null;
          used.add(store.fundamentalsKey(sym));
          return store.fundamentals(sym);
        };
      }
      // Daily and longer bars at the session open, as studies read them (strategies restamp their own bars: the
      // broker and the report keep the chart's bar times).
      // A worker calculation restamps them in the worker (and puts the result back on the chart's times there).
      const offThread = this.calculatesOffThread(entry);
      const restamp = (list: Bar[]) => (isStrategyId(entry.id) ? list : scriptBars(list, ctx));
      // The workers restamp the library studies' and the user scripts' bars (and put their results back) themselves.
      const workerBars = offThread || isUserIndicatorId(entry.id);
      const seen = workerBars ? bars : restamp(bars);
      const range = this.visibleRange();
      if (range) {
        const left = barIndexAt(bars, range.from, true);
        const right = barIndexAt(bars, range.to, false);
        if (left >= 0 && right >= left) {
          const [l, r] = workerBars ? restamp([bars[left], bars[right]]) : [seen[left], seen[right]];
          ctx.leftVisibleBarTime = (l.time as unknown as number) * 1000;
          ctx.rightVisibleBarTime = (r.time as unknown as number) * 1000;
        }
      }
      // Source inputs naming another source of the chart read its values (the bars keep their index).
      const values = this.sourceValues;
      setSourceResolver(values ? (name) => values(name, bars) : null);
      let result: unknown;
      try {
        if (offThread) {
          const off = this.offThreadResult(entry, bars, inputs, ctx, live);
          if (off.error) {
            this.error = off.error;
            return null;
          }
          result = off.result;
        } else {
          result = (entry.calculate as (b: Bar[], i: Record<string, unknown>, ctx: StudyCalcContext) => unknown)(seen, inputs, ctx);
        }
      } finally {
        setSourceResolver(null);
      }
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
    const columns = new Map<string, { points: ColumnPoint[]; base: number }>();
    for (const def of entry.plotConfig) {
      const ov = styles[def.id];
      const style = pineStyle(ov?.plotType);
      const palette = plotPaletteOverride(def as PlotConfig & PlotPalette, ov);
      const shown = plotShown(def as PlotDefaultVisible, ov);
      overrides[def.id] = {
        ...(shown ? {} : { visible: false }),
        ...(ov?.color !== undefined && { color: ov.color }),
        ...(ov?.lineWidth !== undefined && { lineWidth: ov.lineWidth }),
        ...(style && { style }),
        ...(palette && { palette }),
      };
      // A plot turned off is not drawn (the renderer skips it): nothing to prepare.
      if (!shown) continue;
      const effective = style ?? def.style ?? 'line';
      if ((effective === 'linebr' || effective === 'steplinebr') && plots[def.id]?.length) {
        if (plots === result.plots) plots = { ...plots };
        plots[def.id] = withGaps(plots[def.id], bars);
      }
      // Volume Candles: the columns are drawn as wide as their candle (volume-columns.ts); the plot series draws
      // them transparent.
      if (this.volumeCandles && effective === 'columns' && plots[def.id]?.length) {
        const plain = ov?.color ?? def.color ?? '#2962FF';
        const points: ColumnPoint[] = [];
        for (const p of plots[def.id]) {
          if (p.value == null || Number.isNaN(p.value)) continue;
          const own = (p as { color?: string }).color;
          points.push({ time: p.time as unknown as number, value: p.value, color: (own && palette?.[own]) ?? own ?? plain });
        }
        columns.set(def.id, { points, base: (def as { histbase?: number }).histbase ?? 0 });
        if (plots === result.plots) plots = { ...plots };
        plots[def.id] = plots[def.id].map((p) => ({ ...p, color: 'transparent' }));
      }
    }

    // The other outputs with their Style overrides (shapes, arrows, colours, candles, hlines, fills, drawings).
    const styled = applyStyleOverrides(entry as unknown as StyleEntry, result, styles, bars);
    // A built-in study's text in the interface language; a user's script or strategy keeps its own.
    const library = isLibraryEntry(entry) || (!isUserIndicatorId(entry.id) && !isStrategyId(entry.id));
    renderer.setPaneIndex(this.paneIndex);
    renderer.setFutureSlots(this.futureSlots());
    try {
      this.renderResult(renderer, entry, styled, plots, library, bars, overrides, ownScale, reuseSeries);
    } catch (err) {
      // A result the chart library refuses (times out of order…) must not stop the chart's own update (a symbol
      // change left half applied, #307): the study shows the error instead.
      renderer.clear();
      this.error = studyErrorOf(err);
      // eslint-disable-next-line no-console
      console.warn(`[indicators] ${entry.id} failed to draw`, err);
      return;
    }
    this.afterRender(entry, result, plots, overrides, ownScale, columns);
  }

  private renderResult(
    renderer: IndicatorRenderer,
    entry: IndicatorRegistryEntry,
    styled: ReturnType<typeof applyStyleOverrides>,
    plots: Record<string, PlotPoint[]>,
    library: boolean,
    bars: Bar[],
    overrides: Record<string, PlotOverride>,
    ownScale: boolean,
    reuseSeries: boolean,
  ): void {
    renderer.render(
      {
        overlay: this.rendererOverlay,
        plotConfig: library ? translatedPlotConfig(entry.plotConfig) : entry.plotConfig,
        hlineConfig: styled.hlineConfig as IndicatorRegistryEntry["hlineConfig"],
        fillConfig: styled.fillConfig as IndicatorRegistryEntry["fillConfig"],
        arrowConfig: (entry as { arrowConfig?: never }).arrowConfig,
      },
      (library ? translatedStudyResult({ ...styled.result, plots } as IndicatorResult) : { ...styled.result, plots }) as IndicatorResult,
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
    columns: Map<string, { points: ColumnPoint[]; base: number }>,
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
    if (mainFormat) for (const s of series) applyChanged(s, { priceFormat: mainFormat });
    // Elsewhere, with the default precision: the study's own value format (reference), for its scale labels.
    const own = (entry as { format?: { type: "price" | "volume" | "percent"; precision?: number } }).format;
    if (!mainFormat && this.precision === null && own) {
      const precision = own.type === "volume" ? 2 : (own.precision ?? 2);
      const priceFormat =
        studyScaleFormat(own.type, precision) ??
        (own.type === "volume" ? { type: "volume" as const, precision } : { type: own.type, precision, minMove: 1 / 10 ** precision });
      for (const s of series) applyChanged(s, { priceFormat });
    }
    // A language writing numbers with other marks: the library's own formats ("1234.50") in the language's marks,
    // with their decimals.
    for (const s of series) {
      const pf = (s as ISeriesApi<SeriesType>).options().priceFormat;
      const local = pf.type === "custom" ? null : studyScaleFormat(pf.type, pf.precision ?? 2);
      if (local) applyChanged(s, { priceFormat: local });
    }
    if (this.detachedScale && !ownScale && this.detachedAxis) {
      // A scale with its axis (a side scale, or an extra axis that draws the
      // plots' last-value labels itself).
      for (const s of series) setSeriesScale(s as ISeriesApi<SeriesType>, this.detachedScale, (s as ISeriesApi<SeriesType>).options().lastValueVisible || labelWanted(s));
    } else if (this.detachedScale && !ownScale) {
      // No axis for this scale: no value label either.
      for (const s of series) applyChanged(s, { priceScaleId: this.detachedScale, lastValueVisible: false });
      const scale = (series[0] as ISeriesApi<SeriesType> | undefined)?.priceScale();
      if (scale) applyChanged(scale, { visible: false });
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
      if (this.lastStyles[def.id]?.priceLine) applyChanged(s, { priceLineVisible: true, priceLineColor: color });
      if (anchored) continue;
      if (ownScale) this.applyOwnScale(s, entry);
      const cols = columns.get(def.id);
      if (cols) {
        const primitive = new VolumeColumnsPrimitive(cols.points, cols.base, this.lastBars as { time: number; volume?: number }[]);
        s.attachPrimitive(primitive as ISeriesPrimitive<Time>);
        this.detachers.push(() => s.detachPrimitive(primitive as ISeriesPrimitive<Time>));
      }
      if (style === 'stepline_diamond') {
        const points = data.filter((d) => d.value != null && !Number.isNaN(d.value));
        const primitive = new StepDiamondsPrimitive(points, color, overrides[def.id].lineWidth ?? def.lineWidth ?? 1);
        s.attachPrimitive(primitive as ISeriesPrimitive<Time>);
        this.detachers.push(() => s.detachPrimitive(primitive as ISeriesPrimitive<Time>));
      }
      // Fundamentals metrics: the value labels under the steps of their plot.
      const labels = (result as { fundamentalLabels?: Record<string, FundamentalLabel[]> }).fundamentalLabels?.[def.id];
      if (labels?.length) {
        const font = this.chart.options().layout.fontFamily;
        const primitive = new FundamentalLabelsPrimitive(labels, uiTheme() === 'light' ? '#0F0F0F' : '#DBDBDB', font);
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
    applyChanged(series, { priceScaleId: md.ownScaleId, lastValueVisible: false });
    applyChanged(series.priceScale(), { scaleMargins: md.ownScaleMargins ?? { top: 0.75, bottom: 0 }, visible: false });
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
      const hit = indexOfTime(sample, time);
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
      const own = (pt as { color?: string }).color;
      // a palette colour changed in the Style tab
      const mapped = own ? plotPaletteOverride(p as PlotConfig & PlotPalette, ov)?.[own] : undefined;
      const color = mapped ?? own ?? ov?.color ?? p.color ?? '#787b86';
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
    // the Style tab check box first (a plot hidden by default can be shown)
    const ov = this.lastStyles[plotDef.id]?.visible;
    if (ov !== undefined) return ov;
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
