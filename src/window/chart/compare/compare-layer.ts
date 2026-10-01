/*
 * CompareLayer: the series of one compared symbol (header "Compare symbols").
 *
 * The series is a chart series of the entry's style (createSeriesForType with
 * the compare style values), on the scale of its placement:
 *   percent : the main series' price scale (switched to Percent by ChartView)
 *   scale   : the scale on the other side of the main one
 *   pane    : a stacked pane claimed through the IndicatorController, so study
 *             panes and compare panes share one numbering.
 * Bars come from ChartView (fetched per symbol / interval / session).
 */
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import { createSeriesForType, libLineStyle, setDataForType, type AnySeries, type OHLC } from "../chart-types";
import type { ChartTokens } from "../chart-tokens";
import { priceOf } from "../series-transforms";
import type { IndicatorLegendPlot } from "../indicators/indicator-layer";
import type { CompareEntry } from "../../shell/tabs";
import { chartTypeOf, compareColor, compareSeriesStyles, compareSource } from "./compare-style";
import { SelectionMarkers, type BackgroundAt } from "../selection-markers";

export class CompareLayer {
  private series: AnySeries | null = null;
  private bars: OHLC[] = [];
  /** The bars drawn: those at a bar time of the main series (a compared
   *  symbol does not extend the time scale). */
  private drawn: OHLC[] = [];
  /** Style key the series was built with (rebuild when it changes). */
  private builtKey = "";
  /** Selection markers while selected (on the drawn price source). */
  private selectionBg: BackgroundAt | null = null;
  private markers: { series: AnySeries; m: SelectionMarkers } | null = null;
  paneIndex: number;

  constructor(
    private chart: IChartApi,
    public entry: CompareEntry,
    paneIndex: number,
    /** Scale id the series is bound to (set by ChartView per placement). */
    private scaleId: string,
  ) {
    this.paneIndex = paneIndex;
  }

  /** Pane renumbered by the controller (the library already moved the series). */
  setPaneIndex(i: number): void {
    this.paneIndex = i;
  }

  firstSeries(): ISeriesApi<SeriesType> | null {
    return this.series as ISeriesApi<SeriesType> | null;
  }

  get loadedBars(): OHLC[] {
    return this.bars;
  }

  /** The fetched array the bars came from (live merges copy it). */
  source: OHLC[] | null = null;

  /** New bars (drawn by the next render). */
  setBars(bars: OHLC[]): void {
    this.bars = bars;
    this.source = bars;
  }

  /** Merge one live bar (bucketed to the chart interval): extend the last
   *  bar or append a newer one. False when it is older than the last bar. */
  mergeLive(bar: { time: number; open: number; high: number; low: number; close: number; volume?: number }): boolean {
    const b = this.bars;
    const last = b.length ? b[b.length - 1] : null;
    const lastTime = last ? (last.time as number) : -1;
    if (bar.time < lastTime) return false;
    // Copy on write: the fetched array is shared by entries of one symbol.
    if (this.bars === this.source) this.bars = b.slice();
    if (last && bar.time === lastTime) {
      this.bars[this.bars.length - 1] = { ...last, high: Math.max(last.high, bar.high), low: Math.min(last.low, bar.low), close: bar.close };
    } else {
      this.bars.push({ time: bar.time as OHLC["time"], open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    }
    return true;
  }

  setScaleId(id: string): void {
    if (id === this.scaleId) return;
    this.scaleId = id;
    this.series?.applyOptions({ priceScaleId: id });
  }

  /** Draw (or redraw) with the entry's style; `visible` = not eye-hidden and
   *  on its intervals. */
  render(
    tokens: ChartTokens,
    visible = true,
    priceFormat?: { format: (p: number) => string; minMove: number } | null,
    /** Bar times of the main series; undefined = draw every bar. */
    keep?: Set<number>,
  ): void {
    const st = this.entry.style;
    const type = chartTypeOf(st.style);
    const ct: ChartTokens = { ...tokens, styles: compareSeriesStyles(st) };
    const key = JSON.stringify([st.style, st.rows]);
    if (!this.series || key !== this.builtKey) {
      // Keep the pane while the series is swapped (the library deletes a
      // pane left empty).
      const pane = this.series?.getPane() ?? null;
      const kept = pane?.preserveEmptyPane() ?? false;
      pane?.setPreserveEmptyPane(true);
      if (this.series) {
        try { this.chart.removeSeries(this.series); } catch { /* already gone */ }
      }
      this.series = createSeriesForType(this.chart, type, ct, this.paneIndex);
      pane?.setPreserveEmptyPane(kept);
      this.builtKey = key;
    }
    const s = this.series;
    s.applyOptions({
      priceScaleId: this.scaleId,
      visible,
      lastValueVisible: true,
      priceLineVisible: st.priceLine,
      priceLineColor: compareColor(st),
      priceLineStyle: libLineStyle(2),
      title: this.entry.symbol.split(":").pop() ?? this.entry.symbol,
      ...(priceFormat ? { priceFormat: { type: "custom" as const, formatter: priceFormat.format, minMove: priceFormat.minMove } } : {}),
    });
    this.drawn = keep ? this.bars.filter((b) => keep.has(b.time as number)) : this.bars;
    setDataForType(s, type, this.drawn, ct);
    if (this.selectionBg && this.markers?.series !== s) this.setSelected(this.selectionBg);
  }

  /** Selected (markers on the series) or not (null). */
  setSelected(bgAt: BackgroundAt | null): void {
    if (this.markers) {
      try { this.markers.series.detachPrimitive(this.markers.m); } catch { /* series gone */ }
      this.markers = null;
    }
    this.selectionBg = bgAt;
    const s = this.series;
    if (!bgAt || !s) return;
    const src = compareSource(this.entry.style);
    const valueAt = (i: number): number | null => {
      const t = this.chart.timeScale();
      const time = (s.dataByIndex(i) as { time?: number } | null)?.time;
      if (time == null || t.timeToIndex(time as never) !== i) return null;
      const v = this.valueAt(time);
      return v && v.index >= 0 && (this.drawn[v.index]?.time as number) === time ? priceOf(this.drawn[v.index], src) : null;
    };
    const m = new SelectionMarkers(valueAt, bgAt);
    s.attachPrimitive(m);
    this.markers = { series: s, m };
  }

  /** Value of the drawn price source at `time` (the bar at or before it), or
   *  the last bar; with the previous bar's value for the change. */
  valueAt(time?: number): { value: number; prev: number | null; index: number } | null {
    const b = this.drawn;
    if (!b.length) return null;
    let i = b.length - 1;
    if (time != null) {
      let lo = 0;
      let hi = b.length - 1;
      i = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((b[mid].time as number) <= time) { i = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (i < 0) return null;
    }
    const src = compareSource(this.entry.style);
    return { value: priceOf(b[i], src), prev: i > 0 ? priceOf(b[i - 1], src) : null, index: i };
  }

  /** First bar at or after `time`: the base of the percent scale (the
   *  library's percent mode measures from the first visible value). */
  baseAt(time: number): number | null {
    const b = this.drawn;
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((b[mid].time as number) < time) lo = mid + 1; else hi = mid;
    }
    return lo < b.length ? priceOf(b[lo], compareSource(this.entry.style)) : null;
  }

  legendPlots(time?: number): IndicatorLegendPlot[] {
    const v = this.valueAt(time);
    return v ? [{ value: v.value, color: compareColor(this.entry.style) } as IndicatorLegendPlot] : [];
  }

  clear(): void {
    this.drawn = [];
    if (this.markers) {
      try { this.markers.series.detachPrimitive(this.markers.m); } catch { /* series gone */ }
      this.markers = null;
    }
    if (!this.series) return;
    try { this.chart.removeSeries(this.series); } catch { /* chart disposed */ }
    this.series = null;
    this.builtKey = "";
  }
}

