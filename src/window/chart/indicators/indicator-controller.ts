/*
 * IndicatorController — owns the set of active indicators on one chart.
 *
 * ChartView creates a controller per chart instance and calls:
 *   • sync(ids)         when the user's active-indicator list changes
 *   • renderAll(bars)   when the underlying bars change (symbol/interval load,
 *                       history prepend) or the chart is re-themed
 *   • destroy()         on unmount
 *
 * Overlay studies (SMA, BB, …) draw in pane 0 over the price series.  Oscillator
 * studies (RSI, MACD, …) each get their own stacked pane below, allocated here
 * and freed when the study is removed.
 */
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { Bar } from 'oakscriptjs';
import type { StudyChart } from './script-chart';
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { getIndicatorEntry } from './registry';
import { isStrategyId } from './strategy-entries';
import { IndicatorLayer, type IndicatorLegendPlot, type IndicatorStyleOverrides, type StudyError } from './indicator-layer';
import { OtherSymbolBars } from './other-symbols';
import type { TpoBlockHit } from '../profiles/tpo-primitive';
import { intervalSeconds } from '../../../backtester/magnifier';
import type { BackgroundAt } from '../selection-markers';
import { isVisibleOnInterval } from 'lightweight-charts-drawing/core/types';
import {
  MAIN_PANE_GROUP,
  cloneIndicatorOptions,
  defaultIndicatorOptions,
  precisionDigits,
  reviveIndicatorOptions,
  statusLineInputs,
  type IndicatorOptions,
  type StudyScale,
} from './indicator-options';

/** Quiet time after a scroll or zoom before the studies that read the visible range calculate again. */
const VISIBLE_RANGE_DELAY_MS = 120;

/** Bars of other symbols arriving together (several loads, a burst of live updates) give one recalculation. */
const SYMBOLS_DELAY_MS = 50;

/** A stacked-pane owner that is not a study (a compared symbol drawn in
 *  "New pane"): it shares the pane numbering with the studies. */
export interface PaneOwner {
  setPaneIndex(i: number): void;
  clear(): void;
  firstSeries(): ISeriesApi<SeriesType> | null;
  legendPlots(time?: number): IndicatorLegendPlot[];
}

type Instance = {
  layer: IndicatorLayer;
  /** Set for a pane owner that is not a study (`layer` unused then). */
  owner?: PaneOwner;
  paneIndex: number;
  /** Drawn in the price pane. */
  overlay: boolean;
  /** Pane group of a stacked pane (the instances with the same group share
   *  the pane); null in the price pane. */
  group: string | null;
  /** Overlay study on its OWN hidden scale (Volume) — draws in pane 0 but its
   *  values are not prices, so the magnet must ignore it. */
  ownScale: boolean;
};

/** One row of the on-chart studies legend. */
export type IndicatorLegendRow = {
  id: string;
  title: string;
  hidden: boolean;
  plots: IndicatorLegendPlot[];
  /** Pane whose legend lists the study: 0 for overlays, else its own pane
   *  (a study pane's legend sits at that pane's top-left). */
  pane: number;
  /** Input values shown after the title (status line), "" = none. */
  inputs: string;
  /** The study's inputs (defaults + the user's changes), for an alert on it. */
  inputValues?: Record<string, unknown>;
  /** Style -> "Values in status line" / "Inputs in status line". */
  showValues: boolean;
  showInputs: boolean;
  /** Style -> "Precision": decimals of the values, null = Default. */
  precision: number | null;
  /** Hidden because the chart interval is outside its Visibility tab. */
  offInterval: boolean;
  /** The legend eye state alone (hidden also covers offInterval). */
  eyeHidden: boolean;
  /** The study failed: its status in the legend (values hidden). */
  error?: StudyError | null;
  /** The study waits for its data: loading eye, values not available. */
  loading?: boolean;
  /** Set on a compared symbol's row: its value texts (in the line colour);
   *  the title is shown as is and its click changes the symbol. */
  compare?: { texts: { text: string; color: string }[] };
};

export class IndicatorController {
  private chart: IChartApi;
  private getBars: () => Bar[];
  private instances = new Map<string, Instance>();
  /** Selected study and the chart background its markers use. */
  private selected: { id: string; bgAt: BackgroundAt } | null = null;
  private seriesOnlyScale: string | null = null;
  /** Pane indices (>=1) currently claimed by a non-overlay study. */
  private usedPanes = new Set<number>();
  /** Studies whose plots are toggled off via the legend eye. */
  private hidden = new Set<string>();
  /** Per-study input overrides (legend gear → Settings). Merged over the
   *  registry `defaultInputs` at render time. Kept keyed by id even while a study
   *  is synced out (Hide-indicators removes the layers) so the tweaks return when
   *  it's re-added. */
  private inputs = new Map<string, Record<string, unknown>>();
  /** Per-study plot style overrides (legend gear → Settings → Style). Same
   *  lifetime rules as {@link inputs}. */
  private styles = new Map<string, IndicatorStyleOverrides>();
  /** Scales → "Indicators and financials": last-value axis labels on the study
   *  plot series. Default ON (the row ships "Value"). */
  private lastValueVisible = true;
  private nameLabelsVisible = false;
  /** Per-study Style-tab options + Visibility tab. Same lifetime rules as
   *  {@link inputs}. */
  private options = new Map<string, IndicatorOptions>();
  /** Chart interval, for the studies' Visibility tab. */
  private interval: string | undefined;
  /** Stacked panes order (study and pane-owner ids, top to bottom); ids not
   *  listed follow, studies before pane owners. */
  private paneOrder: string[] = [];
  private lastIds: string[] = [];
  /** A study re-created its series (full draw): the chart re-applies the
   *  drawing order of its sources. */
  private seriesChanged: () => void = () => {};
  private redrawn: () => void = () => {};

  /** Identifies the chart for studies that keep per-chart state (strategies). */
  private chartId: string;
  /** Chart context of the studies (timeframe, session...). */
  private scriptChart: StudyChart | undefined;
  /** The chart shows Heikin Ashi bars (strategies run on them). */
  private heikinAshi = false;
  /** The newest bar is still forming (a realtime bar for strategies). */
  private lastBarOpen: () => boolean = () => false;
  /** The chart's main price series (study markers and bar colours). */
  private mainSeries: () => ISeriesApi<SeriesType> | null = () => null;
  /** The newest bar as it was first seen: until it moves, a calculation is its first update. */
  private firstSeen: { time: unknown; sig: string } | null = null;
  private readonly chartState = () => {
    const open = this.lastBarOpen();
    const isNew = this.lastBarNew();
    return { heikinAshi: this.heikinAshi, realtime: open, lastBarConfirmed: !open, lastBarNew: !open || isNew };
  };

  /** Chart bar times of the first and last visible bars (studies that read the visible range). */
  private readonly visibleRange = (): { from: number; to: number } | null => {
    const r = this.chart.timeScale().getVisibleRange();
    return r ? { from: r.from as number, to: r.to as number } : null;
  };
  private visibleKey = "";
  private visibleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisibleRange = (): void => {
    if (this.visibleTimer) clearTimeout(this.visibleTimer);
    this.visibleTimer = setTimeout(() => {
      this.visibleTimer = null;
      this.renderVisibleRangeStudies();
    }, VISIBLE_RANGE_DELAY_MS);
  };

  /** Bars of the other symbols the studies read; keys that moved wait here for one recalculation. */
  private readonly otherSymbols: OtherSymbolBars;
  private symbolsMoved = new Set<string>();
  private symbolsLive = true;
  private symbolsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(chart: IChartApi, getBars: () => Bar[], chartId = "") {
    this.chart = chart;
    this.getBars = getBars;
    this.chartId = chartId;
    chart.timeScale().subscribeVisibleTimeRangeChange(this.onVisibleRange);
    this.otherSymbols = new OtherSymbolBars((keys, live) => this.onSymbolsMoved(keys, live), `ind:${chartId}`);
  }

  /** The TPO study block at media point (x, y) of the price pane (the newest study first), or null. */
  tpoBlockAt(x: number, y: number): { id: string; hit: TpoBlockHit } | null {
    for (const [id, inst] of [...this.instances].reverse()) {
      if (inst.owner || inst.paneIndex !== 0) continue;
      const hit = inst.layer.tpoBlockAt(x, y);
      if (hit) return { id, hit };
    }
    return null;
  }

  /** Lower-timeframe keys the drawings read (volume profile drawings): kept loaded, and the drawings repaint when
   *  their bars move. */
  private drawingKeys = new Set<string>();
  private drawingsDataHook: () => void = () => {};

  /** How the chart hears that bars the drawings read arrived or moved. */
  setDrawingsDataHook(hook: () => void): void {
    this.drawingsDataHook = hook;
  }

  /** Bars of the chart symbol on a lower timeframe, in the chart's session, from `from` (seconds) on, for the
   *  drawings; undefined while they load. */
  drawingLowerBars(resolution: string, from: number): Bar[] | undefined {
    const ticker = this.scriptChart?.tickerid;
    if (!ticker) return undefined;
    const session = this.scriptChart?.sessionType === 'extended' ? 'ETH' : 'RTH';
    this.drawingKeys.add(this.otherSymbols.lowerKey(ticker, resolution, session));
    return this.otherSymbols.lowerBars(ticker, resolution, session, from);
  }

  /** Bars of other symbols arrived or moved: the studies that read them calculate again (once per burst). */
  private onSymbolsMoved(keys: Set<string>, live: boolean): void {
    if ([...keys].some((k) => this.drawingKeys.has(k))) this.drawingsDataHook();
    for (const k of keys) this.symbolsMoved.add(k);
    this.symbolsLive &&= live;
    if (this.symbolsTimer) return;
    this.symbolsTimer = setTimeout(() => {
      this.symbolsTimer = null;
      const moved = this.symbolsMoved;
      const liveOnly = this.symbolsLive;
      this.symbolsMoved = new Set();
      this.symbolsLive = true;
      const bars = this.getBars();
      for (const [id, inst] of this.instances) {
        if (inst.owner || ![...inst.layer.symbolsUsed()].some((k) => moved.has(k))) continue;
        const entry = getIndicatorEntry(id);
        if (entry) this.renderOne(id, inst, entry, bars, liveOnly);
      }
      this.retainSymbols();
      this.redrawn();
    }, SYMBOLS_DELAY_MS);
  }

  /** The other symbols no study reads any more are dropped (and their live updates stopped). */
  private retainSymbols(): void {
    const used = new Set<string>(this.drawingKeys);
    for (const inst of this.instances.values()) if (!inst.owner) for (const k of inst.layer.symbolsUsed()) used.add(k);
    this.otherSymbols.retain(used);
  }

  /** The chart reloads its bars (adjustment changed...): the other symbols are fetched again. */
  reloadOtherSymbols(): void {
    this.drawingKeys.clear();
    this.otherSymbols.clear();
  }

  /** Scroll or zoom: the studies that read the visible range calculate again once the range settles. */
  private renderVisibleRangeStudies(): void {
    const r = this.visibleRange();
    const key = r ? `${r.from}|${r.to}` : "";
    if (key === this.visibleKey) return;
    this.visibleKey = key;
    const bars = this.getBars();
    for (const [id, inst] of this.instances) {
      if (inst.owner) continue;
      const entry = getIndicatorEntry(id);
      if (entry?.usesVisibleRange) this.renderOne(id, inst, entry, bars);
    }
    this.redrawn();
  }

  /** Reconcile the live layers with the desired ordered list of registry ids. */
  sync(ids: string[]): void {
    const desired = new Set(ids);

    // Remove studies no longer wanted (pane owners are not studies).
    for (const [id, inst] of [...this.instances]) {
      if (!inst.owner && !desired.has(id)) { this.remove(id); this.hidden.delete(id); }
    }

    // Add newly-wanted studies (in list order, so pane stacking is stable).
    for (const id of ids) {
      if (this.instances.has(id)) continue;
      this.add(id);
    }
    this.lastIds = ids;
    this.orderPanes(ids);
  }

  /** How the chart hears that studies calculated again on their own (other symbols' bars, visible range): its
   *  legend shows their new values and statuses. */
  setRedrawnHook(hook: () => void): void {
    this.redrawn = hook;
  }

  /** How the chart hears that a study re-created its series. */
  setSeriesChangedHook(hook: () => void): void {
    this.seriesChanged = hook;
  }

  /** Persisted stacking order (pane controls move up / down; add order of
   *  study panes and compared symbols in "New pane"). */
  setPaneOrder(order: string[]): void {
    this.paneOrder = order;
    this.orderPanes(this.lastIds);
  }

  /** Re-apply the stacking order (panes drawn after the last sync). */
  applyPaneOrder(): void {
    this.orderPanes(this.lastIds);
  }

  /** Stacked pane ids, top to bottom (pane index order). */
  stackedOrder(): string[] {
    return [...this.instances].filter(([, inst]) => !inst.overlay).sort((a, b) => a[1].paneIndex - b[1].paneIndex).map(([id]) => id);
  }

  /** Stacked panes in list order (the order a fresh load gives): a study
   *  put back in the middle of the list (undo of a removal) opens at the
   *  bottom, then moves up to its place. Panes not drawn yet are left. */
  private orderPanes(ids: string[]): void {
    // The persisted order first; the others follow (studies in list order,
    // then the other pane owners in add order).
    const rest = [
      ...ids.filter((id) => {
        const inst = this.instances.get(id);
        return !!inst && !inst.overlay && !inst.owner;
      }),
      ...[...this.instances].filter(([, inst]) => !!inst.owner).map(([id]) => id),
    ];
    const rank = (id: string) => {
      const k = this.paneOrder.indexOf(id);
      return k >= 0 ? k : this.paneOrder.length + rest.indexOf(id);
    };
    // One entry per pane: the first of the instances sharing it.
    const groups = new Set<string | null>();
    const stacked = rest
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .filter((id) => {
        const g = this.instances.get(id)!.group;
        if (groups.has(g)) return false;
        groups.add(g);
        return true;
      });
    const n = this.chart.panes().length;
    stacked.forEach((id, k) => {
      const want = k + 1;
      const inst = this.instances.get(id)!;
      if (inst.paneIndex !== want && inst.paneIndex < n && want < n) this.swapPanes(inst.paneIndex, want);
    });
  }

  /** Toggle the studies' last-value axis labels (Settings → Scales →
   *  "Indicators and financials"). No-op when unchanged (the appearance effect
   *  calls this on every settings commit); otherwise re-renders so each layer
   *  re-creates its series with the new flag. */
  setLastValueVisible(v: boolean): void {
    if (v === this.lastValueVisible) return;
    this.lastValueVisible = v;
    for (const inst of this.instances.values()) if (!inst.owner) inst.layer.setLastValueVisible(v);
    this.renderAll();
  }

  /** Toggle the plot-name labels next to the studies' price labels (Settings →
   *  Scales → "Indicators and financials" → Name). No-op when unchanged. */
  setNameLabelsVisible(v: boolean): void {
    if (v === this.nameLabelsVisible) return;
    this.nameLabelsVisible = v;
    for (const inst of this.instances.values()) if (!inst.owner) inst.layer.setNameLabelsVisible(v);
    this.renderAll();
  }

  /** Recompute every active study against the current bars. `live`: only
   *  the newest bars changed (a live update), the studies keep their series. */
  renderAll(live = false): void {
    const bars = this.getBars();
    if (!live) this.otherSymbols.setChartSpan(bars[0]?.time as number | undefined, intervalSeconds(this.scriptChart?.timeframe ?? '1D'));
    for (const [id, inst] of this.instances) {
      const entry = getIndicatorEntry(id);
      if (entry) this.renderOne(id, inst, entry, bars, live);
    }
    if (!live) this.retainSymbols();
  }

  /** The study's options (defaults when never edited). */
  getOptions(id: string): IndicatorOptions {
    return cloneIndicatorOptions(this.options.get(id) ?? defaultIndicatorOptions());
  }

  /** The chart symbol, interval, session or background changed: the chart context of every study.
   *  The studies recompute with the new bars. */
  setScriptChart(chart: StudyChart): void {
    if (JSON.stringify(chart) === JSON.stringify(this.scriptChart)) return;
    // Another symbol or session: the drawings' lower-timeframe bars are read again.
    if (chart.tickerid !== this.scriptChart?.tickerid || chart.sessionType !== this.scriptChart?.sessionType) this.drawingKeys.clear();
    this.scriptChart = chart;
    for (const inst of this.instances.values()) if (!inst.owner) inst.layer.setScriptChart(chart);
  }

  /** The chart type changed: strategies rerun on Heikin Ashi bars or back on the standard bars. */
  setHeikinAshi(on: boolean): void {
    if (on === this.heikinAshi) return;
    this.heikinAshi = on;
    const bars = this.getBars();
    for (const [id, inst] of this.instances) {
      if (inst.owner || !isStrategyId(id)) continue;
      const entry = getIndicatorEntry(id);
      if (entry) this.renderOne(id, inst, entry, bars);
    }
  }

  /** How the chart reads its main price series. */
  setMainSeriesProbe(probe: () => ISeriesApi<SeriesType> | null): void {
    this.mainSeries = probe;
  }

  /** Redraw every study from its last result (the main series was replaced:
   *  markers and bar colours move to the new one). */
  redrawAll(): void {
    for (const inst of this.instances.values()) if (!inst.owner) inst.layer.redraw();
  }

  private lastBarNew(): boolean {
    const bars = this.getBars();
    const last = bars[bars.length - 1];
    if (!last) return true;
    const sig = `${last.open}:${last.high}:${last.low}:${last.close}:${last.volume}`;
    if (this.firstSeen?.time !== last.time) this.firstSeen = { time: last.time, sig };
    return this.firstSeen.sig === sig;
  }

  /** How the chart tells whether its newest bar is still forming. */
  setLastBarOpenProbe(probe: () => boolean): void {
    this.lastBarOpen = probe;
  }

  /** The chart interval changed: studies whose Visibility tab excludes it
   *  stop drawing, the others come back. */
  setChartInterval(interval: string | undefined): void {
    if (interval === this.interval) return;
    const before = new Map([...this.instances.keys()].map((id) => [id, this.onInterval(id)]));
    this.interval = interval;
    const bars = this.getBars();
    for (const [id, inst] of this.instances) {
      if (before.get(id) === this.onInterval(id)) continue;
      const entry = getIndicatorEntry(id);
      if (entry) this.renderOne(id, inst, entry, bars);
    }
  }

  private onInterval(id: string): boolean {
    return isVisibleOnInterval(this.options.get(id)?.visibility, this.interval);
  }

  /** Drawn on the chart: not eye-hidden and on its intervals (strategy trade marks follow it). */
  isDrawn(id: string): boolean {
    return !this.hidden.has(id) && this.onInterval(id);
  }

  /** Draw one study with its options: not drawn when eye-hidden or off its
   *  intervals. */
  private renderOne(id: string, inst: Instance, entry: IndicatorRegistryEntry, bars: Bar[], live = false): void {
    const o = this.options.get(id) ?? defaultIndicatorOptions();
    inst.layer.setPlotOptions({ labelsOnScale: o.labelsOnScale, precision: precisionDigits(o.precision) });
    const pinned = o.scale === 'left' || o.scale === 'right';
    inst.layer.setDetachedScale(this.detachedScale(id, inst, entry), pinned, !!o.scale);
    inst.layer.render(entry, bars, this.effectiveInputs(id, entry), !this.hidden.has(id) && this.onInterval(id), this.styles.get(id) ?? {}, live);
    if (!live) this.seriesChanged();
  }

  /** Scale of its own for a study in a pane whose scale shows other values:
   *  a study that is not a price study in the price pane, and in a shared
   *  stacked pane every study but the one the pane was made for (else the
   *  first one). Null = the pane's scale. A study pinned to a scale ("Pin to
   *  scale") takes it: the other side's scale (shown), or none. */
  private detachedScale(id: string, inst: Instance, entry: IndicatorRegistryEntry): string | null {
    const pinned = this.options.get(id)?.scale;
    if (pinned === 'none') return `src:${id}`;
    if (pinned === 'left' || pinned === 'right') return pinned === this.mainSide ? null : pinned;
    if (inst.overlay) return entry.overlay ? null : `src:${id}`;
    const members = [...this.instances].filter(([, i]) => !i.overlay && i.group === inst.group).map(([mid]) => mid);
    const lead = members.includes(inst.group ?? "") ? inst.group : members[0];
    return lead === id ? null : `src:${id}`;
  }

  /** Side of the main series' scale (the pane scale of the studies). */
  private mainSide: 'left' | 'right' = 'right';

  /** The main series' scale moved side (Settings "Scales placement"): the
   *  studies pinned to a side scale take it again. */
  setMainSide(side: 'left' | 'right'): void {
    if (side === this.mainSide) return;
    this.mainSide = side;
    const bars = this.getBars();
    for (const [id, inst] of this.instances) {
      const entry = getIndicatorEntry(id);
      if (!inst.owner && entry && this.options.get(id)?.scale) this.renderOne(id, inst, entry, bars);
    }
  }

  /** Scale a study is on: the left or right scale of its pane, or none (a
   *  hidden scale of its own: Volume, a study that does not share its pane's
   *  values). Null when it is not on the chart. */
  scaleOf(id: string): StudyScale | null {
    const inst = this.instances.get(id);
    const entry = getIndicatorEntry(id);
    if (!inst || inst.owner || !entry) return null;
    const pinned = this.options.get(id)?.scale;
    if (pinned) return pinned;
    const ownScale = !!(entry.metadata as { ownScaleId?: string }).ownScaleId;
    if (ownScale || this.detachedScale(id, inst, entry)) return 'none';
    return this.mainSide;
  }

  /** A study of the chart is on the scale of side `side`. */
  usesSide(side: 'left' | 'right'): boolean {
    for (const id of this.instances.keys()) if (this.scaleOf(id) === side) return true;
    return false;
  }

  /** Pin a study to a scale ("Pin to scale"); returns its options to save. */
  pinToScale(id: string, scale: StudyScale): IndicatorOptions | null {
    const inst = this.instances.get(id);
    const entry = getIndicatorEntry(id);
    if (!inst || inst.owner || !entry) return null;
    this.options.set(id, { ...cloneIndicatorOptions(this.options.get(id) ?? defaultIndicatorOptions()), scale });
    this.renderOne(id, inst, entry, this.getBars());
    return this.getOptions(id);
  }

  /** Registry defaults merged with any user input overrides for `id`. */
  private effectiveInputs(id: string, entry: IndicatorRegistryEntry): Record<string, unknown> {
    const override = this.inputs.get(id);
    return override ? { ...entry.defaultInputs, ...override } : entry.defaultInputs;
  }

  /** A study's current per-plot style overrides (empty = registry defaults),
   *  for seeding the Settings → Style tab. Null when the study isn't active. */
  getStyles(id: string): IndicatorStyleOverrides | null {
    if (!this.instances.has(id)) return null;
    return this.styles.get(id) ?? {};
  }

  /** A study's current inputs (defaults + overrides), for seeding the Settings
   *  dialog. Null when the study isn't active. */
  getInputs(id: string): Record<string, unknown> | null {
    const entry = getIndicatorEntry(id);
    if (!entry || !this.instances.has(id)) return null;
    return this.effectiveInputs(id, entry);
  }

  /** Commit a study's edited inputs + plot styles (Settings dialog → Ok) and
   *  redraw it once in place, preserving its current eye (hidden) state. */
  applySettings(id: string, inputs: Record<string, unknown>, styles: IndicatorStyleOverrides, options?: IndicatorOptions): void {
    const inst = this.instances.get(id);
    const entry = getIndicatorEntry(id);
    if (!inst || !entry) return;
    this.inputs.set(id, { ...inputs });
    this.styles.set(id, { ...styles });
    if (options) this.options.set(id, cloneIndicatorOptions(options));
    this.renderOne(id, inst, entry, this.getBars());
  }

  /** Seed persisted per-study overrides (from the pane's saved
   *  `indicatorSettings`) into the input/style maps, so a study renders with
   *  them the moment `sync()` adds its layer. Does not render on its own; only
   *  touches the ids present in `map`. Idempotent — safe to call before every
   *  sync. */
  seedSettings(map: Record<string, { inputs?: Record<string, unknown>; styles?: IndicatorStyleOverrides; options?: unknown; hidden?: boolean }>): void {
    for (const id in map) {
      const s = map[id];
      const inst = this.instances.get(id);
      const entry = getIndicatorEntry(id);
      const drawn = !!inst && !inst.owner && !!entry;
      // A study already drawn whose saved settings changed from elsewhere
      // (applied to the entire layout, an undo) is drawn again with them, in
      // its new pane when its pane changed.
      const before = drawn ? this.settingsKey(id) : '';
      const paneBefore = drawn ? this.placementKey(id) : '';
      if (s?.inputs) this.inputs.set(id, { ...s.inputs });
      if (s?.styles) this.styles.set(id, { ...s.styles });
      if (s?.options) this.options.set(id, reviveIndicatorOptions(s.options));
      const eye = !!s?.hidden !== this.hidden.has(id);
      if (eye) {
        if (s?.hidden) this.hidden.add(id); else this.hidden.delete(id);
      }
      if (!drawn) continue;
      if (this.placementKey(id) !== paneBefore) this.refresh(id);
      else if (eye || this.settingsKey(id) !== before) this.renderOne(id, inst!, entry!, this.getBars());
    }
  }

  /** Inputs, styles and options of a study as one comparable text. */
  private settingsKey(id: string): string {
    const sorted = (v: unknown): unknown =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v;
    const o = this.options.get(id);
    return JSON.stringify(sorted({ i: this.inputs.get(id) ?? {}, s: this.styles.get(id) ?? {}, o: o ? reviveIndicatorOptions(o) : null }));
  }

  /** The pane a study's options give it (price pane, own pane, a group). */
  private placementKey(id: string): string {
    const o = this.options.get(id);
    return `${o?.paneGroup ?? ''}|${o?.ownPane ? 1 : 0}`;
  }

  /** Studies legend rows (one per active study) with values at `time` (or the
   *  latest bar), in add order. */
  getLegend(time?: number): IndicatorLegendRow[] {
    const rows: IndicatorLegendRow[] = [];
    for (const [id, inst] of this.instances) {
      if (inst.owner) continue;
      const o = this.options.get(id) ?? defaultIndicatorOptions();
      const entry = getIndicatorEntry(id);
      const offInterval = !this.onInterval(id);
      rows.push({
        id,
        title: inst.layer.title,
        // Legend: a study off its intervals shows as hidden.
        hidden: this.hidden.has(id) || offInterval,
        plots: inst.layer.legendPlots(time, true),
        pane: inst.overlay ? 0 : inst.paneIndex,
        inputs: entry ? statusLineInputs(entry, this.effectiveInputs(id, entry)) : '',
        inputValues: entry ? this.effectiveInputs(id, entry) : undefined,
        showValues: o.valuesInStatusLine,
        showInputs: o.inputsInStatusLine,
        precision: precisionDigits(o.precision),
        offInterval,
        eyeHidden: this.hidden.has(id),
        error: inst.layer.studyError(),
        loading: inst.layer.studyLoading(),
      });
    }
    return rows;
  }

  /** "Download chart data": the visible studies' plots, in the order the
   *  studies were added (hidden studies and those off their intervals are
   *  left out). */
  exportColumns(): { title: string; values: Map<number, number> }[] {
    const out: { title: string; values: Map<number, number> }[] = [];
    for (const [id, inst] of this.instances) {
      if (inst.owner || this.hidden.has(id) || !this.onInterval(id)) continue;
      out.push(...inst.layer.exportPlots());
    }
    return out;
  }

  /** Price-pane (overlay) study plot values at `time`, for the drawing magnet's
   *  "Snap to indicator" option. Oscillator panes are excluded — they live on a
   *  different price scale, so snapping the price axis to them is meaningless.
   *  Hidden studies contribute nothing (legendPlots already skips them). */
  overlayValuesAt(time?: number): number[] {
    const out: number[] = [];
    for (const [id, inst] of this.instances) {
      if (inst.owner || !inst.overlay || inst.ownScale || this.hidden.has(id)) continue;
      for (const p of inst.layer.legendPlots(time)) out.push(p.value);
    }
    return out;
  }

  /** Studies drawn on the main series' price scale (price pane, no scale of
   *  their own), in add order. */
  mainScaleIds(): string[] {
    const out: string[] = [];
    for (const [id, inst] of this.instances) if (!inst.owner && inst.overlay && !inst.ownScale) out.push(id);
    return out;
  }

  /** Owner of chart pane `paneIndex` (>= 1) for drawings: the first study
   *  (add order) with a series in that pane; null when none. Read from the
   *  chart, not the stored pane index. */
  ownerOfPane(paneIndex: number): string | null {
    const pane = this.chart.panes()[paneIndex];
    if (!pane) return null;
    const inPane = new Set<unknown>(pane.getSeries());
    for (const [id, inst] of this.instances) {
      const s = this.seriesOf(inst);
      if (!inst.overlay && s && inPane.has(s)) return id;
    }
    return null;
  }

  /** "Move to" is available for a study drawn over the price series (the
   *  price pane holds the series and it: more than one source). */
  canMoveToNewPane(id: string): boolean {
    const inst = this.instances.get(id);
    return !!inst && !inst.owner && inst.overlay;
  }

  /** Move an overlay study to a new pane (re-created there; the caller puts
   *  the pane in the stacking order and saves the options). Returns the
   *  study's options to persist, or null when it cannot move. */
  moveToNewPane(id: string): IndicatorOptions | null {
    if (!this.canMoveToNewPane(id)) return null;
    const options = { ...(this.options.get(id) ?? defaultIndicatorOptions()), ownPane: true };
    delete options.paneGroup;
    // Other studies may still use its id as their pane group (they joined
    // its former pane): a group of its own then.
    const own = this.ownGroup(id);
    if (own !== id) options.paneGroup = own;
    this.options.set(id, cloneIndicatorOptions(options));
    this.refresh(id);
    return this.getOptions(id);
  }

  /** Studies drawn in stacked pane `paneIndex` (>= 1), pane owners excluded. */
  studiesInPane(paneIndex: number): string[] {
    return [...this.instances].filter(([, i]) => !i.owner && !i.overlay && i.paneIndex === paneIndex).map(([id]) => id);
  }

  /** A study out of a pane it shares (with the series or other studies) into
   *  a new pane of its own (a chart drag dropped on the time axis); the
   *  caller places the pane and saves the options. Null when it is alone in
   *  its pane. */
  unmergeToNewPane(id: string): IndicatorOptions | null {
    const inst = this.instances.get(id);
    if (!inst || inst.owner) return null;
    if (inst.overlay) return this.moveToNewPane(id);
    if (this.idsInPane(inst.paneIndex).length < 2) return null;
    // A group of its own: the studies left behind keep the pane's group.
    const options = { ...(this.options.get(id) ?? defaultIndicatorOptions()), ownPane: false, paneGroup: this.ownGroup(id, true) };
    this.options.set(id, cloneIndicatorOptions(options));
    this.refresh(id);
    return this.getOptions(id);
  }

  /** A pane group no other study uses: the study's id when free (and not
   *  `fresh`), else `<id>~own`, `<id>~own2`, ... */
  private ownGroup(id: string, fresh = false): string {
    const used = new Set([...this.instances].filter(([k]) => k !== id).map(([, i]) => i.group));
    if (!fresh && !used.has(id)) return id;
    let g = `${id}~own`;
    for (let n = 2; used.has(g); n++) g = `${id}~own${n}`;
    return g;
  }

  /** Pane a study is drawn in (0 = the price pane), or null. */
  paneOf(id: string): number | null {
    const inst = this.instances.get(id);
    return inst && !inst.owner ? (inst.overlay ? 0 : inst.paneIndex) : null;
  }

  /** Move a study into the existing pane `paneIndex` (0 = the price pane;
   *  Object tree drag): re-created there, next to what the pane holds. Its
   *  former pane closes when it was alone in it. Returns the study's options
   *  to persist, or null when it cannot move. */
  moveToPane(id: string, paneIndex: number): IndicatorOptions | null {
    const inst = this.instances.get(id);
    const entry = getIndicatorEntry(id);
    if (!inst || inst.owner || !entry || this.paneOf(id) === paneIndex) return null;
    const options = { ...(this.options.get(id) ?? defaultIndicatorOptions()), ownPane: false };
    delete options.paneGroup;
    if (paneIndex === 0) {
      if (!entry.overlay) options.paneGroup = MAIN_PANE_GROUP;
    } else {
      const mate = [...this.instances.values()].find((i) => !i.overlay && i.paneIndex === paneIndex);
      if (!mate?.group) return null;
      options.paneGroup = mate.group;
    }
    this.options.set(id, cloneIndicatorOptions(options));
    this.refresh(id);
    return this.getOptions(id);
  }

  /** Hidden with its eye. */
  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }

  /** Study drawing the series `s` (pane owners excluded), or null. */
  studyOfSeries(s: ISeriesApi<SeriesType>): string | null {
    for (const [id, inst] of this.instances) {
      if (!inst.owner && inst.layer.ownsSeries(s)) return id;
    }
    return null;
  }

  /** "Scale price chart only" on the main series' scale (null = off). */
  setSeriesOnlyScale(scaleId: string | null): void {
    this.seriesOnlyScale = scaleId;
    for (const inst of this.instances.values()) if (!inst.owner) inst.layer.setSeriesOnlyScale(scaleId);
  }

  /** Selected study (markers on its plots); null = none. */
  setSelected(id: string | null, bgAt: BackgroundAt): void {
    this.selected = id ? { id, bgAt } : null;
    for (const [instId, inst] of this.instances) {
      if (!inst.owner) inst.layer.setSelected(instId === id ? bgAt : null);
    }
  }

  /** The series a study's drawings are mapped with (its first plot), or
   *  null. A redraw replaces the series: read it at use time. */
  studySeries(id: string): ISeriesApi<SeriesType> | null {
    const inst = this.instances.get(id);
    return inst ? this.seriesOf(inst) : null;
  }

  private seriesOf(inst: Instance): ISeriesApi<SeriesType> | null {
    return inst.owner ? inst.owner.firstSeries() : inst.layer.firstSeries();
  }
  private plotsOf(inst: Instance, time?: number): IndicatorLegendPlot[] {
    return inst.owner ? inst.owner.legendPlots(time) : inst.layer.legendPlots(time);
  }

  /** Claim the next stacked pane for a pane owner that is not a study (a
   *  compared symbol in "New pane"). Returns the pane index; the owner draws
   *  there. Released with {@link releasePane}. */
  claimPaneFor(id: string, owner: PaneOwner): number {
    const existing = this.instances.get(id);
    if (existing?.owner) return existing.paneIndex;
    const paneIndex = this.claimPane();
    this.instances.set(id, { layer: null as unknown as IndicatorLayer, owner, paneIndex, overlay: false, ownScale: false, group: id });
    return paneIndex;
  }

  /** Remove a pane owner: its series goes, its pane closes, the panes below
   *  move up. */
  releasePane(id: string): void {
    if (this.instances.get(id)?.owner) this.remove(id);
  }

  /** Plot values at `time` of the shown studies in the pane of study `id`
   *  (the drawing magnet's "Snap to indicator" in an indicator pane). */
  paneValuesAt(id: string, time?: number): number[] {
    const s = this.studySeries(id);
    if (!s) return [];
    const inPane = new Set<unknown>(s.getPane().getSeries());
    const out: number[] = [];
    for (const [sid, inst] of this.instances) {
      const fs = this.seriesOf(inst);
      if (inst.overlay || this.hidden.has(sid) || !fs || !inPane.has(fs)) continue;
      for (const p of this.plotsOf(inst, time)) out.push(p.value);
    }
    return out;
  }

  /** Studies drawn in stacked pane `paneIndex` (>= 1). */
  idsInPane(paneIndex: number): string[] {
    const out: string[] = [];
    for (const [id, inst] of this.instances) if (!inst.overlay && inst.paneIndex === paneIndex) out.push(id);
    return out;
  }

  /** Swap two stacked study panes (pane controls: move up / down). */
  swapPanes(a: number, b: number): void {
    if (a < 1 || b < 1 || a === b) return;
    this.chart.swapPanes(a, b);
    for (const inst of this.instances.values()) {
      if (inst.overlay) continue;
      if (inst.paneIndex === a) { inst.paneIndex = b; this.setPaneOf(inst, b); }
      else if (inst.paneIndex === b) { inst.paneIndex = a; this.setPaneOf(inst, a); }
    }
  }

  private setPaneOf(inst: Instance, i: number): void {
    if (inst.owner) inst.owner.setPaneIndex(i);
    else inst.layer.setPaneIndex(i);
  }

  /** Toggle a study's plot visibility (legend eye). Returns the new hidden state. */
  toggleHidden(id: string): boolean {
    const inst = this.instances.get(id);
    if (!inst) return false;
    const nowHidden = !this.hidden.has(id);
    if (nowHidden) this.hidden.add(id); else this.hidden.delete(id);
    const entry = getIndicatorEntry(id);
    if (entry) this.renderOne(id, inst, entry, this.getBars());
    return nowHidden;
  }

  /** Tear down and rebuild one active study in place. Needed when a user
   *  script recompiles with a different shape — its overlay flag (and so its
   *  pane assignment, fixed at add time) may have changed. */
  refresh(id: string): void {
    if (!this.instances.has(id) || this.instances.get(id)?.owner) return;
    this.remove(id);
    this.add(id);
  }

  destroy(): void {
    if (this.visibleTimer) clearTimeout(this.visibleTimer);
    if (this.symbolsTimer) clearTimeout(this.symbolsTimer);
    this.otherSymbols.dispose();
    try {
      this.chart.timeScale().unsubscribeVisibleTimeRangeChange(this.onVisibleRange);
    } catch {
      // the chart was removed first
    }
    for (const id of [...this.instances.keys()]) this.remove(id);
  }

  private add(id: string): void {
    const entry = getIndicatorEntry(id);
    if (!entry) return;
    // An overlay moved to its own pane ("Move to") is drawn like a pane
    // study; a study moved to another pane (Object tree drag) joins it.
    const o = this.options.get(id);
    const overlay = o?.paneGroup === MAIN_PANE_GROUP || (!o?.paneGroup && entry.overlay && !o?.ownPane);
    const group = overlay ? null : o?.paneGroup ?? id;
    const mate = overlay ? undefined : [...this.instances.values()].find((i) => !i.overlay && i.group === group);
    const paneIndex = overlay ? 0 : mate ? mate.paneIndex : this.claimPane();
    const layer = new IndicatorLayer(this.chart, paneIndex, this.chartId, id);
    layer.setLastValueVisible(this.lastValueVisible);
    layer.setNameLabelsVisible(this.nameLabelsVisible);
    layer.setScriptChart(this.scriptChart);
    layer.setChartState(this.chartState);
    layer.setVisibleRange(this.visibleRange);
    layer.setOtherSymbols(this.otherSymbols);
    layer.setMainSeries(() => this.mainSeries());
    const ownScale = !!(entry.metadata as { ownScaleId?: string }).ownScaleId;
    const inst: Instance = { layer, paneIndex, overlay, ownScale, group };
    this.instances.set(id, inst);
    if (this.selected?.id === id) layer.setSelected(this.selected.bgAt);
    layer.setSeriesOnlyScale(this.seriesOnlyScale);
    this.renderOne(id, inst, entry, this.getBars());
  }

  private remove(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    const panesBefore = this.chart.panes().length;
    if (inst.owner) inst.owner.clear();
    else inst.layer.clear();
    this.instances.delete(id);
    // Others share its pane: the pane stays, and one of them takes the
    // pane's scale when this one had it.
    const mates = inst.overlay ? [] : [...this.instances].filter(([, i]) => !i.overlay && i.paneIndex === inst.paneIndex);
    if (mates.length) {
      const bars = this.getBars();
      for (const [mid, m] of mates) {
        const entry = getIndicatorEntry(mid);
        if (!m.owner && entry) this.renderOne(mid, m, entry, bars);
      }
    } else if (!inst.overlay) {
      this.usedPanes.delete(inst.paneIndex);
      this.removeEmptyPanes();
      // Its pane is gone: the panes below move up one index. Renumber the
      // studies there, else their next redraw re-creates the old index and
      // leaves an empty pane.
      if (this.chart.panes().length < panesBefore) {
        for (const other of this.instances.values()) {
          if (other.overlay || other.paneIndex <= inst.paneIndex) continue;
          other.paneIndex -= 1;
          this.setPaneOf(other, other.paneIndex);
        }
        this.usedPanes = new Set([...this.instances.values()].filter((o) => !o.overlay).map((o) => o.paneIndex));
      }
    }
  }

  private claimPane(): number {
    let pane = 1;
    while (this.usedPanes.has(pane)) pane++;
    this.usedPanes.add(pane);
    return pane;
  }

  /** Drop any stacked pane (index >= 1) that no longer holds a series. */
  private removeEmptyPanes(): void {
    const panes = this.chart.panes();
    for (let i = panes.length - 1; i >= 1; i--) {
      if (panes[i].getSeries().length === 0) {
        try { this.chart.removePane(i); } catch { /* race with teardown */ }
      }
    }
  }
}
