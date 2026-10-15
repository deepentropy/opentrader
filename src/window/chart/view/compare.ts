/*
 * Compared symbols of a chart view (header "Compare symbols"): one layer per
 * entry, its scale / pane placement, bars, live ticks and legend rows.
 */
import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js";
import { PriceScaleMode, type ISeriesApi, type SeriesType } from "lightweight-charts";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { CompareEntry } from "../../shell/tabs";
import { CompareLayer } from "../compare/compare-layer";
import { compareColor, type CompareStyleState } from "../compare/compare-style";
import { isVisibleOnInterval } from "lightweight-charts-drawing/core/types";
import { getBars, getTickerInfo, setLiveSymbol, splitSymbol, subscribeBars } from "../../../data/datafeed";
import { type OHLC } from "../chart-types";
import { chartPriceFormat } from "../price-format";
import { cachedSymbolSessions } from "../../../data/session";
import { type IndicatorLegendRow } from "../indicators/indicator-controller";
import { toOHLC } from "./helpers";
import { type ChartCx } from "./context";
import type { Setter } from "solid-js";

/** A compared symbol as an alert source: "Microsoft Corp. (NASDAQ)", its
 *  last value and price format. */
export type CompareSource = { id: string; symbol: string; label: string; description: string; hidden: boolean; last: number | null; format: (v: number) => string };

/** What createCompare adds to the chart context. */
export interface CompareApi {
  compareEntries: () => CompareEntry[];
  compareEntry: (id: string) => CompareEntry | undefined;
  compareLayers: Map<string, CompareLayer>;
  compareLegendRows: (time?: number) => IndicatorLegendRow[];
  compareLiveDirty: boolean;
  compareTitle: (e: CompareEntry) => string;
  compareSources: () => CompareSource[];
  compareUsesOtherSide: () => boolean;
  holdCompares: (ids: string[]) => void;
  followMainPane: () => void;
  renderCompareAll: () => void;
  setComparePreview: Setter<{
    id: string;
    symbol: string;
    style: CompareStyleState;
  } | null>;
  studyOfSeries: (s: ISeriesApi<SeriesType>) => string | null;
  syncCompare: () => void;
  syncSideScales: () => void;
}

export function createCompare(cx: ChartCx): CompareApi {
  const { chartReady, currentTokens, hidden, paneId, props, refreshIndicatorLegend, reloadTick, selectedStudy, studySelectionBg } = cx;
  // ── Compare symbols (header "Compare symbols") ─────────────────────────
  // One CompareLayer per entry (compare/compare-layer.ts). Placement:
  //   percent : the main series' scale, switched to Percent while at least
  //             one such entry exists, back to Regular when the last goes;
  //   scale   : the scale on the other side (the library has one scale per
  //             side: a 2nd "New price scale" entry gets its own unlabelled
  //             overlay scale);
  //   pane    : a stacked pane claimed through the indicator controller.
  // Bars are fetched per symbol under the pane's interval / session; live
  // ticks for compared symbols stay out of scope (lines refresh on fetch).
  const compareLayers = new Map<string, CompareLayer>();
  /** Bars per symbol under `compareBasis`. */
  const compareFetch = new Map<string, Promise<OHLC[]>>();
  let compareBasis = "";
  /** Main scale switched to Percent by a "Same % scale" entry. */
  let comparePercentOn = false;
  /** Description of each compared symbol (legend / dialog titles). */
  const [compareNames, setCompareNames] = createSignal<Record<string, string>>({});
  /** Settings dialog draft drawn live (Cancel drops it). */
  const [comparePreview, setComparePreview] = createSignal<{ id: string; symbol: string; style: CompareStyleState } | null>(null);
  const compareEntries = (): CompareEntry[] => {
    const list = props.compare ?? [];
    const pv = comparePreview();
    return pv ? list.map((e) => (e.id === pv.id ? { ...e, symbol: pv.symbol, style: pv.style } : e)) : list;
  };
  const compareEntry = (id: string) => compareEntries().find((e) => e.id === id);
  /** Legend / dialog title: "description · exchange". */
  const compareTitle = (e: CompareEntry) => {
    const { ticker, exchange } = splitSymbol(e.symbol);
    const name = compareNames()[e.symbol] || ticker;
    return exchange ? `${name} · ${exchange}` : name;
  };

  /** The compared symbols as alert sources: "<description> (<exchange>)" (the ticker before the description is
   *  known). */
  const compareSources = (): CompareSource[] =>
    compareEntries().map((e) => {
      const { ticker, exchange } = splitSymbol(e.symbol);
      const description = compareNames()[e.symbol] || ticker;
      const layer = compareLayers.get(e.id);
      const fmt = compareFormat(e)?.format ?? ((n: number) => n.toFixed(2));
      return { id: e.id, symbol: e.symbol, label: exchange ? `${description} (${exchange})` : description, description, hidden: !compareVisible(e), last: layer?.valueAt()?.value ?? null, format: fmt };
    });

  const otherSide = (side: "left" | "right") => (side === "right" ? "left" : "right");
  /** Scale id of every entry (placement rules above). */
  // Scales placement: Auto puts the first extra scale on the side with fewer
  // scales (the main scale is on the right, so the left); the "Stack on …"
  // choices keep every scale on the main side, where the library has one
  // scale per side: an extra scale there is an unlabelled overlay scale.
  // In a study pane the series shares, both sides are taken (the study's
  // scale and the series'): a "New price scale" entry gets an overlay scale.
  function compareScaleIds(): Map<string, string> {
    const t = currentTokens();
    const main = cx.mainSide();
    const out = new Map<string, string>();
    let sideUsed = t.scalesMode !== "auto" || !!cx.controller?.seriesShares();
    for (const e of compareEntries()) {
      if (e.placement === "pane") out.set(e.id, t.scalesPlacement);
      else if (e.placement === "percent") out.set(e.id, main);
      else if (!sideUsed) { out.set(e.id, otherSide(main)); sideUsed = true; }
      else out.set(e.id, `cmp:${e.id}`);
    }
    return out;
  }
  /** Compared symbols over the series that stay in the pane the series left
   *  (reference: they are not the series' children): they are not moved with
   *  it until their entry turns into "pane" placement. The series' scale
   *  keeps its percent mode (its new scale takes the former one's modes). */
  const held = new Set<string>();
  const heldPercent = new Set<string>();
  function holdCompares(ids: string[]) {
    for (const id of ids) {
      held.add(id);
      if (compareEntry(id)?.placement === "percent") heldPercent.add(id);
    }
    if (ids.length) comparePercentOn = compareEntries().some((e) => e.placement === "percent" && !held.has(e.id)) && comparePercentOn;
  }
  /** The price pane moved or the series changed scale: the compared symbols
   *  over the series follow it (not the ones staying where it was). */
  function followMainPane() {
    if (!cx.chart) return;
    const ids = compareScaleIds();
    for (const [id, layer] of compareLayers) {
      if (layer.entry.placement === "pane" || held.has(id)) continue;
      layer.moveToPane(cx.mainPane());
      layer.setScaleId(ids.get(id) ?? cx.mainSide());
      renderCompare(layer);
    }
    cx.syncScaleSides();
  }
  /** A "New price scale" entry uses the other side's scale (Auto only). */
  function compareUsesOtherSide(): boolean {
    return currentTokens().scalesMode === "auto" && !cx.controller?.seriesShares() && compareEntries().some((e) => e.placement === "scale");
  }
  /** Studies changed their scale ("Pin to scale"): the other side's scale follows. */
  const syncSideScales = () => cx.syncScaleSides();
  function compareVisible(e: CompareEntry): boolean {
    return !e.hidden && isVisibleOnInterval(e.style.visibility, props.interval);
  }
  function compareFormat(e: CompareEntry) {
    return chartPriceFormat(e.style.minTick, cachedSymbolSessions(e.symbol));
  }
  // Bar times of the main series (cached per bars array / length).
  let mainTimesOf: OHLC[] | null = null;
  let mainTimesLen = -1;
  let mainTimes = new Set<number>();
  function mainTimeSet(): Set<number> {
    if (cx.raw !== mainTimesOf || cx.raw.length !== mainTimesLen) {
      mainTimes = new Set(cx.raw.map((b) => b.time as number));
      mainTimesOf = cx.raw;
      mainTimesLen = cx.raw.length;
    }
    return mainTimes;
  }
  function renderCompare(layer: CompareLayer) {
    layer.render(currentTokens(), compareVisible(layer.entry), compareFormat(layer.entry), mainTimeSet());
    cx.scheduleSourceOrder();
  }
  /** Main bars changed (load, scroll-back): redraw the compared symbols on
   *  the new bar times. */
  function renderCompareAll() {
    for (const layer of compareLayers.values()) renderCompare(layer);
    // Study panes drawn after the last sync take their stacking place.
    cx.controller?.applyPaneOrder();
  }
  createEffect(() => {
    chartReady();
    const order = props.paneOrder ?? [];
    untrack(() => cx.controller?.setPaneOrder(order));
  });
  /** Reconcile the layers with the entries (structure, style, scales). */
  /** A sync asked for while one runs (the price pane moved under it): it
   *  runs again after. */
  let syncing = false;
  let syncAgain = false;
  function syncCompare() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      do {
        syncAgain = false;
        syncCompareOnce();
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  }
  function syncCompareOnce() {
    if (!cx.chart) return;
    const want = compareEntries();
    const basis = `${props.interval ?? "1D"}|${props.session ?? "RTH"}|${reloadTick()}`;
    if (basis !== compareBasis) {
      compareBasis = basis;
      compareFetch.clear();
      // The loaded bars belong to the old interval / session.
      for (const layer of compareLayers.values()) layer.setBars([]);
    }
    // Removed entries, and entries whose placement or symbol changed (rebuilt).
    for (const [id, layer] of [...compareLayers]) {
      const e = want.find((x) => x.id === id);
      if (!e || e.placement !== layer.entry.placement || e.symbol !== layer.entry.symbol) dropCompareLayer(id);
    }
    const scaleIds = compareScaleIds();
    for (const e of want) {
      let layer = compareLayers.get(e.id);
      const scaleId = scaleIds.get(e.id) ?? currentTokens().scalesPlacement;
      let created = false;
      if (!layer) {
        // Over the series: in the price pane.
        layer = new CompareLayer(cx.chart, e, cx.mainPane(), scaleId);
        if (e.placement === "pane" && cx.controller) {
          layer.setPaneIndex(cx.controller.claimPaneFor(e.id, layer));
          // Studies above it may not be drawn yet (no bars): open their panes
          // now, else the library puts this series in the next new pane.
          while (cx.chart.panes().length < layer.paneIndex) cx.chart.addPane(true);
        }
        compareLayers.set(e.id, layer);
        if (untrack(selectedStudy) === e.id) layer.setSelected(untrack(studySelectionBg));
        layer.setSeriesOnlyScale(untrack(cx.seriesOnlyScale));
        startCompareLive(layer);
        created = true;
      } else {
        layer.entry = e;
        // Over the series: it follows the price pane (not one staying where
        // the series was, about to get that pane).
        if (!held.has(e.id)) {
          if (e.placement !== "pane") layer.moveToPane(cx.mainPane());
          layer.setScaleId(scaleId);
        }
      }
      renderCompare(layer);
      // A new pane copies the main scale's mode (Percent with a same % scale
      // entry): its own scale starts Regular.
      // One staying where the series was keeps its percent scale.
      if (created && e.placement === "pane") {
        const mode = heldPercent.has(e.id) ? PriceScaleMode.Percentage : PriceScaleMode.Normal;
        try { cx.chart.priceScale(scaleId, layer.paneIndex).applyOptions({ mode }); } catch { /* pane not built yet */ }
      }
      if (e.placement === "pane") { held.delete(e.id); heldPercent.delete(e.id); }
      loadCompareBars(layer);
    }
    cx.syncScaleSides();
    cx.controller?.applyPaneOrder();
    // Same % scale: the main scale shows percent while such an entry exists.
    const percent = want.some((e) => e.placement === "percent");
    if (percent !== comparePercentOn) {
      comparePercentOn = percent;
      cx.mainScale()?.applyOptions({ mode: percent ? PriceScaleMode.Percentage : PriceScaleMode.Normal });
      cx.refreshScaleOverlays();
    }
    cx.setPaneEpoch((n) => n + 1);
    queueMicrotask(cx.refreshPaneBoxes);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }
  // Live ticks of the compared symbols: one subscription slot per entry.
  const compareLive = new Map<string, () => void>();
  /** Live bars merged while the tab was hidden (drawn when shown). */
  let compareLiveDirty = false;
  function startCompareLive(layer: CompareLayer) {
    const id = layer.entry.id;
    const slot = `${paneId}:cmp:${id}`;
    const sym = layer.entry.symbol;
    setLiveSymbol(sym, slot).catch(() => {});
    let off: UnlistenFn | null = null;
    let dead = false;
    subscribeBars(() => sym, () => props.interval ?? "1D", (bar) => {
      if (compareLayers.get(id) !== layer || !layer.mergeLive(bar)) return;
      if (hidden()) { compareLiveDirty = true; return; }
      renderCompare(layer);
      if (!cx.crosshairActive) refreshIndicatorLegend();
    }, () => props.session ?? "RTH").then((u) => { if (dead) u(); else off = u; });
    compareLive.set(id, () => {
      dead = true;
      off?.();
      setLiveSymbol(null, slot).catch(() => {});
    });
  }
  /** Study or compared symbol drawing the series `s`, or null. */
  function studyOfSeries(s: ISeriesApi<SeriesType>): string | null {
    const id = cx.controller?.studyOfSeries(s) ?? null;
    if (id) return id;
    for (const [cid, layer] of compareLayers) if (layer.firstSeries() === s) return cid;
    return null;
  }

  function dropCompareLayer(id: string) {
    const layer = compareLayers.get(id);
    if (!layer) return;
    compareLive.get(id)?.();
    compareLive.delete(id);
    compareLayers.delete(id);
    if (layer.entry.placement === "pane" && cx.controller) cx.controller.releasePane(id);
    else layer.clear();
  }
  function loadCompareBars(layer: CompareLayer) {
    const sym = layer.entry.symbol;
    let p = compareFetch.get(sym);
    if (!p) {
      p = getBars(sym, props.interval ?? "1D", props.session ?? "RTH").then((r) =>
        toOHLC(r.bars.filter((c) => c.time != null && c.close != null)),
      );
      compareFetch.set(sym, p);
    }
    const basis = compareBasis;
    p.then((bars) => {
      // The pane may have moved on, or the layer gone, before the fetch lands.
      if (basis !== compareBasis || compareLayers.get(layer.entry.id) !== layer) return;
      if (layer.source === bars) return;
      layer.setBars(bars);
      renderCompare(layer);
      refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    }).catch(() => { /* symbol not found / transient: the series stays empty */ });
    // Description for the legend title.
    if (!(sym in untrack(compareNames))) {
      setCompareNames((m) => ({ ...m, [sym]: "" }));
      getTickerInfo(sym)
        .then((info) => {
          setCompareNames((m) => ({ ...m, [sym]: info?.name ?? "" }));
          refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
        })
        .catch(() => {});
    }
  }
  createEffect(() => {
    chartReady();
    void props.compare;
    void comparePreview();
    void props.interval;
    void props.session;
    void reloadTick();
    untrack(syncCompare);
  });
  // A reload (adjustment changed...) fetches the other symbols the studies read again.
  createEffect(on(reloadTick, () => cx.controller?.reloadOtherSymbols(), { defer: true }));
  onCleanup(() => {
    for (const id of [...compareLayers.keys()]) dropCompareLayer(id);
  });

  /** Legend rows of the compared symbols at `time` (or the last bar). */
  function compareLegendRows(time?: number): IndicatorLegendRow[] {
    const rows: IndicatorLegendRow[] = [];
    if (!cx.chart) return rows;
    const visFrom = cx.chart.timeScale().getVisibleRange()?.from as number | undefined;
    for (const e of compareEntries()) {
      const layer = compareLayers.get(e.id);
      if (!layer) continue;
      const color = compareColor(e.style);
      const v = layer.valueAt(time);
      const texts: { text: string; color: string }[] = [];
      if (v) {
        if (e.placement === "percent") {
          // Percent from the first visible value (the scale's base).
          const base = visFrom != null ? layer.baseAt(visFrom) : null;
          if (base) {
            const pct = (v.value / base - 1) * 100;
            texts.push({ text: `${pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`, color });
          }
        } else {
          const f = compareFormat(e)?.format ?? ((n: number) => n.toFixed(2));
          texts.push({ text: f(v.value), color });
          if (v.prev != null && v.prev !== 0) {
            const d = v.value - v.prev;
            const sign = d < 0 ? "−" : "+";
            texts.push({ text: `${sign}${f(Math.abs(d))} (${sign}${Math.abs((d / v.prev) * 100).toFixed(2)}%)`, color });
          }
        }
      }
      const offInterval = !isVisibleOnInterval(e.style.visibility, props.interval);
      rows.push({
        id: e.id,
        title: compareTitle(e),
        hidden: !!e.hidden || offInterval,
        plots: [],
        pane: e.placement === "pane" ? layer.paneIndex : cx.mainPane(),
        inputs: "",
        showValues: true,
        showInputs: false,
        precision: null,
        offInterval,
        eyeHidden: !!e.hidden,
        compare: { texts },
      });
    }
    return rows;
  }

  return {
    compareEntries,
    compareEntry,
    compareLayers,
    compareLegendRows,
    get compareLiveDirty() {
      return compareLiveDirty;
    },
    set compareLiveDirty(v: typeof compareLiveDirty) {
      compareLiveDirty = v;
    },
    compareTitle,
    compareSources,
    compareUsesOtherSide,
    holdCompares,
    followMainPane,
    renderCompareAll,
    setComparePreview,
    studyOfSeries,
    syncCompare,
    syncSideScales,
  };
}
