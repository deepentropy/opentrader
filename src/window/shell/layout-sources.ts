/*
 * Layout-wide edits of the charts' sources, asked by the chart menus:
 *   - "Add this indicator / strategy / symbol to entire layout" (study and
 *     compared-symbol menus): a copy of the source on every other chart of
 *     the layout, in the price pane when it is there, else in a new pane at
 *     the same position (the last one when the chart has fewer panes); a
 *     compared symbol on the main scale in percent stays a "same % scale"
 *     symbol;
 *   - "Apply these indicators to entire layout" (chart menu): every other
 *     chart takes this chart's studies and compared symbols in place of its
 *     own (the drawings of its studies go with them);
 *   - "Move chart" > Forward / Back (chart menu): the focused chart swaps its
 *     place with the next / previous chart (charts in reading order of the
 *     template, wrapping), and stays focused;
 *   - "Paste" of a copied study or compared symbol (chart menu, Ctrl+V): a
 *     copy on the focused chart, placed by its own rules.
 * Each one is one undo step. Installed by App.
 */
import { onAppEvent, type AddToLayoutDetail } from "../../data/app-events";
import { clipboardSource, type ClipboardSource } from "../drawings/clipboard";
import { getIndicatorEntry } from "../chart/indicators/registry";
import { MAIN_PANE_GROUP, defaultIndicatorOptions, type IndicatorOptions } from "../chart/indicators/indicator-options";
import { isStrategyId } from "../chart/indicators/strategy-entries";
import { newStudyId, typeIdOf } from "../chart/indicators/study-id";
import { LAYOUT_SPECS, type LayoutId } from "../chart/layouts";
import { cellRects, initialSizing } from "../chart/layout-sizes";
import { newCompareId, type CompareEntry, type PaneIndicatorSettings } from "./tabs";
import type { AppTabs } from "./app-tabs";
import type { ChartSources, DrawingSlice, LayoutSourcesUndoEntry, UndoHistory } from "./undo-history";
import type { DrawingStore } from "../drawings/drawing-store";

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The sources part of a chart. */
export function chartSources(p: ChartSources): ChartSources {
  return {
    indicators: p.indicators.slice(),
    indicatorSettings: clone(p.indicatorSettings),
    compare: clone(p.compare),
    paneOrder: p.paneOrder?.slice(),
    sourceOrder: p.sourceOrder?.slice(),
    seriesScale: p.seriesScale,
    seriesPane: p.seriesPane,
  };
}

/** Pane group of a study (null = the price pane), by the controller's rule:
 *  the price pane for an overlay study not moved to its own pane, or a study
 *  moved there; else its group (its own id by default). */
export function studyGroup(id: string, settings: PaneIndicatorSettings | undefined, isOverlayType: (typeId: string) => boolean): string | null {
  const o = settings?.options as Partial<IndicatorOptions> | undefined;
  const overlay = o?.paneGroup === MAIN_PANE_GROUP || (!o?.paneGroup && isOverlayType(typeIdOf(id)) && !o?.ownPane);
  return overlay ? null : o?.paneGroup ?? id;
}

/** The stacked panes of a chart, top to bottom, one id per pane (its first
 *  source): studies in list order, then compared symbols in their own pane,
 *  sorted by the saved stacking order (the controller's orderPanes rule). */
export function stackedPanes(p: ChartSources, isOverlayType: (typeId: string) => boolean): string[] {
  const group = new Map<string, string>();
  for (const id of p.indicators) {
    const g = studyGroup(id, p.indicatorSettings?.[id], isOverlayType);
    if (g !== null) group.set(id, g);
  }
  for (const c of p.compare ?? []) if (c.placement === "pane") group.set(c.id, c.id);
  const rest = [...group.keys()];
  const order = p.paneOrder ?? [];
  const rank = (id: string) => {
    const k = order.indexOf(id);
    return k >= 0 ? k : order.length + rest.indexOf(id);
  };
  const seen = new Set<string>();
  return rest
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .filter((id) => {
      const g = group.get(id)!;
      if (seen.has(g)) return false;
      seen.add(g);
      return true;
    });
}

/** Where a copied source goes on a chart. */
export type SourcePlace = {
  /** In the price pane. */
  main: boolean;
  /** Else: index of its pane in the chart it comes from (1 = first pane under
   *  the price pane); the new pane takes that position, or the last one. */
  paneIndex?: number;
  /** A compared symbol on the main scale in percent. */
  asCompare?: boolean;
};

/** `p` with a copy of `src` added at `place`. `taken` = study ids not to
 *  reuse (undo entries of the chart). */
export function withSource(
  p: ChartSources,
  src: ClipboardSource,
  place: SourcePlace | null,
  isOverlayType: (typeId: string) => boolean,
  taken: string[] = [],
): ChartSources {
  const out = chartSources(p);
  /** The new pane at the source's position (null place = the bottom). */
  const placePane = (id: string) => {
    const stacked = stackedPanes(p, isOverlayType);
    const at = place?.paneIndex !== undefined ? Math.max(0, Math.min(place.paneIndex - 1, stacked.length)) : stacked.length;
    stacked.splice(at, 0, id);
    out.paneOrder = stacked;
  };
  if (src.kind === "compare") {
    const placement = place?.asCompare ? "percent" : place && !place.main ? "pane" : src.entry.placement;
    const entry: CompareEntry = { ...clone(src.entry), id: newCompareId(), placement };
    out.compare = [...(out.compare ?? []), entry];
    if (placement === "pane") placePane(entry.id);
    return out;
  }
  const id = newStudyId(src.typeId, [...p.indicators, ...taken]);
  const settings = clone(src.settings);
  const options: IndicatorOptions = { ...defaultIndicatorOptions(), ...(settings.options ?? {}) };
  delete options.paneGroup;
  delete options.scale;
  options.ownPane = false;
  const overlayType = isOverlayType(src.typeId);
  if (place?.main) {
    if (!overlayType) options.paneGroup = MAIN_PANE_GROUP;
  } else if (place) {
    if (overlayType) options.ownPane = true;
  }
  settings.options = options;
  out.indicators = [...out.indicators, id];
  out.indicatorSettings = { ...out.indicatorSettings, [id]: settings };
  // A new study goes behind the other sources.
  if (out.sourceOrder?.includes(id)) out.sourceOrder = out.sourceOrder.filter((x) => x !== id);
  if (place && !place.main) placePane(id);
  return out;
}

/** Chart indexes of a template in reading order (top, then left) on equal
 *  sizes. */
export function readingOrder(layout: LayoutId, count: number): number[] {
  const expr = LAYOUT_SPECS[layout].expr;
  const rects = cellRects(expr, { left: 0, top: 0, width: 256, height: 256 }, 0, initialSizing(expr));
  return rects
    .map((r, i) => ({ r, i }))
    .filter((x) => x.i < count)
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
    .map((x) => x.i);
}

/** The chart that `index` swaps with for "Move chart" Forward (`back` false)
 *  or Back; null with a single chart. */
export function swapTarget(layout: LayoutId, count: number, index: number, back: boolean): number | null {
  const order = readingOrder(layout, count);
  if (order.length < 2) return null;
  const k = order.indexOf(index);
  if (k < 0) return null;
  return order[(k + (back ? order.length - 1 : 1)) % order.length];
}

const isOverlayType = (typeId: string) => !!getIndicatorEntry(typeId)?.overlay;

/** Undo label of an "entire layout" add. */
function addLabel(src: ClipboardSource): string {
  if (src.kind === "compare") return "add this symbol to entire layout";
  return isStrategyId(src.typeId) ? "add this strategy to entire layout" : "add this indicator to entire layout";
}

export function installLayoutSources(
  t: Pick<AppTabs, "tabOf" | "activeTab">,
  undo: Pick<UndoHistory, "commit" | "undoStack" | "redoStack">,
  d: Pick<DrawingStore, "drawingKeyFor" | "drawingsFor" | "splitView">,
): () => void {
  /** Study ids held by undo / redo entries of a chart (not reused). */
  function heldIds(tabId: string, paneIndex: number): string[] {
    const out: string[] = [];
    for (const e of [...undo.undoStack(), ...undo.redoStack()]) {
      if (e.kind === "study" && e.tabId === tabId && e.paneIndex === paneIndex) out.push(...e.ids);
      if (e.kind === "layout-sources" && e.tabId === tabId) for (const side of [e.before, e.after]) out.push(...(side[paneIndex]?.indicators ?? []));
    }
    return out;
  }
  function commit(tabId: string, after: Record<number, ChartSources>, slices: DrawingSlice[], label: string) {
    const tab = t.tabOf(tabId);
    if (!tab || Object.keys(after).length === 0) return;
    const before: Record<number, ChartSources> = {};
    for (const k of Object.keys(after)) before[Number(k)] = chartSources(tab.panes[Number(k)]);
    const entry: LayoutSourcesUndoEntry = { kind: "layout-sources", tabId, before, after, slices, label, at: Date.now() };
    undo.commit(entry);
  }
  /** Study menu "Add this … to entire layout". */
  function addToLayout(detail: AddToLayoutDetail) {
    const tab = t.activeTab();
    const after: Record<number, ChartSources> = {};
    tab.panes.forEach((p, i) => {
      if (i === tab.activePane) return;
      after[i] = withSource(p, detail.source, detail.place, isOverlayType, heldIds(tab.id, i));
    });
    commit(tab.id, after, [], addLabel(detail.source));
  }
  /** Chart menu "Apply these indicators to entire layout". */
  function applyToLayout() {
    const tab = t.activeTab();
    const from = tab.panes[tab.activePane];
    if (!from) return;
    const fromKey = d.drawingKeyFor(from, tab.id);
    const after: Record<number, ChartSources> = {};
    const slices: DrawingSlice[] = [];
    const done = new Set<string>([fromKey]);
    // Stores of drawings the source chart shows are left alone.
    const fromScopes = new Set(d.splitView(fromKey, []).map((s) => s.key));
    tab.panes.forEach((p, i) => {
      if (i === tab.activePane) return;
      after[i] = chartSources(from);
      // The drawings of the chart's studies go with them (not on a view this
      // chart shares with the source chart).
      const key = d.drawingKeyFor(p, tab.id);
      if (done.has(key)) return;
      done.add(key);
      const list = d.drawingsFor(key);
      const kept = list.filter((x) => !x.owner);
      if (kept.length !== list.length) slices.push(...d.splitView(key, kept).filter((s) => !fromScopes.has(s.key)));
    });
    commit(tab.id, after, slices, "apply indicators to entire layout");
  }
  /** Chart menu "Paste" / Ctrl+V of a copied source. */
  function paste() {
    const src = clipboardSource();
    if (!src) return;
    const tab = t.activeTab();
    const p = tab.panes[tab.activePane];
    if (!p) return;
    commit(tab.id, { [tab.activePane]: withSource(p, src, null, isOverlayType, heldIds(tab.id, tab.activePane)) }, [], `paste ${src.title}`);
  }
  /** Chart menu "Move chart" > Forward / Back. */
  function moveChart(back: boolean) {
    const tab = t.activeTab();
    const other = swapTarget(tab.layout, tab.panes.length, tab.activePane, back);
    if (other === null) return;
    undo.commit({ kind: "chart-swap", tabId: tab.id, a: tab.activePane, b: other, activeBefore: tab.activePane, activeAfter: other, label: "swap charts in the Layout", at: Date.now() });
  }
  const offs = [
    onAppEvent("chart-add-to-layout", (detail) => addToLayout(detail)),
    onAppEvent("chart-apply-studies-to-layout", () => applyToLayout()),
    onAppEvent("chart-paste-source", () => paste()),
    onAppEvent("chart-move-in-layout", (detail) => moveChart(!!detail?.back)),
  ];
  return () => offs.forEach((off) => off());
}
