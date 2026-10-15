// Registers the saved-template default hook of the shared drawing core
// before any module reads tool defaults.
import "./window/drawings/templates";
import { createEffect, createMemo, createSignal, For, lazy, onCleanup, onMount, Show } from "solid-js";
import { HeaderToolbar } from "./window/header/HeaderToolbar";
import { HeaderMenu } from "./window/header/HeaderMenu";
import { buildIntervalMenu } from "./window/chart/custom-intervals";
import { HEADER_MENUS } from "./window/header/header-menus/registry";
import { SymbolSearchDialog } from "./window/header/SymbolSearchDialog";
import { ChangeIntervalDialog } from "./window/chart/ChangeIntervalDialog";
import { IndicatorsDialog } from "./window/header/IndicatorsDialog";
import { ChartPropertiesDialog } from "./window/header/ChartPropertiesDialog";
import { appearanceFrom, cloneDraft, saveChartSettingsDefaults, seedDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, type Draft } from "./window/header/chart-settings";
import { activeChartProbe } from "./window/chart/active-chart";
import { openCreateAlertOnSelection } from "./window/shell/create-alert";
import { findTimezone } from "./data/timezones";
import { ChartGrid } from "./window/chart/ChartGrid";
import { layoutFromVariantId, variantIdForLayout, type LayoutId } from "./window/chart/layouts";
import { DrawingToolbar } from "./window/drawings/DrawingToolbar";
import { drawingPanelVisible } from "./data/drawing-panel";
import { FavoritesToolbar } from "./window/drawings/FavoritesToolbar";
import { TabPanel } from "./window/shell/TabPanel";
import { TabPanelActions } from "./window/shell/TabPanelActions";
import { WindowControls } from "./window/shell/WindowControls";
import { reconcilePanes } from "./window/shell/tabs";
import { recordRecentSymbol } from "./data/recent-symbols";
import { AppSettingsDialog } from "./window/header/AppSettingsDialog";
import { AlertDialog } from "./window/alerts/AlertDialog";
import { startAlertEngine, onAlertFire } from "./data/alert-engine";
import { whenAlertLeader } from "./data/alert-backend";
import { AlertToasts, type AlertToastData } from "./window/alerts/AlertToast";
import { loadTabTitleParts, saveTabTitleParts, type TabTitlePartState } from "./window/shell/tab-title";
import { reopenLabel } from "./window/shell/closed-stack";
import { initShellBus } from "./window/shell/shell-bus";
import { currentWindowLabel, initWindowStorageCleanup, isTauri, toggleFullscreen } from "./window/shell/window-bridge";
import { RightRail } from "./window/right-rail/RightRail";
import { BottomBar } from "./window/bottom-bar/BottomBar";
import { OakScriptPanel } from "./window/oakscript/OakScriptPanel";
import { StrategyTesterPanel } from "./window/strategy-tester/StrategyTesterPanel";
import { intervalSeconds } from "./window/strategy-tester/equity-data";
import { PROPERTIES_INPUT, isStrategyId } from "./window/chart/indicators/strategy-entries";
import { ScreenerPanel } from "./window/screener/ScreenerPanel";
import { screenerPanel } from "./data/screener-store";
import { CHART_TYPE_IDS, type ChartTypeId } from "./window/chart/chart-types";
import { isAdjusted, setAdjusted, isFullSymbol, isIntradayInterval, isIntradayResolution, isSupportedResolution, tickerOf, toFullSymbol, type SessionId } from "./data/datafeed";
import { displayTimeZone } from "./data/session";
import { LayoutNameDialog } from "./window/header/LayoutNameDialog";
import { DialogHost } from "./components/Dialogs";
import { buildFavoriteIndicatorsMenu } from "./data/indicator-favorites";
import { OAKSCRIPT_OPEN_EVENT } from "./window/chart/indicators/user-scripts";
import * as oakScripts from "./data/oakscript-store";
import { APPLY_TEMPLATE_PREFIX, buildIndicatorTemplatesMenu, SAVE_TEMPLATE_ROW_ID } from "./data/indicator-template-store";
import { buildSaveLoadMenu, layoutAutosave } from "./data/layout-store";
import { emitAppEvent, onAppEvent } from "./data/app-events";
import { setTimezone, timezone } from "./data/chart-timezone";
import { createAppTheme, createChartThemeSync } from "./window/shell/app-theme";
import { createAppTabs } from "./window/shell/app-tabs";
import { createTabLinkSync } from "./window/shell/tab-link-sync";
import { createSavedLayouts } from "./window/shell/saved-layouts";
import { LayoutNamingDialog, SavedLayoutDialogs } from "./window/shell/SavedLayoutDialogs";
import { createUndoHistory } from "./window/shell/undo-history";
import { createChartEdits } from "./window/shell/chart-edits";
import { installKeyboardShortcuts } from "./window/shell/keyboard-shortcuts";
import { installAppRequests } from "./window/shell/app-requests";
import { installLayoutSources } from "./window/shell/layout-sources";
import { installSourceEdits } from "./window/shell/source-edits";
import { createDrawingStore } from "./window/drawings/drawing-store";
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
  compareDialogOpen,
  compareTarget,
  indicatorsDialogOpen,
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
  setIntervalDialog,
  setOakPanelOpen,
  setSettingsDialogOpen,
  setSettingsDialogTab,
  setSymbolDialogOpen,
  setTemplateNameDialogOpen,
  settingsDialogOpen,
  settingsDialogTab,
  symbolDialogOpen,
  symbolSearchSeed,
  templateNameDialogOpen,
} from "./window/shell/app-dialogs";

function App() {
  // App theme, set before the charts are created (see app-theme.ts).
  const { theme, observeTheme } = createAppTheme();

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

  // Reap localStorage for closed detached/new windows: non-main windows clear
  // themselves on close; the main window sweeps orphans at launch.
  let disposeStorageCleanup = () => {};
  onMount(() => {
    void initWindowStorageCleanup(windowLabel).then((d) => {
      disposeStorageCleanup = d;
    });
  });
  onCleanup(() => disposeStorageCleanup());

  // Tab-title parts (App Settings → Tabs).
  const [tabTitleParts, setTabTitlePartsRaw] = createSignal<TabTitlePartState[]>(loadTabTitleParts());
  const setTabTitleParts = (p: TabTitlePartState[]) => { setTabTitlePartsRaw(p); saveTabTitleParts(p); };

  // ── App theme and chart theme ──────────────────────────────────────────
  const { switchTheme } = createChartThemeSync(theme, appTabs);

  const interval = () => activePaneState().interval;

  // ── Tab syncing (colour link) ──────────────────────────────────────────
  const { broadcastLink, linkTab, unlinkTab, toggleLinkChannel } = createTabLinkSync(appTabs, windowLabel);

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
  const undo = createUndoHistory((e, side) => chartEdits.applyUndoEntry(e, side));
  appTabs.migrateBareSymbols();
  const drawingStore = createDrawingStore(appTabs, undo);
  const {
    drawingKeyFor,
    drawingsFor,
    drawings,
    addDrawingToSymbol,
    updateDrawingForSymbol,
    removeDrawingForSymbol,
    updateDrawingsForSymbol,
    removeDrawingsForSymbol,
    cloneDrawingForSymbol,
    updateDrawing,
    removeDrawing,
    cloneDrawing,
    drawingSyncForSymbol,
    setDrawingsSyncForSymbol,
    toggleHide,
    toggleLock,
    removeAllDrawings,
    reorderDrawingForSymbol,
    placeDrawingsForSymbol,
    moveDrawingToDisplayIndex,
  } = drawingStore;
  const chartEdits = createChartEdits(appTabs, undo, drawingStore);
  const {
    removeIndicatorFromPane,
    reorderIndicatorsForPane,
    setIndicatorSettingsForPane,
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
    setPaneOrderForPane,
    setSeriesPaneForPane,
    setSourceOrderForPane,
    setPaneLinkGroup,
    toggleSeriesHidden,
  } = chartEdits;
  function removeAllObjects() {
    removeAllDrawings();
    removeAllIndicators();
  }

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

  // ── Header dropdowns ───────────────────────────────────────────────────
  function onMenuSelect(rowId: string) {
    const which = openMenu();
    if (which === "chart-interval") {
      setInterval(rowId);
    } else if (which === "candles" && CHART_TYPE_IDS.has(rowId as ChartTypeId)) {
      setChartType(rowId as ChartTypeId);
    } else if (which === "layout-setup") {
      setLayout(layoutFromVariantId(rowId));
    } else if (which === "save-load-menu") {
      layouts.onManageLayoutsSelect(rowId);
    } else if (which === "take-a-snapshot") {
      // Snapshot menu (the link and tweet rows are cloud actions, not
      // offered). "Open in new tab" opens the PNG in the OS default viewer
      // (temp file via the open_snapshot command).
      if (rowId === "save-chart-image") {
        emitAppEvent("chart-snapshot", { action: "download" });
      } else if (rowId === "copy-chart-image") {
        emitAppEvent("chart-snapshot", { action: "copy" });
      } else if (rowId === "open-image-in-new-tab") {
        emitAppEvent("chart-snapshot", { action: "open" });
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
        summaryOf: layouts.summaryOfLayout,
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
    // Edits of one source (visual order, visibility, Move to, Pin to scale, settings): undo steps.
    onCleanup(installSourceEdits(appTabs, undo));

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
          reopenLabel={reopenLabel()}
          onReopen={() => void appTabs.reopenClosed()}
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
        onSymbolSearch={() => openSymbolSearch(null)}
        onOpenIndicators={() => setIndicatorsDialogOpen(true)}
        onToggleFullscreen={() => void toggleFullscreen()}
        onOpenSettings={() => setSettingsDialogOpen(true)}
        onOpenAppSettings={(tab) => setAppSettingsTab(tab)}
        onCreateAlert={() => openCreateAlertOnSelection(symbol())}
        layoutName={layoutName()}
        layoutDirty={layoutDirty()}
        onSaveLayout={saveActiveLayout}
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
              onSeriesPane={(i, group) => setSeriesPaneForPane(tabId, i, group)}
              onSourceOrder={(i, order) => setSourceOrderForPane(tabId, i, order)}
              onChangeCompareSymbol={(i, id) => {
                setCompareTarget({ tabId, paneIndex: i, id });
                openSymbolSearch(null);
              }}
              onVisibleRange={(i, r) => setVisibleRangeForPane(tabId, i, r)}
              linkSyncVisible={tab().panes.length > 1 && (tab().sync.symbol || tab().sync.interval)}
              onLinkGroup={(i, g) => setPaneLinkGroup(tabId, i, g)}
              onToggleSeries={(i) => toggleSeriesHidden(tabId, i)}
              onChangeInterval={() => setIntervalDialog({ initVal: interval(), selectOnInit: true })}
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
              onPlaceToSymbol={addDrawingToSymbol}
              onDisarm={() => setArmedTool(null)}
              selectedDrawingId={selectedDrawingId()}
              selectedDrawingIds={selectedDrawingIds()}
              setSelectedDrawingId={setSelectedDrawingId}
              toggleSelectedDrawing={toggleSelectedDrawing}
              updateDrawingForSymbol={updateDrawingForSymbol}
              updateDrawingsForSymbol={updateDrawingsForSymbol}
              cloneDrawingForSymbol={cloneDrawingForSymbol}
              drawingSyncForSymbol={drawingSyncForSymbol}
              setDrawingsSyncForSymbol={setDrawingsSyncForSymbol}
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
              onAddIndicator={addIndicator}
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
              emitAppEvent("chart-patch-study-inputs", { id, patch: { [PROPERTIES_INPUT]: { ...cur, ...patch } } });
            }}
            onSettings={(id, tab) => emitAppEvent("chart-open-study-settings", { id, tab })}
            onAddStrategy={() => emitAppEvent("chart-open-indicators")}
            onShowOnChart={(time) => emitAppEvent("chart-link-time", { time })}
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
          onAddCompare={addCompareFromList}
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
