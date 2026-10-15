/*
 * Sources of a chart view and their order: study selection requests, the
 * drawing order of the series (Object tree), drawings painted behind a series,
 * the Object tree rows and the study moves between panes.
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { type ISeriesApi, type SeriesType } from "lightweight-charts";
import { MOVE_STUDY_EVENT, SELECT_STUDY_EVENT, setFocusedStudySelection } from "../study-selection";
import {
  MAIN_SOURCE_ID,
  TREE_HIDE_EVENT,
  TREE_MOVE_EVENT,
  TREE_REMOVE_EVENT,
  setFocusedTreePanes,
  setFocusedTreeSources,
  type TreePane,
  type TreeSource,
} from "../object-tree-sources";
import { moveItem, overOf, paneItems, splitItems } from "../tree-order";
import { seriesPaneLast } from "../indicators/pane-order";
import { SunkDrawings, sameSunkGroups, type SunkGroup } from "../sunk-drawings";
import { statusLineInputs } from "../indicators/indicator-options";
import { isVisibleOnInterval } from "lightweight-charts-drawing/core/types";
import { splitSymbol } from "../../../data/datafeed";
import type { IndicatorOptions } from "../indicators/indicator-options";
import type { SeriesMove } from "../indicators/indicator-controller";
import { getIndicatorEntry } from "../indicators/registry";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { NEVER_SUNK_KINDS, type SunkPainter } from "../../drawings/DrawingsOverlay";
import { type ChartCx } from "./context";
import { onAppEvent, type AppEventName, type AppEvents } from "../../../data/app-events";
import { sourcesEdit } from "../../shell/source-edits";
import type { Accessor } from "solid-js";

/** What createSources adds to the chart context. */
export interface SourcesApi {
  dropSeriesOnTimeAxis: () => boolean;
  dropStudyOnTimeAxis: (id: string) => boolean;
  mergeSeriesToPane: (pane: number) => boolean;
  mergeStudyToPane: (id: string, pane: number) => boolean;
  /** Visual order steps a source can take in its pane (null = not a source of the chart). */
  zOrderSteps: (id: string) => { front: boolean; back: boolean } | null;
  /** Visual order: move a source to the front / back of its pane, or one step. */
  moveZ: (id: string, op: ZOrderOp) => void;
  /** "Move to" rows a study can take (merge into the pane above / below, a new pane above / below). */
  studyMoves: (id: string) => StudyMoves | null;
  /** Apply one "Move to" row. */
  moveStudy: (id: string, move: keyof StudyMoves) => void;
  scheduleSourceOrder: () => void;
  sunkIds: Accessor<ReadonlySet<string>>;
  sunkPainter: SunkPainter | null;
}

/** Visual order operations (study / compared-symbol menu). */
export type ZOrderOp = "front" | "back" | "forward" | "backward";

/** "Move to" rows of a study (reference order: existing pane above, new pane
 *  above, existing pane below, new pane below); true = offered. */
export type StudyMoves = { mergeUp: boolean; unmergeUp: boolean; mergeDown: boolean; unmergeDown: boolean };

export function createSources(cx: ChartCx): SourcesApi {
  const { chartReady, indLegend, props, refreshIndicatorLegend, removeStudy, selectStudy, selectedStudy, setSelectedStudy, toggleSourceHidden, whenShown } = cx;
  // A selected drawing clears the study selection.
  createEffect(() => {
    if (props.selectedDrawingId || (props.selectedDrawingIds?.length ?? 0) > 0) setSelectedStudy(null);
  });
  // A removed study is no longer selected.
  createEffect(() => {
    const id = selectedStudy();
    if (id && !indLegend().some((r) => r.id === id)) setSelectedStudy(null);
  });
  // The focused chart publishes its selected study (Object tree rows and
  // its "Move to" button) and serves the Object tree's requests.
  createEffect(() => {
    if (props.active === false || props.shown === false) return;
    const id = selectedStudy();
    cx.paneEpoch();
    untrack(() => {
      const movable = !!id && !cx.compareEntry(id) && !!cx.controller?.canMoveToNewPane(id);
      // A new pane above or below the price pane (it can sit anywhere).
      setFocusedStudySelection(id ? { id, moveAbove: movable, moveBelow: movable } : null);
    });
  });
  /** Requests of the Object tree and the drawing toolbar: the focused chart
   *  of the shown tab serves them. */
  const listenWhenShown = <K extends AppEventName>(type: K, fn: (detail: AppEvents[K] | undefined) => void) =>
    onCleanup(onAppEvent(type, (d) => { if (props.shown !== false) fn(d); }));
  const onSelectStudyRequest = (d: AppEvents["chart-select-study"] | undefined) => {
    if (props.active === false) return;
    const id = d?.id;
    if (id && indLegend().some((r) => r.id === id)) selectStudy(id);
  };
  listenWhenShown(SELECT_STUDY_EVENT, onSelectStudyRequest);
  const onMoveStudyRequest = (d: AppEvents["chart-move-study"] | undefined) => {
    if (props.active === false || !cx.controller) return;
    const { id, where } = (d ?? {}) as AppEvents["chart-move-study"];
    if (!id || (where !== "below" && where !== "above")) return;
    const options = cx.controller.moveToNewPane(id);
    if (!options) return;
    // The new pane goes right below (above) the price pane.
    const order = where === "above" ? cx.controller.orderAbovePricePane(id) : cx.controller.orderBelowPricePane(id);
    cx.controller.setPaneOrder(order);
    props.onPaneOrder?.(order);
    props.onIndicatorSettings?.(id, {
      inputs: cx.controller.getInputs(id) ?? {},
      styles: cx.controller.getStyles(id) ?? {},
      options,
    });
    cx.setPaneEpoch((n) => n + 1);
    queueMicrotask(cx.refreshPaneBoxes);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  };
  listenWhenShown(MOVE_STUDY_EVENT, onMoveStudyRequest);
  // ── Drawing order of the sources (Object tree) ─────────────────────────
  /** Sources front first: the saved order, then the ones it does not list
   *  (by default the main series in front, then the studies in list order,
   *  then the compared symbols; a new source goes behind the others). */
  function sourceOrderIds(): string[] {
    const present = [MAIN_SOURCE_ID, ...indLegend().map((r) => r.id)];
    const saved = (props.sourceOrder ?? []).filter((id) => present.includes(id));
    return [...saved, ...present.filter((id) => !saved.includes(id))];
  }
  /** Series of every pane put in the sources' order (the library draws a
   *  pane's series in their order, the last one in front). A series with no
   *  known source (a helper series) stays with the source before it. */
  function applySourceOrder() {
    if (!cx.chart) return;
    const order = untrack(sourceOrderIds);
    const rank = (id: string) => {
      const k = order.indexOf(id);
      return k < 0 ? order.length : k;
    };
    for (const pane of cx.chart.panes()) {
      const list = pane.getSeries() as ISeriesApi<SeriesType>[];
      if (list.length < 2) continue;
      let owner = MAIN_SOURCE_ID;
      const keyed = list.map((s, i) => {
        const id = s === (cx.series as unknown) ? MAIN_SOURCE_ID : cx.studyOfSeries(s);
        if (id) owner = id;
        return { s, i, r: rank(owner) };
      });
      const sorted = keyed.slice().sort((a, b) => b.r - a.r || a.i - b.i);
      if (sorted.every((k, i) => k.i === i)) continue;
      sorted.forEach((k, i) => k.s.setSeriesOrder(i));
    }
    syncSunk();
  }

  // ── Drawings behind a series (sunk-drawings.ts) ────────────────────────
  /** Painter of the overlay (it owns the drawings' geometry). */
  let sunkPainter: SunkPainter | null = null;
  /** Drawings painted on the canvas now (transparent in the overlay). */
  const [sunkIds, setSunkIds] = createSignal<ReadonlySet<string>>(new Set(), {
    equals: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)),
  });
  let sunkGroups: SunkGroup[] = [];
  let sunkPrims: { series: ISeriesApi<SeriesType>; prim: SunkDrawings }[] = [];
  /** Every drawing behind a shown series goes to a primitive of the nearest
   *  shown source behind it (or to the back of its pane); the ones in front
   *  of every shown series stay with the overlay. */
  function syncSunk() {
    const groups: SunkGroup[] = [];
    const sunk = new Set<string>();
    const paint = sunkPainter;
    if (cx.chart && paint) {
      const byId = new Map((props.drawings ?? []).map((d) => [d.id, d]));
      const paintable = (d: Drawing) =>
        !d.hidden && isVisibleOnInterval(d.visibility, props.interval) && !NEVER_SUNK_KINDS.has(d.kind);
      const lwPanes = cx.chart.panes();
      /** Back group of each pane with a shown series. */
      const backOf = new Map<number, SunkGroup>();
      const paneKeys = new Map<number, string | null>();
      const mainIdx = cx.mainPane();
      for (const tp of untrack(treePanes)) {
        const pane = lwPanes[tp.pane];
        const paneKey = tp.pane === mainIdx ? null : cx.controller?.ownerOfPane(tp.pane) ?? null;
        if (!pane || (tp.pane !== mainIdx && !paneKey)) continue;
        // Shown series of the pane, back to front, each with its source.
        let owner = MAIN_SOURCE_ID;
        const shown: ISeriesApi<SeriesType>[] = [];
        const frontOf = new Map<string, ISeriesApi<SeriesType>>();
        for (const s of pane.getSeries() as ISeriesApi<SeriesType>[]) {
          const id = s === (cx.series as unknown) ? MAIN_SOURCE_ID : cx.studyOfSeries(s);
          if (id) owner = id;
          if (s.options().visible === false) continue;
          shown.push(s);
          frontOf.set(owner, s);
        }
        if (shown.length === 0) continue;
        paneKeys.set(tp.pane, paneKey);
        const front = shown[shown.length - 1];
        const back: SunkGroup = { series: shown[0], bottom: true, paneKey, ids: [] };
        backOf.set(tp.pane, back);
        const byAnchor = new Map<ISeriesApi<SeriesType>, SunkGroup>();
        let anchor: ISeriesApi<SeriesType> | null = null;
        for (let i = tp.items.length - 1; i >= 0; i--) {
          const it = tp.items[i];
          if (it.kind === "source") {
            anchor = frontOf.get(it.id) ?? anchor;
            continue;
          }
          const d = byId.get(it.id);
          if (!d || !paintable(d) || anchor === front) continue;
          sunk.add(d.id);
          if (!anchor) { back.ids.push(d.id); continue; }
          let g = byAnchor.get(anchor);
          if (!g) byAnchor.set(anchor, (g = { series: anchor, bottom: false, paneKey, ids: [] }));
          g.ids.push(d.id);
        }
        groups.push(...byAnchor.values());
      }
      // A vertical line with "Extend" runs through every pane: behind the
      // series of the other panes too.
      for (const id of sunk) {
        const d = byId.get(id)!;
        if (d.kind !== "vertical-line" || d.style.extendLine === false) continue;
        const own = d.owner ?? null;
        for (const [pane, back] of backOf) if (paneKeys.get(pane) !== own) back.ids.push(id);
      }
      for (const back of backOf.values()) if (back.ids.length) groups.push(back);
    }
    setSunkIds(sunk);
    if (sameSunkGroups(groups, sunkGroups)) {
      for (const p of sunkPrims) p.prim.update();
      return;
    }
    for (const p of sunkPrims) {
      try { p.series.detachPrimitive(p.prim); } catch { /* its series is gone */ }
    }
    sunkGroups = groups;
    sunkPrims = paint
      ? groups.map((g) => {
          const prim = new SunkDrawings(g, paint);
          g.series.attachPrimitive(prim);
          return { series: g.series, prim };
        })
      : [];
  }
  let sourceOrderQueued = false;
  /** Re-apply the order once after the current batch of redraws (a redrawn
   *  source re-creates its series in front). */
  function scheduleSourceOrder() {
    if (sourceOrderQueued) return;
    sourceOrderQueued = true;
    queueMicrotask(() => {
      sourceOrderQueued = false;
      applySourceOrder();
    });
  }
  createEffect(() => {
    chartReady();
    props.sourceOrder;
    // The drawings painted on the canvas follow the drawings, their order,
    // the panes and what is shown.
    props.drawings;
    props.interval;
    props.seriesHidden;
    treePanes();
    cx.paneEpoch();
    scheduleSourceOrder();
  });
  /** Object tree rows of this chart: per pane, front source first. */
  const treeSources = createMemo<TreeSource[]>(() => {
    const { ticker, exchange } = splitSymbol(props.symbol ?? "");
    const rows = indLegend();
    cx.mainPaneEpoch();
    const mainIdx = untrack(cx.mainPane);
    const out: TreeSource[] = [];
    for (const id of sourceOrderIds()) {
      if (id === MAIN_SOURCE_ID) {
        out.push({
          id,
          kind: "series",
          title: `${exchange ? `${ticker} · ${exchange}` : ticker}, ${props.interval ?? "1D"}`,
          hidden: !!props.seriesHidden,
          pane: mainIdx,
        });
        continue;
      }
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      const entry = row.compare ? undefined : getIndicatorEntry(id);
      const inputs = entry && row.inputValues ? statusLineInputs(entry, row.inputValues, ", ") : "";
      out.push({
        id,
        kind: row.compare ? "compare" : "study",
        title: inputs ? `${row.title} (${inputs})` : row.title,
        hidden: row.eyeHidden,
        pane: row.pane,
      });
    }
    return out.sort((a, b) => a.pane - b.pane);
  }, [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  /** Pane of a drawing: its owner study's pane, the price pane without an
   *  owner (null = owner not on the chart). */
  const paneOfDrawing = (d: Drawing): number | null => {
    if (!d.owner) return treeSources().find((s) => s.id === MAIN_SOURCE_ID)?.pane ?? 0;
    return treeSources().find((s) => s.id === d.owner)?.pane ?? null;
  };
  /** Objects of every pane (sources and drawings in one list), front first. */
  const treePanes = createMemo<TreePane[]>(() => {
    const srcs = treeSources();
    const ds = props.drawings ?? [];
    const mainIdx = srcs.find((s) => s.id === MAIN_SOURCE_ID)?.pane ?? 0;
    const panes = [...new Set([mainIdx, ...srcs.map((s) => s.pane)])].sort((a, b) => a - b);
    return panes.map((pane) => ({
      pane,
      items: paneItems(
        srcs.filter((s) => s.pane === pane).map((s) => s.id),
        ds.filter((d) => paneOfDrawing(d) === pane).reverse().map((d) => ({ id: d.id, over: overOf(d) })),
      ),
    }));
  }, [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  // The focused chart publishes its sources and serves the tree's requests.
  createEffect(() => {
    if (props.active === false || props.shown === false) return;
    setFocusedTreeSources(treeSources());
    setFocusedTreePanes(treePanes());
  });
  const onTreeHideRequest = (d: AppEvents["chart-tree-toggle-hide"] | undefined) => {
    if (props.active === false) return;
    const id = d?.id;
    if (id && treeSources().some((s) => s.id === id)) toggleSourceHidden(id);
  };
  const onTreeRemoveRequest = (d: AppEvents["chart-tree-remove"] | undefined) => {
    if (props.active === false) return;
    const id = d?.id;
    if (id && treeSources().some((s) => s.id === id && s.kind !== "series")) removeStudy(id);
  };
  /** Save a study's new pane (options, stacking order) and redraw the panes. */
  function studyPaneChanged(id: string, options: IndicatorOptions, order?: string[]) {
    if (!cx.controller) return;
    if (order) cx.controller.setPaneOrder(order);
    props.onIndicatorSettings?.(id, {
      inputs: cx.controller.getInputs(id) ?? {},
      styles: cx.controller.getStyles(id) ?? {},
      options,
    });
    props.onPaneOrder?.(order ?? cx.controller.stackedOrder());
    cx.setPaneEpoch((n) => n + 1);
    cx.setCollapsedPanes(new Map());
    queueMicrotask(cx.refreshPaneBoxes);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }
  /** Study dropped on pane `pane` (chart drag): it joins that pane. */
  function mergeStudyToPane(id: string, pane: number): boolean {
    const options = cx.controller?.moveToPane(id, pane);
    if (!options) return false;
    studyPaneChanged(id, options);
    return true;
  }
  /** Study dropped on the time axis (chart drag): a new pane at the bottom
   *  when it shares its pane, else its pane moves to the bottom. */
  function dropStudyOnTimeAxis(id: string): boolean {
    if (!cx.controller) return false;
    const options = cx.controller.unmergeToNewPane(id);
    if (options) {
      studyPaneChanged(id, options, [...cx.controller.stackedOrder().filter((x) => x !== id), id]);
      return true;
    }
    const pane = cx.controller.paneOf(id);
    const last = (cx.chart?.panes().length ?? 1) - 1;
    if (pane === null || pane === last) return false;
    const mates = cx.controller.studiesInPane(pane);
    const order = [...cx.controller.stackedOrder().filter((x) => !mates.includes(x)), ...mates];
    cx.controller.setPaneOrder(order);
    props.onPaneOrder?.(order);
    cx.setPaneEpoch((n) => n + 1);
    cx.setCollapsedPanes(new Map());
    queueMicrotask(cx.refreshPaneBoxes);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    return true;
  }
  // ── Main series drag (reference rules) ─────────────────────────────────
  // Onto a study pane: the series joins it (the pane's price scale when it
  // shows prices, else a scale of its own on the free side) with its
  // drawings; the studies and compared symbols drawn over it stay in its
  // former pane, which closes when left empty. Onto the time axis: a new
  // pane at the bottom when it shares its pane, else its pane moves to the
  // bottom.
  /** Compared symbols drawn over the series (not in a pane of their own). */
  const overSeriesCompares = () => cx.compareEntries().filter((e) => e.placement !== "pane").map((e) => e.id);
  /** The series left its pane: what stayed there is saved (the studies'
   *  pane group, the compared symbols now in that pane), then the stacking
   *  order and the panes are redrawn. */
  function seriesMoved(move: SeriesMove, compares: string[], order?: string[]) {
    const c = cx.controller;
    if (!c) return;
    for (const id of move.ids) {
      props.onIndicatorSettings?.(id, { inputs: c.getInputs(id) ?? {}, styles: c.getStyles(id) ?? {}, options: c.getOptions(id) });
    }
    // The first compared symbol takes the pane the series left (with the
    // studies that stayed); a second one opens its own pane (one compared
    // symbol per pane here).
    // The order is read before the compared symbols change (that redraws them).
    const stay = compares[0];
    const next = order ?? c.stackedOrder(stay ? [[stay, move.from]] : []);
    for (const id of compares) props.onCompareChange?.(id, { placement: "pane" });
    c.setPaneOrder(next);
    props.onPaneOrder?.(next);
    cx.setPaneEpoch((n) => n + 1);
    cx.setCollapsedPanes(new Map());
    queueMicrotask(cx.refreshPaneBoxes);
    requestAnimationFrame(() => requestAnimationFrame(cx.refreshPaneBoxes));
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }
  /** Main series dropped on study pane `pane` (chart drag). */
  function mergeSeriesToPane(pane: number): boolean {
    const c = cx.controller;
    if (!c?.canMergeSeriesTo(pane)) return false;
    const compares = overSeriesCompares();
    cx.holdCompares(compares);
    const move = c.mergeSeriesToPane(pane, compares[0]);
    if (!move) return false;
    seriesMoved(move, compares);
    return true;
  }
  /** Main series dropped on the time axis (chart drag). */
  function dropSeriesOnTimeAxis(): boolean {
    const c = cx.controller;
    if (!c) return false;
    const compares = overSeriesCompares();
    if (c.seriesPaneShared(compares.length > 0)) {
      cx.holdCompares(compares);
      const move = c.unmergeSeriesToNewPane(compares[0]);
      if (!move) return false;
      const stay = compares[0];
      seriesMoved(move, compares, seriesPaneLast(c.stackedOrder(stay ? [[stay, move.from]] : [])));
      return true;
    }
    // Alone in its pane: the pane moves to the bottom.
    const last = (cx.chart?.panes().length ?? 1) - 1;
    if (cx.mainPane() >= last) return false;
    seriesMoved({ from: cx.mainPane(), group: null, ids: [] }, [], seriesPaneLast(c.stackedOrder()));
    return true;
  }
  const onTreeMoveRequest = (d: AppEvents["chart-tree-move"] | undefined) => {
    if (props.active === false) return;
    const { id, target, below } = (d ?? {}) as AppEvents["chart-tree-move"];
    // A source moved: one undo step (reference texts); a drawing's move is the drawings' own.
    const src = treeSources().find((x) => x.id === id);
    if (src && !(d as { recorded?: boolean } | undefined)?.recorded) {
      const into = treePanes().find((p) => p.items.some((x) => x.id === target));
      const from = treePanes().find((p) => p.items.some((x) => x.id === id));
      const targetTitle = treeSources().find((x) => x.id === target)?.title ?? "";
      const label = from && into && from !== into ? "merge to pane" : `insert ${src.title} ${below ? "after" : "before"} ${targetTitle}`;
      sourcesEdit(label, () => onTreeMoveRequest({ ...(d as AppEvents["chart-tree-move"]), recorded: true } as AppEvents["chart-tree-move"]));
      return;
    }
    let pane = treePanes().find((p) => p.items.some((x) => x.id === id));
    const targetPane = treePanes().find((p) => p.items.some((x) => x.id === target));
    if (!pane || !targetPane) return;
    if (pane !== targetPane) {
      // A drop in another pane: only a study changes pane (it joins the
      // target's pane, its former pane closes when left empty).
      if (!cx.controller || treeSources().find((s) => s.id === id)?.kind !== "study") return;
      const options = cx.controller.moveToPane(id, targetPane.pane);
      if (!options) return;
      props.onIndicatorSettings?.(id, {
        inputs: cx.controller.getInputs(id) ?? {},
        styles: cx.controller.getStyles(id) ?? {},
        options,
      });
      props.onPaneOrder?.(cx.controller.stackedOrder());
      cx.setPaneEpoch((n) => n + 1);
      queueMicrotask(cx.refreshPaneBoxes);
      refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
      pane = treePanes().find((p) => p.items.some((x) => x.id === id));
      if (!pane) return;
    }
    placeInPane(pane, id, target, below);
  };
  /** Put `id` right above / below `target` among the objects of `pane`:
   *  the sources' order and the drawings' places are saved. */
  function placeInPane(pane: TreePane, id: string, target: string, below: boolean) {
    const next = moveItem(pane.items, id, target, below);
    if (!next) return;
    const was = splitItems(pane.items);
    const now = splitItems(next);
    if (now.sources.join("\n") !== was.sources.join("\n")) {
      // The pane's sources take, in their new order, the places they hold
      // in the chart's order.
      const inPane = new Set(now.sources);
      let k = 0;
      const order = sourceOrderIds().map((x) => (inPane.has(x) ? now.sources[k++] : x));
      // Saved ids of sources not on the chart now ("Hide indicators") are kept.
      const kept = (props.sourceOrder ?? []).filter((x) => !order.includes(x));
      props.onSourceOrder?.([...order, ...kept]);
    }
    if (now.drawings.join("\n") !== was.drawings.join("\n") || JSON.stringify(now.over) !== JSON.stringify(was.over)) {
      props.placeDrawings?.(now.drawings, now.over);
    }
  }
  /** Visual order steps of a source: to the front unless it is the front
   *  object of its pane, to the back unless it is the back one. */
  function zOrderSteps(id: string): { front: boolean; back: boolean } | null {
    const pane = treePanes().find((p) => p.items.some((x) => x.id === id && x.kind === "source"));
    if (!pane) return null;
    const i = pane.items.findIndex((x) => x.id === id);
    return { front: i > 0, back: i < pane.items.length - 1 };
  }
  /** Visual order of a source among the objects (sources and drawings) of
   *  its pane: to the front / back, or over / under the next object. */
  function moveZ(id: string, op: ZOrderOp) {
    const pane = treePanes().find((p) => p.items.some((x) => x.id === id && x.kind === "source"));
    if (!pane) return;
    const items = pane.items;
    const i = items.findIndex((x) => x.id === id);
    const last = items.length - 1;
    if ((op === "front" || op === "forward") && i <= 0) return;
    if ((op === "back" || op === "backward") && i >= last) return;
    if (op === "front") placeInPane(pane, id, items[0].id, false);
    else if (op === "back") placeInPane(pane, id, items[last].id, true);
    else if (op === "forward") placeInPane(pane, id, items[i - 1].id, false);
    else placeInPane(pane, id, items[i + 1].id, true);
  }
  /** "Move to" rows of a study (reference rules): a pane above / below to
   *  merge into unless it is the first / last pane; a new pane above / below
   *  when its pane holds another source (the main series counts). */
  function studyMoves(id: string): StudyMoves | null {
    const c = cx.controller;
    if (!c || cx.compareEntry(id)) return null;
    const pane = c.paneOf(id);
    if (pane === null) return null;
    const last = (cx.chart?.panes().length ?? 1) - 1;
    const shared = pane === cx.mainPane() || c.idsInPane(pane).length > 1;
    return { mergeUp: pane > 0, unmergeUp: shared, mergeDown: pane < last, unmergeDown: shared };
  }
  /** Apply a "Move to" row: merge into the pane above / below, or a new
   *  pane right above / below the study's pane. */
  function moveStudy(id: string, move: keyof StudyMoves) {
    const c = cx.controller;
    const moves = studyMoves(id);
    if (!c || !moves?.[move]) return;
    const pane = c.paneOf(id) ?? 0;
    if (move === "mergeUp" || move === "mergeDown") {
      mergeStudyToPane(id, move === "mergeUp" ? pane - 1 : pane + 1);
      return;
    }
    // Stacked panes, top to bottom, before the move (the price pane as `_series` when the series has its own).
    const before = c.stackedOrder().filter((x) => x !== id);
    const mates = [...c.idsInPane(pane).filter((x) => x !== id), ...(pane === cx.mainPane() ? [MAIN_SOURCE_ID] : [])];
    const options = c.unmergeToNewPane(id);
    if (!options) return;
    const first = before.findIndex((x) => mates.includes(x));
    let lastMate = first;
    before.forEach((x, k) => { if (mates.includes(x)) lastMate = k; });
    const at = first < 0 ? (move === "unmergeUp" ? 0 : before.length) : move === "unmergeUp" ? first : lastMate + 1;
    studyPaneChanged(id, options, [...before.slice(0, at), id, ...before.slice(at)]);
  }
  listenWhenShown(TREE_HIDE_EVENT, onTreeHideRequest);
  listenWhenShown(TREE_REMOVE_EVENT, onTreeRemoveRequest);
  listenWhenShown(TREE_MOVE_EVENT, onTreeMoveRequest);
  // Delete / Backspace remove the selected study, Escape clears it (focused
  // chart only, not while typing or with a dialog open).
  const onStudyKey = (e: KeyboardEvent) => {
    const id = selectedStudy();
    if (!id || props.active === false) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (document.querySelector('[role="dialog"]')) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeStudy(id);
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyC") {
      // Ctrl+C copies the selected study / compared symbol (study menu "Copy").
      e.preventDefault();
      cx.copySourceOf(id);
    } else if (e.key === "Escape") {
      setSelectedStudy(null);
    }
  };
  document.addEventListener("keydown", whenShown(onStudyKey));
  onCleanup(() => document.removeEventListener("keydown", whenShown(onStudyKey)));

  return {
    dropSeriesOnTimeAxis,
    dropStudyOnTimeAxis,
    mergeSeriesToPane,
    mergeStudyToPane,
    moveStudy,
    moveZ,
    studyMoves,
    zOrderSteps,
    scheduleSourceOrder,
    sunkIds,
    get sunkPainter() {
      return sunkPainter;
    },
    set sunkPainter(v: typeof sunkPainter) {
      sunkPainter = v;
    },
  };
}
