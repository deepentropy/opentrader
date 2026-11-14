// Registers the saved-template default hook of the shared drawing core
// before any module reads tool defaults.
import { track } from "./data/analytics";
import "./window/drawings/templates";
import { batch, createEffect, createMemo, createSignal, For, lazy, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { HeaderToolbar } from "./window/header/HeaderToolbar";
import { HeaderMenu } from "./window/header/HeaderMenu";
import { buildIntervalMenu } from "./window/chart/custom-intervals";
import { HEADER_MENUS, type HeaderMenuDef } from "./window/header/header-menus/registry";
import { SymbolSearchDialog } from "./window/header/SymbolSearchDialog";
import { ChangeIntervalDialog } from "./window/chart/ChangeIntervalDialog";
import { IndicatorsDialog } from "./window/header/IndicatorsDialog";
import { ChartPropertiesDialog } from "./window/header/ChartPropertiesDialog";
import { appearanceFrom, cloneDraft, saveChartSettingsDefaults, seedDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, type Draft } from "./window/header/chart-settings";
import { activeChartProbe } from "./window/chart/active-chart";
import { openCreateAlertOnSelection } from "./window/shell/create-alert";
import { findTimezone } from "./data/timezones";
import { ChartGrid } from "./window/chart/ChartGrid";
import { LAYOUT_SPECS, layoutFromVariantId, variantIdForLayout, type LayoutId } from "./window/chart/layouts";
import { DrawingToolbar } from "./window/drawings/DrawingToolbar";
import { drawingPanelVisible } from "./data/drawing-panel";
import { FavoritesToolbar } from "./window/drawings/FavoritesToolbar";
import { TabPanel } from "./window/shell/TabPanel";
import { TabPanelActions } from "./window/shell/TabPanelActions";
import { WindowControls } from "./window/shell/WindowControls";
import { DEFAULT_PANELS, reconcilePanes } from "./window/shell/tabs";
import { recordRecentSymbol } from "./data/recent-symbols";
import { AppSettingsDialog } from "./window/header/AppSettingsDialog";
import { AlertDialog } from "./window/alerts/AlertDialog";
import { startAlertEngine, onAlertFire } from "./data/alert-engine";
import { whenAlertLeader } from "./data/alert-backend";
import { startScreenAlerts } from "./data/screen-alerts";
import { AlertToasts, type AlertToastData } from "./window/alerts/AlertToast";
import { UpdateRequiredBanner } from "./window/shell/UpdateRequiredBanner";
import { loadTabTitleParts, saveTabTitleParts, type TabTitlePartState } from "./window/shell/tab-title";
import { reopenLabel } from "./window/shell/closed-stack";
import { initShellBus } from "./window/shell/shell-bus";
import { currentWindowLabel, initWindowStorageCleanup, isTauri, openScreenerWindow, toggleFullscreen } from "./window/shell/window-bridge";
import { RightRail } from "./window/right-rail/RightRail";
import { BottomBar } from "./window/bottom-bar/BottomBar";
import { OakScriptPanel } from "./window/oakscript/OakScriptPanel";
import { StrategyTesterPanel } from "./window/strategy-tester/StrategyTesterPanel";
import { intervalSeconds } from "./window/strategy-tester/equity-data";
import { PROPERTIES_INPUT, isStrategyId } from "./window/chart/indicators/strategy-entries";
import { ScreenerPanel } from "./window/screener/ScreenerPanel";
import { AssistantPanel } from "./window/assistant/AssistantPanel";
import { assistantPanel } from "./data/assistant/panel";
import { screenerPanel, type ScreenerPlacement } from "./data/screener-store";
import { SCREENER_PLACE_EVENT } from "./window/screener/ScreenerPanel";
import { SCREENER_PICK_EVENT } from "./window/screener/ScreenerWindow";
import { listen } from "@tauri-apps/api/event";
import { CHART_TYPE_IDS, SINGLE_VALUE_TYPES, rememberSingleValueType, type ChartTypeId } from "./window/chart/chart-types";
import { isAdjusted, setAdjusted, isEconomicSymbol, isFullSymbol, isIntradayInterval, isIntradayResolution, isSupportedResolution, symbolServesResolution, tickerOf, toFullSymbol, type SessionId } from "./data/datafeed";
import { displayTimeZone } from "./data/session";
import { tradeJournal } from "./data/trade-journal";
import { chartFrame } from "./data/trade-journal-calc";
import { LayoutNameDialog } from "./window/header/LayoutNameDialog";
import { DialogHost, showNotice } from "./components/Dialogs";
import { startLocalFolderSync } from "./data/local-folders";
import { installDialogDrag } from "./components/dialog-drag";
import { buildFavoriteIndicatorsMenu } from "./data/indicator-favorites";
import { OAKSCRIPT_OPEN_EVENT } from "./window/chart/indicators/user-scripts";
import * as oakScripts from "./data/oakscript-store";
import { APPLY_TEMPLATE_PREFIX, buildIndicatorTemplatesMenu, SAVE_TEMPLATE_ROW_ID } from "./data/indicator-template-store";
import { buildSaveLoadMenu, layoutAutosave } from "./data/layout-store";
import { emitAppEvent, onAppEvent, type AppEvents } from "./data/app-events";
import { setTimezone, timezone } from "./data/chart-timezone";
import { createAppTheme, createChartThemeSync } from "./window/shell/app-theme";
import { createAppTabs } from "./window/shell/app-tabs";
import { createTabLinkSync } from "./window/shell/tab-link-sync";
import { createSavedLayouts } from "./window/shell/saved-layouts";
import { LayoutNamingDialog, SavedLayoutDialogs } from "./window/shell/SavedLayoutDialogs";
import { createUndoHistory, type PaneFields } from "./window/shell/undo-history";
import { createChartEdits } from "./window/shell/chart-edits";
import { installKeyboardShortcuts } from "./window/shell/keyboard-shortcuts";
import { installAppRequests } from "./window/shell/app-requests";
import { installLayoutSources } from "./window/shell/layout-sources";
import { ReplayToolbar } from "./window/replay/ReplayToolbar";
import { replayEnabled, replayToolbarShown, setReplaySessionStore, setReplayTabSource } from "./data/replay";
import { ReplaySettingsDialog } from "./window/replay/ReplaySettingsDialog";
import { ReplayEndDialog } from "./window/replay/ReplayEndDialog";
import { OrderTicket } from "./window/trading/OrderTicket";
import { BrokerPicker } from "./window/trading/BrokerPicker";
import { TradingToasts } from "./window/trading/TradingToasts";
import { tradingUi } from "./data/trading/trading-ui";
import { replayBroker } from "./data/trading/replay-broker";
import { pluginBroker } from "./data/trading/plugin-broker";
import { createDrawingStore } from "./window/drawings/drawing-store";
import { createChartBridge } from "./window/right-rail/community/chart-bridge";
import { setChartBridge } from "./data/community/chart-share";
import { setNotesChartHost } from "./data/symbol-notes";
import { requestShare } from "./data/community/share";
import { selectedDrawingId, selectedDrawingIds, setSelectedDrawingId, toggleSelectedDrawing } from "./window/drawings/drawing-selection";
import {
  alwaysRemoveLocked,
  armedGlyph,
  armedTool,
  cursorMode,
  hideDrawingsMode,
  hideMode,
  indicatorsHidden,
  indicatorsLocked,
  lockDrawingsMode,
  lockMode,
  magnetMode,
  magnetOn,
  magnetSnapsToIndicators,
  setArmedGlyph,
  setArmedTool,
  setCursorMode,
  setMagnetMode,
  setMagnetOn,
  setMagnetSnapsToIndicators,
  setStayMode,
  setSyncMode,
  stayMode,
  syncMode,
  toggleAlwaysRemoveLocked,
} from "./window/drawings/drawing-tools-state";
import {
  activeRailTab,
  alertDialog,
  anchorRect,
  appSettingsTab,
  closeMenu,
  onboardingOpen,
  openFirstStartOnboarding,
  setOnboardingOpen,
  compareDialogOpen,
  compareTarget,
  indicatorsDialogOpen,
  indicatorsParent,
  intervalDialog,
  oakPanelOpen,
  onRailTabSelect,
  openMenu,
  openMenuAt,
  openSymbolSearch,
  setAlertDialog,
  setAppSettingsTab,
  setCompareDialogOpen,
  setCompareTarget,
  setIndicatorsDialogOpen,
  setIndicatorsParent,
  setIntervalDialog,
  setOakPanelOpen,
  setSettingsDialogOpen,
  setSettingsDialogTab,
  setSymbolDialogOpen,
  setTemplateNameDialogOpen,
  settingsDialogOpen,
  showPanels,
  shownPanels,
  settingsDialogTab,
  symbolDialogOpen,
  symbolSearchSeed,
  templateNameDialogOpen,
} from "./window/shell/app-dialogs";

function App() {
  // App theme, set before the charts are created (see app-theme.ts).
  const { theme, themeSetting, setThemeSetting, observeTheme } = createAppTheme();

  // ── Multi-tab shell ───────────────────────────────────────────────────
  // The active tab's fields back the accessor/setter pairs below, so the
  // rest of App reads `symbol()`/`interval()`/… of the focused pane (see
  // app-tabs.ts).
  const windowLabel = currentWindowLabel();
  const appTabs = createAppTabs(windowLabel);
  const {
    tabs,
    activeTabId,
    activeTab,
    tabById,
    gridTabIds,
    patchActive,
    patchActivePane,
    patchAllPanes,
    patchSyncGroupPanes,
    activePaneState,
    setActivePaneIndex,
    layoutSync,
  } = appTabs;

  // Panels are per tab (the reference app): the shown ones are kept in the active tab, a tab switch shows the next
  // tab's (a new tab's: the watchlist only). A tab saved before has none: the panels stay as they were.
  const startPanels = activeTab().panels;
  if (startPanels) showPanels(startPanels);
  createEffect(() => {
    const p = shownPanels();
    untrack(() => {
      const t = activeTab();
      if (JSON.stringify(t.panels) !== JSON.stringify(p)) appTabs.patchTab(t.id, { panels: p });
    });
  });
  createEffect(on(activeTabId, (id) => showPanels(tabById().get(id)?.panels ?? DEFAULT_PANELS), { defer: true }));

  // Reap localStorage for closed detached/new windows: non-main windows clear
  // themselves on close; the main window sweeps orphans at launch.
  let disposeStorageCleanup = () => {};
  onMount(() => {
    void initWindowStorageCleanup(windowLabel).then((d) => {
      disposeStorageCleanup = d;
    });
  });
  onCleanup(() => disposeStorageCleanup());

  onCleanup(installDialogDrag());

  // Tab-title parts (App Settings → Tabs).
  const [tabTitleParts, setTabTitlePartsRaw] = createSignal<TabTitlePartState[]>(loadTabTitleParts());
  const setTabTitleParts = (p: TabTitlePartState[]) => { setTabTitlePartsRaw(p); saveTabTitleParts(p); };

  // ── App theme and chart theme ──────────────────────────────────────────
  createChartThemeSync(theme, appTabs);

  const interval = () => activePaneState().interval;

  // ── Tab syncing (colour link) ──────────────────────────────────────────
  const { broadcastLink, linkTab, unlinkTab, toggleLinkChannel } = createTabLinkSync(appTabs, windowLabel);

  // Symbol / interval honour the Sync-in-layout toggles: when on, the change
  // mirrors to every pane of the layout instead of just the focused one. Either
  // way the change then propagates to colour-linked tabs.
  /** A symbol, interval or chart type change of the active tab's charts, as one undo step (the reference app):
   *  the charts `change` set, before and after. */
  const undoablePaneChange = (field: "symbol" | "interval" | "chartType", label: string, change: () => void) => {
    const tab = activeTab();
    const was = new Map(tab.panes.map((p) => [p.id, p[field]]));
    change();
    const before: Record<string, PaneFields> = {};
    const after: Record<string, PaneFields> = {};
    for (const p of tabById().get(tab.id)?.panes ?? []) {
      if (!was.has(p.id) || was.get(p.id) === p[field]) continue;
      before[p.id] = { [field]: was.get(p.id) };
      after[p.id] = { [field]: p[field] };
    }
    if (Object.keys(after).length) undo.record({ kind: "pane-fields", tabId: tab.id, before, after, label, at: Date.now() });
  };
  const setInterval = (v: string) => {
    // Source-level gate: ignore intervals the datafeed can't serve (ticks,
    // ranges, too large a multiplier). The picker greys these out and
    // getBars rejects them too; this stops the remaining paths — keyboard
    // digit-entry, a stale persisted favourite — from ever applying an
    // unservable id.
    if (!isSupportedResolution(v)) return;
    undoablePaneChange("interval", "change resolution", () => {
      if (layoutSync().interval) patchSyncGroupPanes({ interval: v });
      else patchActivePane({ interval: v });
    });
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
    undoablePaneChange("symbol", "change symbol", () => {
      if (layoutSync().symbol) patchSyncGroupPanes({ symbol: v });
      else patchActivePane({ symbol: v });
    });
    broadcastLink("symbol", v);
  };

  const chartType = () => activePaneState().chartType;
  const setChartType = (v: ChartTypeId) => {
    // A type picked on a close-only symbol is the one such symbols take next.
    if (isEconomicSymbol(activePaneState().symbol)) rememberSingleValueType(v);
    undoablePaneChange("chartType", "change series style", () => patchActivePane({ chartType: v }));
  };
  // Bottom-bar RTH/ETH session — per focused pane (not a layout-sync
  // channel), so it only ever patches the active pane.
  const session = () => activePaneState().session;
  const setSession = (v: SessionId) => patchActivePane({ session: v });
  const layout = () => activeTab().layout;
  // Switching layout grows/shrinks the pane set to the template's cell count.
  const setLayout = (v: LayoutId) => patchActive(reconcilePanes(activeTab(), v));

  // ── Saved chart layouts ("Manage layouts" header dropdown) ───────────────
  // The drawing store is created below (its effects run after the autosave
  // one); the layouts only call it once App is set up.
  const layouts = createSavedLayouts(appTabs, {
    drawingsFor: (key) => drawingStore.drawingsFor(key),
    setSlice: (key, next, meta) => drawingStore.setSlice(key, next, meta),
  });
  const { layoutDirty, layoutName, saveActiveLayout, requestOpenLayout } = layouts;

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
      emitAppEvent("chart-reload-data");
      emitAppEvent("adjusted-changed");
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
  // Popups of the alerts that fired (in addition to the log + sound), oldest first.
  const [alertToasts, setAlertToasts] = createSignal<AlertToastData[]>([]);

  // Active indicators on the chart — an ordered list of library registry ids
  // (see window/chart/indicators/registry.ts). Per-PANE (each chart cell
  // carries its own studies).
  const indicators = () => activePaneState().indicators;

  // ── Undo / redo, drawings, chart edits ─────────────────────────────────
  // Undo entries are applied by the chart edits (created below; only called
  // once App is set up).
  // Each tab has its own Bar Replay; the toolbar shows the shown tab's.
  setReplayTabSource(activeTabId);
  // A Bar Replay left with "Save this replay" is kept on its tab (the layout).
  setReplaySessionStore({
    load: (tabId) => tabById().get(tabId)?.replaySession ?? null,
    save: (tabId, s) => {
      if (tabById().has(tabId)) appTabs.patchTab(tabId, { replaySession: s ?? undefined });
    },
    restoreCharts: (s) => {
      const tab = appTabs.activeTab();
      const panes = tab.panes.map((p) => {
        const c = s.charts.find((x) => x.uid === p.id);
        return c ? { ...p, symbol: c.symbol, interval: c.interval, session: c.session as typeof p.session } : p;
      });
      const first = tab.panes.findIndex((p) => p.id === s.charts[0]?.uid);
      appTabs.patchTab(tab.id, { panes, ...(first >= 0 ? { activePane: first } : {}) });
    },
  });
  const undo = createUndoHistory((e, side) => chartEdits.applyUndoEntry(e, side));
  // Replay trading settings changes are undo steps.
  replayBroker.setSettingsUndo((paneId, before, after, label) => undo.commit({ kind: "replay-settings", paneId, before, after, label, at: Date.now() }));
  appTabs.migrateBareSymbols();
  appTabs.followCloseOnlyTypes();
  const drawingStore = createDrawingStore(appTabs, undo);
  const {
    drawings,
    updateDrawing,
    removeDrawing,
    cloneDrawing,
    toggleHide,
    toggleLock,
    removeAllDrawings,
    moveDrawingToDisplayIndex,
  } = drawingStore;
  const chartEdits = createChartEdits(appTabs, undo, drawingStore);
  const {
    patchStudyInputs,
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
  } = chartEdits;
  function removeAllObjects() {
    removeAllDrawings();
    removeAllIndicators();
  }

  // App onboarding (loaded when shown): once on the desktop app's first start,
  // in the main window; then from the main menu.
  const AppOnboarding = lazy(() => import("./window/shell/AppOnboarding").then((m) => ({ default: m.AppOnboarding })));
  onMount(() => { if (isTauri() && windowLabel === "main") openFirstStartOnboarding(); });

  // Synced folders of CSV files (#267): the main window keeps them in sync.
  onMount(() => {
    if (isTauri() && windowLabel === "main") onCleanup(startLocalFolderSync((text) => showNotice({ title: "Local data", text })));
  });

  // Main series / compared symbol menu "Symbol info…" (loaded on first use).
  const SymbolInfoDialog = lazy(() => import("./window/chart/SymbolInfoDialog").then((m) => ({ default: m.SymbolInfoDialog })));
  const [symbolInfoFor, setSymbolInfoFor] = createSignal<string | null>(null);
  onCleanup(onAppEvent("chart-open-symbol-info", (d) => { if (d?.symbol) setSymbolInfoFor(d.symbol); }));

  // Legend "Source code": the script becomes the editor's current one and the
  // panel opens (an open panel switches to it itself).
  onCleanup(
    onAppEvent(OAKSCRIPT_OPEN_EVENT, (d) => {
      const id = d?.scriptId;
      if (!id) return;
      oakScripts.setCurrentScriptId(id);
      if (!oakPanelOpen()) setOakPanelOpen(true);
    }),
  );

  /** The focused pane's full name "EXCHANGE:TICKER" (the pane symbol itself
   *  once saved bare tickers are migrated, see app-tabs.ts). */
  const activeFullSymbol = (): string | undefined => {
    const s = symbol();
    return s && isFullSymbol(s) ? s : undefined;
  };

  // Trade journal: a trade goes to the active chart (its symbol, the interval
  // that fits it when asked), then the chart frames it once loaded.
  tradeJournal.setNavigator((r) => {
    batch(() => {
      if (symbol() !== r.symbol) setSymbol(r.symbol);
      if (r.interval && r.interval !== interval() && symbolServesResolution(r.symbol, r.interval)) setInterval(r.interval);
    });
    const { from, to } = chartFrame(r, interval());
    emitAppEvent("chart-show-range", { from, to, replayAt: r.replayAt, done: r.onFramed });
  });
  onCleanup(() => tradeJournal.setNavigator(null));

  // Symbol notes (#301): a note keeps the shown charts; a click on it puts them back, each chart framed on its span
  // once its data is in (the charts a larger template adds listen from their first frame).
  setNotesChartHost({
    view: () => {
      const tab = activeTab();
      if (!tab.isChart) return null;
      const q: AppEvents["chart-view-query"] = { ranges: {} };
      emitAppEvent("chart-view-query", q);
      return {
        layout: tab.layout,
        activePane: tab.activePane,
        panes: tab.panes.map((p, i) => ({ symbol: p.symbol, interval: p.interval, ...q.ranges[i] })),
      };
    },
    show: (view) => {
      if (!(view.layout in LAYOUT_SPECS)) return;
      batch(() => {
        const r = reconcilePanes(activeTab(), view.layout as LayoutId);
        const panes = r.panes.map((p, i) => {
          const v = view.panes[i];
          if (!v) return p;
          const next = { ...p, symbol: v.symbol, interval: symbolServesResolution(v.symbol, v.interval) ? v.interval : p.interval };
          // The chart's own last view would frame it after its data loads: the note's span does.
          if (v.from !== undefined) {
            delete next.visibleLogicalRange;
            delete next.initialScale;
          }
          return next;
        });
        patchActive({ ...r, panes, activePane: Math.min(view.activePane, panes.length - 1) });
      });
      setTimeout(() => {
        view.panes.forEach((v, i) => {
          const p = activeTab().panes[i];
          if (p && v.from !== undefined && v.to !== undefined)
            emitAppEvent("chart-show-range", { from: v.from, to: v.to, paneIndex: i, series: `${p.symbol}|${p.interval}` });
        });
      }, 0);
    },
  });
  onCleanup(() => setNotesChartHost(null));

  // The order ticket's default symbol; it closes with Bar Replay.
  createEffect(() => tradingUi.setActiveSymbol(activeFullSymbol() ?? symbol()));
  // A tab switch only hides it: the tab left keeps its replay.
  createEffect(
    on([activeTabId, replayEnabled], ([tab, on], prev) => {
      // A connected broker plugin keeps it.
      if (!on && (!prev || prev[0] === tab) && !pluginBroker.status()?.active) tradingUi.closeTicket();
    }),
  );

  // The screener in its own window: opening it (the rail button) opens or raises the window; its row picks change
  // this window's chart (the main window only).
  createEffect(() => {
    if (screenerPanel.open() && screenerPanel.placement() === "window") {
      openScreenerWindow();
      screenerPanel.setOpen(false);
    }
  });
  if (windowLabel === "main" && isTauri()) {
    const off = listen<{ ticker: string }>(SCREENER_PICK_EVENT, (e) => onSymbolPicked(e.payload.ticker));
    const offPlace = listen<{ placement: ScreenerPlacement }>(SCREENER_PLACE_EVENT, (e) => {
      screenerPanel.setPlacement(e.payload.placement);
      screenerPanel.setOpen(true);
    });
    onCleanup(() => {
      void off.then((f) => f());
      void offPlace.then((f) => f());
    });
  }

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

  onMount(() => onCleanup(initShellBus({ stripIndexAt: appTabs.stripIndexAt, insertTab: appTabs.insertTab })));

  // Settings > Coding agents: the agent tool calls the endpoint hands this window (src/agent/), and the AI assistant
  // panel's.
  onMount(() => {
    if (!isTauri()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void Promise.all([import("./agent/bridge"), import("./data/assistant/session")]).then(([{ createAgentServer, installAgentBridge }, { setAssistantHost }]) => {
      if (gone) return;
      const server = createAgentServer({
        tabs: appTabs,
        edits: chartEdits,
        drawings: drawingStore,
        setSymbol: (full) => {
          recordRecentSymbol("search", full);
          setSymbol(full);
        },
        setInterval,
        layouts,
      });
      // The AI assistant panel runs the same tools in this window.
      setAssistantHost(server);
      stop = installAgentBridge(server);
    });
    onCleanup(() => {
      gone = true;
      stop?.();
    });
  });

  // Community: the active chart attached to a post, a shared chart opened on it (#206).
  onMount(() => {
    setChartBridge(
      createChartBridge({
        tabs: appTabs,
        drawings: drawingStore,
        setSymbol: (full) => {
          recordRecentSymbol("search", full);
          setSymbol(full);
        },
        setInterval,
      }),
    );
    onCleanup(() => setChartBridge(null));
  });

  // ── Header dropdowns ───────────────────────────────────────────────────
  /** Snapshot menu rows (the link and tweet rows are cloud actions, not offered). "Open in new tab" opens the PNG
   *  in the OS default viewer (temp file via the open_snapshot command). */
  const snapshotRows: Record<string, () => void> = {
    "save-chart-image": () => emitAppEvent("chart-snapshot", { action: "download" }),
    "copy-chart-image": () => emitAppEvent("chart-snapshot", { action: "copy" }),
    "open-image-in-new-tab": () => emitAppEvent("chart-snapshot", { action: "open" }),
    "share-to-community": () => requestShare({ attach: true }),
    "snapshot-to-community": () => requestShare({ snapshotOnly: true }),
  };

  /** Each header dropdown in one place: its rows when they come from live state (otherwise the registry entry), the
   *  row shown as the current choice, and what picking a row does. A menu missing here only shows its rows. */
  const headerMenus: Record<string, { build?: () => HeaderMenuDef; selected?: () => string | undefined; onSelect?: (rowId: string) => void }> = {
    "chart-interval": { build: buildIntervalMenu, selected: interval, onSelect: setInterval },
    candles: {
      selected: chartType,
      onSelect: (rowId) => {
        if (CHART_TYPE_IDS.has(rowId as ChartTypeId)) setChartType(rowId as ChartTypeId);
      },
    },
    "layout-setup": { selected: () => variantIdForLayout(layout()), onSelect: (rowId) => setLayout(layoutFromVariantId(rowId)) },
    "save-load-menu": {
      // Built from the live autosave state and the saved-layouts list.
      build: () =>
        buildSaveLoadMenu({
          activeId: activeTab().savedLayoutId,
          autosave: layoutAutosave(),
          dirty: layoutDirty(),
          summaryOf: layouts.summaryOfLayout,
        }),
      onSelect: (rowId) => layouts.onManageLayoutsSelect(rowId),
    },
    "take-a-snapshot": { onSelect: (rowId) => snapshotRows[rowId]?.() },
    // A favourite row adds that study to the focused pane (one more instance when it is already on the chart).
    "show-favorite-indicators": { build: buildFavoriteIndicatorsMenu, onSelect: (rowId) => addIndicator(rowId) },
    "indicator-templates": {
      build: buildIndicatorTemplatesMenu,
      onSelect: (rowId) => {
        if (rowId === SAVE_TEMPLATE_ROW_ID) setTemplateNameDialogOpen(true);
        else if (rowId.startsWith(APPLY_TEMPLATE_PREFIX)) applyIndicatorTemplate(rowId.slice(APPLY_TEMPLATE_PREFIX.length));
      },
    },
  };

  function onMenuSelect(rowId: string) {
    const id = openMenu();
    if (id) headerMenus[id]?.onSelect?.(rowId);
  }

  /** Rows of the open dropdown. */
  function currentMenuDef(): HeaderMenuDef | undefined {
    const id = openMenu();
    if (!id) return undefined;
    return headerMenus[id]?.build?.() ?? HEADER_MENUS[id];
  }

  function selectedRowForOpenMenu(): string | undefined {
    const id = openMenu();
    return id ? headerMenus[id]?.selected?.() : undefined;
  }

  onMount(() => {
    observeTheme();

    onCleanup(
      installKeyboardShortcuts({
        tabs: appTabs,
        symbol,
        interval,
        session,
        setSession,
        undo: undo.undo,
        redo: undo.redo,
        saveLayout: () => saveActiveLayout(),
        openLayoutBrowser: () => layouts.setLayoutBrowserOpen(true),
      }),
    );

    onCleanup(
      installAppRequests({
        tabs: appTabs,
        activeSettingsDraft,
        commitChartSettings,
        removeAllIndicators,
        setSession,
      }),
    );
    // Chart menus: sources added / applied to the entire layout, pasted
    // sources, "Move chart".
    onCleanup(installLayoutSources(appTabs, undo, drawingStore));

    // Start the alert engine and surface fires as a transient toast. ONE
    // engine per app, not per window: detached chart windows load this same
    // bundle, and a second engine would duplicate every fire (sound, toast,
    // OS notification, webhook POST) and race the shared kv fire log. The
    // backend names the window that runs it (another one takes over when it
    // is closed). The other windows still read the store for their alert UI.
    whenAlertLeader(windowLabel, () => {
      startAlertEngine(windowLabel);
      startScreenAlerts();
    });
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
          onActivate={appTabs.activateTab}
          onClose={appTabs.closeTab}
          onNewTab={appTabs.newTab}
          onReorder={appTabs.reorderTab}
          onDuplicate={appTabs.duplicateTab}
          onCloseOthers={appTabs.closeOthers}
          onCloseToRight={appTabs.closeToRight}
          onCopySymbol={appTabs.copyTabSymbol}
          onDetach={appTabs.detachTab}
          onDropOnWindow={appTabs.dropTabOnWindow}
          onReload={appTabs.reloadTab}
          onTogglePin={appTabs.togglePinTab}
          onDevTools={appTabs.openDevTools}
          canDetach={isTauri()}
          onCustomizeTitle={() => setAppSettingsTab("tabs")}
          titleParts={tabTitleParts()}
          onLink={linkTab}
          onUnlink={unlinkTab}
          onToggleChannel={toggleLinkChannel}
        />
        <TabPanelActions
          onOpenAppSettings={() => setAppSettingsTab("general")}
          onNewTab={appTabs.newTab}
          reopenLabel={reopenLabel()}
          onReopen={() => void appTabs.reopenClosed()}
          themeSetting={themeSetting()}
          onThemeChange={setThemeSetting}
        />
        <WindowControls />
      </div>
      {/* Main layout (header toolbar + chart area) | screener split view.
          The split view takes its width from the right; in its fullscreen
          mode the main layout is hidden (kept mounted). The panels keep their
          places right to left (ot-panel-row, styles/rtl.css). */}
      <div class="ot-panel-row flex flex-1 flex-row" style={{ "min-height": 0, "min-width": 0, position: "relative" }}>
      <div
        class="flex flex-1 flex-col"
        style={{
          "min-height": 0,
          "min-width": 0,
          overflow: "hidden",
          display: screenerPanel.open() && screenerPanel.placement() === "right" && screenerPanel.fullscreen() ? "none" : undefined,
        }}
      >
      <HeaderToolbar
        symbol={tickerOf(symbol())}
        interval={interval()}
        chartType={chartType()}
        onChartTypeChange={setChartType}
        chartTypeAvailable={(id) => !isEconomicSymbol(activeFullSymbol() ?? symbol()) || SINGLE_VALUE_TYPES.has(id)}
        layout={layout()}
        onIntervalChange={setInterval}
        intervalAvailable={(id) => symbolServesResolution(activeFullSymbol() ?? symbol(), id)}
        onMenuOpen={openMenuAt}
        onSymbolSearch={() => openSymbolSearch(null)}
        onOpenIndicators={() => {
          setIndicatorsParent(null);
          setIndicatorsDialogOpen(true);
        }}
        onToggleFullscreen={() => void toggleFullscreen()}
        onOpenSettings={() => setSettingsDialogOpen(true)}
        onOpenAppSettings={(tab) => setAppSettingsTab(tab)}
        onCreateAlert={() => openCreateAlertOnSelection(symbol())}
        layoutName={layoutName()}
        layoutDirty={layoutDirty()}
        onSaveLayout={() => {
          track("layout_saved");
          saveActiveLayout();
        }}
        onApplyIndicatorTemplate={applyIndicatorTemplate}
        activeLayoutId={activeTab().savedLayoutId}
        onOpenLayout={requestOpenLayout}
        onUndo={undo.undo}
        onRedo={undo.redo}
        canUndo={undo.canUndo()}
        canRedo={undo.canRedo()}
        undoLabel={undo.undoLabel()}
        redoLabel={undo.redoLabel()}
        onCompare={() => setCompareDialogOpen(true)}
      />
      {/* chart-area — flex row: drawing toolbar | chart-pane | right rail.
          Mirrors the mock's `.chart-area` (App.tsx) so the right rail spans
          the full height and the bottom bar lives inside the chart-pane. */}
      <div
        class="ot-panel-row flex flex-1 flex-row"
        style={{
          "min-height": 0,
          "min-width": 0,
          "background-color": "var(--ot-chart-bg)",
          position: "relative",
          // 4px separator under the header toolbar — the whole body row
          // (drawing toolbar + chart + rail) sits 4px below the header, the gap
          // revealing the #2e2e2e window background. Mirrors mock `.chart-area`.
          "border-top": "4px solid var(--color-widget-border)",
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
          hideMode={hideMode()}
          hidden={{ drawings: hideDrawingsMode(), indicators: indicatorsHidden() }}
          onToggleHide={toggleHide}
          lockMode={lockMode()}
          locked={{ drawings: lockDrawingsMode(), indicators: indicatorsLocked() }}
          onToggleLock={toggleLock}
          onRemoveAll={removeAllDrawings}
          onRemoveIndicators={removeAllIndicators}
          onRemoveAllObjects={removeAllObjects}
          alwaysRemoveLocked={alwaysRemoveLocked()}
          onToggleAlwaysRemoveLocked={toggleAlwaysRemoveLocked}
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
            "border-inline": "4px solid var(--color-widget-border)",
            // Painted so the 2px seam above the bottom bar (its margin-top)
            // and the rounded chart-card corners show the window background.
            "background-color": "var(--color-widget-border)",
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
              tabId={tabId}
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
              chartEdits={chartEdits}
              drawingStore={drawingStore}
              onChangeCompareSymbol={(i, id) => {
                setCompareTarget({ tabId, paneIndex: i, id });
                openSymbolSearch(null);
              }}
              linkSyncVisible={tab().panes.length > 1 && (tab().sync.symbol || tab().sync.interval)}
              onChangeInterval={() => setIntervalDialog({ initVal: interval(), selectOnInit: true })}
              onSetInterval={setInterval}
              onChangeSymbol={() => {
                // The press focused this pane (ChartGrid capture): the search
                // changes its symbol, like the header symbol button.
                openSymbolSearch(null);
              }}
              indicatorsHidden={indicatorsHidden()}
              indicatorsLocked={indicatorsLocked()}
              armedTool={armedTool()}
              cursorMode={cursorMode()}
              armedGlyph={armedGlyph()}
              magnet={magnetOn()}
              magnetMode={magnetMode()}
              magnetSnapsToIndicators={magnetSnapsToIndicators()}
              stayMode={stayMode()}
              onDisarm={() => setArmedTool(null)}
              selectedDrawingId={selectedDrawingId()}
              selectedDrawingIds={selectedDrawingIds()}
              setSelectedDrawingId={setSelectedDrawingId}
              toggleSelectedDrawing={toggleSelectedDrawing}
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
              onAddIndicator={addIndicator}
              onClose={() => setOakPanelOpen(false)}
            />
          </Show>
          {/* The screener placed in the bottom panel (its title menu, Placement). */}
          <Show when={screenerPanel.open() && screenerPanel.placement() === "bottom"}>
            <ScreenerPanel windowLabel={windowLabel} onSymbolPicked={onSymbolPicked} dock="bottom" />
          </Show>
          {/* Bar Replay toolbar, above the bottom bar while replay is on. */}
          <Show when={replayToolbarShown()}>
            <ReplayToolbar />
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
            replayTab={replayToolbarShown()}
            strategyIds={indicators().filter(isStrategyId)}
            intraday={isIntradayInterval(interval())}
            intervalSec={intervalSeconds(interval())}
            interval={interval()}
            chartStyle={activePaneState().chartType}
            symbol={activeFullSymbol() ?? symbol()}
            properties={(id) => ((activePaneState().indicatorSettings?.[id]?.inputs as Record<string, unknown> | undefined)?.[PROPERTIES_INPUT] ?? {}) as Record<string, unknown>}
            onPatchProperties={(id, patch) => {
              const cur = ((activePaneState().indicatorSettings?.[id]?.inputs as Record<string, unknown> | undefined)?.[PROPERTIES_INPUT] ?? {}) as Record<string, unknown>;
              const tab = activeTab();
              patchStudyInputs(tab.id, tab.activePane, id, { [PROPERTIES_INPUT]: { ...cur, ...patch } });
            }}
            onSettings={(id, tab) => emitAppEvent("chart-open-study-settings", { id, tab })}
            onAddStrategy={() => emitAppEvent("chart-open-indicators")}
            onShowOnChart={(time) => emitAppEvent("chart-link-time", { time })}
            onSymbol={setSymbol}
            timeZone={{ label: timezone().label, iana: displayTimeZone(timezone().label, timezone().iana, activeFullSymbol() ?? symbol()) }}
          />
        </div>
        {/* activeSymbol falls back to the bare ticker: most watchlist symbols
            aren't in the static SYMBOLS set, so activeFullSymbol() is undefined
            for them — without this the WatchlistDetail panel gets no symbol and
            stays blank. WatchlistDetail/Watchlist both accept the bare form. */}
        {/* Order ticket (paper trading in Bar Replay, or a connected broker plugin), docked left of the right rail. */}
        <Show when={replayEnabled() || !!pluginBroker.status()?.active}>
          <OrderTicket />
        </Show>
        <RightRail
          activeTab={activeRailTab()}
          setActiveTab={onRailTabSelect}
          activeSymbol={activeFullSymbol() ?? symbol()}
          activeTicker={symbol()}
          onSymbolSelect={onSymbolPicked}
          onAddCompare={addCompareFromList}
          interval={interval()}
          timeZone={displayTimeZone(timezone().label, timezone().iana, activeFullSymbol() ?? symbol())}
          onIntervalSelect={setInterval}
          drawings={drawings()}
          selectedDrawingId={selectedDrawingId()}
          setSelectedDrawingId={setSelectedDrawingId}
          updateDrawing={updateDrawing}
          removeDrawing={removeDrawing}
          moveDrawing={moveDrawingToDisplayIndex}
          cloneDrawing={cloneDrawing}
          pressedTab={(id) =>
            (id === "screener-dialog-button" && screenerPanel.open()) ||
            (id === "trade-journal-button" && tradeJournal.open()) ||
            (id === "assistant-button" && assistantPanel.open())
          }
          collapsedTab={(id) => (id === "screener-dialog-button" && screenerPanel.collapsed()) || (id === "assistant-button" && assistantPanel.collapsed())}
          onOpenAlertSettings={() => setAppSettingsTab("alerts")}
        />
      </div>
      </div>
      <Show when={screenerPanel.open() && screenerPanel.placement() === "right"}>
        <ScreenerPanel windowLabel={windowLabel} onSymbolPicked={onSymbolPicked} />
      </Show>
      {/* AI assistant (desktop: its requests go through Rust). */}
      <Show when={assistantPanel.open() && isTauri()}>
        <AssistantPanel ticker={tickerOf(symbol())} />
      </Show>
      </div>
      <Show when={openMenu() && currentMenuDef() && anchorRect()}>
        <HeaderMenu
          menu={currentMenuDef()!}
          menuId={openMenu()!}
          anchor={anchorRect()!}
          selectedRowId={selectedRowForOpenMenu()}
          intervalAvailable={(id) => symbolServesResolution(activeFullSymbol() ?? symbol(), id)}
          chartTypeAvailable={(id) => !isEconomicSymbol(activeFullSymbol() ?? symbol()) || SINGLE_VALUE_TYPES.has(id as ChartTypeId)}
          onSelect={onMenuSelect}
          onClose={closeMenu}
        />
      </Show>
      <LayoutNamingDialog layouts={layouts} />
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
      <ReplaySettingsDialog />
      <ReplayEndDialog />
      {/* Here, not under the Trade button: leaving replay for a broker hides the button when no plugin is enabled. */}
      <Show when={tradingUi.brokerPicker()}>
        <BrokerPicker />
      </Show>
      <TradingToasts />
      <Show when={symbolInfoFor()}>{(s) => <SymbolInfoDialog symbol={s()} onClose={() => setSymbolInfoFor(null)} />}</Show>
      <SavedLayoutDialogs layouts={layouts} activeId={activeTab().savedLayoutId} />
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
          onAddIndicator={(id) => addIndicator(id, indicatorsParent() ?? undefined)}
          onClose={() => {
            setIndicatorsDialogOpen(false);
            setIndicatorsParent(null);
          }}
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
            themeSetting={themeSetting()}
            onThemeChange={setThemeSetting}
            onClose={() => setAppSettingsTab(null)}
          />
        )}
      </Show>
      <Show when={onboardingOpen()}>
        <AppOnboarding
          theme={theme()}
          themeSetting={themeSetting()}
          onThemeChange={setThemeSetting}
          onClose={() => setOnboardingOpen(false)}
        />
      </Show>
      <Show when={alertDialog()}>
        {(d) => (
          <AlertDialog
            editId={d().editId}
            symbol={d().symbol}
            price={d().price}
            indicatorId={d().indicatorId}
            compareSymbol={d().compareSymbol}
            drawingId={d().drawingId}
            interval={interval()}
            session={session()}
            onClose={() => setAlertDialog(null)}
          />
        )}
      </Show>
      {/* Settings → Alerts → "Automatically hide toasts" (focused pane, default
          on): off keeps a popup until it is closed. */}
      <UpdateRequiredBanner />
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
