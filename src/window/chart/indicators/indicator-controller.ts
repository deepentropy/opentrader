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
import type { ChartContext } from 'oakscriptjs/script';
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { getIndicatorEntry } from './registry';
import { IndicatorLayer, type IndicatorLegendPlot, type IndicatorStyleOverrides } from './indicator-layer';
import { isVisibleOnInterval } from 'lightweight-charts-drawing/core/types';
import {
  cloneIndicatorOptions,
  defaultIndicatorOptions,
  precisionDigits,
  reviveIndicatorOptions,
  statusLineInputs,
  type IndicatorOptions,
} from './indicator-options';

type Instance = {
  layer: IndicatorLayer;
  paneIndex: number;
  overlay: boolean;
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
  /** Style -> "Values in status line" / "Inputs in status line". */
  showValues: boolean;
  showInputs: boolean;
  /** Style -> "Precision": decimals of the values, null = Default. */
  precision: number | null;
  /** Hidden because the chart interval is outside its Visibility tab. */
  offInterval: boolean;
  /** The legend eye state alone (hidden also covers offInterval). */
  eyeHidden: boolean;
};

export class IndicatorController {
  private chart: IChartApi;
  private getBars: () => Bar[];
  private instances = new Map<string, Instance>();
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
  /** Per-study Style-tab options + Visibility tab. Same lifetime rules as
   *  {@link inputs}. */
  private options = new Map<string, IndicatorOptions>();
  /** Chart interval, for the studies' Visibility tab. */
  private interval: string | undefined;

  /** Identifies the chart for studies that keep per-chart state (strategies). */
  private chartId: string;
  /** Chart context of the OakScript scripts (timeframe, session...). */
  private scriptChart: ChartContext | undefined;

  constructor(chart: IChartApi, getBars: () => Bar[], chartId = "") {
    this.chart = chart;
    this.getBars = getBars;
    this.chartId = chartId;
  }

  /** Reconcile the live layers with the desired ordered list of registry ids. */
  sync(ids: string[]): void {
    const desired = new Set(ids);

    // Remove studies no longer wanted.
    for (const id of [...this.instances.keys()]) {
      if (!desired.has(id)) { this.remove(id); this.hidden.delete(id); }
    }

    // Add newly-wanted studies (in list order, so pane stacking is stable).
    for (const id of ids) {
      if (this.instances.has(id)) continue;
      this.add(id);
    }
    this.orderPanes(ids);
  }

  /** Stacked panes in list order (the order a fresh load gives): a study
   *  put back in the middle of the list (undo of a removal) opens at the
   *  bottom, then moves up to its place. Panes not drawn yet are left. */
  private orderPanes(ids: string[]): void {
    const stacked = ids.filter((id) => {
      const inst = this.instances.get(id);
      return !!inst && !inst.overlay;
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
    for (const inst of this.instances.values()) inst.layer.setLastValueVisible(v);
    this.renderAll();
  }

  /** Recompute every active study against the current bars. */
  renderAll(): void {
    const bars = this.getBars();
    for (const [id, inst] of this.instances) {
      const entry = getIndicatorEntry(id);
      if (entry) this.renderOne(id, inst, entry, bars);
    }
  }

  /** The study's options (defaults when never edited). */
  getOptions(id: string): IndicatorOptions {
    return cloneIndicatorOptions(this.options.get(id) ?? defaultIndicatorOptions());
  }

  /** The chart symbol, interval or session changed: the OakScript chart context of every study.
   *  The studies recompute with the new bars. */
  setScriptChart(chart: ChartContext): void {
    if (JSON.stringify(chart) === JSON.stringify(this.scriptChart)) return;
    this.scriptChart = chart;
    for (const inst of this.instances.values()) inst.layer.setScriptChart(chart);
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
  private renderOne(id: string, inst: Instance, entry: IndicatorRegistryEntry, bars: Bar[]): void {
    const o = this.options.get(id) ?? defaultIndicatorOptions();
    inst.layer.setPlotOptions({ labelsOnScale: o.labelsOnScale, precision: precisionDigits(o.precision) });
    inst.layer.render(entry, bars, this.effectiveInputs(id, entry), !this.hidden.has(id) && this.onInterval(id), this.styles.get(id) ?? {});
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
  seedSettings(map: Record<string, { inputs?: Record<string, unknown>; styles?: IndicatorStyleOverrides; options?: unknown }>): void {
    for (const id in map) {
      const s = map[id];
      if (s?.inputs) this.inputs.set(id, { ...s.inputs });
      if (s?.styles) this.styles.set(id, { ...s.styles });
      if (s?.options) this.options.set(id, reviveIndicatorOptions(s.options));
    }
  }

  /** Studies legend rows (one per active study) with values at `time` (or the
   *  latest bar), in add order. */
  getLegend(time?: number): IndicatorLegendRow[] {
    const rows: IndicatorLegendRow[] = [];
    for (const [id, inst] of this.instances) {
      const o = this.options.get(id) ?? defaultIndicatorOptions();
      const entry = getIndicatorEntry(id);
      const offInterval = !this.onInterval(id);
      rows.push({
        id,
        title: inst.layer.title,
        // Legend: a study off its intervals shows as hidden.
        hidden: this.hidden.has(id) || offInterval,
        plots: inst.layer.legendPlots(time),
        pane: inst.overlay ? 0 : inst.paneIndex,
        inputs: entry ? statusLineInputs(entry, this.effectiveInputs(id, entry)) : '',
        showValues: o.valuesInStatusLine,
        showInputs: o.inputsInStatusLine,
        precision: precisionDigits(o.precision),
        offInterval,
        eyeHidden: this.hidden.has(id),
      });
    }
    return rows;
  }

  /** Price-pane (overlay) study plot values at `time`, for the drawing magnet's
   *  "Snap to indicator" option. Oscillator panes are excluded — they live on a
   *  different price scale, so snapping the price axis to them is meaningless.
   *  Hidden studies contribute nothing (legendPlots already skips them). */
  overlayValuesAt(time?: number): number[] {
    const out: number[] = [];
    for (const [id, inst] of this.instances) {
      if (!inst.overlay || inst.ownScale || this.hidden.has(id)) continue;
      for (const p of inst.layer.legendPlots(time)) out.push(p.value);
    }
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
      const s = inst.layer.firstSeries();
      if (!inst.overlay && s && inPane.has(s)) return id;
    }
    return null;
  }

  /** The series a study's drawings are mapped with (its first plot), or
   *  null. A redraw replaces the series: read it at use time. */
  studySeries(id: string): ISeriesApi<SeriesType> | null {
    return this.instances.get(id)?.layer.firstSeries() ?? null;
  }

  /** Plot values at `time` of the shown studies in the pane of study `id`
   *  (the drawing magnet's "Snap to indicator" in an indicator pane). */
  paneValuesAt(id: string, time?: number): number[] {
    const s = this.studySeries(id);
    if (!s) return [];
    const inPane = new Set<unknown>(s.getPane().getSeries());
    const out: number[] = [];
    for (const [sid, inst] of this.instances) {
      const fs = inst.layer.firstSeries();
      if (inst.overlay || this.hidden.has(sid) || !fs || !inPane.has(fs)) continue;
      for (const p of inst.layer.legendPlots(time)) out.push(p.value);
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
      if (inst.paneIndex === a) { inst.paneIndex = b; inst.layer.setPaneIndex(b); }
      else if (inst.paneIndex === b) { inst.paneIndex = a; inst.layer.setPaneIndex(a); }
    }
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
    if (!this.instances.has(id)) return;
    this.remove(id);
    this.add(id);
  }

  destroy(): void {
    for (const id of [...this.instances.keys()]) this.remove(id);
  }

  private add(id: string): void {
    const entry = getIndicatorEntry(id);
    if (!entry) return;
    const paneIndex = entry.overlay ? 0 : this.claimPane();
    const layer = new IndicatorLayer(this.chart, paneIndex, this.chartId);
    layer.setLastValueVisible(this.lastValueVisible);
    layer.setScriptChart(this.scriptChart);
    const ownScale = !!(entry.metadata as { ownScaleId?: string }).ownScaleId;
    const inst: Instance = { layer, paneIndex, overlay: entry.overlay, ownScale };
    this.instances.set(id, inst);
    this.renderOne(id, inst, entry, this.getBars());
  }

  private remove(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    const panesBefore = this.chart.panes().length;
    inst.layer.clear();
    this.instances.delete(id);
    if (!inst.overlay) {
      this.usedPanes.delete(inst.paneIndex);
      this.removeEmptyPanes();
      // Its pane is gone: the panes below move up one index. Renumber the
      // studies there, else their next redraw re-creates the old index and
      // leaves an empty pane.
      if (this.chart.panes().length < panesBefore) {
        for (const other of this.instances.values()) {
          if (other.overlay || other.paneIndex <= inst.paneIndex) continue;
          other.paneIndex -= 1;
          other.layer.setPaneIndex(other.paneIndex);
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
