// Registers the saved-template default hook of the shared drawing core
// before any module reads tool defaults.
import "./window/drawings/templates";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { HeaderToolbar } from "./window/header/HeaderToolbar";
import { HeaderMenu } from "./window/header/HeaderMenu";
import { HEADER_MENUS } from "./window/header/header-menus/registry";
import { SymbolSearchDialog } from "./window/header/SymbolSearchDialog";
import { ChangeIntervalDialog } from "./window/chart/ChangeIntervalDialog";
import { IndicatorsDialog } from "./window/header/IndicatorsDialog";
import { ChartPropertiesDialog } from "./window/header/ChartPropertiesDialog";
import { appearanceFrom, cloneDraft, patchDraftScales, saveChartSettingsDefaults, seedDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, type ScaleMenuPatch } from "./window/header/chart-settings";
import { activeChartProbe } from "./window/chart/active-chart";
import { TIMEZONES, findTimezone } from "./data/timezones";
import { SYMBOLS } from "./data/symbol-search";
import { ChartGrid } from "./window/chart/ChartGrid";
import { layoutFromVariantId, variantIdForLayout, type LayoutId } from "./window/chart/layouts";
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
  type PaneChart,
  type PaneIndicatorSettings,
  type TabChart,
} from "./window/shell/tabs";
import { AppSettingsDialog, type AppSettingsTabId } from "./window/header/AppSettingsDialog";
import { AlertDialog } from "./window/alerts/AlertDialog";
import { startAlertEngine, onAlertFire } from "./data/alert-engine";
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
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/tv/types";
import type { CursorMode } from "./data/drawing-toolbar";
import { defaultStyleFor } from "lightweight-charts-drawing/tv/specs";
import { labelForKind } from "./window/drawings/labels";
import { loadDrawings, saveDrawings } from "./window/drawings/persistence";
import { RightRail } from "./window/right-rail/RightRail";
import { BottomBar } from "./window/bottom-bar/BottomBar";
import { OakScriptPanel } from "./window/oakscript/OakScriptPanel";
import { CHART_TYPE_IDS, type ChartTypeId } from "./window/chart/chart-types";
import { isAdjusted, isIntradayInterval, isIntradayResolution, isSupportedResolution, type SessionId } from "./data/datafeed";
import { requestDataWindow } from "./data/data-window-store";
import { bindLayoutSync, defaultLayoutSync, rememberCrosshair, reviveLayoutSync, type LayoutSyncKey } from "./window/chart/layout-sync";
import { LayoutNameDialog } from "./window/header/LayoutNameDialog";
import { DialogHost } from "./components/Dialogs";
import { getIndicatorEntry } from "./window/chart/indicators/registry";
import { loadIndicatorDefault } from "./data/indicator-defaults";
import { defaultIndicatorOptions } from "./window/chart/indicators/indicator-options";
import { UnsavedLayoutDialog } from "./window/header/UnsavedLayoutDialog";
import { LayoutBrowserDialog } from "./window/header/LayoutBrowserDialog";
import { buildFavoriteIndicatorsMenu } from "./data/indicator-favorites";
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
  nextUnnamedName,
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
      panes: t.panes.map((p, idx) => (spread || idx === t.activePane ? { ...p, [field]: value } : p)),
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
    // Source-level gate: ignore intervals the datafeed can't serve (tick,
    // 2/3/4/10/45-min, 3H, 3M/6M, custom). The picker greys these out and
    // getBars rejects them too; this stops the remaining paths — keyboard
    // digit-entry, "Add custom interval", a stale persisted favourite — from
    // ever applying an unservable id.
    if (!isSupportedResolution(v)) return;
    if (layoutSync().interval) patchAllPanes({ interval: v });
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
    if (layoutSync().symbol) patchAllPanes({ symbol: v });
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
      const key = drawingKeyFor(p);
      if (!(key in drawings)) drawings[key] = drawingsFor(key);
    }
    return { layout: t.layout, activePane: t.activePane, panes: t.panes, drawings, sync: t.sync };
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
    createSignal<null | { mode: "save" | "rename" | "copy"; initial: string; persist?: boolean }>(null);
  // "Open layout" browser modal (lists every saved layout; load / delete).
  const [layoutBrowserOpen, setLayoutBrowserOpen] = createSignal(false);

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
      panes: l.snapshot.panes.map((p) => ({ ...p, id: p.id ?? newPaneId(), indicators: [...p.indicators], ...revivePaneSettings(p) })),
      activePane: Math.min(l.snapshot.activePane, l.snapshot.panes.length - 1),
      // Layouts saved before per-tab sync keep the tab's current toggles.
      sync: l.snapshot.sync ? reviveLayoutSync(l.snapshot.sync) : activeTab().sync,
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
  // "Create new layout" — reset the active tab to a default single-pane chart
  // and save it under `name`. It is created immediately as "Unnamed" (no
  // prompt); the caller passes nextUnnamedName() for the suffix sequence.
  function createNewLayoutNamed(name: string) {
    const fresh = makeTab();
    patchActive({
      layout: fresh.layout,
      panes: fresh.panes,
      activePane: 0,
      sync: defaultLayoutSync(),
      savedLayoutId: undefined,
      savedLayoutName: undefined,
    });
    const created = createLayout(name, snapshotActive());
    patchActive({ savedLayoutId: created.id, savedLayoutName: created.name });
  }
  // "Download chart data" — the cloud download is unavailable locally, so export
  // the active snapshot as a JSON file the user keeps (a faithful local stand-in).
  function downloadActiveLayout() {
    const data = JSON.stringify({ name: layoutName(), snapshot: snapshotActive() }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${layoutName().replace(/[^\w.-]+/g, "_") || "layout"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function submitLayoutName(name: string) {
    const dlg = layoutNameDialog();
    if (!dlg) return;
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
  // Tab the Settings dialog opens on (axis menus → "More settings…" = Scales).
  const [settingsDialogTab, setSettingsDialogTab] = createSignal<string | undefined>();
  // Create/Edit-alert modal: null = closed; object carries the prefill (symbol +
  // clicked price for new, or editId to edit an existing rule).
  const [alertDialog, setAlertDialog] = createSignal<
    null | { editId?: string; symbol?: string; price?: number }
  >(null);
  // Transient banner shown when an alert fires (in addition to the log + sound).
  const [alertToast, setAlertToast] = createSignal<{ title: string; message: string } | null>(null);
  // Chart display timezone (bottom-bar TimezoneMenu), persisted. Default to the
  // "Exchange" zone (US equities → New York).
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
  // carries its own studies). Setter accepts a value or an updater, mirroring
  // the old createSignal API used by toggleIndicator / clear-indicators, and
  // targets the focused pane.
  const indicators = () => activePaneState().indicators;
  const setIndicators = (v: string[] | ((cur: string[]) => string[])) => {
    const next = typeof v === "function" ? v(activePaneState().indicators) : v;
    patchActivePane({ indicators: next });
  };
  // The per-pane callbacks below name their tab: every opened tab keeps its
  // grid mounted, so a pane writes into its own tab, shown or not.
  const tabOf = (tabId: string) => tabs().find((t) => t.id === tabId);
  /** Remove a study from a SPECIFIC pane (the per-pane legend's trash). */
  function removeIndicatorFromPane(tabId: string, paneIndex: number, id: string) {
    const tab = tabOf(tabId);
    if (!tab) return;
    patchTab(tabId, {
      panes: tab.panes.map((p, i) =>
        i === paneIndex ? { ...p, indicators: p.indicators.filter((x) => x !== id) } : p,
      ),
    });
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
        i === paneIndex ? { ...p, indicatorSettings: { ...p.indicatorSettings, [id]: settings } } : p,
      ),
    });
  }
  /** Persist a pane's settled scroll/zoom anchor (its visible logical range).
   *  The saveTabs effect then writes it to localStorage, so the view survives tab
   *  switches and full reloads (ChartView restores it on data load). No-op when
   *  the range is unchanged, so it doesn't churn the tabs signal on every
   *  programmatic re-frame that reports the same window. */
  function setVisibleRangeForPane(tabId: string, paneIndex: number, range: { from: number; to: number }) {
    const tab = tabOf(tabId);
    if (!tab) return;
    const cur = tab.panes[paneIndex]?.visibleLogicalRange;
    if (cur && cur.from === range.from && cur.to === range.to) return;
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
  // The store is a reactive key→list map; `drawings()` is the FOCUSED pane's
  // slice; `drawingsFor(key)` gives any pane its own slice. Two panes resolving
  // to the same key share the slice, so an edit on one shows on the others.
  const drawingKeyFor = (pane: PaneChart, tabId: string = activeTab().id): string => {
    switch (syncMode()) {
      case "none": return `p:${pane.id}:${pane.symbol}`;
      case "layout": return `l:${tabId}:${pane.symbol}`;
      default: return pane.symbol; // global
    }
  };
  const activeDrawingKey = () => drawingKeyFor(activePaneState());
  const initialKey = activeDrawingKey();
  const [drawingStore, setDrawingStore] = createStore<Record<string, Drawing[]>>({
    [initialKey]: loadDrawings(initialKey),
  });
  const drawingsFor = (key: string): Drawing[] => drawingStore[key] ?? [];
  const drawings = () => drawingsFor(activeDrawingKey());
  // ── Drawing undo/redo (header Undo/Redo + Ctrl+Z / Ctrl+Y) ─────────────
  // Session-scoped snapshot history over the drawing slices: every mutation
  // that flows through setSlice records {key, before, after}. Drag streams
  // (updateDrawing per pointer-move) coalesce into ONE entry via coalesceId +
  // a sliding 800ms window, so one gesture = one undo step. The stack is not
  // persisted with the layout (session-only).
  type DrawingUndoEntry = {
    key: string;
    before: Drawing[];
    after: Drawing[];
    label: string;
    at: number;
    coalesceId?: string;
  };
  const UNDO_CAP = 100;
  const [undoStack, setUndoStack] = createSignal<DrawingUndoEntry[]>([]);
  const [redoStack, setRedoStack] = createSignal<DrawingUndoEntry[]>([]);
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
  ) {
    const stack = undoStack();
    const last = stack[stack.length - 1];
    if (
      meta.coalesceId &&
      last &&
      last.coalesceId === meta.coalesceId &&
      last.key === key &&
      lastEntryEpoch === gestureEpoch &&
      Date.now() - last.at < 800
    ) {
      // Same gesture continuing — extend the open entry (keep its `before`).
      setUndoStack([...stack.slice(0, -1), { ...last, after, at: Date.now() }]);
    } else {
      setUndoStack([
        ...stack.slice(Math.max(0, stack.length - (UNDO_CAP - 1))),
        { key, before, after, label: meta.label, at: Date.now(), coalesceId: meta.coalesceId },
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
  function undoDrawing() {
    const stack = undoStack();
    const e = stack[stack.length - 1];
    if (!e) return;
    setUndoStack(stack.slice(0, -1));
    setRedoStack([...redoStack(), e]);
    restoreSlice(e.key, e.before);
  }
  function redoDrawing() {
    const stack = redoStack();
    const e = stack[stack.length - 1];
    if (!e) return;
    setRedoStack(stack.slice(0, -1));
    setUndoStack([...undoStack(), e]);
    restoreSlice(e.key, e.after);
  }

  /** Replace a scope key's drawings + persist. The per-pane mutators target the
   *  pane's scope key; the focused wrappers (object tree / selected toolbar)
   *  pass `activeDrawingKey()`. `meta` records the change on the undo stack;
   *  pass null for non-user mutations (loading a saved layout). */
  function setSlice(key: string, next: Drawing[], meta?: { label: string; coalesceId?: string } | null) {
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
        const key = drawingKeyFor(p, t.id);
        if (!(key in drawingStore)) setDrawingStore(key, loadDrawings(key));
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

  function removeDrawingForSymbol(key: string, id: string) {
    const victim = drawingsFor(key).find((d) => d.id === id);
    setSlice(key, drawingsFor(key).filter((d) => d.id !== id), {
      label: `remove ${victim ? labelForKind(victim.kind) : "drawing"}`,
    });
    setSelectedDrawingIds((cur) => cur.filter((x) => x !== id));
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
    const set = new Set(ids);
    setSlice(key, drawingsFor(key).filter((d) => !set.has(d.id)), {
      label: `remove ${ids.length} drawings`,
    });
    setSelectedDrawingIds((cur) => cur.filter((id) => !set.has(id)));
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
    setSlice(key, [...drawingsFor(key), cloned], { label: `clone ${labelForKind(src.kind)}` });
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
    setActiveDrawings([], { label: "remove all drawings" });
    setSelectedDrawingId(null);
  }
  /** Remove-objects dropdown actions. Indicators live on the active pane. */
  function removeAllIndicators() {
    setIndicators([]);
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

  /** Full "EXCHANGE:TICKER" form derived from the active ticker, so the
   *  symbol dialog can match the active row by symbolName. */
  const activeFullSymbol = () =>
    SYMBOLS.find((s) => s.ticker === symbol())?.symbolName;

  /** Add/remove an indicator (by registry id). Also the studies-legend trash. */
  function toggleIndicator(id: string) {
    const pane = activePaneState();
    if (pane.indicators.includes(id)) {
      setIndicators((cur) => cur.filter((x) => x !== id));
      return;
    }
    // A newly added study starts with the user's saved default ("Save as
    // default"), else the factory values (a new study never inherits the
    // settings of an earlier, removed instance).
    const entry = getIndicatorEntry(id);
    const seed = loadIndicatorDefault(id) ?? (entry ? { inputs: { ...entry.defaultInputs }, styles: {}, options: defaultIndicatorOptions() } : undefined);
    patchActivePane({
      indicators: [...pane.indicators, id],
      ...(seed ? { indicatorSettings: { ...pane.indicatorSettings, [id]: seed } } : {}),
    });
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

  // Compare mode: the header "Compare symbols" button reuses the symbol
  // search; picking a symbol TOGGLES it in the focused pane's compare list
  // (re-picking an already-compared symbol removes its overlay).
  const [compareMode, setCompareMode] = createSignal(false);
  function toggleCompareSymbol(ticker: string) {
    const cur = activePaneState().compare ?? [];
    const next = cur.includes(ticker) ? cur.filter((t) => t !== ticker) : [...cur, ticker];
    patchActivePane({ compare: next });
  }

  function onSymbolPicked(symbolName: string) {
    const ticker = symbolName.includes(":")
      ? symbolName.split(":").pop()!
      : symbolName;
    if (compareMode()) {
      // Add (or, if already compared, remove) the symbol's overlay on the
      // focused pane. The dialog closes after the pick (its commit closes it),
      // so it's one symbol per "Compare symbols" press — re-open to add more.
      toggleCompareSymbol(ticker);
      setCompareMode(false);
      setSymbolDialogOpen(false);
      return;
    }
    setSymbol(ticker);
    setSymbolDialogOpen(false);
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
      isChart: src.isChart,
      sync: { ...src.sync },
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
      // Snapshot menu. Copy link / Tweet are cloud actions with no
      // backing here — left as no-ops. "Open in new tab" opens the PNG in
      // the OS default viewer (temp file via the open_snapshot command).
      if (rowId === "save-chart-image") {
        window.dispatchEvent(new CustomEvent("chart-snapshot", { detail: { action: "download" } }));
      } else if (rowId === "copy-chart-image") {
        window.dispatchEvent(new CustomEvent("chart-snapshot", { detail: { action: "copy" } }));
      } else if (rowId === "open-image-in-new-tab") {
        window.dispatchEvent(new CustomEvent("chart-snapshot", { detail: { action: "open" } }));
      }
    } else if (which === "show-favorite-indicators") {
      // A favourite row toggles that study on the focused pane (checked rows
      // are already on the chart, so a second click removes; studies are an
      // id-set, not instances).
      toggleIndicator(rowId);
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
        downloadActiveLayout();
        break;
      case "save-load-menu-item-create":
        // The new layout is created immediately as "Unnamed" (no prompt);
        // duplicates get a numeric suffix ("Unnamed1", "Unnamed2", …).
        createNewLayoutNamed(nextUnnamedName());
        break;
      case "save-load-menu-item-load":
        setLayoutBrowserOpen(true);
        break;
      // "save-load-menu-item-sharing" (cloud-only) + the empty placeholder: no-op.
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
      return buildFavoriteIndicatorsMenu(new Set(indicators()));
    if (id === "indicator-templates") return buildIndicatorTemplatesMenu();
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
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add(`theme-${theme()}`);
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
      // (bottom bar), and Alt+Shift+R — left untouched here. Alt+S is "copy
      // link" (a cloud action with no backing here), so it stays unbound rather
      // than aliasing the image snapshot — the menu would otherwise mislabel it.
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
              [{ ticker: full, short: full.split(":").pop() || full, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null }],
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
    const onSaveTemplate = () => setTemplateNameDialogOpen(true);
    const onClearIndicators = () => setIndicators([]);
    const onOpenPanel = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setActiveRailTab(id);
    };
    // Chart context-menu "Add alert", AlertsPanel "edit", header "Create alert".
    const onOpenAlertDialog = (e: Event) => {
      const d = (e as CustomEvent<{ editId?: string; symbol?: string; price?: number }>).detail ?? {};
      setAlertDialog({ editId: d.editId, symbol: d.symbol, price: d.price });
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
      window.removeEventListener("chart-clear-indicators", onClearIndicators);
      window.removeEventListener("chart-open-panel", onOpenPanel);
      window.removeEventListener("chart-open-alert-dialog", onOpenAlertDialog);
      window.removeEventListener("chart-patch-scale-settings", onPatchScaleSettings);
      window.removeEventListener("chart-set-session", onSetSession);
      window.removeEventListener("chart-set-timezone", onSetTimezone);
      window.removeEventListener("chart-open-indicators", onOpenIndicators);
    });

    // Start the client-side alert engine and surface fires as a transient
    // toast. ONE engine per app, not per window: detached chart windows load
    // this same bundle, and a second engine would duplicate every fire
    // (sound, toast, OS notification, webhook POST) and race the shared kv
    // fire log. Secondary windows still read the store for their alert UI.
    if (windowLabel === "main") startAlertEngine();
    let toastTimer: number | undefined;
    const offFire = onAlertFire((f) => {
      setAlertToast({ title: f.title, message: f.message });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = undefined;
      // Settings → Alerts → "Automatically hide toasts" (focused pane's
      // settings, default on): off keeps the toast until it is clicked away.
      if (appearanceFrom(activePaneState().settings).autoHideToasts ?? true) {
        toastTimer = window.setTimeout(() => setAlertToast(null), 5000);
      }
    });
    onCleanup(() => {
      offFire();
      if (toastTimer) clearTimeout(toastTimer);
    });
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
      <HeaderToolbar
        symbol={symbol()}
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
        onCompare={() => {
          setCompareMode(true);
          setSymbolSearchSeed(null);
          setSymbolDialogOpen(true);
        }}
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
            <FavoritesToolbar armedTool={armedTool()} />
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
              theme={theme()}
              timeZone={timezone().iana}
              timeZoneLabel={timezone().label}
              drawingsFor={drawingsFor}
              drawingKeyForPane={(p) => drawingKeyFor(p, tabId)}
              onRemoveIndicator={(i, id) => removeIndicatorFromPane(tabId, i, id)}
              onReorderIndicators={(i, ids) => reorderIndicatorsForPane(tabId, i, ids)}
              onIndicatorSettings={(i, id, st) => setIndicatorSettingsForPane(tabId, i, id, st)}
              onVisibleRange={(i, r) => setVisibleRangeForPane(tabId, i, r)}
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
              onToggleIndicator={toggleIndicator}
              onClose={() => setOakPanelOpen(false)}
            />
          </Show>
          <BottomBar
            interval={interval()}
            setInterval={setInterval}
            session={session()}
            onSessionChange={setSession}
            timezoneLabel={timezone().label}
            timezoneIana={timezone().iana}
            onTimezoneChange={(e) => setTimezone({ label: e.label, iana: e.iana })}
            maximized={maximized()}
            onToggleMaximize={toggleMaximize}
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
          indicators={indicators()}
          onRemoveIndicator={toggleIndicator}
          chartSource={`${symbol()}, ${interval()}`}
          cloneDrawing={cloneDrawing}
        />
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
                  : "Save new chart layout"
            }
            submitLabel={dlg().mode === "rename" ? "Rename" : "Save"}
            initialValue={dlg().initial}
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
          onClose={() => { setSymbolDialogOpen(false); setCompareMode(false); }}
        />
      </Show>
      <Show when={indicatorsDialogOpen()}>
        <IndicatorsDialog
          activeIndicatorIds={new Set(indicators())}
          onToggleIndicator={toggleIndicator}
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
          seed={seedDraft(activePaneState().settings, {
            timezone: timezone().label,
            adjusted: isAdjusted(),
            session: session(),
            scaleRatio: activeChartProbe()?.scaleRatio(),
          })}
          chartType={chartType()}
          intraday={isIntradayResolution(interval())}
          onCommit={(draft, scope) => {
            // Symbol → Timezone drives the app-wide display timezone (one
            // axis timezone for the whole app, same signal as the bottom bar).
            const appearance = appearanceFrom(draft);
            const tzLabel = appearance.timezone;
            if (tzLabel && tzLabel !== timezone().label) {
              const tz = tzLabel === "Exchange"
                ? { label: "Exchange", iana: "America/New_York" }
                : findTimezone(tzLabel);
              if (tz) setTimezone({ label: tz.label, iana: tz.iana });
            }
            // Symbol → "Adjust data for dividends" is the SAME app-wide flag
            // as the bottom-bar ADJ toggle (kv ot:adjusted) — one feature,
            // two surfaces. Apply + refetch + let the button re-read.
            if (appearance.adjustDividends !== undefined && appearance.adjustDividends !== isAdjusted()) {
              kv.setItem("ot:adjusted", String(appearance.adjustDividends));
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
          }}
        />
      </Show>
      <Show when={appSettingsTab()}>
        {(initialTab) => (
          <AppSettingsDialog
            initialTab={initialTab()}
            tabParts={tabTitleParts()}
            onTabPartsChange={setTabTitleParts}
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
            interval={interval()}
            onClose={() => setAlertDialog(null)}
          />
        )}
      </Show>
      <Show when={alertToast()}>
        {(t) => (
          <div class="alert-toast" role="status" onClick={() => setAlertToast(null)}>
            <div class="alert-toast-title">{t().title}</div>
            <div class="alert-toast-message">{t().message}</div>
          </div>
        )}
      </Show>
    </div>
  );
}

export default App;
