// Registers the saved-template default hook of the shared drawing core
// before any module reads tool defaults.
import "./window/drawings/templates";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { HeaderToolbar } from "./window/header/HeaderToolbar";
import { HeaderMenu } from "./window/header/HeaderMenu";
import { DownloadChartDataDialog } from "./window/header/DownloadChartDataDialog";
import { buildIntervalMenu } from "./window/chart/custom-intervals";
import { HEADER_MENUS } from "./window/header/header-menus/registry";
import { SymbolSearchDialog } from "./window/header/SymbolSearchDialog";
import { ChangeIntervalDialog } from "./window/chart/ChangeIntervalDialog";
import { IndicatorsDialog } from "./window/header/IndicatorsDialog";
import { ChartPropertiesDialog } from "./window/header/ChartPropertiesDialog";
import { appearanceFrom, cloneDraft, patchDraftScales, saveChartSettingsDefaults, seedDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, stdThemeOf, withStdTheme, type Draft, type ScaleMenuPatch, type StdTheme } from "./window/header/chart-settings";
import { activeChartProbe } from "./window/chart/active-chart";
import { TIMEZONES, findTimezone } from "./data/timezones";
import { ChartGrid } from "./window/chart/ChartGrid";
import { LAYOUT_NUMBERING, layoutFromVariantId, variantIdForLayout, type LayoutId } from "./window/chart/layouts";
import { DrawingToolbar, type SyncMode } from "./window/drawings/DrawingToolbar";
import { drawingPanelVisible } from "./data/drawing-panel";
import * as kv from "./data/kv";
import { FavoritesToolbar } from "./window/drawings/FavoritesToolbar";
import { TabPanel } from "./window/shell/TabPanel";
import { TabPanelActions } from "./window/shell/TabPanelActions";
import { WindowControls } from "./window/shell/WindowControls";
import {
  activePaneOf,
  fullSymbolFor,
  loadTabs,
  makeTab,
  newTabId,
  newPaneId,
  reconcilePanes,
  revivePaneSettings,
  saveTabs,
  linkedTabCountInOtherWindows,
  clampMoveIndex,
  insertPosition,
  newCompareId,
  reviveCompare,
  type CompareEntry,
  type ComparePlacement,
  type PaneChart,
  type PaneIndicatorSettings,
  type TabChart,
  reviveLayoutSizes,
} from "./window/shell/tabs";
import type { Sizing } from "./window/chart/layout-sizes";
import { COMPARE_COLORS, newCompareStyle, type CompareStyleState } from "./window/chart/compare/compare-style";
import { recentSymbols, recordRecentSymbol } from "./data/recent-symbols";
import { AppSettingsDialog, type AppSettingsTabId } from "./window/header/AppSettingsDialog";
import { AlertDialog } from "./window/alerts/AlertDialog";
import { startAlertEngine, onAlertFire } from "./data/alert-engine";
import { whenAlertLeader } from "./data/alert-backend";
import { AlertToasts, type AlertToastData } from "./window/alerts/AlertToast";
import { loadTabTitleParts, saveTabTitleParts, type TabTitlePartState } from "./window/shell/tab-title";
import { type LinkChannel, type LinkColor } from "./window/shell/tab-linking";
import { popClosed, pushClosed, reopenLabel } from "./window/shell/closed-stack";
import { findStripAt, initShellBus, reopenTabIn, screenToClient, sendTabTo } from "./window/shell/shell-bus";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { groupChannels, linkGroup, LINK_CHANNELS_DEFAULT, setGroupValue, setLinkGroup, toggleGroupChannel } from "./data/link-groups";
import {
  initLinkBus,
  onLinkChannelData,
  postIntervalLink,
  postSymbolLink,
  setActiveLink,
} from "./data/tab-link-bus";
import {
  closeCurrentWindow,
  markClosingAfterMove,
  reopenClosedWindow,
  currentWindowLabel,
  detachTabToWindow,
  initWindowStorageCleanup,
  isTauri,
  openNewWindow,
  takeDetachPayload,
  toggleFullscreen,
} from "./window/shell/window-bridge";
import { watchlistStore, requestOpenList } from "./data/watchlist-store";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import type { CursorMode } from "./data/drawing-toolbar";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import { labelForKind } from "./window/drawings/labels";
import { loadDrawings, saveDrawings } from "./window/drawings/persistence";
import { RightRail } from "./window/right-rail/RightRail";
import { BottomBar } from "./window/bottom-bar/BottomBar";
import { OakScriptPanel } from "./window/oakscript/OakScriptPanel";
import { StrategyTesterPanel } from "./window/strategy-tester/StrategyTesterPanel";
import { intervalSeconds } from "./window/strategy-tester/equity-data";
import { strategyTester } from "./data/strategy-tester-store";
import { PROPERTIES_INPUT, isStrategyId } from "./window/chart/indicators/strategy-entries";
import { ScreenerPanel } from "./window/screener/ScreenerPanel";
import { screenerPanel } from "./data/screener-store";
import { CHART_TYPE_IDS, type ChartTypeId } from "./window/chart/chart-types";
import { getTickerInfo, isAdjusted, setAdjusted, isFullSymbol, isIntradayInterval, isIntradayResolution, isSupportedResolution, tickerOf, toFullSymbol, type SessionId } from "./data/datafeed";
import { migrateDrawingKey } from "./window/drawings/persistence";
import { displayTimeZone } from "./data/session";
import { requestDataWindow } from "./data/data-window-store";
import { bindLayoutSync, defaultLayoutSync, rememberCrosshair, reviveLayoutSync, type LayoutSyncKey } from "./window/chart/layout-sync";
import { LayoutNameDialog } from "./window/header/LayoutNameDialog";
import { DialogHost, showConfirm, showRename } from "./components/Dialogs";
import { alertStore } from "./data/alert-store";
import { ruleDrawingIds } from "./data/alert-condition";
import { chartTemplateDraft, chartTemplates, removeChartTemplate, saveChartTemplate } from "./window/header/chart-templates";
import { getIndicatorEntry } from "./window/chart/indicators/registry";
import { loadIndicatorDefault } from "./data/indicator-defaults";
import { defaultIndicatorOptions } from "./window/chart/indicators/indicator-options";
import { UnsavedLayoutDialog } from "./window/header/UnsavedLayoutDialog";
import { LayoutBrowserDialog } from "./window/header/LayoutBrowserDialog";
import { buildFavoriteIndicatorsMenu } from "./data/indicator-favorites";
import { newStudyId, typeIdOf } from "./window/chart/indicators/study-id";
import { overOf, type PlacedDrawing } from "./window/chart/tree-order";
import {
  APPLY_TEMPLATE_PREFIX,
  buildIndicatorTemplatesMenu,
  getIndicatorTemplate,
  SAVE_TEMPLATE_ROW_ID,
  saveIndicatorTemplate,
  touchIndicatorTemplate,
} from "./data/indicator-template-store";
import {
  buildSaveLoadMenu,
  createLayout,
  getLayout,
  isUnnamedLayout,
  layoutAutosave,
  OPEN_LAYOUT_PREFIX,
  toggleFavoriteLayout,
  removeLayout,
  renameLayout,
  savedLayouts,
  setLayoutAutosave,
  snapshotsEqual,
  updateLayoutSnapshot,
  type LayoutSnapshot,
  type SavedLayout,
} from "./data/layout-store";

function App() {
  // Seeded from the App-Settings theme picker's kv key; the picker itself
  // swaps the <html> class live, so changes are observed off that class (see
  // the MutationObserver in onMount) rather than via a second channel.
  const loadTheme = (): "dark" | "light" => {
    try { return kv.getItem("ot:theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
  };
  const [theme, setThemeSignal] = createSignal<"dark" | "light">(loadTheme());
  // Set before the charts are created: a pane with no stored settings reads
  // its default colours from this class.
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add(`theme-${theme()}`);

  // ── Multi-tab shell ───────────────────────────────────────────────────
  // Each tab is an independent chart (symbol/interval/chartType/layout/
  // indicators). The active tab's fields back the accessor/setter pairs below,
  // so the rest of App reads `symbol()`/`interval()`/… exactly as before — the
  // per-chart state just lives inside the active tab instead of free signals.
  // Per-window: detached windows scope their own tab storage by window label
  // and open seeded from the handoff payload the detach left behind.
  const windowLabel = currentWindowLabel();
  const initial = loadTabs(windowLabel, takeDetachPayload(windowLabel));
  const [tabs, setTabs] = createSignal<TabChart[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = createSignal<string>(initial.activeId);
  const activeTab = () => tabs().find((t) => t.id === activeTabId()) ?? tabs()[0];
  createEffect(() => saveTabs(windowLabel, tabs(), activeTabId()));
  // Tabs whose chart grid is mounted. A tab mounts the first time it is shown
  // and then stays mounted while hidden (every tab page stays alive and a
  // background tab loads on its first display), so a later switch only
  // shows it. Closed tabs drop out.
  const [mountedTabs, setMountedTabs] = createSignal<Set<string>>(new Set([initial.activeId]));
  createEffect(() => {
    const id = activeTabId();
    const ids = new Set(tabs().map((t) => t.id));
    const cur = untrack(mountedTabs);
    if (cur.has(id) && [...cur].every((x) => ids.has(x))) return;
    setMountedTabs(new Set([...cur].filter((x) => ids.has(x)).concat(id)));
  });
  const tabById = createMemo(() => new Map(tabs().map((t) => [t.id, t] as const)));
  const gridTabIds = createMemo(() => tabs().map((t) => t.id).filter((id) => mountedTabs().has(id)));

  // Reap localStorage for closed detached/new windows: non-main windows clear
  // themselves on close; the main window sweeps orphans at launch.
  let disposeStorageCleanup = () => {};
  onMount(() => {
    void initWindowStorageCleanup(windowLabel).then((d) => {
      disposeStorageCleanup = d;
    });
  });
  onCleanup(() => disposeStorageCleanup());

  // Tab-title parts (App Settings → Tabs) + the App Settings modal. `null` =
  // closed; otherwise the tab to open on.
  const [tabTitleParts, setTabTitlePartsRaw] = createSignal<TabTitlePartState[]>(loadTabTitleParts());
  const setTabTitleParts = (p: TabTitlePartState[]) => { setTabTitlePartsRaw(p); saveTabTitleParts(p); };
  const [appSettingsTab, setAppSettingsTab] = createSignal<AppSettingsTabId | null>(null);

  /** Patch one tab's (tab-level) state. */
  function patchTab(id: string, patch: Partial<TabChart>) {
    setTabs(tabs().map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  /** Patch the active tab's (tab-level) state. */
  function patchActive(patch: Partial<TabChart>) {
    patchTab(activeTabId(), patch);
  }

  /** Patch the active pane of the active tab. */
  function patchActivePane(patch: Partial<PaneChart>) {
    const tab = activeTab();
    const i = tab.activePane;
    patchActive({ panes: tab.panes.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });
  }

  /** Patch EVERY pane of the active tab (used by Sync-in-layout broadcasts). */
  function patchAllPanes(patch: Partial<PaneChart>) {
    const tab = activeTab();
    patchActive({ panes: tab.panes.map((p) => ({ ...p, ...patch })) });
  }
  /** Symbol / Interval sync in layout: the focused chart and the charts of
   *  its syncing group (no group = the charts without one). */
  function patchSyncGroupPanes(patch: Partial<PaneChart>) {
    const tab = activeTab();
    const g = tab.panes[tab.activePane]?.linkGroup;
    patchActive({ panes: tab.panes.map((p, i) => (i === tab.activePane || p.linkGroup === g ? { ...p, ...patch } : p)) });
  }

  // ── App theme and chart theme ──────────────────────────────────────────
  // The chart colours are chart settings. A chart that still uses a standard
  // theme's values follows the app theme; one with custom colours keeps them
  // unless the user agrees to switch it too.
  function applyUiTheme(t: StdTheme) {
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add(`theme-${t}`);
    kv.setItem("ot:theme", t);
  }
  const usesStdTheme = (tab: TabChart) => tab.panes.every((p) => stdThemeOf(p.settings) !== null);
  /** Re-colour every pane of a tab with the standard theme `t`. */
  function applyChartTheme(tabId: string, t: StdTheme) {
    const tab = tabs().find((x) => x.id === tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p) =>
        p.settings && stdThemeOf(p.settings) !== t
          ? { ...p, settings: withStdTheme(p.settings, t), settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV }
          : p),
    });
  }
  /** App Settings theme picker. Charts of the shown layout that use a
   *  standard theme switch with it (effect below); custom colours ask first. */
  function switchTheme(next: StdTheme) {
    if (usesStdTheme(activeTab())) { applyUiTheme(next); return; }
    const tabId = activeTabId();
    showConfirm({
      title: "Theme",
      text: `The interface is switching to the ${next === "light" ? "Light" : "Dark"} theme. Switch the chart theme too?`,
      onConfirm: () => { applyUiTheme(next); applyChartTheme(tabId, next); },
      onCancel: () => applyUiTheme(next),
    });
  }
  // A shown layout whose charts all use a standard theme takes the app theme
  // (app start, tab switch, theme switch, new panes).
  const activePaneSettings = createMemo(() => activeTab().panes.map((p) => p.settings), undefined, {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  createEffect(() => {
    const t = theme();
    activePaneSettings();
    const tab = untrack(activeTab);
    if (!usesStdTheme(tab)) return;
    if (tab.panes.some((p) => p.settings && stdThemeOf(p.settings) !== t)) untrack(() => applyChartTheme(tab.id, t));
  });

  // Active-pane-backed accessors. Each multi-chart layout cell is its own
  // independent chart; the header / right-rail / drawing tools act on the
  // FOCUSED pane (`activePane`), so these read/write that pane. `layout` and
  // pane-focus stay tab-level.
  const activePaneState = () => activePaneOf(activeTab());
  const interval = () => activePaneState().interval;
  // ── Sync in layout (per tab, saved per layout) ─────────────────────────
  const layoutSync = () => activeTab().sync;
  const toggleLayoutSync = (key: LayoutSyncKey) => {
    const next = { ...layoutSync(), [key]: !layoutSync()[key] };
    patchActive({ sync: next });
    // Symbol / Interval sync turned on: every syncing group takes the value
    // of its focused chart, else of its first chart.
    if ((key === "symbol" || key === "interval") && next[key]) {
      const tab = activeTab();
      const ref = new Map<number | undefined, string>();
      const active = tab.panes[tab.activePane];
      if (active) ref.set(active.linkGroup, active[key]);
      for (const p of tab.panes) if (!ref.has(p.linkGroup)) ref.set(p.linkGroup, p[key]);
      patchActive({ panes: tab.panes.map((p) => (p[key] === ref.get(p.linkGroup) ? p : { ...p, [key]: ref.get(p.linkGroup) })) });
    }
    if (key === "crosshair") rememberCrosshair(next.crosshair);
  };
  bindLayoutSync(layoutSync, toggleLayoutSync);

  // ── Tab syncing (colour link) ──────────────────────────────────────────
  // A linked value lands on the tab's ACTIVE pane, and the tab's own layout
  // Symbol / Interval sync then spreads it.
  function withLinkedValue(t: TabChart, field: "symbol" | "interval", value: string): TabChart {
    const spread = t.sync[field];
    return {
      ...t,
      // The tab's layout sync spreads it within the focused chart's group.
      panes: t.panes.map((p, idx) => (idx === t.activePane || (spread && p.linkGroup === t.panes[t.activePane]?.linkGroup) ? { ...p, [field]: value } : p)),
    };
  }
  // Mirror a value onto every tab in THIS window linked to `color` (optionally
  // skipping the source tab). The sender checked the group's channel.
  function applyLinkChannel(color: LinkColor, field: "symbol" | "interval", value: string, exceptId?: string) {
    setTabs(
      tabs().map((t) => (t.id === exceptId || t.link?.color !== color ? t : withLinkedValue(t, field, value))),
    );
  }
  // Propagate a focused-tab change to linked tabs (this window's others + every
  // other window via the bus), and record it as the group value.
  function broadcastLink(field: "symbol" | "interval", value: string) {
    const link = activeTab().link;
    if (!link || !groupChannels(link.color)[field]) return;
    setGroupValue(link.color, field, value);
    applyLinkChannel(link.color, field, value, activeTabId());
    if (field === "symbol") postSymbolLink(link.color, value);
    else postIntervalLink(link.color, value);
  }

  // Symbol / interval honour the Sync-in-layout toggles: when on, the change
  // mirrors to every pane of the layout instead of just the focused one. Either
  // way the change then propagates to colour-linked tabs.
  const setInterval = (v: string) => {
    // Source-level gate: ignore intervals the datafeed can't serve (ticks,
    // ranges, too large a multiplier). The picker greys these out and
    // getBars rejects them too; this stops the remaining paths — keyboard
    // digit-entry, a stale persisted favourite — from ever applying an
    // unservable id.
    if (!isSupportedResolution(v)) return;
    if (layoutSync().interval) patchSyncGroupPanes({ interval: v });
    else patchActivePane({ interval: v });
    broadcastLink("interval", v);
  };
  const symbol = () => activePaneState().symbol;
  const setSymbol = (v: string) => {
    // Authoritative selection timestamp for the perf logs — every path (mouse
    // click, keyboard ↓/Space, symbol search, link-sync) funnels through here,
    // unlike the watchlist row click handler.
    const w = window as unknown as { __clickT?: number; __clickSym?: string };
    w.__clickT = performance.now();
    w.__clickSym = v;
    console.log(`[select] ${v} @ ${w.__clickT.toFixed(0)}ms`);
    if (layoutSync().symbol) patchSyncGroupPanes({ symbol: v });
    else patchActivePane({ symbol: v });
    broadcastLink("symbol", v);
  };

  // Link tag mutators (driven by the tab right-click → Tab syncing widget).
  // Linker join: a tab joining a group with members takes the group values;
  // joining an empty group starts it (Symbol channel only) with the tab's values.
  const linkTab = (id: string, color: LinkColor) => {
    const tab = tabs().find((t) => t.id === id);
    if (!tab) return;
    const members =
      tabs().filter((t) => t.id !== id && t.link?.color === color).length +
      linkedTabCountInOtherWindows(color, windowLabel);
    const group = linkGroup(color);
    let next: TabChart = { ...tab, link: { color } };
    if (members === 0 || !group) {
      const pane = activePaneOf(tab);
      setLinkGroup(color, { channels: { ...LINK_CHANNELS_DEFAULT }, symbol: pane.symbol, interval: pane.interval });
    } else {
      if (group.channels.symbol && group.symbol) next = withLinkedValue(next, "symbol", group.symbol);
      if (group.channels.interval && group.interval && isSupportedResolution(group.interval))
        next = withLinkedValue(next, "interval", group.interval);
    }
    setTabs(tabs().map((t) => (t.id === id ? next : t)));
  };
  const unlinkTab = (id: string) =>
    setTabs(tabs().map((t) => (t.id === id ? { ...t, link: undefined } : t)));
  // Channels belong to the colour's group, shared by every member tab.
  const toggleLinkChannel = (id: string, channel: LinkChannel) => {
    const color = tabs().find((t) => t.id === id)?.link?.color;
    if (color) toggleGroupChannel(color, channel);
  };

  // Keep the bus aware of the focused tab's link and its group channels, and
  // apply inbound symbol/interval syncs from other windows.
  createEffect(() => {
    const link = activeTab().link;
    setActiveLink(link ? { color: link.color, channels: groupChannels(link.color) } : null);
  });
  onMount(() => {
    const disposeBus = initLinkBus({
      tabs: () => tabs().map((t) => ({ id: t.id, color: t.link?.color })),
      activeId: activeTabId,
    });
    const unsub = onLinkChannelData((m) => applyLinkChannel(m.color, m.kind, m.value));
    onCleanup(() => {
      disposeBus();
      unsub();
    });
  });
  const chartType = () => activePaneState().chartType;
  const setChartType = (v: ChartTypeId) => patchActivePane({ chartType: v });
  // Bottom-bar RTH/ETH session — per focused pane (not a layout-sync
  // channel), so it only ever patches the active pane.
  const session = () => activePaneState().session;
  const setSession = (v: SessionId) => patchActivePane({ session: v });
  const layout = () => activeTab().layout;
  // Switching layout grows/shrinks the pane set to the template's cell count.
  const setLayout = (v: LayoutId) => patchActive(reconcilePanes(activeTab(), v));

  // ── Saved chart layouts ("Manage layouts" header dropdown) ───────────────
  // A saved layout snapshots the active tab's chart config (template + every
  // pane). The tab tracks which saved layout it shows (savedLayoutId) so the
  // header badge can name it and flag unsaved edits. See data/layout-store.ts.
  const snapshotActive = (): LayoutSnapshot => {
    const t = activeTab();
    // Capture each unique pane scope key's drawings so the layout carries them.
    // Reading drawingsFor here keeps the dirty check reactive to drawing edits.
    const drawings: Record<string, Drawing[]> = {};
    for (const p of t.panes) {
      for (const key of scopeKeys(drawingKeyFor(p))) {
        if (!(key in drawings)) drawings[key] = drawingsFor(key);
      }
    }
    return { layout: t.layout, activePane: t.activePane, panes: t.panes, drawings, sync: t.sync, layoutSizes: t.layoutSizes, numbering: LAYOUT_NUMBERING };
  };
  const activeSaved = () => {
    const id = activeTab().savedLayoutId;
    return id ? getLayout(id) : undefined;
  };
  // Dirty = no saved layout yet, or the live snapshot differs from the saved one.
  const layoutDirty = () => {
    const saved = activeSaved();
    return saved ? !snapshotsEqual(snapshotActive(), saved.snapshot) : true;
  };
  const layoutName = () => activeTab().savedLayoutName ?? "Unnamed";
  // "SYMBOL, INTERVAL" of a saved layout's focused pane (the recent-list suffix).
  const summaryOfLayout = (l: SavedLayout) => {
    const p = l.snapshot.panes[l.snapshot.activePane] ?? l.snapshot.panes[0];
    return p ? `${p.symbol}, ${p.interval}` : "";
  };

  // Naming-dialog state: null = closed. `mode` selects the submit behaviour.
  const [layoutNameDialog, setLayoutNameDialog] =
    createSignal<null | { mode: "save" | "rename" | "copy" | "create"; initial: string; persist?: boolean }>(null);
  // "Create layout" dialog: its "Open in new tab" box is remembered (default on).
  const CREATE_NEW_TAB_KEY = "ot:create-layout-new-tab";
  const [createInNewTab, setCreateInNewTab] = createSignal(kv.getItem(CREATE_NEW_TAB_KEY) !== "false");
  // "Open layout" browser modal (lists every saved layout; load / delete).
  const [layoutBrowserOpen, setLayoutBrowserOpen] = createSignal(false);
  // Manage layouts → "Download chart data…" (CSV export dialog).
  const [downloadDataOpen, setDownloadDataOpen] = createSignal(false);

  // Delete a saved layout; if it's the one the active tab shows, detach the tab
  // (the badge falls back to "Untitled").
  function deleteSavedLayout(id: string) {
    removeLayout(id);
    if (activeTab().savedLayoutId === id) {
      patchActive({ savedLayoutId: undefined, savedLayoutName: undefined });
    }
  }

  // Persist the active snapshot into its saved layout; untitled charts open the
  // name dialog first (Save As), otherwise overwrite in place. Returns true
  // when saved at once, false when a name dialog was opened.
  function saveActiveLayout(): boolean {
    const t = activeTab();
    const saved = t.savedLayoutId ? getLayout(t.savedLayoutId) : undefined;
    // A named layout overwrites in place silently; a still-"Unnamed" (or unsaved)
    // one prompts for a real name first — an Unnamed is never saved silently.
    if (saved && !isUnnamedLayout(saved.name)) {
      updateLayoutSnapshot(saved.id, snapshotActive());
      return true;
    } else if (saved) {
      // Existing but still "Unnamed" → the rename popup (persist the snapshot on
      // submit), not the "Save new chart layout" dialog.
      setLayoutNameDialog({ mode: "rename", initial: "", persist: true });
    } else {
      setLayoutNameDialog({ mode: "save", initial: "" });
    }
    return false;
  }
  // Create a fresh saved layout from the current snapshot (Save As / Make a
  // copy) and point the active tab at it.
  function saveActiveLayoutAs(name: string) {
    const created = createLayout(name, snapshotActive());
    patchActive({ savedLayoutId: created.id, savedLayoutName: created.name });
  }
  // Switching layouts with unsaved changes asks first ("Save layout before
  // switching?"). `pendingOpenId` = the layout waiting on
  // that answer; `openAfterNaming` = the one to open once a Save that needed a
  // name dialog is submitted (cleared if that dialog is cancelled).
  const [pendingOpenId, setPendingOpenId] = createSignal<string | null>(null);
  let openAfterNaming: string | null = null;
  function requestOpenLayout(id: string) {
    if (!getLayout(id)) return;
    if (layoutDirty()) setPendingOpenId(id);
    else openSavedLayout(id);
  }
  function resolvePendingOpen(choice: "save" | "dontSave" | "cancel") {
    const id = pendingOpenId();
    setPendingOpenId(null);
    if (!id || choice === "cancel") return;
    if (choice === "dontSave") {
      openSavedLayout(id);
      return;
    }
    if (saveActiveLayout()) openSavedLayout(id);
    else openAfterNaming = id;
  }
  // Load a saved layout's snapshot into the active tab, restoring its captured
  // drawings into the live per-symbol store. NOTE: drawings are symbol-keyed
  // globally, so this overwrites those symbols' drawings everywhere (any other
  // tab/pane on the same symbol) — the cost of layout-scoped drawings on top of
  // the symbol-keyed model. See data/layout-store.ts.
  function openSavedLayout(id: string) {
    const l = getLayout(id);
    if (!l) return;
    patchActive({
      layout: l.snapshot.layout,
      panes: l.snapshot.panes.map((p) => ({ ...p, id: p.id ?? newPaneId(), indicators: [...p.indicators], compare: reviveCompare(p.compare), ...revivePaneSettings(p) })),
      activePane: Math.min(l.snapshot.activePane, l.snapshot.panes.length - 1),
      // Layouts saved before per-tab sync keep the tab's current toggles.
      sync: l.snapshot.sync ? reviveLayoutSync(l.snapshot.sync) : activeTab().sync,
      layoutSizes: reviveLayoutSizes(l.snapshot.layoutSizes),
      savedLayoutId: l.id,
      savedLayoutName: l.name,
    });
    const dmap = l.snapshot.drawings;
    if (dmap) {
      for (const [sym, list] of Object.entries(dmap)) {
        // Clone so later edits never mutate the stored snapshot's arrays.
        setSlice(sym, JSON.parse(JSON.stringify(list)) as Drawing[], null);
      }
    }
  }
  // "Create new layout…" (the "Create layout" dialog): a default single-pane
  // chart on the first chart's symbol and interval, saved under `name`, in a
  // new tab or in the active one.
  function createNewLayoutNamed(name: string, inNewTab: boolean) {
    const first = activeTab().panes[0];
    const fresh = makeTab({ symbol: first?.symbol, interval: first?.interval });
    if (inNewTab) {
      setTabs([...tabs(), fresh]);
      activateTab(fresh.id);
    }
    patchActive({
      layout: fresh.layout,
      panes: fresh.panes,
      activePane: 0,
      sync: defaultLayoutSync(),
      layoutSizes: undefined,
      savedLayoutId: undefined,
      savedLayoutName: undefined,
    });
    const created = createLayout(name, snapshotActive());
    patchActive({ savedLayoutId: created.id, savedLayoutName: created.name });
  }
  function submitLayoutName(name: string) {
    const dlg = layoutNameDialog();
    if (!dlg) return;
    if (dlg.mode === "create") {
      kv.setItem(CREATE_NEW_TAB_KEY, String(createInNewTab()));
      createNewLayoutNamed(name, createInNewTab());
      return;
    }
    if (dlg.mode === "rename") {
      const id = activeTab().savedLayoutId;
      if (id) {
        renameLayout(id, name);
        // Saving an Unnamed layout reuses this popup with `persist`, so also
        // commit the current snapshot (a plain rename leaves it untouched).
        if (dlg.persist) updateLayoutSnapshot(id, snapshotActive());
        patchActive({ savedLayoutName: name });
      } else {
        saveActiveLayoutAs(name);
      }
    } else {
      // "save" (Save As) and "copy" create a new named layout from the snapshot.
      saveActiveLayoutAs(name);
    }
    if (openAfterNaming) {
      const id = openAfterNaming;
      openAfterNaming = null;
      openSavedLayout(id);
    }
  }
  // Autosave: when on, persist a NAMED layout whenever it goes dirty. Never
  // silently creates a layout for an untitled chart.
  createEffect(() => {
    if (!layoutAutosave()) return;
    const t = activeTab();
    if (!t.savedLayoutId) return;
    if (layoutDirty()) updateLayoutSnapshot(t.savedLayoutId, snapshotActive());
  });
  // Focus a pane (clicking / interacting with a cell). Guarded so acting
  // within the already-focused pane doesn't rewrite + persist the tab on every
  // click. Selection clearing is handled by the symbol-change effect below.
  const setActivePaneIndex = (i: number) => {
    if (activeTab().activePane !== i) patchActive({ activePane: i });
  };
  // "Maximize chart": enlarge the focused pane over the rest of the layout
  // (bottom-bar layoutFullscreen / Alt+Enter). App-level toggle, reset whenever
  // the layout or active tab changes so we never stay maximized on a different
  // pane set than the one that was enlarged.
  const [maximized, setMaximized] = createSignal(false);
  // `layout()` reads through activeTab() → tabs(), so tracking it directly made
  // this effect re-run on EVERY tab patch — focusing a pane, persisting a scroll
  // anchor, switching symbol — each one silently un-maximizing. Memoise so it
  // fires only when the layout id or the tab actually changes, which is what the
  // comment above always intended.
  const maximizeScope = createMemo(() => `${activeTabId()}:${layout()}`);
  createEffect(() => {
    maximizeScope();
    setMaximized(false);
  });
  const toggleMaximize = () => setMaximized((m) => !m);
  const [openMenu, setOpenMenu] = createSignal<string | null>(null);
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  const [symbolDialogOpen, setSymbolDialogOpen] = createSignal(false);
  // Compare-mode flag rides the dialog; any close resets it (see effect below).
  // When the dialog is opened by typing a character (rather than clicking the
  // symbol pill), the query is seeded with that character. `null` = clicked open.
  const [symbolSearchSeed, setSymbolSearchSeed] = createSignal<string | null>(null);
  // "Change interval" dialog (digit keys, legend interval click).
  const [intervalDialog, setIntervalDialog] = createSignal<{ initVal: string; selectOnInit: boolean } | null>(null);
  const [indicatorsDialogOpen, setIndicatorsDialogOpen] = createSignal(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
  /** The active chart's Chart Settings as a draft (the Settings dialog seed). */
  function activeSettingsDraft() {
    return seedDraft(activePaneState().settings, {
      timezone: timezone().label,
      adjusted: isAdjusted(),
      session: session(),
      scaleRatio: activeChartProbe()?.scaleRatio(),
    });
  }
  /** Commit Chart Settings to the active chart or every chart (Settings
   *  dialog Ok / Apply to all, chart template applied from the chart menu). */
  function commitChartSettings(draft: Draft, scope: "active" | "all") {
    // Symbol → Timezone drives the app-wide display timezone (one
    // axis timezone for the whole app, same signal as the bottom bar).
    const appearance = appearanceFrom(draft);
    const tzLabel = appearance.timezone;
    if (tzLabel && tzLabel !== timezone().label) {
      const tz = findTimezone(tzLabel);
      if (tz) setTimezone({ label: tz.label, iana: tz.iana });
    }
    // Symbol → "Adjust data for dividends" is the SAME app-wide flag
    // as the bottom-bar ADJ toggle — one feature,
    // two surfaces. Apply + refetch + let the button re-read.
    if (appearance.adjustDividends !== undefined && appearance.adjustDividends !== isAdjusted()) {
      setAdjusted(appearance.adjustDividends);
      window.dispatchEvent(new CustomEvent("chart-reload-data"));
      window.dispatchEvent(new CustomEvent("adjusted-changed"));
    }
    // Symbol → Session is the pane's RTH/ETH session (same state as
    // the bottom-bar session menu).
    const ses = appearance.session === "Extended" ? "ETH" : "RTH";
    if (ses !== session()) setSession(ses);
    (scope === "all" ? patchAllPanes : patchActivePane)({
      settings: cloneDraft(draft),
      settingsFp: SETTINGS_FINGERPRINT,
      settingsRev: SETTINGS_REV,
    });
    // Chart settings edits are saved as the defaults of new charts.
    saveChartSettingsDefaults(draft);
  }
  // Tab the Settings dialog opens on (axis menus → "More settings…" = Scales).
  const [settingsDialogTab, setSettingsDialogTab] = createSignal<string | undefined>();
  // Create/Edit-alert modal: null = closed; object carries the prefill (symbol +
  // clicked price for new, or editId to edit an existing rule).
  const [alertDialog, setAlertDialog] = createSignal<
    null | { editId?: string; symbol?: string; price?: number; indicatorId?: string; drawingId?: string }
  >(null);
  // Popups of the alerts that fired (in addition to the log + sound), oldest first.
  const [alertToasts, setAlertToasts] = createSignal<AlertToastData[]>([]);
  // Chart display timezone (bottom-bar TimezoneMenu), persisted. Default to the
  // "Exchange" zone: each chart shows its symbol's exchange zone (see
  // displayTimeZone); the stored IANA name is the fallback until the symbol's
  // session resolves.
  const TZ_KEY = "ot:timezone";
  const loadTz = (): { label: string; iana: string } => {
    try {
      const raw = kv.getItem(TZ_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { label: "Exchange", iana: "America/New_York" };
  };
  const [timezone, setTimezone] = createSignal(loadTz());
  createEffect(() => {
    kv.setItem(TZ_KEY, JSON.stringify(timezone()));
  });
  // Live cross-window sync (the persist effect above re-writes the same value,
  // which kv.setItem dedups to a no-op).
  onCleanup(kv.onExternalChange(TZ_KEY, () => setTimezone(loadTz())));

  // Active indicators on the chart — an ordered list of library registry ids
  // (see window/chart/indicators/registry.ts). Per-PANE now (each chart cell
  // carries its own studies). Removals go through removeStudies (one undo
  // step with the drawings the studies own).
  const indicators = () => activePaneState().indicators;
  // The per-pane callbacks below name their tab: every opened tab keeps its
  // grid mounted, so a pane writes into its own tab, shown or not.
  const tabOf = (tabId: string) => tabs().find((t) => t.id === tabId);
  /** Remove a study from a SPECIFIC pane (the per-pane legend's trash). */
  function removeIndicatorFromPane(tabId: string, paneIndex: number, id: string) {
    removeStudies(tabId, paneIndex, [id]);
  }
  /** Reorder a SPECIFIC pane's studies (pane controls: move pane up / down —
   *  stacked panes are allocated in list order). */
  function reorderIndicatorsForPane(tabId: string, paneIndex: number, ids: string[]) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) => (i === paneIndex ? { ...p, indicators: ids } : p)),
    });
  }
  /** Persist a study's edited inputs/styles onto a SPECIFIC pane (the per-pane
   *  Settings dialog → Ok). Stored under `indicatorSettings[id]`; the saveTabs
   *  effect persists it and `snapshotActive` carries it into saved layouts. */
  function setIndicatorSettingsForPane(tabId: string, paneIndex: number, id: string, settings: PaneIndicatorSettings) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) =>
        i === paneIndex ? { ...p, indicatorSettings: { ...p.indicatorSettings, [id]: { ...p.indicatorSettings?.[id], ...settings } } } : p,
      ),
    });
  }
  /** Persist a pane's settled scroll/zoom anchor (its visible logical range).
   *  The saveTabs effect then writes it to localStorage, so the view survives tab
   *  switches and full reloads (ChartView restores it on data load). No-op when
   *  the range is unchanged, so it doesn't churn the tabs signal on every
   *  programmatic re-frame that reports the same window. */
  function setVisibleRangeForPane(tabId: string, paneIndex: number, range: { from: number; to: number; last?: number }) {
    const tab = tabOf(tabId);
    if (!tab) return;
    const cur = tab.panes[paneIndex]?.visibleLogicalRange;
    if (cur && cur.from === range.from && cur.to === range.to && cur.last === range.last) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) => (i === paneIndex ? { ...p, visibleLogicalRange: range } : p)),
    });
  }
  const [armedTool, setArmedTool] = createSignal<string | null>(null);
  // Chart interaction mode set by the Cursor group (cross / dot / arrow /
  // eraser / demonstration). Shared with the chart host + overlay.
  const [cursorMode, setCursorMode] = createSignal<CursorMode>("cross");
  // Glyph staged by the FontIconPicker, consumed when a `font-icon` is placed.
  const [armedGlyph, setArmedGlyph] = createSignal<string>("");
  // Drawing-sync scope (drawingSyncMode button), App-owned + persisted so
  // the toolbar dropdown and the store key agree. Default "global" = the
  // out-of-box behaviour. Live cross-window sync of the choice itself.
  const [syncMode, setSyncModeRaw] = createSignal<SyncMode>(
    ((): SyncMode => {
      const v = kv.getItem("ot:drawing-sync");
      return v === "none" || v === "layout" || v === "global" ? v : "global";
    })(),
  );
  const setSyncMode = (m: SyncMode) => {
    setSyncModeRaw(m);
    kv.setItem("ot:drawing-sync", m);
  };
  onCleanup(kv.onExternalChange("ot:drawing-sync", () => {
    const v = kv.getItem("ot:drawing-sync");
    if (v === "none" || v === "layout" || v === "global") setSyncModeRaw(v);
  }));

  // Drawings are keyed by a SCOPE KEY derived from the sync mode, so the same
  // drawing can be shared at three scopes:
  //   none   → per pane   (`p:<paneId>:<symbol>`) — independent even same-symbol
  //   layout → per layout (`l:<tabId>:<symbol>`)  — shared across the tab's panes
  //   global → per symbol (`<symbol>`)            — shared across tabs + windows
  // The sync scope belongs to each drawing (the reference app keeps a sync
  // mode per drawing): a chart shows its pane-only, layout and global
  // drawings together, and the sync mode only picks the scope of NEW
  // drawings. A chart is addressed by a VIEW key (drawingKeyFor) that maps to
  // its three scope keys; reads concatenate them and writes put each drawing
  // back in the scope it lives in (a new one in the current mode's scope).
  // The store is a reactive scope key→list map; `drawings()` is the FOCUSED
  // pane's view; `drawingsFor(key)` gives any pane its own view. Two panes
  // sharing a scope key share those drawings.
  const VIEW_SEP = "\u001f";
  const drawingKeyFor = (pane: PaneChart, tabId: string = activeTab().id): string =>
    ["v", pane.id, tabId, pane.symbol].join(VIEW_SEP);
  const isViewKey = (key: string) => key.startsWith(`v${VIEW_SEP}`);
  /** The scope keys of a view key: pane only, layout, global. */
  const scopeKeys = (view: string): string[] => {
    const [, paneId, tabId, symbol] = view.split(VIEW_SEP);
    return [`p:${paneId}:${symbol}`, `l:${tabId}:${symbol}`, symbol];
  };
  /** The scope key new drawings of a view go to (the sync mode). */
  const modeScopeKey = (view: string): string => {
    const [p, l, g] = scopeKeys(view);
    return syncMode() === "none" ? p : syncMode() === "layout" ? l : g;
  };
  const activeDrawingKey = () => drawingKeyFor(activePaneState());

  // Symbols saved as bare tickers (before panes kept "EXCHANGE:TICKER") get
  // their primary listing once, in every tab (incl. compare lists); their
  // drawings move to the full-name keys first so nothing is lost.
  createEffect(() => {
    const bare = new Set<string>();
    for (const t of tabs()) {
      for (const p of t.panes) {
        if (p.symbol && !isFullSymbol(p.symbol)) bare.add(p.symbol);
        for (const c of p.compare ?? []) if (!isFullSymbol(c.symbol)) bare.add(c.symbol);
      }
    }
    if (bare.size === 0) return;
    void Promise.allSettled([...bare].map(async (b) => [b, await toFullSymbol(b)] as const)).then((rs) => {
      const full = new Map(rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
      if (full.size === 0) return;
      const fix = (s: string) => full.get(s) ?? s;
      for (const t of tabs()) {
        for (const p of t.panes) {
          const to = full.get(p.symbol);
          if (!to) continue;
          migrateDrawingKey(p.symbol, to);
          migrateDrawingKey(`l:${t.id}:${p.symbol}`, `l:${t.id}:${to}`);
          migrateDrawingKey(`p:${p.id}:${p.symbol}`, `p:${p.id}:${to}`);
        }
      }
      setTabs(
        tabs().map((t) =>
          t.panes.some((p) => full.has(p.symbol) || p.compare?.some((c) => full.has(c.symbol)))
            ? { ...t, panes: t.panes.map((p) => ({ ...p, symbol: fix(p.symbol), compare: p.compare?.map((c) => ({ ...c, symbol: fix(c.symbol) })) })) }
            : t,
        ),
      );
    });
  });
  const [drawingStore, setDrawingStore] = createStore<Record<string, Drawing[]>>(
    Object.fromEntries(scopeKeys(activeDrawingKey()).map((k) => [k, loadDrawings(k)])),
  );
  /** A scope key's drawings, or a view's drawings (global, layout, then
   *  pane-only ones). */
  const drawingsFor = (key: string): Drawing[] =>
    isViewKey(key) ? scopeKeys(key).flatMap((k) => drawingStore[k] ?? []) : drawingStore[key] ?? [];
  /** Split a view's new list into its scope keys: each drawing stays in the
   *  scope it lives in; a drawing not in any (new) goes to `newScope`. */
  function splitView(view: string, next: Drawing[], newScope = modeScopeKey(view)): { key: string; before: Drawing[]; after: Drawing[] }[] {
    const keys = scopeKeys(view);
    const owner = new Map<string, string>();
    for (const k of keys) for (const d of drawingStore[k] ?? []) owner.set(d.id, k);
    const after = new Map(keys.map((k) => [k, [] as Drawing[]]));
    for (const d of next) after.get(owner.get(d.id) ?? newScope)?.push(d);
    return keys
      .map((k) => ({ key: k, before: drawingStore[k] ?? [], after: after.get(k)! }))
      .filter((s) => s.before.length !== s.after.length || s.before.some((d, i) => d !== s.after[i]));
  }
  const drawings = () => drawingsFor(activeDrawingKey());
  // ── Drawing undo/redo (header Undo/Redo + Ctrl+Z / Ctrl+Y) ─────────────
  // Session-scoped snapshot history over the drawing slices: every mutation
  // that flows through setSlice records {key, before, after}. Drag streams
  // (updateDrawing per pointer-move) coalesce into ONE entry via coalesceId +
  // a sliding 800ms window, so one gesture = one undo step. The stack is not
  // persisted with the layout (session-only).
  type DrawingUndoEntry = {
    kind?: undefined;
    key: string;
    before: Drawing[];
    after: Drawing[];
    /** A view key's change: the scope slices it touched. */
    slices?: { key: string; before: Drawing[]; after: Drawing[] }[];
    label: string;
    at: number;
    coalesceId?: string;
  };
  /** Studies removed from a chart, with the drawings they owned (removed with
   *  them): one undo step brings both back, settings included. Only these
   *  studies are put back / removed again (a study added since is kept). */
  type StudyUndoEntry = {
    kind: "study";
    tabId: string;
    paneIndex: number;
    /** Removed study ids and their index in the list before the removal. */
    ids: string[];
    positions: number[];
    settings: NonNullable<PaneChart["indicatorSettings"]>;
    slices: { key: string; before: Drawing[]; after: Drawing[] }[];
    label: string;
    at: number;
  };
  /** Compared symbols added / removed: the pane's compare list before and
   *  after. */
  type CompareUndoEntry = {
    kind: "compare";
    tabId: string;
    paneIndex: number;
    before: CompareEntry[] | undefined;
    after: CompareEntry[] | undefined;
    label: string;
    at: number;
  };
  /** Chart sizes of a layout template changed with a splitter (drag, or a
   *  double click = back to equal sizes). */
  type LayoutSizesUndoEntry = {
    kind: "layout-sizes";
    tabId: string;
    layout: LayoutId;
    before: Sizing | undefined;
    after: Sizing | undefined;
    label: string;
    at: number;
  };
  type UndoEntry = DrawingUndoEntry | StudyUndoEntry | CompareUndoEntry | LayoutSizesUndoEntry;
  const UNDO_CAP = 100;
  const [undoStack, setUndoStack] = createSignal<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = createSignal<UndoEntry[]>([]);
  const canUndoDrawing = () => undoStack().length > 0;
  const canRedoDrawing = () => redoStack().length > 0;
  const undoDrawingLabel = () => {
    const e = undoStack()[undoStack().length - 1];
    return e ? `Undo ${e.label}` : "Undo";
  };
  const redoDrawingLabel = () => {
    const e = redoStack()[redoStack().length - 1];
    return e ? `Redo ${e.label}` : "Redo";
  };
  // Bumped by the overlay's pointer-up ("drawing-gesture-end") so two quick
  // drags of the same drawing never coalesce into one undo entry — the time
  // window alone merged back-to-back gestures.
  let gestureEpoch = 0;
  let lastEntryEpoch = -1;
  const onGestureEnd = () => { gestureEpoch++; };
  window.addEventListener("drawing-gesture-end", onGestureEnd);
  onCleanup(() => window.removeEventListener("drawing-gesture-end", onGestureEnd));
  function recordDrawingChange(
    key: string,
    before: Drawing[],
    after: Drawing[],
    meta: { label: string; coalesceId?: string },
    slices?: { key: string; before: Drawing[]; after: Drawing[] }[],
  ) {
    const stack = undoStack();
    const last = stack[stack.length - 1];
    if (
      meta.coalesceId &&
      last &&
      !last.kind &&
      last.coalesceId === meta.coalesceId &&
      last.key === key &&
      lastEntryEpoch === gestureEpoch &&
      Date.now() - last.at < 800
    ) {
      // Same gesture continuing — extend the open entry (keep its `before`).
      let merged = last.slices;
      if (slices) {
        merged = [...(last.slices ?? [])];
        for (const s of slices) {
          const i = merged.findIndex((m) => m.key === s.key);
          if (i >= 0) merged[i] = { ...merged[i], after: s.after };
          else merged.push(s);
        }
      }
      setUndoStack([...stack.slice(0, -1), { ...last, after, slices: merged, at: Date.now() }]);
    } else {
      setUndoStack([
        ...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))),
        { key, before, after, slices, label: meta.label, at: Date.now(), coalesceId: meta.coalesceId },
      ]);
    }
    lastEntryEpoch = gestureEpoch;
    if (redoStack().length) setRedoStack([]);
  }
  /** Restore a slice without recording (undo/redo application path). */
  function restoreSlice(key: string, list: Drawing[]) {
    setDrawingStore(key, list);
    saveDrawings(key, list);
    setSelectedDrawingIds((cur) => cur.filter((id) => list.some((d) => d.id === id)));
  }
  /** Apply one side of an undo entry. */
  function applyUndoEntry(e: UndoEntry, side: "before" | "after") {
    if (e.kind === "layout-sizes") {
      setTabLayoutSizes(e.tabId, e.layout, e[side]);
      return;
    }
    if (e.kind === "compare") {
      setPaneCompare(e.tabId, e.paneIndex, e[side]);
      return;
    }
    if (e.kind === "study") {
      setPaneStudies(e, side === "before");
      for (const sl of e.slices) restoreSlice(sl.key, sl[side]);
      return;
    }
    if (e.slices) {
      for (const sl of e.slices) restoreSlice(sl.key, sl[side]);
      return;
    }
    restoreSlice(e.key, e[side]);
  }
  function undoDrawing() {
    const stack = undoStack();
    const e = stack[stack.length - 1];
    if (!e) return;
    setUndoStack(stack.slice(0, -1));
    setRedoStack([...redoStack(), e]);
    applyUndoEntry(e, "before");
  }
  function redoDrawing() {
    const stack = redoStack();
    const e = stack[stack.length - 1];
    if (!e) return;
    setRedoStack(stack.slice(0, -1));
    setUndoStack([...undoStack(), e]);
    applyUndoEntry(e, "after");
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
    // List order, so re-inserting at the old indexes rebuilds the same order.
    const gone = pane.indicators.filter((id) => ids.includes(id));
    if (gone.length === 0) return;
    const positions = gone.map((id) => pane.indicators.indexOf(id));
    const settings: StudyUndoEntry["settings"] = {};
    for (const id of gone) {
      const st = pane.indicatorSettings?.[id];
      if (st) settings[id] = st;
    }
    const key = drawingKeyFor(pane, tabId);
    const list = drawingsFor(key);
    const kept = list.filter((d) => !d.owner || !gone.includes(d.owner));
    const slices = kept.length !== list.length ? splitView(key, kept) : [];
    const name = gone.length === 1 ? getIndicatorEntry(gone[0])?.name ?? gone[0] : "indicators";
    const entry: StudyUndoEntry = { kind: "study", tabId, paneIndex, ids: gone, positions, settings, slices, label: `remove ${name}`, at: Date.now() };
    applyUndoEntry(entry, "after");
    const stack = undoStack();
    setUndoStack([...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))), entry]);
    if (redoStack().length) setRedoStack([]);
  }

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
    applyUndoEntry(entry, "after");
    const stack = undoStack();
    setUndoStack([...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))), entry]);
    if (redoStack().length) setRedoStack([]);
  }
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
    applyUndoEntry(entry, "after");
    const stack = undoStack();
    setUndoStack([...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))), entry]);
    if (redoStack().length) setRedoStack([]);
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
      const order = (pane.paneOrder ?? []).filter((id) => pane.indicators.includes(id) || cur.some((c) => c.id === id));
      for (const id of pane.indicators) if (!order.includes(id)) order.push(id);
      for (const c of cur) if (c.placement === "pane" && !order.includes(c.id)) order.push(c.id);
      order.push(entry.id);
      patchTab(tabId, { panes: tabOf(tabId)!.panes.map((p, i) => (i === paneIndex ? { ...p, paneOrder: order } : p)) });
    }
    recordRecentSymbol("compare", symbol);
    changeCompare(tabId, paneIndex, [...cur, entry], `insert ${tickerOf(symbol)}`);
  }
  /** Pane controls moved a pane: persist the stacking order. */
  function setPaneOrderForPane(tabId: string, paneIndex: number, order: string[]) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, { panes: tab.panes.map((p, i) => (i === paneIndex ? { ...p, paneOrder: order } : p)) });
  }
  /** Persist a pane's source drawing order (Object tree drag). */
  function setSourceOrderForPane(tabId: string, paneIndex: number, order: string[]) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, { panes: tab.panes.map((p, i) => (i === paneIndex ? { ...p, sourceOrder: order } : p)) });
  }
  function removeCompare(tabId: string, paneIndex: number, id: string) {
    const cur = tabOf(tabId)?.panes[paneIndex]?.compare ?? [];
    const gone = cur.find((c) => c.id === id);
    if (!gone) return;
    changeCompare(tabId, paneIndex, cur.filter((c) => c.id !== id), `remove ${tickerOf(gone.symbol)}`);
  }
  /** Legend eye / Settings → Ok on one compared symbol. */
  function patchCompare(tabId: string, paneIndex: number, id: string, patch: { hidden?: boolean; symbol?: string; style?: CompareStyleState }) {
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

  /** Replace a scope key's drawings + persist. The per-pane mutators target the
   *  pane's scope key; the focused wrappers (object tree / selected toolbar)
   *  pass `activeDrawingKey()`. `meta` records the change on the undo stack;
   *  pass null for non-user mutations (loading a saved layout). */
  function setSlice(key: string, next: Drawing[], meta?: { label: string; coalesceId?: string } | null) {
    if (isViewKey(key)) {
      // A view: write each scope slice the change touches (one undo entry).
      const slices = splitView(key, next);
      if (meta !== null) recordDrawingChange(key, drawingsFor(key), next, meta ?? { label: "drawing change" }, slices);
      for (const s of slices) {
        setDrawingStore(s.key, s.after);
        saveDrawings(s.key, s.after);
      }
      return;
    }
    if (meta !== null) {
      recordDrawingChange(key, drawingsFor(key), next, meta ?? { label: "drawing change" });
    }
    setDrawingStore(key, next);
    saveDrawings(key, next);
  }
  /** Replace the FOCUSED pane's drawings (object-tree / bottom-rail ops). */
  const setActiveDrawings = (next: Drawing[], meta?: { label: string; coalesceId?: string } | null) =>
    setSlice(activeDrawingKey(), next, meta);
  // Live cross-window sync for drawings: when another window edits a key we
  // currently hold a slice for, re-load just that slice (setDrawingStore, not
  // setSlice — no re-persist). Keys we haven't loaded are fetched lazily on
  // first access, so they need no handling here. (Only global/symbol keys are
  // shared across windows; none/layout keys are window-local by construction.)
  onCleanup(kv.onExternalChangePrefix("ot:drawings:", (storeKey) => {
    const key = storeKey.slice("ot:drawings:".length);
    if (key in drawingStore) setDrawingStore(key, loadDrawings(key));
  }));
  const newDrawingId = () => `dw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  // Multi-select (Ctrl/Cmd+click adds to the selection). Ordered; the LAST
  // id is the primary — it anchors the floating toolbar and single-drawing
  // surfaces (settings, object-tree highlight), so the single-id accessor
  // below keeps every legacy consumer working unchanged.
  const [selectedDrawingIds, setSelectedDrawingIds] = createSignal<string[]>([]);
  const selectedDrawingId = () => {
    const a = selectedDrawingIds();
    return a.length ? a[a.length - 1] : null;
  };
  const setSelectedDrawingId = (id: string | null) => setSelectedDrawingIds(id ? [id] : []);
  const toggleSelectedDrawing = (id: string) =>
    setSelectedDrawingIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const [activeRailTab, setActiveRailTab] = createSignal<string | null>("base");
  // OakScript editor drawer (bottom of the chart pane). The right-rail script
  // button toggles it — it never becomes the active rail tab (the button
  // opens the drawer rather than a rail panel).
  const [oakPanelOpen, setOakPanelOpenRaw] = createSignal(kv.getItem("ot:oakscript:panelOpen") === "1");
  const setOakPanelOpen = (open: boolean) => {
    setOakPanelOpenRaw(open);
    kv.setItem("ot:oakscript:panelOpen", open ? "1" : "0");
  };
  const onRailTabSelect = (id: string | null) => {
    if (id === "pine-dialog-button") {
      setOakPanelOpen(!oakPanelOpen());
      return;
    }
    // Screeners: toggles the stock screener split view (right of the layout).
    if (id === "screener-dialog-button") {
      screenerPanel.toggle();
      return;
    }
    setActiveRailTab(id);
  };
  // Bottom-rail toggles for the drawing toolbar.
  const [magnetOn, setMagnetOn] = createSignal(false);
  // Magnet strength + "snap to indicator" — the split-control sub-options.
  // Persisted (desktop preference) unlike the session-only on/off toggle.
  const [magnetMode, setMagnetModeRaw] = createSignal<"weak" | "strong">(
    kv.getItem("ot:magnet-mode") === "strong" ? "strong" : "weak",
  );
  const setMagnetMode = (m: "weak" | "strong") => {
    setMagnetModeRaw(m);
    kv.setItem("ot:magnet-mode", m);
  };
  const [magnetSnapsToIndicators, setMagnetSnapsRaw] = createSignal(
    kv.getItem("ot:magnet-snap-indicators") === "true",
  );
  const setMagnetSnapsToIndicators = (v: boolean) => {
    setMagnetSnapsRaw(v);
    kv.setItem("ot:magnet-snap-indicators", String(v));
  };
  // Live cross-window sync for the two magnet sub-options (raw setters, no echo).
  onCleanup(kv.onExternalChange("ot:magnet-mode", () =>
    setMagnetModeRaw(kv.getItem("ot:magnet-mode") === "strong" ? "strong" : "weak")));
  onCleanup(kv.onExternalChange("ot:magnet-snap-indicators", () =>
    setMagnetSnapsRaw(kv.getItem("ot:magnet-snap-indicators") === "true")));
  const [stayMode, setStayMode] = createSignal(false);

  // Lazily load each scope key shown by the mounted tabs' panes into the store
  // (skips keys already loaded so edits aren't clobbered). Re-runs when the
  // pane set OR the sync mode changes (drawingKeyFor reads syncMode), so
  // switching mode pulls in the right slices. Saving is done inline on edit.
  createEffect(() => {
    const open = mountedTabs();
    for (const t of tabs()) {
      if (!open.has(t.id)) continue;
      for (const p of t.panes) {
        for (const key of scopeKeys(drawingKeyFor(p, t.id))) {
          if (!(key in drawingStore)) setDrawingStore(key, loadDrawings(key));
        }
      }
    }
  });
  // When the focused pane's scope key changes, drop the selection ONLY if the
  // selected drawing doesn't belong to the new key. (Changing symbol/pane
  // orphans the old selection → clear; but selecting a drawing on another pane
  // focuses that pane and must KEEP the just-made selection.)
  let lastSelKey = activeDrawingKey();
  createEffect(() => {
    const key = activeDrawingKey();
    if (key === lastSelKey) return;
    lastSelKey = key;
    const list = drawingsFor(key);
    setSelectedDrawingIds((cur) => cur.filter((id) => list.some((d) => d.id === id)));
  });

  // ── Per-pane drawing mutators ──────────────────────────────────────────
  // Each operates on the SCOPE KEY of the pane the user acted on (see
  // drawingKeyFor), so placing / editing on any pane lands on that pane's
  // chart. The focused wrappers below back the right-rail object tree + the
  // selected-toolbar, which follow the focused pane.

  /** Place a new drawing onto a specific pane's scope key. While Lock-all /
   *  Hide-all mode is active the new drawing inherits the flag, so the toggles
   *  keep applying to drawings created after they were turned on. */
  function addDrawingToSymbol(key: string, d: NewDrawing): string {
    const id = newDrawingId();
    const placed = { id, style: defaultStyleFor(d.kind), ...d } as Drawing;
    if (lockDrawingsMode()) placed.locked = true;
    if (hideDrawingsMode()) placed.hidden = true;
    setSlice(key, [...drawingsFor(key), placed], { label: `create ${labelForKind(d.kind)}` });
    return id;
  }

  function updateDrawingForSymbol(key: string, next: Drawing) {
    setSlice(
      key,
      drawingsFor(key).map((d) => (d.id === next.id ? next : d)),
      // Drag/nudge streams coalesce into one undo entry per gesture.
      { label: `change ${labelForKind(next.kind)}`, coalesceId: `${key}:${next.id}` },
    );
  }

  /** Run a removal of drawings. A drawing that carries alerts is removed
   *  with them, after a confirmation. */
  function removingDrawings(ids: string[], run: () => void) {
    const rules = alertStore.rules().filter((r) => ruleDrawingIds(r).some((id) => ids.includes(id)));
    if (rules.length === 0) { run(); return; }
    showConfirm({
      title: "Remove drawing",
      text:
        rules.length === 1
          ? "This drawing has an alert. Removing the drawing removes the alert too."
          : `${rules.length} alerts use ${ids.length === 1 ? "this drawing" : "these drawings"}. Removing ${ids.length === 1 ? "it" : "them"} removes the alerts too.`,
      mainText: "Remove",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => {
        run();
        for (const r of rules) alertStore.remove(r.id);
      },
    });
  }

  function removeDrawingForSymbol(key: string, id: string) {
    removingDrawings([id], () => {
      const victim = drawingsFor(key).find((d) => d.id === id);
      setSlice(key, drawingsFor(key).filter((d) => d.id !== id), {
        label: `remove ${victim ? labelForKind(victim.kind) : "drawing"}`,
      });
      setSelectedDrawingIds((cur) => cur.filter((x) => x !== id));
    });
  }

  // ── Multi-select bulk mutators ─────────────────────────────────────────
  /** Replace several drawings at once (group body-drag / group nudge) — ONE
   *  slice write, so the whole gesture lands as one undo entry. */
  function updateDrawingsForSymbol(key: string, list: Drawing[]) {
    if (list.length === 0) return;
    const byId = new Map(list.map((d) => [d.id, d]));
    setSlice(
      key,
      drawingsFor(key).map((d) => byId.get(d.id) ?? d),
      { label: `move ${list.length} drawings`, coalesceId: `${key}:group-move` },
    );
  }

  /** Delete several drawings in one undo entry (multi-select Delete). */
  function removeDrawingsForSymbol(key: string, ids: string[]) {
    if (ids.length === 0) return;
    removingDrawings(ids, () => {
      const set = new Set(ids);
      setSlice(key, drawingsFor(key).filter((d) => !set.has(d.id)), {
        label: `remove ${ids.length} drawings`,
      });
      setSelectedDrawingIds((cur) => cur.filter((id) => !set.has(id)));
    });
  }

  /** Duplicate a drawing — same kind/style, points offset by a small
   *  pixel-equivalent delta so the clone is visible. Done in data space
   *  via a tiny price bump; time stays identical since we have no easy
   *  pixel→time delta here. The clone takes a new id and ends up on top. */
  function cloneDrawingForSymbol(key: string, id: string) {
    const src = drawingsFor(key).find((d) => d.id === id);
    if (!src) return;
    const newId = newDrawingId();
    const offsetPrice = (p: { time: unknown; price: number }) => ({ ...p, price: +(p.price * 1.005).toFixed(2) });
    const cloned = {
      ...src,
      id: newId,
      style: { ...src.style },
      points: src.points.map(offsetPrice),
    } as Drawing;
    // The clone keeps the source's sync scope.
    const scope = isViewKey(key) ? scopeKeys(key).find((k) => (drawingStore[k] ?? []).some((d) => d.id === id)) ?? key : key;
    setSlice(scope, [...drawingsFor(scope), cloned], { label: `clone ${labelForKind(src.kind)}` });
    setSelectedDrawingId(newId);
  }

  // Focused-pane wrappers (object tree / selected toolbar act on the focused
  // pane's scope key).
  const updateDrawing = (next: Drawing) => updateDrawingForSymbol(activeDrawingKey(), next);
  const removeDrawing = (id: string) => removeDrawingForSymbol(activeDrawingKey(), id);
  const cloneDrawing = (id: string) => cloneDrawingForSymbol(activeDrawingKey(), id);

  // Lock-all / Hide-all are PERSISTENT toggle modes: they stay
  // on even with zero drawings and auto-apply to drawings placed later (see
  // addDrawingToSymbol), so the buttons are always meaningful to click. The
  // mode signals — not a derived "every drawing has the flag" read — drive the
  // buttons' active visual. `indicatorsHidden` mirrors this for studies.
  const [lockDrawingsMode, setLockDrawingsMode] = createSignal(false);
  const [hideDrawingsMode, setHideDrawingsMode] = createSignal(false);
  const [indicatorsHidden, setIndicatorsHidden] = createSignal(false);

  function toggleLockAll() {
    const next = !lockDrawingsMode();
    setLockDrawingsMode(next);
    setActiveDrawings(drawings().map((d) => ({ ...d, locked: next })), {
      label: next ? "lock all drawings" : "unlock all drawings",
    });
  }
  /** Hide-all dropdown — "Hide drawings" row + the icon's default click. */
  function toggleHideAll() {
    const next = !hideDrawingsMode();
    setHideDrawingsMode(next);
    setActiveDrawings(drawings().map((d) => ({ ...d, hidden: next })), {
      label: next ? "hide all drawings" : "show all drawings",
    });
  }
  /** Hide-all dropdown — "Hide indicators" row. */
  function toggleHideIndicators() {
    setIndicatorsHidden((v) => !v);
  }
  /** Hide-all dropdown — "Hide drawings & indicators" row. Turns both on unless
   *  both are already on, in which case it clears both. */
  function toggleHideBoth() {
    const next = !(hideDrawingsMode() && indicatorsHidden());
    setHideDrawingsMode(next);
    setIndicatorsHidden(next);
    setActiveDrawings(drawings().map((d) => ({ ...d, hidden: next })), {
      label: next ? "hide drawings & indicators" : "show drawings & indicators",
    });
  }
  function removeAllDrawings() {
    removingDrawings(drawings().map((d) => d.id), () => {
      setActiveDrawings([], { label: "remove all drawings" });
      setSelectedDrawingId(null);
    });
  }
  /** Remove-objects dropdown actions. Indicators live on the active pane. */
  function removeAllIndicators() {
    const tab = activeTab();
    removeStudies(tab.id, tab.activePane, activePaneState().indicators);
  }
  function removeAllObjects() {
    removeAllDrawings();
    removeAllIndicators();
  }

  /** Z-order via array position: end of array = topmost (rendered last + hit
   *  first). Front/back move all the way; forward/backward swap by one. */
  function reorderDrawingForSymbol(key: string, id: string, dir: "front" | "forward" | "backward" | "back") {
    const arr = drawingsFor(key).slice();
    const i = arr.findIndex((d) => d.id === id);
    if (i < 0) return;
    const [d] = arr.splice(i, 1);
    let j = i;
    if (dir === "front") j = arr.length;
    else if (dir === "back") j = 0;
    else if (dir === "forward") j = Math.min(arr.length, i + 1);
    else if (dir === "backward") j = Math.max(0, i - 1);
    arr.splice(j, 0, d);
    setSlice(key, arr, { label: `reorder ${labelForKind(d.kind)}`, coalesceId: `${key}:order:${id}` });
  }

  /** Object tree drag: the listed drawings (front first) take, in that order,
   *  the places they hold together in the list, each with the source it now
   *  sits in front of (`over`; null = behind every source). One undo step. */
  function placeDrawingsForSymbol(key: string, ids: string[], over: Record<string, string | null>) {
    const list = drawingsFor(key);
    const byId = new Map(list.map((d) => [d.id, d]));
    const backFirst = ids.filter((id) => byId.has(id)).reverse();
    const moved = new Set(backFirst);
    let k = 0;
    let changed = false;
    const next = list.map((d) => {
      if (!moved.has(d.id)) return d;
      const src = byId.get(backFirst[k++])!;
      const want = over[src.id] ?? undefined;
      if (src !== d) changed = true;
      if (overOf(src) === want) return src;
      changed = true;
      const placed: PlacedDrawing = { ...src };
      if (want === undefined) delete placed.over;
      else placed.over = want;
      return placed;
    });
    if (changed) setSlice(key, next, { label: "move objects" });
  }

  /** Move a drawing to an absolute slot in the ObjectTree's DISPLAY order
   *  (topmost-first = reverse of the array). Used by the panel's drag-to-
   *  reorder; `toDisplayIndex` is the insert position in that display list. */
  function moveDrawingToDisplayIndex(id: string, toDisplayIndex: number) {
    const display = drawings().slice().reverse();
    const from = display.findIndex((d) => d.id === id);
    if (from < 0) return;
    // Account for the removal shifting later indices down by one.
    let to = from < toDisplayIndex ? toDisplayIndex - 1 : toDisplayIndex;
    to = Math.max(0, Math.min(display.length - 1, to));
    if (to === from) return;
    const [d] = display.splice(from, 1);
    display.splice(to, 0, d);
    setActiveDrawings(display.reverse(), { label: `reorder ${labelForKind(d.kind)}` });
  }

  /** The focused pane's full name "EXCHANGE:TICKER" (the pane symbol itself
   *  once saved bare tickers are migrated, see the effect below). */
  const activeFullSymbol = (): string | undefined => {
    const s = symbol();
    return s && isFullSymbol(s) ? s : undefined;
  };

  /** Add a study of type `typeId` (registry id) to the focused pane. Every
   *  call adds a new instance with its own settings, like the reference app
   *  (the same indicator can be on a chart several times). */
  function addIndicator(typeId: string) {
    const pane = activePaneState();
    const tab = activeTab();
    // Ids still held by undo/redo entries of this pane are not reused: undo
    // would otherwise restore over the new instance.
    const held: string[] = [];
    for (const e of [...undoStack(), ...redoStack()])
      if (e.kind === "study" && e.tabId === tab.id && e.paneIndex === tab.activePane) held.push(...e.ids);
    const id = newStudyId(typeId, [...pane.indicators, ...held]);
    // A newly added study starts with the user's saved default ("Save as
    // default"), else the factory values (a new study never inherits the
    // settings of an earlier, removed instance).
    const entry = getIndicatorEntry(typeId);
    // A strategy that cannot be read is not put on the chart (it would be a study without a name or a report).
    if (!entry && isStrategyId(typeId)) return;
    const seed = loadIndicatorDefault(typeId) ?? (entry ? { inputs: { ...entry.defaultInputs }, styles: {}, options: defaultIndicatorOptions() } : undefined);
    // Adding a strategy opens its report (the reference app opens the footer panel).
    if (isStrategyId(typeId)) strategyTester.setCollapsed(false);
    patchActivePane({
      indicators: [...pane.indicators, id],
      ...(seed ? { indicatorSettings: { ...pane.indicatorSettings, [id]: seed } } : {}),
      // A new study goes behind the other sources (no place kept from an
      // earlier, removed instance of the same id).
      ...(pane.sourceOrder?.includes(id) ? { sourceOrder: pane.sourceOrder.filter((x) => x !== id) } : {}),
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

  // ── Indicator templates (header "Indicator templates" dropdown) ─────────
  // A template captures the focused pane's studies + their edited settings.
  // Save prompts for a name (same modal as layout naming); applying replaces
  // the pane's studies with the template's. `null` = dialog closed.
  const [templateNameDialogOpen, setTemplateNameDialogOpen] = createSignal(false);
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
  function applyIndicatorTemplate(id: string) {
    const tpl = getIndicatorTemplate(id);
    if (!tpl) return;
    patchActivePane({
      indicators: [...tpl.indicators],
      indicatorSettings: JSON.parse(JSON.stringify(tpl.settings)) as PaneChart["indicatorSettings"],
    });
    touchIndicatorTemplate(id);
  }

  // Header "Compare symbols": the symbol search in its compare mode.
  const [compareDialogOpen, setCompareDialogOpen] = createSignal(false);
  // Legend title of a compared symbol ("Change symbol"): the symbol search
  // replaces that entry's symbol.
  const [compareTarget, setCompareTarget] = createSignal<{ tabId: string; paneIndex: number; id: string } | null>(null);

  /** A picked symbol: the full name "EXCHANGE:TICKER" from the search dialog,
   *  the watchlist and the static catalog; a bare ticker (screener rows) gets
   *  its primary listing first. */
  function onSymbolPicked(picked: string) {
    const target = compareTarget();
    setCompareTarget(null);
    setSymbolDialogOpen(false);
    const apply = (full: string) => {
      if (target) {
        recordRecentSymbol("compare", full);
        patchCompare(target.tabId, target.paneIndex, target.id, { symbol: full });
      } else {
        recordRecentSymbol("search", full);
        setSymbol(full);
      }
    };
    if (isFullSymbol(picked)) apply(picked.toUpperCase());
    else void toFullSymbol(picked).then(apply, (e) => console.warn(`[symbol] ${picked}: ${e}`));
  }

  // ── Tab operations ─────────────────────────────────────────────────────
  function activateTab(id: string) {
    if (id === activeTabId()) return;
    setActiveTabId(id);
    setSelectedDrawingId(null);
  }
  function newTab() {
    const t = makeTab();
    setTabs([...tabs(), t]);
    activateTab(t.id);
  }
  function duplicateTab(id: string) {
    const src = tabs().find((t) => t.id === id);
    if (!src) return;
    const clone: TabChart = {
      id: newTabId(),
      layout: src.layout,
      activePane: src.activePane,
      panes: src.panes.map((p) => ({ ...p, id: newPaneId(), indicators: [...p.indicators] })),
      numbering: src.numbering,
      isChart: src.isChart,
      sync: { ...src.sync },
      layoutSizes: src.layoutSizes,
    };
    const arr = tabs().slice();
    // An unpinned copy goes after the pinned block.
    arr.splice(insertPosition(arr, false, arr.findIndex((t) => t.id === id) + 1), 0, clone);
    setTabs(arr);
    activateTab(clone.id);
  }
  /** Record a tab closed by the user for "Reopen closed tab" (undo stack). */
  function recordClosedTab(tab: TabChart, position: number) {
    pushClosed({ kind: "tab", win: windowLabel, position, active: tab.id === activeTabId(), tab });
  }
  /** Insert a tab (reopened, or merged in from another window) at `index`,
   *  keeping its id unless this window already has it. */
  function insertTab(tab: TabChart, index: number, active: boolean) {
    const arr = tabs().slice();
    const t = arr.some((x) => x.id === tab.id) ? { ...tab, id: newTabId() } : tab;
    arr.splice(insertPosition(arr, !!t.pinned, index), 0, t);
    setTabs(arr);
    if (active) activateTab(t.id);
    if (isTauri()) void getCurrentWebviewWindow().setFocus().catch(() => undefined);
  }
  /** "Reopen closed tab / window" (main menu, Ctrl+Shift+T): the newest
   *  closed tab comes back in its own window (nothing opens when that window
   *  is gone); a closed window opens again with its tabs. */
  async function reopenClosed() {
    const e = popClosed();
    if (!e) return;
    if (e.kind === "window") return reopenClosedWindow(e);
    if (e.win === windowLabel) return insertTab(e.tab, e.position, e.active);
    if (!isTauri()) return;
    const open = (await getAllWebviewWindows()).map((w) => w.label);
    if (open.includes(e.win)) reopenTabIn(e.win, e.tab, e.position, e.active);
  }
  /** Tab strip index for a drop at this screen point, when it is on this
   *  window's strip (merge target test, shell-bus). */
  function stripIndexAt(sx: number, sy: number): number | null {
    const strip = document.querySelector<HTMLElement>(".tabs");
    if (!strip) return null;
    const { x, y } = screenToClient(sx, sy);
    const r = strip.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    let index = 0;
    for (const t of tabs()) {
      const el = document.getElementById(t.id);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      if (x > b.left + b.width / 2) index++;
    }
    return index;
  }
  /** Drop of a dragged tab outside this window: if it lands on another
   *  window's tab strip, move the tab there. The main window
   *  keeps at least one tab. Returns true when the tab moved. */
  async function dropTabOnWindow(id: string, sx: number, sy: number): Promise<boolean> {
    const tab = tabs().find((t) => t.id === id);
    if (!tab || (tabs().length <= 1 && windowLabel === "main")) return false;
    const hit = await findStripAt(sx, sy);
    if (!hit || hit.label === windowLabel) return false;
    if (!(await sendTabTo(hit.label, tab, hit.index))) return false;
    const arr = tabs();
    if (arr.length <= 1) {
      markClosingAfterMove();
      closeCurrentWindow();
      return true;
    }
    const idx = arr.findIndex((t) => t.id === id);
    const next = arr.filter((t) => t.id !== id);
    setTabs(next);
    if (activeTabId() === id) activateTab(next[Math.min(idx, next.length - 1)].id);
    return true;
  }
  onMount(() => onCleanup(initShellBus({ stripIndexAt, insertTab })));

  function closeTab(id: string) {
    const arr = tabs();
    if (arr.length <= 1) {
      // Closing the last tab of a detached window closes the window (recorded
      // as a closed window); the main window always keeps at least one tab.
      if (windowLabel !== "main") closeCurrentWindow();
      return;
    }
    const idx = arr.findIndex((t) => t.id === id);
    if (idx >= 0) recordClosedTab(arr[idx], idx);
    const next = arr.filter((t) => t.id !== id);
    setTabs(next);
    if (activeTabId() === id) {
      activateTab(next[Math.min(idx, next.length - 1)].id);
    }
  }
  /** Tear a tab off into a new window, then drop it from this one. No-ops (stays
   *  put) outside Tauri or when it's the only tab. */
  function detachTab(id: string, screenX: number, screenY: number) {
    const arr = tabs();
    if (arr.length <= 1) return;
    const tab = arr.find((t) => t.id === id);
    if (!tab || !detachTabToWindow(tab, screenX, screenY)) return;
    const idx = arr.findIndex((t) => t.id === id);
    const next = arr.filter((t) => t.id !== id);
    setTabs(next);
    if (activeTabId() === id) activateTab(next[Math.min(idx, next.length - 1)].id);
  }
  /** Record tabs closed together, right to left with their indexes, so
   *  reopening one by one puts each back at its place. */
  function recordClosedTabs(ids: Set<string>) {
    const arr = tabs();
    for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) recordClosedTab(arr[i], i);
  }
  // Pinned tabs survive "Close other tabs" and "Close tabs to the right".
  function closeOthers(id: string) {
    const keep = tabs().filter((t) => t.pinned || t.id === id);
    if (!keep.some((t) => t.id === id) || keep.length === tabs().length) return;
    recordClosedTabs(new Set(tabs().filter((t) => !keep.includes(t)).map((t) => t.id)));
    setTabs(keep);
    activateTab(id);
  }
  function closeToRight(id: string) {
    const arr = tabs();
    const idx = arr.findIndex((t) => t.id === id);
    const firstUnpinned = arr.findIndex((t) => !t.pinned);
    if (idx < 0 || firstUnpinned === -1) return;
    const next = idx >= firstUnpinned ? arr.slice(0, idx + 1) : arr.filter((t) => t.pinned);
    recordClosedTabs(new Set(arr.filter((t) => !next.includes(t)).map((t) => t.id)));
    setTabs(next);
    if (!next.some((t) => t.id === activeTabId())) activateTab(id);
  }
  function reorderTab(from: number, to: number) {
    const arr = tabs().slice();
    const target = clampMoveIndex(arr, from, to);
    const [t] = arr.splice(from, 1);
    arr.splice(target, 0, t);
    setTabs(arr);
  }
  /** "Pin tab" / "Unpin tab": a pinned tab
   *  moves to the end of the pinned block, an unpinned one to just after it. */
  function togglePinTab(id: string) {
    const arr = tabs().slice();
    const idx = arr.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const pinned = !arr[idx].pinned;
    const firstUnpinned = arr.findIndex((t) => !t.pinned);
    arr[idx] = { ...arr[idx], pinned: pinned || undefined };
    const normalized = pinned ? firstUnpinned : firstUnpinned - 1;
    if (idx !== normalized) {
      const newIndex = firstUnpinned !== -1 ? (pinned ? firstUnpinned : normalized) : pinned ? 0 : arr.length - 1;
      const [t] = arr.splice(idx, 1);
      arr.splice(newIndex, 0, t);
    }
    setTabs(arr);
  }
  /** "Reload tab" (Ctrl+R): the tab's charts are built again with fresh
   *  data. A hidden tab unmounts and loads again on its next display. */
  function reloadTab(id: string) {
    setMountedTabs((cur) => new Set([...cur].filter((x) => x !== id)));
    if (id === activeTabId()) queueMicrotask(() => setMountedTabs((cur) => new Set([...cur, id])));
  }
  /** "Developer tools" (tab menu with Shift held): this window's devtools. */
  function openDevTools() {
    if (!isTauri()) return;
    void import("./bindings").then(({ commands }) => commands.openDevtools()).catch(() => undefined);
  }
  function copyTabSymbol(id: string) {
    const t = tabs().find((x) => x.id === id);
    if (t) navigator.clipboard?.writeText(fullSymbolFor(activePaneOf(t).symbol)).catch(() => undefined);
  }

  function openMenuAt(id: string, anchor: DOMRect) {
    // Toggle: clicking the same opener twice closes it.
    if (openMenu() === id) {
      setOpenMenu(null);
      setAnchorRect(null);
    } else {
      setOpenMenu(id);
      setAnchorRect(anchor);
    }
  }

  function closeMenu() {
    setOpenMenu(null);
    setAnchorRect(null);
  }

  function onMenuSelect(rowId: string) {
    const which = openMenu();
    if (which === "chart-interval") {
      setInterval(rowId);
    } else if (which === "candles" && CHART_TYPE_IDS.has(rowId as ChartTypeId)) {
      setChartType(rowId as ChartTypeId);
    } else if (which === "layout-setup") {
      setLayout(layoutFromVariantId(rowId));
    } else if (which === "save-load-menu") {
      onManageLayoutsSelect(rowId);
    } else if (which === "take-a-snapshot") {
      // Snapshot menu (the link and tweet rows are cloud actions, not
      // offered). "Open in new tab" opens the PNG in the OS default viewer
      // (temp file via the open_snapshot command).
      if (rowId === "save-chart-image") {
        window.dispatchEvent(new CustomEvent("chart-snapshot", { detail: { action: "download" } }));
      } else if (rowId === "copy-chart-image") {
        window.dispatchEvent(new CustomEvent("chart-snapshot", { detail: { action: "copy" } }));
      } else if (rowId === "open-image-in-new-tab") {
        window.dispatchEvent(new CustomEvent("chart-snapshot", { detail: { action: "open" } }));
      }
    } else if (which === "show-favorite-indicators") {
      // A favourite row adds that study to the focused pane (one more
      // instance when it is already on the chart).
      addIndicator(rowId);
    } else if (which === "indicator-templates") {
      if (rowId === SAVE_TEMPLATE_ROW_ID) setTemplateNameDialogOpen(true);
      else if (rowId.startsWith(APPLY_TEMPLATE_PREFIX))
        applyIndicatorTemplate(rowId.slice(APPLY_TEMPLATE_PREFIX.length));
    }
    // Other menus: no-op for now.
  }

  /** Dispatch a "Manage layouts" row click. Saved-layout rows carry their id in
   *  the `open-layout:<id>` row id; the rest are fixed action ids. */
  function onManageLayoutsSelect(rowId: string) {
    if (rowId.startsWith(OPEN_LAYOUT_PREFIX)) {
      requestOpenLayout(rowId.slice(OPEN_LAYOUT_PREFIX.length));
      return;
    }
    switch (rowId) {
      case "save-load-menu-item-save":
        saveActiveLayout();
        break;
      case "save-load-menu-item-auto-save":
        setLayoutAutosave(!layoutAutosave());
        break;
      case "save-load-menu-item-clone":
        setLayoutNameDialog({ mode: "copy", initial: `${layoutName()} copy` });
        break;
      case "save-load-menu-item-rename":
        setLayoutNameDialog({
          mode: "rename",
          initial: activeTab().savedLayoutName ?? "",
        });
        break;
      case "save-load-menu-item-download":
        setDownloadDataOpen(true);
        break;
      case "save-load-menu-item-create":
        setLayoutNameDialog({ mode: "create", initial: "" });
        break;
      case "save-load-menu-item-load":
        setLayoutBrowserOpen(true);
        break;
      // The empty placeholder row: nothing to do.
      default:
        break;
    }
  }

  /** Live menu def for the open dropdown — the "Manage layouts" menu is built
   *  dynamically (live autosave state + saved-layouts list); the rest are the
   *  static registry entries. */
  function currentMenuDef() {
    const id = openMenu();
    if (!id) return undefined;
    if (id === "save-load-menu") {
      return buildSaveLoadMenu({
        activeId: activeTab().savedLayoutId,
        autosave: layoutAutosave(),
        dirty: layoutDirty(),
        summaryOf: summaryOfLayout,
      });
    }
    // Live menus (the static registry entries for these ids are placeholders
    // — the real rows come from the local stores).
    if (id === "show-favorite-indicators")
      return buildFavoriteIndicatorsMenu();
    if (id === "indicator-templates") return buildIndicatorTemplatesMenu();
    if (id === "chart-interval") return buildIntervalMenu();
    return HEADER_MENUS[id];
  }

  function selectedRowForOpenMenu(): string | undefined {
    const which = openMenu();
    if (which === "chart-interval") return interval();
    if (which === "candles") return chartType();
    if (which === "layout-setup") return variantIdForLayout(layout());
    return undefined;
  }

  onMount(() => {
    // The App-Settings theme picker re-themes by swapping this class; follow
    // it so the chart canvases (props.theme → token re-read) update too.
    const themeObserver = new MutationObserver(() => {
      const t = document.documentElement.classList.contains("theme-light") ? "light" : "dark";
      if (t !== theme()) setThemeSignal(t);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => themeObserver.disconnect());
    // Cross-window live theme sync: another window's picker writes ot:theme;
    // apply the class here (the observer above then updates the signal).
    onCleanup(kv.onExternalChange("ot:theme", () => {
      const t = loadTheme();
      document.documentElement.classList.remove("theme-dark", "theme-light");
      document.documentElement.classList.add(`theme-${t}`);
    }));

    // Global keyboard shortcuts. Window/alert shortcuts fire
    // regardless of chart focus; everything else is suppressed while a text
    // field is focused or a modal dialog already owns the keyboard:
    //   Alt+A         → Create alert;       Ctrl/Cmd+N → new window;
    //   Ctrl/Cmd+S    → Save layout;
    //   Shift+F       → fullscreen;         "/"        → Indicators dialog;
    //   Alt+R/I/L/P   → reset / invert / log / percent scale (focused pane);
    //   Ctrl+Alt+S    → download image;     Ctrl+Shift+S → copy image;
    //   Ctrl+↑/↓      → zoom in / out;      Ctrl+←/→   → jump left / right;
    //   Space/Shift+Sp → next / prev watchlist symbol (even off the list);
    //   ←/→           → scroll one bar;     ","        → chart-interval menu;
    //   any digit     → chart-interval menu (type a number to change frame);
    //   any letter    → Symbol search seeded with that character.
    // Chart pan/zoom/scale/snapshot are dispatched as window events; the
    // focused ChartView pane handles them (see ChartView's chart-* listeners).
    const dispatch = (type: string, detail?: unknown) =>
      window.dispatchEvent(new CustomEvent(type, detail === undefined ? undefined : { detail }));
    // Arrow key currently driving a held scroll — plain (moveByBar) or Ctrl
    // (move). One slot for both: the two gestures share one animation, so
    // only one can be live.
    let pannedKey: string | null = null;
    const onKey = (e: KeyboardEvent) => {
      // Shell hotkeys. They apply whatever holds focus: tab cycling wraps
      // around, Ctrl+1..8 picks tab N, Ctrl+9 the last one.
      if (e.ctrlKey && !e.metaKey && !e.altKey) {
        const list = tabs();
        const cur = list.findIndex((t) => t.id === activeTabId());
        const go = (i: number) => {
          e.preventDefault();
          const t = list[(i + list.length) % list.length];
          if (t) activateTab(t.id);
        };
        if (!e.shiftKey && (e.code === "PageDown" || e.code === "Numpad3" || e.key === "Tab")) return go(cur + 1);
        if ((e.shiftKey && e.key === "Tab") || (!e.shiftKey && (e.code === "PageUp" || e.code === "Numpad9"))) return go(cur - 1);
        if (!e.shiftKey && /^Digit[1-8]$/.test(e.code)) {
          e.preventDefault();
          const t = list[Number(e.code.slice(5)) - 1];
          if (t) activateTab(t.id);
          return;
        }
        if (!e.shiftKey && e.code === "Digit9") return go(list.length - 1);
        if (!e.shiftKey && e.code === "KeyT") {
          e.preventDefault();
          newTab();
          return;
        }
        if (!e.shiftKey && e.code === "F4") {
          e.preventDefault();
          closeTab(activeTabId());
          return;
        }
        if (!e.shiftKey && e.code === "Comma") {
          e.preventDefault();
          setAppSettingsTab("general");
          return;
        }
      }
      // F5 → reload the active tab, not the webview.
      if (e.code === "F5" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        reloadTab(activeTabId());
        return;
      }
      // Ctrl+Alt+Q → reset the time scale only. AltGr
      // reports as Ctrl+Alt on Windows intl layouts: ignore it, as for Ctrl+Alt+S.
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === "KeyQ" && !e.getModifierState?.("AltGraph")) {
        const tgt = e.target as HTMLElement | null;
        const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
        if (!typing && !document.querySelector('[role="dialog"]')) {
          e.preventDefault();
          dispatch("chart-reset-time");
          return;
        }
      }
      // Snapshot combos: Ctrl+Alt+S → download image, Ctrl+Shift+S → copy
      // image. Skip while a text field is focused or a modal owns the keyboard
      // (so the keystroke isn't eaten), and ignore AltGr+S — on Windows intl
      // layouts AltGr reports as Ctrl+Alt, so typing e.g. 'ś' must not download.
      if (e.ctrlKey && !e.metaKey && e.code === "KeyS") {
        const tgt = e.target as HTMLElement | null;
        const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
        const modal = !!document.querySelector('[role="dialog"]');
        if (!typing && !modal) {
          if (e.altKey && !e.shiftKey && !e.getModifierState?.("AltGraph")) {
            e.preventDefault();
            dispatch("chart-snapshot", { action: "download" });
            return;
          }
          if (e.shiftKey && !e.altKey) {
            e.preventDefault();
            dispatch("chart-snapshot", { action: "copy" });
            return;
          }
        }
      }
      // Alt+A → Create alert. Handled before the modifier guard.
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "a" || e.key === "A")) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        setAlertDialog({ symbol: symbol() });
        return;
      }
      // Ctrl/Cmd+Z → undo drawing change; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y →
      // redo. Skipped while typing / while a modal owns the keyboard.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z")) {
        const tgt = e.target as HTMLElement | null;
        const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
        if (typing || document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        if (e.shiftKey) redoDrawing();
        else undoDrawing();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "y" || e.key === "Y")) {
        const tgt = e.target as HTMLElement | null;
        const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
        if (typing || document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        redoDrawing();
        return;
      }
      // Ctrl/Cmd+R → reload the active tab (also stops the
      // webview's own page reload).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        reloadTab(activeTabId());
        return;
      }
      // Ctrl/Cmd+Shift+T → reopen the newest closed tab / window.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && (e.key === "t" || e.key === "T")) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        void reopenClosed();
        return;
      }
      // Ctrl/Cmd+N → open a new window. No-op off-shell, where we let the
      // browser keep its native shortcut.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "n" || e.key === "N")) {
        if (openNewWindow()) e.preventDefault();
        return;
      }
      // Ctrl/Cmd+S → save the active chart layout ("Save layout").
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        saveActiveLayout();
        return;
      }
      // Ctrl+U / Ctrl+W → duplicate / close the active tab (the hotkeys the
      // tab context menu advertises). Safe to claim in a Tauri webview — there
      // is no browser chrome for Ctrl+W to collide with. Suppressed while a
      // text field is focused (inline watchlist inputs etc.), like Ctrl+Z.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyU" || e.code === "KeyW")) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest?.(".monaco-editor"))) return;
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        if (e.code === "KeyU") duplicateTab(activeTabId());
        else closeTab(activeTabId());
        return;
      }
      const t = e.target as HTMLElement | null;
      // monaco 0.5x types through the EditContext API — its key events target a
      // plain div (only an IME fallback textarea exists), so the OakScript
      // editor must be recognized structurally, not by tag.
      const editable = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest?.(".monaco-editor")));
      const blocked = editable || !!document.querySelector('[role="dialog"]');
      // Space / Shift+Space → load the next / previous watchlist symbol, even
      // when the chart (not the watchlist) holds focus. When the watchlist
      // itself is focused, its own key handler runs — defer to it here so the
      // symbol doesn't advance twice.
      if ((e.code === "Space" || e.key === " ") && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (blocked) return;
        if ((document.activeElement as HTMLElement | null)?.closest?.(".watchlist-rows")) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("watchlist-navigate", { detail: { dir: e.shiftKey ? -1 : 1 } }));
        return;
      }
      // Shift+F → toggle fullscreen. Skip while typing so capital F works.
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "F" || e.key === "f")) {
        if (blocked) return;
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      // Shift+W → open the watchlist "Open list" picker. Surface the rail's
      // watchlist tab first, then flag the request the panel consumes on mount.
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "W" || e.key === "w")) {
        if (blocked) return;
        e.preventDefault();
        setActiveRailTab("base");
        requestOpenList();
        return;
      }
      // Trading hotkeys (reference app, bound whether or not a broker is
      // connected): Shift+B buy, Shift+S sell, Shift+T order ticket, and
      // Alt+Shift+B / Alt+Shift+S limit orders (the Alt+Shift block below).
      // They run the chart menu's Buy / Sell / Add order rows, which have no
      // trading backend in this app, so they do nothing; they no longer
      // start a symbol search with that letter.
      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyB" || e.code === "KeyS" || e.code === "KeyT")) {
        if (blocked) return;
        e.preventDefault();
        return;
      }
      // Alt+Shift+→ / ← → jump to the most recent / the first bar on the focused
      // pane (control-bar hotkey, the same action as its goto-realtime arrow).
      // Kept above the Alt-only block, which requires !shiftKey.
      // Repeat-guarded like the held gestures: the guard covers all four arrow
      // branches, and without it holding the key would restart the 1s ease
      // every repeat, so the chart would only ever creep along its slow
      // opening frames.
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (blocked) return;
        // Alt+Shift+E → next session: intraday only,
        // cycles the symbol's sessions (Regular → Extended → Regular).
        // Alt+Shift+B / Alt+Shift+S: trading hotkeys (see Shift+B above).
        if (e.code === "KeyB" || e.code === "KeyS") { e.preventDefault(); return; }
        if (e.code === "KeyE") {
          e.preventDefault();
          if (!isIntradayInterval(interval())) return;
          const ids: SessionId[] = ["RTH", "ETH"];
          setSession(ids[(ids.indexOf(session()) + 1) % ids.length]);
          return;
        }
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          if (pannedKey !== null) return; // key repeat
          pannedKey = e.key;
          dispatch(e.key === "ArrowRight" ? "chart-goto-realtime" : "chart-goto-first");
          return;
        }
      }
      // Alt+{R,I,L,P} → reset view / scale toggles on the focused pane. Other
      // Alt combos belong to drawing tools (Alt+T/H/F/V/C/J), Alt+G / Alt+Enter
      // (bottom bar), and Alt+Shift+R — left untouched here. Alt+S ("copy
      // link", a cloud action) is not offered.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (blocked) return;
        if (e.code === "KeyR") { e.preventDefault(); dispatch("chart-reset"); return; }
        if (e.code === "KeyI") { e.preventDefault(); dispatch("chart-scale", { mode: "invert" }); return; }
        if (e.code === "KeyL") { e.preventDefault(); dispatch("chart-scale", { mode: "log" }); return; }
        if (e.code === "KeyP") { e.preventDefault(); dispatch("chart-scale", { mode: "percent" }); return; }
        // Alt+D → Object tree page on its Data window view.
        if (e.code === "KeyD") {
          e.preventDefault();
          setActiveRailTab("object_tree");
          requestDataWindow();
          return;
        }
        // Alt+W → add the focused symbol to the end of the active watchlist
        // (no anchor), deduped by the store.
        if (e.code === "KeyW") {
          e.preventDefault();
          const full = symbol();
          if (full) {
            watchlistStore.addSymbols(
              [{ ticker: full, short: tickerOf(full), last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null }],
              null,
            );
          }
          return;
        }
        return;
      }
      // Ctrl/Cmd + arrows → zoom (↑/↓) and the held accelerating pan (←/→) on
      // the focused pane. The pan starts on the FIRST keydown only, because
      // the motion builds speed off its own elapsed time and a repeat would
      // restart it at zero. `keyup` (below) ends it.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (blocked) return;
        if (e.key === "ArrowUp") { e.preventDefault(); dispatch("chart-zoom", { dir: "in" }); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); dispatch("chart-zoom", { dir: "out" }); return; }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          if (pannedKey !== null) return; // key repeat
          pannedKey = e.key;
          dispatch("chart-scroll-start", { dir: e.key === "ArrowLeft" ? -1 : 1, mode: "smooth" });
          return;
        }
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (blocked) return;
      // Tab / Shift+Tab → cycle the focused pane ("switch between charts").
      // Single-pane layouts fall through to native focus traversal.
      if (e.key === "Tab") {
        const count = activeTab().panes.length;
        if (count <= 1) return;
        e.preventDefault();
        const cur = activeTab().activePane;
        setActivePaneIndex(e.shiftKey ? (cur - 1 + count) % count : (cur + 1) % count);
        return;
      }
      // Shift+→ / Shift+← → switch focused pane (alternate binding for Tab).
      if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        const count = activeTab().panes.length;
        if (count <= 1) return;
        e.preventDefault();
        const cur = activeTab().activePane;
        setActivePaneIndex(e.key === "ArrowRight" ? (cur + 1) % count : (cur - 1 + count) % count);
        return;
      }
      // ←↑→↓ → nudge the selected drawing 1px; with nothing selected,
      // ←/→ scroll the chart (↑/↓ do nothing — no vertical pan).
      // Held ←/→ is moveByBar: a run that walks one bar, then speeds up the
      // longer it's held. Like the Ctrl variant it starts on the FIRST keydown
      // only and ends on keyup, so repeats must not restart it.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (selectedDrawingId()) {
          e.preventDefault();
          const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
          dispatch("drawing-nudge", { dx, dy });
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          if (pannedKey !== null) return; // key repeat
          pannedKey = e.key;
          dispatch("chart-scroll-start", { dir: e.key === "ArrowLeft" ? -1 : 1, mode: "bar" });
        }
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setIndicatorsDialogOpen(true);
      } else if (e.key === ".") {
        // "." → open the saved-layout browser ("Open layout").
        e.preventDefault();
        setLayoutBrowserOpen(true);
      } else if (e.key.length === 1 && /[1-9]/.test(e.key)) {
        // A digit 1-9 → "Change interval" dialog with that digit, caret at
        // the end.
        e.preventDefault();
        setIntervalDialog({ initVal: e.key, selectOnInit: false });
      } else if (e.key === ",") {
        // "," → the chart-interval menu.
        e.preventDefault();
        const btn = document.querySelector<HTMLButtonElement>('[data-name="chart-interval"]');
        if (!btn) return;
        openMenuAt("chart-interval", btn.getBoundingClientRect());
      } else if (e.key.length === 1 && /[a-zA-Z0]/.test(e.key)) {
        // A letter (or 0, which is not an interval key) starts a symbol
        // lookup anywhere.
        e.preventDefault();
        setSymbolSearchSeed(e.key);
        setSymbolDialogOpen(true);
      }
    };
    // Ends the held scroll. Keyed on the ARROW alone, so letting go of
    // Ctrl first still stops it. `blur` covers releasing the key while the
    // window is in the background, which never delivers a keyup.
    const onKeyUp = (e: KeyboardEvent) => {
      if (pannedKey === null || e.key !== pannedKey) return;
      pannedKey = null;
      dispatch("chart-scroll-stop");
    };
    const onBlur = () => {
      if (pannedKey === null) return;
      pannedKey = null;
      dispatch("chart-scroll-stop");
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    });

    // Window events from the chart right-click menu (ChartContextMenu).
    const onOpenSettings = (e: Event) => {
      setSettingsDialogTab((e as CustomEvent<{ tab?: string } | null>).detail?.tab);
      setSettingsDialogOpen(true);
    };
    // Chart ctx menu → Chart template → "Save as…" (indicator-template name dialog).
    // Chart menu "Chart template": "Save as…" saves the active chart's
    // settings as a chart template ("Save template as" name dialog, the
    // Settings dialog Template menu's); a template row applies it to the
    // active chart; its trash removes it (confirmation).
    const onSaveTemplate = () =>
      showRename({
        title: "Save template as",
        label: "Template name:",
        maxLength: 128,
        names: chartTemplates().map((t) => t.name),
        replaceText: (n) => `Template '${n}' already exists. Do you really want to replace it?`,
        onSave: (name) => saveChartTemplate(name, activeSettingsDraft()),
      });
    const onApplyTemplate = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name;
      const t = chartTemplates().find((x) => x.name === name);
      const draft = t ? chartTemplateDraft(t) : undefined;
      if (draft) commitChartSettings(draft, "active");
    };
    const onRemoveTemplate = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name;
      if (!name) return;
      showConfirm({ text: `Do you really want to delete Chart Template '${name}' ?`, onConfirm: () => removeChartTemplate(name) });
    };
    const onClearIndicators = () => removeAllIndicators();
    const onOpenPanel = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setActiveRailTab(id);
    };
    // Chart context-menu "Add alert", AlertsPanel "edit", header "Create alert".
    const onOpenAlertDialog = (e: Event) => {
      const d = (e as CustomEvent<{ editId?: string; symbol?: string; price?: number; indicatorId?: string; drawingId?: string }>).detail ?? {};
      setAlertDialog({ editId: d.editId, symbol: d.symbol, price: d.price, indicatorId: d.indicatorId, drawingId: d.drawingId });
    };
    // Price-scale context menu (right-click on the price axis): checkable
    // Labels/Lines rows + "Move scale" fold into the focused pane's Settings
    // draft (same rows the dialog edits); Session radios reuse setSession.
    const onPatchScaleSettings = (e: Event) => {
      const patch = (e as CustomEvent<{ patch?: ScaleMenuPatch }>).detail?.patch;
      if (!patch) return;
      const settings = patchDraftScales(activePaneState().settings, patch);
      patchActivePane({ settings, settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV });
      // Price-scale menu edits are chart setting edits too (saved as the
      // defaults of new charts).
      saveChartSettingsDefaults(settings);
    };
    const onSetSession = (e: Event) => {
      const id = (e as CustomEvent<{ id?: SessionId }>).detail?.id;
      if (id === "RTH" || id === "ETH") setSession(id);
    };
    // Legend series More → "Add indicator/strategy on …".
    const onOpenIndicators = () => setIndicatorsDialogOpen(true);
    // Time-axis menu → "Time zone" row: the app-wide display timezone (same
    // signal as the bottom-bar timezone menu).
    const onSetTimezone = (e: Event) => {
      const label = (e as CustomEvent<{ label?: string }>).detail?.label;
      const tz = TIMEZONES.find((z) => z.label === label);
      if (tz) setTimezone({ label: tz.label, iana: tz.iana });
    };
    window.addEventListener("chart-open-settings", onOpenSettings);
    window.addEventListener("chart-save-template", onSaveTemplate);
    window.addEventListener("chart-apply-template", onApplyTemplate);
    window.addEventListener("chart-remove-template", onRemoveTemplate);
    window.addEventListener("chart-clear-indicators", onClearIndicators);
    window.addEventListener("chart-open-panel", onOpenPanel);
    window.addEventListener("chart-open-alert-dialog", onOpenAlertDialog);
    window.addEventListener("chart-patch-scale-settings", onPatchScaleSettings);
    window.addEventListener("chart-set-session", onSetSession);
    window.addEventListener("chart-set-timezone", onSetTimezone);
    window.addEventListener("chart-open-indicators", onOpenIndicators);
    onCleanup(() => {
      window.removeEventListener("chart-open-settings", onOpenSettings);
      window.removeEventListener("chart-save-template", onSaveTemplate);
      window.removeEventListener("chart-apply-template", onApplyTemplate);
      window.removeEventListener("chart-remove-template", onRemoveTemplate);
      window.removeEventListener("chart-clear-indicators", onClearIndicators);
      window.removeEventListener("chart-open-panel", onOpenPanel);
      window.removeEventListener("chart-open-alert-dialog", onOpenAlertDialog);
      window.removeEventListener("chart-patch-scale-settings", onPatchScaleSettings);
      window.removeEventListener("chart-set-session", onSetSession);
      window.removeEventListener("chart-set-timezone", onSetTimezone);
      window.removeEventListener("chart-open-indicators", onOpenIndicators);
    });

    // Start the alert engine and surface fires as a transient toast. ONE
    // engine per app, not per window: detached chart windows load this same
    // bundle, and a second engine would duplicate every fire (sound, toast,
    // OS notification, webhook POST) and race the shared kv fire log. The
    // backend names the window that runs it (another one takes over when it
    // is closed). The other windows still read the store for their alert UI.
    whenAlertLeader(windowLabel, () => startAlertEngine(windowLabel));
    let toastSeq = 0;
    const offFire = onAlertFire((f) => {
      setAlertToasts((list) => [...list, { id: `${f.time}-${++toastSeq}`, alertId: f.alertId, symbol: f.symbol, message: f.message, time: f.time, sound: f.sound }]);
    });
    onCleanup(offFire);
  });

  return (
    <div class="flex h-full w-full flex-col">
      <div class="tab-bar" data-tauri-drag-region>
        <TabPanel
          tabs={tabs()}
          activeId={activeTabId()}
          onActivate={activateTab}
          onClose={closeTab}
          onNewTab={newTab}
          onReorder={reorderTab}
          onDuplicate={duplicateTab}
          onCloseOthers={closeOthers}
          onCloseToRight={closeToRight}
          onCopySymbol={copyTabSymbol}
          onDetach={detachTab}
          onDropOnWindow={dropTabOnWindow}
          onReload={reloadTab}
          onTogglePin={togglePinTab}
          onDevTools={openDevTools}
          canDetach={isTauri()}
          onCustomizeTitle={() => setAppSettingsTab("tabs")}
          titleParts={tabTitleParts()}
          onLink={linkTab}
          onUnlink={unlinkTab}
          onToggleChannel={toggleLinkChannel}
        />
        <TabPanelActions
          onOpenAppSettings={() => setAppSettingsTab("general")}
          reopenLabel={reopenLabel()}
          onReopen={() => void reopenClosed()}
        />
        <WindowControls />
      </div>
      {/* Main layout (header toolbar + chart area) | screener split view.
          The split view takes its width from the right; in its fullscreen
          mode the main layout is hidden (kept mounted). */}
      <div class="flex flex-1 flex-row" style={{ "min-height": 0, "min-width": 0 }}>
      <div
        class="flex flex-1 flex-col"
        style={{
          "min-height": 0,
          "min-width": 0,
          overflow: "hidden",
          display: screenerPanel.open() && screenerPanel.fullscreen() ? "none" : undefined,
        }}
      >
      <HeaderToolbar
        symbol={tickerOf(symbol())}
        interval={interval()}
        chartType={chartType()}
        layout={layout()}
        onIntervalChange={setInterval}
        onMenuOpen={openMenuAt}
        onSymbolSearch={() => { setSymbolSearchSeed(null); setSymbolDialogOpen(true); }}
        onOpenIndicators={() => setIndicatorsDialogOpen(true)}
        onToggleFullscreen={() => void toggleFullscreen()}
        onOpenSettings={() => setSettingsDialogOpen(true)}
        onOpenAppSettings={(tab) => setAppSettingsTab(tab)}
        onCreateAlert={() => setAlertDialog({ symbol: symbol() })}
        layoutName={layoutName()}
        layoutDirty={layoutDirty()}
        onSaveLayout={saveActiveLayout}
        onApplyIndicatorTemplate={applyIndicatorTemplate}
        activeLayoutId={activeTab().savedLayoutId}
        onOpenLayout={requestOpenLayout}
        onUndo={undoDrawing}
        onRedo={redoDrawing}
        canUndo={canUndoDrawing()}
        canRedo={canRedoDrawing()}
        undoLabel={undoDrawingLabel()}
        redoLabel={redoDrawingLabel()}
        onCompare={() => setCompareDialogOpen(true)}
      />
      {/* chart-area — flex row: drawing toolbar | chart-pane | right rail.
          Mirrors the mock's `.chart-area` (App.tsx) so the right rail spans
          the full height and the bottom bar lives inside the chart-pane. */}
      <div
        class="flex flex-1 flex-row"
        style={{
          "min-height": 0,
          "min-width": 0,
          "background-color": "var(--ot-chart-bg)",
          position: "relative",
          // 4px separator under the header toolbar — the whole body row
          // (drawing toolbar + chart + rail) sits 4px below the header, the gap
          // revealing the #2e2e2e window background. Mirrors mock `.chart-area`.
          "border-top": "4px solid var(--color-widget-border, #2e2e2e)",
        }}
      >
        <Show when={drawingPanelVisible()}>
        <DrawingToolbar
          armedTool={armedTool()}
          setArmedTool={setArmedTool}
          setArmedGlyph={setArmedGlyph}
          cursorMode={cursorMode()}
          setCursorMode={setCursorMode}
          magnet={magnetOn()}
          setMagnet={setMagnetOn}
          magnetMode={magnetMode()}
          setMagnetMode={setMagnetMode}
          magnetSnapsToIndicators={magnetSnapsToIndicators()}
          setMagnetSnapsToIndicators={setMagnetSnapsToIndicators}
          stayMode={stayMode()}
          setStayMode={setStayMode}
          lockAllActive={lockDrawingsMode()}
          hideAllActive={hideDrawingsMode()}
          indicatorsHidden={indicatorsHidden()}
          onToggleLockAll={toggleLockAll}
          onToggleHideAll={toggleHideAll}
          onToggleHideIndicators={toggleHideIndicators}
          onToggleHideBoth={toggleHideBoth}
          onRemoveAll={removeAllDrawings}
          onRemoveIndicators={removeAllIndicators}
          onRemoveAllObjects={removeAllObjects}
          drawingCount={drawings().length}
          indicatorCount={indicators().length}
          syncMode={syncMode()}
          setSyncMode={setSyncMode}
        />
        </Show>
        {/* chart-pane — flex column: chart canvas stacked over the bottom bar
            (mock's `.chart-pane` > `.chart-pane-canvas` + <BottomBar>). */}
        <div
          class="flex flex-1 flex-col"
          style={{
            "min-width": 0,
            position: "relative",
            // 4px gutters framing the chart on the left (drawing toolbar) and
            // right (watchlist rail) — same #2e2e2e seam as the top. Bottom is
            // the window edge (no gutter). Mirrors mock `.chart-pane`.
            "border-left": "4px solid var(--color-widget-border, #2e2e2e)",
            "border-right": "4px solid var(--color-widget-border, #2e2e2e)",
            // Painted so the 2px seam above the bottom bar (its margin-top)
            // and the rounded chart-card corners show the window background.
            "background-color": "var(--color-widget-border, #2e2e2e)",
          }}
        >
          <div
            class="flex-1"
            style={{
              "background-color": "var(--ot-chart-bg)",
              "min-height": 0,
              position: "relative",
            }}
          >
            <FavoritesToolbar />
            <For each={gridTabIds()}>
              {(tabId) => (
            <Show when={tabById().get(tabId)}>
              {(tab) => (
            <ChartGrid
              shown={tabId === activeTabId()}
              layout={tab().layout}
              panes={tab().panes}
              activePane={tab().activePane}
              setActivePane={setActivePaneIndex}
              maximized={tabId === activeTabId() && maximized()}
              onToggleMaximize={toggleMaximize}
              sizes={tab().layoutSizes?.[tab().layout]}
              onSizes={(sizes) => changeLayoutSizes(tabId, sizes)}
              theme={theme()}
              timeZone={timezone().iana}
              timeZoneLabel={timezone().label}
              drawingsFor={drawingsFor}
              drawingKeyForPane={(p) => drawingKeyFor(p, tabId)}
              onRemoveIndicator={(i, id) => removeIndicatorFromPane(tabId, i, id)}
              onReorderIndicators={(i, ids) => reorderIndicatorsForPane(tabId, i, ids)}
              onIndicatorSettings={(i, id, st) => setIndicatorSettingsForPane(tabId, i, id, st)}
              onCompareChange={(i, id, patch) => patchCompare(tabId, i, id, patch)}
              onRemoveCompare={(i, id) => removeCompare(tabId, i, id)}
              onPaneOrder={(i, order) => setPaneOrderForPane(tabId, i, order)}
              onSourceOrder={(i, order) => setSourceOrderForPane(tabId, i, order)}
              onChangeCompareSymbol={(i, id) => {
                setCompareTarget({ tabId, paneIndex: i, id });
                setSymbolSearchSeed(null);
                setSymbolDialogOpen(true);
              }}
              onVisibleRange={(i, r) => setVisibleRangeForPane(tabId, i, r)}
              linkSyncVisible={tab().panes.length > 1 && (tab().sync.symbol || tab().sync.interval)}
              onLinkGroup={(i, g) => {
                const tab = tabOf(tabId);
                if (!tab) return;
                patchTab(tabId, { panes: tab.panes.map((p, k) => (k === i ? { ...p, linkGroup: g } : p)) });
              }}
              onToggleSeries={(i) => {
                const tab = tabOf(tabId);
                if (!tab) return;
                patchTab(tabId, {
                  panes: tab.panes.map((p, k) => (k === i ? { ...p, seriesHidden: p.seriesHidden ? undefined : true } : p)),
                });
              }}
              onChangeInterval={() => setIntervalDialog({ initVal: interval(), selectOnInit: true })}
              onChangeSymbol={() => {
                // The press focused this pane (ChartGrid capture): the search
                // changes its symbol, like the header symbol button.
                setSymbolSearchSeed(null);
                setSymbolDialogOpen(true);
              }}
              indicatorsHidden={indicatorsHidden()}
              armedTool={armedTool()}
              cursorMode={cursorMode()}
              armedGlyph={armedGlyph()}
              magnet={magnetOn()}
              magnetMode={magnetMode()}
              magnetSnapsToIndicators={magnetSnapsToIndicators()}
              stayMode={stayMode()}
              onPlaceToSymbol={addDrawingToSymbol}
              onDisarm={() => setArmedTool(null)}
              selectedDrawingId={selectedDrawingId()}
              selectedDrawingIds={selectedDrawingIds()}
              setSelectedDrawingId={setSelectedDrawingId}
              toggleSelectedDrawing={toggleSelectedDrawing}
              updateDrawingForSymbol={updateDrawingForSymbol}
              updateDrawingsForSymbol={updateDrawingsForSymbol}
              cloneDrawingForSymbol={cloneDrawingForSymbol}
              reorderDrawingForSymbol={reorderDrawingForSymbol}
              placeDrawingsForSymbol={placeDrawingsForSymbol}
              removeDrawingForSymbol={removeDrawingForSymbol}
              removeDrawingsForSymbol={removeDrawingsForSymbol}
            />
              )}
            </Show>
              )}
            </For>
          </div>
          <Show when={oakPanelOpen()}>
            <OakScriptPanel
              theme={theme()}
              indicators={indicators()}
              onToggleIndicator={toggleScriptOnChart}
              onClose={() => setOakPanelOpen(false)}
            />
          </Show>
          <BottomBar
            interval={interval()}
            setInterval={setInterval}
            session={session()}
            onSessionChange={setSession}
            timezoneLabel={timezone().label}
            timezoneIana={displayTimeZone(timezone().label, timezone().iana, activeFullSymbol() ?? symbol())}
            onTimezoneChange={(e) => setTimezone({ label: e.label, iana: e.iana })}
            maximized={maximized()}
            onToggleMaximize={toggleMaximize}
          />
          {/* Strategy Tester: the reference app's footer report, shown while the
              active chart holds a strategy. */}
          <StrategyTesterPanel
            strategyIds={indicators().filter(isStrategyId)}
            intraday={isIntradayInterval(interval())}
            intervalSec={intervalSeconds(interval())}
            interval={interval()}
            symbol={activeFullSymbol() ?? symbol()}
            properties={(id) => ((activePaneState().indicatorSettings?.[id]?.inputs as Record<string, unknown> | undefined)?.[PROPERTIES_INPUT] ?? {}) as Record<string, unknown>}
            onPatchProperties={(id, patch) => {
              const cur = ((activePaneState().indicatorSettings?.[id]?.inputs as Record<string, unknown> | undefined)?.[PROPERTIES_INPUT] ?? {}) as Record<string, unknown>;
              window.dispatchEvent(new CustomEvent("chart-patch-study-inputs", { detail: { id, patch: { [PROPERTIES_INPUT]: { ...cur, ...patch } } } }));
            }}
            onSettings={(id, tab) => window.dispatchEvent(new CustomEvent("chart-open-study-settings", { detail: { id, tab } }))}
            onAddStrategy={() => window.dispatchEvent(new CustomEvent("chart-open-indicators"))}
            onShowOnChart={(time) => window.dispatchEvent(new CustomEvent("chart-link-time", { detail: { time } }))}
          />
        </div>
        {/* activeSymbol falls back to the bare ticker: most watchlist symbols
            aren't in the static SYMBOLS set, so activeFullSymbol() is undefined
            for them — without this the WatchlistDetail panel gets no symbol and
            stays blank. WatchlistDetail/Watchlist both accept the bare form. */}
        <RightRail
          activeTab={activeRailTab()}
          setActiveTab={onRailTabSelect}
          activeSymbol={activeFullSymbol() ?? symbol()}
          activeTicker={symbol()}
          onSymbolSelect={onSymbolPicked}
          interval={interval()}
          drawings={drawings()}
          selectedDrawingId={selectedDrawingId()}
          setSelectedDrawingId={setSelectedDrawingId}
          updateDrawing={updateDrawing}
          removeDrawing={removeDrawing}
          moveDrawing={moveDrawingToDisplayIndex}
          cloneDrawing={cloneDrawing}
          pressedTab={(id) => id === "screener-dialog-button" && screenerPanel.open()}
        />
      </div>
      </div>
      <Show when={screenerPanel.open()}>
        <ScreenerPanel windowLabel={windowLabel} onSymbolPicked={onSymbolPicked} />
      </Show>
      </div>
      <Show when={openMenu() && currentMenuDef() && anchorRect()}>
        <HeaderMenu
          menu={currentMenuDef()!}
          menuId={openMenu()!}
          anchor={anchorRect()!}
          selectedRowId={selectedRowForOpenMenu()}
          onSelect={onMenuSelect}
          onClose={closeMenu}
        />
      </Show>
      <Show when={layoutNameDialog()}>
        {(dlg) => (
          <LayoutNameDialog
            title={
              dlg().mode === "rename"
                ? "Rename chart layout"
                : dlg().mode === "copy"
                  ? "Copy chart layout"
                  : dlg().mode === "create"
                    ? "Create layout"
                    : "Save new chart layout"
            }
            submitLabel={dlg().mode === "rename" ? "Rename" : dlg().mode === "create" ? "Create" : "Save"}
            initialValue={dlg().initial}
            {...(dlg().mode === "create"
              ? {
                  fieldLabel: "New layout name",
                  placeholder: "My layout",
                  maxLength: 64,
                  checkbox: { label: "Open in new tab", checked: createInNewTab(), onChange: setCreateInNewTab },
                }
              : {})}
            onSubmit={submitLayoutName}
            onClose={() => {
              openAfterNaming = null;
              setLayoutNameDialog(null);
            }}
          />
        )}
      </Show>
      <Show when={templateNameDialogOpen()}>
        <LayoutNameDialog
          title="Save indicator template"
          submitLabel="Save"
          fieldLabel="Template name"
          onSubmit={saveIndicatorTemplateNamed}
          onClose={() => setTemplateNameDialogOpen(false)}
        />
      </Show>
      <DialogHost />
      <Show when={pendingOpenId()}>
        <UnsavedLayoutDialog
          onSave={() => resolvePendingOpen("save")}
          onDontSave={() => resolvePendingOpen("dontSave")}
          onCancel={() => resolvePendingOpen("cancel")}
        />
      </Show>
      <Show when={downloadDataOpen()}>
        <DownloadChartDataDialog onClose={() => setDownloadDataOpen(false)} />
      </Show>
      <Show when={layoutBrowserOpen()}>
        <LayoutBrowserDialog
          layouts={savedLayouts()}
          activeId={activeTab().savedLayoutId}
          summaryOf={summaryOfLayout}
          onOpen={requestOpenLayout}
          onDelete={deleteSavedLayout}
          onToggleFavorite={toggleFavoriteLayout}
          onClose={() => setLayoutBrowserOpen(false)}
        />
      </Show>
      <Show when={intervalDialog()}>
        {(d) => (
          <ChangeIntervalDialog
            initVal={d().initVal}
            selectOnInit={d().selectOnInit}
            current={interval()}
            isSupported={isSupportedResolution}
            onApply={setInterval}
            onClose={() => setIntervalDialog(null)}
          />
        )}
      </Show>
      <Show when={symbolDialogOpen()}>
        <SymbolSearchDialog
          activeSymbol={activeFullSymbol()}
          seedQuery={symbolSearchSeed()}
          onSelect={onSymbolPicked}
          onClose={() => { setSymbolDialogOpen(false); setCompareTarget(null); }}
        />
      </Show>
      <Show when={compareDialogOpen()}>
        <SymbolSearchDialog
          compare={{
            added: compareAdded,
            recent: compareRecent,
            add: (picked, placement) => {
              if (isFullSymbol(picked)) addCompare(picked.toUpperCase(), placement);
              else void toFullSymbol(picked).then((full) => addCompare(full, placement), (e) => console.warn(`[symbol] ${picked}: ${e}`));
            },
            remove: (id) => removeCompare(activeTab().id, activeTab().activePane, id),
          }}
          onSelect={() => {}}
          onClose={() => setCompareDialogOpen(false)}
        />
      </Show>
      <Show when={indicatorsDialogOpen()}>
        <IndicatorsDialog
          onAddIndicator={addIndicator}
          onClose={() => setIndicatorsDialogOpen(false)}
        />
      </Show>
      <Show when={settingsDialogOpen()}>
        <ChartPropertiesDialog
          onClose={() => {
            setSettingsDialogOpen(false);
            setSettingsDialogTab(undefined);
          }}
          initialTab={settingsDialogTab()}
          seed={activeSettingsDraft()}
          chartType={chartType()}
          intraday={isIntradayResolution(interval())}
          symbol={activeFullSymbol() ?? symbol()}
          onCommit={commitChartSettings}
        />
      </Show>
      <Show when={appSettingsTab()}>
        {(initialTab) => (
          <AppSettingsDialog
            initialTab={initialTab()}
            tabParts={tabTitleParts()}
            onTabPartsChange={setTabTitleParts}
            theme={theme()}
            onThemeChange={switchTheme}
            onClose={() => setAppSettingsTab(null)}
          />
        )}
      </Show>
      <Show when={alertDialog()}>
        {(d) => (
          <AlertDialog
            editId={d().editId}
            symbol={d().symbol}
            price={d().price}
            indicatorId={d().indicatorId}
            drawingId={d().drawingId}
            interval={interval()}
            session={session()}
            onClose={() => setAlertDialog(null)}
          />
        )}
      </Show>
      {/* Settings → Alerts → "Automatically hide toasts" (focused pane, default
          on): off keeps a popup until it is closed. */}
      <AlertToasts
        toasts={alertToasts()}
        autoHide={appearanceFrom(activePaneState().settings).autoHideToasts ?? true}
        onRemove={(ids) => setAlertToasts((list) => list.filter((t) => !ids.includes(t.id)))}
        onEdit={(editId) => setAlertDialog({ editId })}
        onSymbol={onSymbolPicked}
      />
    </div>
  );
}

export default App;
