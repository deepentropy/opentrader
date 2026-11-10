import { translate, translateWith } from "../../i18n/translator";
/*
 * Edits of a chart's content written into its tab: studies (add, remove with
 * the drawings they own, order, settings, indicator templates), compared
 * symbols, the places of the sources (editSources: panes, scales, drawing
 * order), link group / series eye, the settled visible range and the layout
 * splitter sizes. The per-pane callbacks name
 * their tab: every opened tab keeps its grid mounted, so a pane writes into
 * its own tab, shown or not. Removals of studies, compare changes and
 * splitter changes are undo steps; `applyUndoEntry` writes one side of any
 * undo entry. Created once by App.
 */
import { createSignal } from "solid-js";
import { emitAppEvent } from "../../data/app-events";
import { track } from "../../data/analytics";
import { getTickerInfo, isFullSymbol, tickerOf, toFullSymbol } from "../../data/datafeed";
import { recentSymbols, recordRecentSymbol } from "../../data/recent-symbols";
import { loadIndicatorDefault } from "../../data/indicator-defaults";
import { getIndicatorTemplate, saveIndicatorTemplate, touchIndicatorTemplate } from "../../data/indicator-template-store";
import { strategyTester } from "../../data/strategy-tester-store";
import { replayBroker } from "../../data/trading/replay-broker";
import { FIXED_RANGE_VP_TOOL_ROW, getIndicatorEntry } from "../chart/indicators/registry";
import { defaultIndicatorOptions } from "../chart/indicators/indicator-options";
import { isStrategyId } from "../chart/indicators/strategy-entries";
import { newStudyId, typeIdOf } from "../chart/indicators/study-id";
import { COMPARE_COLORS, newCompareStyle } from "../chart/compare/compare-style";
import { MAIN_SOURCE_ID } from "../chart/object-tree-sources";
import type { LayoutId } from "../chart/layouts";
import type { Sizing } from "../chart/layout-sizes";
import { newCompareId, type CompareEntry, type ComparePatch, type ComparePlacement, type PaneChart, type PaneIndicatorSettings } from "./tabs";
import type { AppTabs } from "./app-tabs";
import type { ChartSources, CompareUndoEntry, LayoutSizesUndoEntry, StudyUndoEntry, UndoEntry, UndoHistory } from "./undo-history";
import { chartSources } from "./layout-sources";
import { sourceInputIds, sourceRef, withDescendants } from "../chart/indicators/study-sources";
import { isScaleKey } from "../chart/scales/scale-layout";
import { showConfirm } from "../../components/Dialogs";
import type { ChildStudyParent } from "../../data/app-events";
import type { DrawingStore } from "../drawings/drawing-store";
import type { Drawing } from "lightweight-charts-drawing/core/types";

/** An edit of a chart's sources (editSources): study settings and compared symbol patches by id, the studies' list
 *  in a new order, the pane order, the sources' drawing order, the series' scale (null = the chart's scales side)
 *  and pane (the group of the study pane it shares, null = a pane of its own), and the chart's drawings placed
 *  again with them (the drawings `key` holds, in their new order). */
export type SourcesPatch = {
  studies?: Record<string, PaneIndicatorSettings>;
  compare?: Record<string, ComparePatch>;
  indicators?: string[];
  paneOrder?: string[];
  sourceOrder?: string[];
  seriesScale?: string | null;
  seriesPane?: string | null;
  drawings?: { key: string; list: Drawing[] };
};

export function createChartEdits(
  t: Pick<AppTabs, "tabOf" | "patchTab" | "activeTab" | "activePaneState" | "patchActivePane">,
  undo: Pick<UndoHistory, "commit" | "record" | "rollback" | "undoStack" | "redoStack">,
  d: Pick<DrawingStore, "drawingKeyFor" | "drawingsFor" | "splitView" | "restoreSlice">,
) {
  const { tabOf, patchTab, activeTab, activePaneState, patchActivePane } = t;

  // ── Studies of a pane ──────────────────────────────────────────────────
  // Removals go through removeStudies (one undo step with the drawings the
  // studies own).
  /** Remove a study from a SPECIFIC pane (the per-pane legend's trash). */
  function removeIndicatorFromPane(tabId: string, paneIndex: number, id: string) {
    removeStudies(tabId, paneIndex, [id]);
  }
  /** Persist a study's edited inputs/styles onto a SPECIFIC pane (the per-pane
   *  Settings dialog → Ok). Stored under `indicatorSettings[id]`; the saveTabs
   *  effect persists it and the layout snapshot carries it into saved layouts. */
  function setIndicatorSettingsForPane(tabId: string, paneIndex: number, id: string, settings: PaneIndicatorSettings) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) =>
        i === paneIndex ? { ...p, indicatorSettings: { ...p.indicatorSettings, [id]: { ...p.indicatorSettings?.[id], ...settings } } } : p,
      ),
    });
  }
  /** Change the sources of a SPECIFIC pane as one undo step named `label`: the store is written and the chart draws
   *  the sources from it (studies' settings and order, compared symbols, the pane and source orders, the series'
   *  scale and pane), with the drawings placed again with them. Each study / compare patch replaces the fields it
   *  holds. `coalesce`: one step with the previous one of the same key (the keystrokes
   *  of one dialog field); `session`: the dialog the edit is made in (its Cancel takes the session's steps back, see
   *  UndoHistory.rollback). */
  function editSources(tabId: string, paneIndex: number, patch: SourcesPatch, label: string, opts: { coalesce?: string; session?: string } = {}) {
    const pane = tabOf(tabId)?.panes[paneIndex];
    if (!pane) return;
    const before = chartSources(pane);
    const after = chartSources(pane);
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    // A study on its defaults has no saved settings: its `before` takes the defaults of the fields the edit sets,
    // so an undo draws the study with them again (no saved value leaves the edited one drawn).
    const defaults: PaneIndicatorSettings = { inputs: {}, styles: {}, options: defaultIndicatorOptions() };
    for (const [id, p] of Object.entries(patch.studies ?? {})) {
      if (!pane.indicators.includes(id)) continue;
      const cur = before.indicatorSettings?.[id];
      const next: PaneIndicatorSettings = { ...cur, ...clone(p) };
      if (JSON.stringify(next) === JSON.stringify(cur ?? {})) continue;
      after.indicatorSettings = { ...after.indicatorSettings, [id]: next };
      const was: PaneIndicatorSettings = { ...cur };
      for (const k of ["inputs", "styles", "options"] as const) if (k in p && was[k] === undefined) Object.assign(was, { [k]: defaults[k] });
      if (Object.keys(was).length) before.indicatorSettings = { ...before.indicatorSettings, [id]: was };
    }
    if (patch.compare && after.compare) {
      after.compare = after.compare.map((c) => {
        const p = patch.compare![c.id];
        return p ? clone({ ...c, ...p, hidden: p.hidden ?? c.hidden }) : c;
      });
    }
    if (patch.indicators) after.indicators = patch.indicators.slice();
    if (patch.paneOrder) after.paneOrder = patch.paneOrder.slice();
    if (patch.sourceOrder) after.sourceOrder = patch.sourceOrder.slice();
    if (patch.seriesScale !== undefined) after.seriesScale = (patch.seriesScale ?? undefined) as PaneChart["seriesScale"];
    if (patch.seriesPane !== undefined) after.seriesPane = patch.seriesPane ?? undefined;
    const slices = patch.drawings ? d.splitView(patch.drawings.key, patch.drawings.list) : [];
    if (!slices.length && JSON.stringify(after) === JSON.stringify(chartSources(pane))) return;
    undo.commit({
      kind: "layout-sources",
      tabId,
      before: { [paneIndex]: before },
      after: { [paneIndex]: after },
      slices,
      label,
      at: Date.now(),
      ...opts,
    });
  }
  /** A Settings dialog's Cancel: the steps made in its session are taken back (not left to redo). */
  function rollbackSources(session: string) {
    undo.rollback(session);
  }
  /** Change a study's settings on a SPECIFIC pane as one undo step (editSources). */
  function editStudySettings(
    tabId: string,
    paneIndex: number,
    id: string,
    patch: PaneIndicatorSettings,
    label: string,
    opts: { coalesce?: string; session?: string } = {},
  ) {
    editSources(tabId, paneIndex, { studies: { [id]: patch } }, label, opts);
  }
  /** Merge input values into a study's saved inputs, one undo step as the Settings dialog's Ok (Strategy Tester
   *  properties, the agent's set inputs). */
  function patchStudyInputs(tabId: string, paneIndex: number, id: string, patch: Record<string, unknown>) {
    const cur = tabOf(tabId)?.panes[paneIndex]?.indicatorSettings?.[id]?.inputs;
    editStudySettings(tabId, paneIndex, id, { inputs: { ...cur, ...patch } }, translateWith("change {0} properties", translate(getIndicatorEntry(id)?.name ?? id)));
  }
  /** Persist a pane's settled scroll/zoom anchor (its visible logical range).
   *  The saveTabs effect then writes it to localStorage, so the view survives tab
   *  switches and full reloads (ChartView restores it on data load). No-op when
   *  the range is unchanged, so it doesn't churn the tabs signal on every
   *  programmatic re-frame that reports the same window. */
  function setVisibleRangeForPane(tabId: string, paneIndex: number, range: { from: number; to: number; last?: number; barSpacing?: number; rightOffset?: number }) {
    const tab = tabOf(tabId);
    if (!tab) return;
    const cur = tab.panes[paneIndex]?.visibleLogicalRange;
    if (cur && cur.from === range.from && cur.to === range.to && cur.last === range.last && cur.barSpacing === range.barSpacing) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) => (i === paneIndex ? { ...p, visibleLogicalRange: range, initialScale: undefined } : p)),
    });
  }
  /** Put the entry's studies back (at their old positions, with their
   *  settings) or remove them again. */
  function setPaneStudies(e: StudyUndoEntry, restore: boolean) {
    const tab = tabOf(e.tabId);
    const pane = tab?.panes[e.paneIndex];
    if (!tab || !pane) return;
    let indicators = pane.indicators.filter((x) => !e.ids.includes(x));
    let indicatorSettings = pane.indicatorSettings;
    if (restore) {
      indicators = indicators.slice();
      e.ids.forEach((id, k) => indicators.splice(Math.min(e.positions[k], indicators.length), 0, id));
      indicatorSettings = { ...pane.indicatorSettings, ...e.settings };
    }
    patchTab(e.tabId, { panes: tab.panes.map((p, i) => (i === e.paneIndex ? { ...p, indicators, indicatorSettings } : p)) });
  }
  /** Remove studies from a chart as one undo step. The drawings they own on
   *  the chart's current symbol go with them (a drawing lives in its owner's
   *  pane); undo restores the studies, their settings and the drawings. */
  function removeStudies(tabId: string, paneIndex: number, ids: string[]) {
    const pane = tabOf(tabId)?.panes[paneIndex];
    if (!pane) return;
    // The studies built on them go with them (reference: a source is removed with its dependencies).
    ids = withDescendants(pane.indicators, pane.indicatorSettings, ids, getIndicatorEntry);
    // List order, so re-inserting at the old indexes rebuilds the same order.
    const gone = pane.indicators.filter((id) => ids.includes(id));
    if (gone.length === 0) return;
    const positions = gone.map((id) => pane.indicators.indexOf(id));
    const settings: StudyUndoEntry["settings"] = {};
    for (const id of gone) {
      const st = pane.indicatorSettings?.[id];
      if (st) settings[id] = st;
    }
    const key = d.drawingKeyFor(pane, tabId);
    const list = d.drawingsFor(key);
    const kept = list.filter((x) => !x.owner || !gone.includes(x.owner));
    const slices = kept.length !== list.length ? d.splitView(key, kept) : [];
    const name = gone.length === 1 ? getIndicatorEntry(gone[0])?.name ?? gone[0] : "indicators";
    const entry: StudyUndoEntry = { kind: "study", tabId, paneIndex, ids: gone, positions, settings, slices, label: translateWith("remove {0}", name), at: Date.now() };
    undo.commit(entry);
  }

  /** Add a study of type `typeId` (registry id) to the focused pane. Every
   *  call adds a new instance with its own settings, like the reference app
   *  (the same indicator can be on a chart several times). */
  function addIndicator(typeId: string, parent?: ChildStudyParent) {
    // The fixed range volume profile row picks its drawing tool, as in the reference app
    // (counted as a drawing tool, not as an indicator).
    if (typeId === FIXED_RANGE_VP_TOOL_ROW) {
      emitAppEvent("select-drawing-tool", { toolId: "fixed-range-volume-profile" });
      return;
    }
    // A user's own script is counted, not named.
    track("indicator_added", { indicator: typeId.startsWith("user:") ? "user-script" : typeId });
    const pane = activePaneState();
    const tab = activeTab();
    // Ids still held by undo/redo entries of this pane are not reused: undo
    // would otherwise restore over the new instance.
    const held: string[] = [];
    for (const e of [...undo.undoStack(), ...undo.redoStack()])
      if (e.kind === "study" && e.tabId === tab.id && e.paneIndex === tab.activePane) held.push(...e.ids);
    const id = newStudyId(typeId, [...pane.indicators, ...held]);
    // A newly added study starts with the user's saved default ("Save as
    // default"), else the factory values (a new study never inherits the
    // settings of an earlier, removed instance).
    const entry = getIndicatorEntry(typeId);
    // A strategy that cannot be read is not put on the chart (it would be a study without a name or a report).
    if (!entry && isStrategyId(typeId)) return;
    let seed = loadIndicatorDefault(typeId) ?? (entry ? { inputs: { ...entry.defaultInputs }, styles: {}, options: defaultIndicatorOptions() } : undefined);
    // On a source ("Add indicator/strategy on …", reference rules): the first source input reads the source's
    // first output; a study drawn over the chart goes into the source's pane, on its scale; a study with no
    // source input cannot be added on a source.
    if (parent) {
      const src = entry ? sourceInputIds(entry)[0] : undefined;
      if (!entry || !src || !seed) {
        showConfirm({
          title: "Can't apply this indicator",
          text: "This indicator has no source-type input, so it can't be applied to another indicator.",
          mainText: "Got it",
          cancelText: null,
          onConfirm: () => {},
        });
        return;
      }
      const options = { ...seed.options ?? defaultIndicatorOptions() };
      if (entry.overlay) {
        if (parent.paneGroup) options.paneGroup = parent.paneGroup;
        if (parent.scale === "none" || isScaleKey(parent.scale)) options.scale = parent.scale;
      }
      seed = { ...seed, inputs: { ...seed.inputs, [src]: sourceRef(parent.id, 0) }, options };
    }
    // Adding a strategy opens its report (the reference app opens the footer panel).
    if (isStrategyId(typeId)) strategyTester.setCollapsed(false);
    patchActivePane({
      indicators: [...pane.indicators, id],
      ...(seed ? { indicatorSettings: { ...pane.indicatorSettings, [id]: seed } } : {}),
      // A new study goes behind the other sources (no place kept from an
      // earlier, removed instance of the same id).
      ...(pane.sourceOrder?.includes(id) ? { sourceOrder: pane.sourceOrder.filter((x) => x !== id) } : {}),
    });
    // One undo step, "insert <name>" (the reference app): undo takes it off, redo puts it back.
    undo.record({
      kind: "study",
      added: true,
      tabId: tab.id,
      paneIndex: tab.activePane,
      ids: [id],
      positions: [pane.indicators.length],
      settings: seed ? { [id]: seed } : {},
      slices: [],
      label: translateWith("insert {0}", translate(entry?.name ?? typeId)),
      at: Date.now(),
    });
  }
  /** OakScript panel: add the script to the chart, or take every instance of
   *  it off the chart. */
  function toggleScriptOnChart(typeId: string) {
    const on = activePaneState().indicators.filter((x) => typeIdOf(x) === typeId);
    if (on.length) {
      const tab = activeTab();
      removeStudies(tab.id, tab.activePane, on);
    } else addIndicator(typeId);
  }
  /** Remove-objects dropdown actions. Indicators live on the active pane. */
  function removeAllIndicators() {
    const tab = activeTab();
    removeStudies(tab.id, tab.activePane, activePaneState().indicators);
  }

  // ── Indicator templates (header "Indicator templates" dropdown) ─────────
  // A template captures the focused pane's studies + their edited settings.
  // Save prompts for a name (same modal as layout naming); applying replaces
  // the pane's studies with the template's.
  function saveIndicatorTemplateNamed(name: string) {
    const pane = activePaneState();
    // Carry only the settings of studies the template actually contains.
    const settings: Record<string, unknown> = {};
    for (const id of pane.indicators) {
      const s = pane.indicatorSettings?.[id];
      if (s) settings[id] = s;
    }
    saveIndicatorTemplate(name, pane.indicators, settings);
  }
  /** Replace the focused chart's studies with a template's, as one undo step ("apply study template <name>", the
   *  reference app). */
  function applyIndicatorTemplate(id: string) {
    const tpl = getIndicatorTemplate(id);
    if (!tpl) return;
    const tab = activeTab();
    const before = chartSources(activePaneState());
    const after: ChartSources = {
      ...before,
      indicators: [...tpl.indicators],
      indicatorSettings: JSON.parse(JSON.stringify(tpl.settings)) as PaneChart["indicatorSettings"],
    };
    undo.commit({
      kind: "layout-sources",
      tabId: tab.id,
      before: { [tab.activePane]: before },
      after: { [tab.activePane]: after },
      slices: [],
      label: translateWith("apply study template {0}", tpl.name),
      at: Date.now(),
    });
    touchIndicatorTemplate(id);
  }

  // ── Layout splitter sizes ──────────────────────────────────────────────
  /** Write a tab's chart sizes of one template (no undo record). */
  function setTabLayoutSizes(tabId: string, layout: LayoutId, sizes: Sizing | undefined) {
    const tab = tabOf(tabId);
    if (!tab) return;
    const next = { ...tab.layoutSizes };
    if (sizes) next[layout] = sizes;
    else delete next[layout];
    patchTab(tabId, { layoutSizes: Object.keys(next).length ? next : undefined });
  }
  /** A splitter drag ended (`sizes`) or a splitter was double-clicked
   *  (undefined): one undo step. */
  function changeLayoutSizes(tabId: string, sizes: Sizing | undefined) {
    const tab = tabOf(tabId);
    if (!tab) return;
    const entry: LayoutSizesUndoEntry = {
      kind: "layout-sizes",
      tabId,
      layout: tab.layout,
      before: tab.layoutSizes?.[tab.layout],
      after: sizes,
      label: sizes ? "resize layout" : "reset layout sizes",
      at: Date.now(),
    };
    undo.commit(entry);
  }

  // ── Compared symbols ───────────────────────────────────────────────────
  /** Write a pane's compare list (no undo record). */
  function setPaneCompare(tabId: string, paneIndex: number, list: CompareEntry[] | undefined) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, { panes: tab.panes.map((p, i) => (i === paneIndex ? { ...p, compare: list && list.length ? list : undefined } : p)) });
  }
  /** Change a pane's compare list as one undo step. */
  function changeCompare(tabId: string, paneIndex: number, next: CompareEntry[], label: string) {
    const pane = tabOf(tabId)?.panes[paneIndex];
    if (!pane) return;
    const entry: CompareUndoEntry = { kind: "compare", tabId, paneIndex, before: pane.compare, after: next.length ? next : undefined, label, at: Date.now() };
    undo.commit(entry);
  }
  /** Compare dialog: add a symbol to the focused pane. Line colour by add
   *  order on the pane. */
  function addCompare(symbol: string, placement: ComparePlacement) {
    const tabId = activeTab().id;
    const paneIndex = activeTab().activePane;
    const pane = activePaneState();
    const cur = pane.compare ?? [];
    const color = COMPARE_COLORS[cur.length % COMPARE_COLORS.length];
    const entry: CompareEntry = { id: newCompareId(), symbol, placement, color, style: newCompareStyle(color) };
    // A new pane goes below the existing ones: record the current order with
    // it last, so a study added later goes below it in turn.
    if (placement === "pane") {
      const order = (pane.paneOrder ?? []).filter((id) => id === MAIN_SOURCE_ID || pane.indicators.includes(id) || cur.some((c) => c.id === id));
      for (const id of pane.indicators) if (!order.includes(id)) order.push(id);
      for (const c of cur) if (c.placement === "pane" && !order.includes(c.id)) order.push(c.id);
      order.push(entry.id);
      patchTab(tabId, { panes: tabOf(tabId)!.panes.map((p, i) => (i === paneIndex ? { ...p, paneOrder: order } : p)) });
    }
    recordRecentSymbol("compare", symbol);
    changeCompare(tabId, paneIndex, [...cur, entry], translateWith("insert {0}", tickerOf(symbol)));
  }
  /** Watchlist row menu "Add … to compare": each symbol joins the focused
   *  pane on the % scale, in list order. */
  async function addCompareFromList(tickers: string[]) {
    for (const s of tickers) {
      try {
        addCompare(isFullSymbol(s) ? s.toUpperCase() : await toFullSymbol(s), "percent");
      } catch (e) {
        console.warn(`[symbol] ${s}: ${e}`);
      }
    }
  }
  function removeCompare(tabId: string, paneIndex: number, id: string) {
    const cur = tabOf(tabId)?.panes[paneIndex]?.compare ?? [];
    const gone = cur.find((c) => c.id === id);
    if (!gone) return;
    const pane = tabOf(tabId)!.panes[paneIndex];
    const kids = withDescendants(pane.indicators, pane.indicatorSettings, [id], getIndicatorEntry).filter((x) => x !== id);
    if (!kids.length) {
      changeCompare(tabId, paneIndex, cur.filter((c) => c.id !== id), translateWith("remove {0}", tickerOf(gone.symbol)));
      return;
    }
    // The studies built on it go with it, in one undo step (with the drawings they owned).
    const before = chartSources(pane);
    const left = cur.filter((c) => c.id !== id);
    const settings = { ...pane.indicatorSettings };
    for (const k of kids) delete settings[k];
    const after: ChartSources = { ...before, compare: left.length ? left : undefined, indicators: pane.indicators.filter((x) => !kids.includes(x)), indicatorSettings: settings };
    const key = d.drawingKeyFor(pane, tabId);
    const list = d.drawingsFor(key);
    const kept = list.filter((x) => !x.owner || !kids.includes(x.owner));
    const slices = kept.length !== list.length ? d.splitView(key, kept) : [];
    undo.commit({ kind: "layout-sources", tabId, before: { [paneIndex]: before }, after: { [paneIndex]: after }, slices, label: translateWith("remove {0}", tickerOf(gone.symbol)), at: Date.now() });
  }
  /** Legend eye / Settings → Ok on one compared symbol. */
  function patchCompare(tabId: string, paneIndex: number, id: string, patch: ComparePatch) {
    const cur = tabOf(tabId)?.panes[paneIndex]?.compare ?? [];
    if (!cur.some((c) => c.id === id)) return;
    setPaneCompare(tabId, paneIndex, cur.map((c) => (c.id === id ? { ...c, ...patch, hidden: patch.hidden ?? c.hidden } : c)));
  }
  /** Compared-symbol descriptions for the Compare dialog's added rows. */
  const [compareNames, setCompareNames] = createSignal<Record<string, string>>({});
  function compareAdded() {
    const list = activePaneState().compare ?? [];
    for (const c of list) {
      if (c.symbol in compareNames()) continue;
      setCompareNames((m) => ({ ...m, [c.symbol]: "" }));
      getTickerInfo(c.symbol).then((info) => setCompareNames((m) => ({ ...m, [c.symbol]: info?.name ?? "" }))).catch(() => {});
    }
    return list.map((c) => ({ id: c.id, symbol: c.symbol, description: compareNames()[c.symbol] || undefined }));
  }
  /** Recent symbols of the Compare dialog, with their descriptions. */
  function compareRecent() {
    const list = recentSymbols("compare");
    for (const s of list) {
      if (s in compareNames()) continue;
      setCompareNames((m) => ({ ...m, [s]: "" }));
      getTickerInfo(s).then((info) => setCompareNames((m) => ({ ...m, [s]: info?.name ?? "" }))).catch(() => {});
    }
    return list.map((s) => ({ symbol: s, description: compareNames()[s] || undefined }));
  }

  // ── Series pane, link group, series eye ────────────────────────────────
  /** The saved place of the main series (the group of the study pane it shares, null = a pane of its own), no undo
   *  step: the place the chart settles on (the study pane it shared is gone). Its moves are editSources steps. */
  function setSeriesPaneForPane(tabId: string, paneIndex: number, group: string | null) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) => {
        if (i !== paneIndex) return p;
        const { seriesPane: _old, ...rest } = p;
        return group ? { ...rest, seriesPane: group } : rest;
      }),
    });
  }
  /** Symbol / Interval syncing group of a chart of the layout. */
  function setPaneLinkGroup(tabId: string, paneIndex: number, g: PaneChart["linkGroup"]) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, { panes: tab.panes.map((p, k) => (k === paneIndex ? { ...p, linkGroup: g } : p)) });
  }
  /** Legend eye of the main series. */
  function toggleSeriesHidden(tabId: string, paneIndex: number) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, k) => (k === paneIndex ? { ...p, seriesHidden: p.seriesHidden ? undefined : true } : p)),
    });
  }

  /** Indicators legend toggler (collapse / expand the studies' rows). */
  function toggleIndicatorsLegend(tabId: string, paneIndex: number) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, k) => (k === paneIndex ? { ...p, indicatorsLegendCollapsed: p.indicatorsLegendCollapsed ? undefined : true } : p)),
    });
  }

  /** Apply one side of an undo entry. */
  function applyUndoEntry(e: UndoEntry, side: "before" | "after") {
    if (e.kind === "pane-fields") {
      const tab = tabOf(e.tabId);
      if (!tab) return;
      const snap = e[side];
      patchTab(e.tabId, { panes: tab.panes.map((p) => (snap[p.id] ? { ...p, ...snap[p.id] } : p)) });
      return;
    }
    if (e.kind === "replay-settings") {
      replayBroker.setSettings(e[side], e.paneId);
      return;
    }
    if (e.kind === "layout-sources") {
      const tab = tabOf(e.tabId);
      if (!tab) return;
      const snap = e[side];
      patchTab(e.tabId, { panes: tab.panes.map((p, i) => (snap[i] ? { ...p, ...snap[i] } : p)) });
      for (const sl of e.slices) d.restoreSlice(sl.key, sl[side]);
      return;
    }
    if (e.kind === "chart-swap") {
      const tab = tabOf(e.tabId);
      if (!tab || !tab.panes[e.a] || !tab.panes[e.b]) return;
      const panes = tab.panes.slice();
      [panes[e.a], panes[e.b]] = [panes[e.b], panes[e.a]];
      patchTab(e.tabId, { panes, activePane: side === "after" ? e.activeAfter : e.activeBefore });
      return;
    }
    if (e.kind === "layout-sizes") {
      setTabLayoutSizes(e.tabId, e.layout, e[side]);
      return;
    }
    if (e.kind === "compare") {
      setPaneCompare(e.tabId, e.paneIndex, e[side]);
      return;
    }
    if (e.kind === "study") {
      setPaneStudies(e, e.added ? side === "after" : side === "before");
      for (const sl of e.slices) d.restoreSlice(sl.key, sl[side]);
      return;
    }
    if (e.slices) {
      for (const sl of e.slices) d.restoreSlice(sl.key, sl[side]);
      return;
    }
    d.restoreSlice(e.key, e[side]);
  }

  return {
    removeIndicatorFromPane,
    setIndicatorSettingsForPane,
    editSources,
    rollbackSources,
    editStudySettings,
    patchStudyInputs,
    setVisibleRangeForPane,
    addIndicator,
    toggleScriptOnChart,
    removeAllIndicators,
    saveIndicatorTemplateNamed,
    applyIndicatorTemplate,
    changeLayoutSizes,
    addCompare,
    addCompareFromList,
    removeCompare,
    patchCompare,
    compareAdded,
    compareRecent,
    setSeriesPaneForPane,
    setPaneLinkGroup,
    toggleSeriesHidden,
    toggleIndicatorsLegend,
    applyUndoEntry,
  };
}

/** The chart edits App creates once. */
export type ChartEdits = ReturnType<typeof createChartEdits>;
