/*
 * The window's tabs: the tab list and the active tab (saved per window), the
 * tab grids kept mounted, the patch helpers on a tab and its panes, the
 * tab's Sync in layout toggles, and the tab operations of the tab strip, its
 * menu and the shell hotkeys (new, duplicate, close, reopen, pin, reorder,
 * move to another window, reload).
 *
 * Each tab is an independent chart (symbol/interval/chartType/layout/
 * indicators); the per-chart state lives inside the active tab's FOCUSED pane
 * (`activePaneState`). Per-window: detached windows scope their own tab
 * storage by window label and open seeded from the handoff payload the detach
 * left behind. Created once by App, under its owner (the save effect and the
 * mounted-grid effect live with it).
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  activePaneOf,
  clampMoveIndex,
  fullSymbolFor,
  insertPosition,
  loadTabs,
  makeTab,
  markEditedPanes,
  newPaneId,
  newTabId,
  saveTabs,
  type PaneChart,
  type TabChart,
} from "./tabs";
import { popClosed, pushClosed } from "./closed-stack";
import { findStripAt, reopenTabIn, screenToClient, sendTabTo } from "./shell-bus";
import {
  closeCurrentWindow,
  detachTabToWindow,
  isTauri,
  markClosingAfterMove,
  reopenClosedWindow,
  takeDetachPayload,
} from "./window-bridge";
import { bindLayoutSync, rememberCrosshair, type LayoutSyncKey } from "../chart/layout-sync";
import { isEconomicSymbol, isFullSymbol, toFullSymbol } from "../../data/datafeed";
import { SINGLE_VALUE_TYPES, lastSingleValueType } from "../chart/chart-types";
import { migrateDrawingKey } from "../drawings/persistence";
import { setSelectedDrawingId } from "../drawings/drawing-selection";

export function createAppTabs(windowLabel: string) {
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

  /** Patch one tab's (tab-level) state. */
  function patchTab(id: string, patch: Partial<TabChart>) {
    setTabs(tabs().map((t) => {
      if (t.id !== id) return t;
      // An edit of a chart's own content (not a template / layout change)
      // makes it a chart saved even while hidden.
      const panes = patch.panes && patch.layout === undefined ? markEditedPanes(t.panes, patch.panes) : patch.panes;
      return panes ? { ...t, ...patch, panes } : { ...t, ...patch };
    }));
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

  // Active-pane-backed accessor. Each multi-chart layout cell is its own
  // independent chart; the header / right-rail / drawing tools act on the
  // FOCUSED pane (`activePane`). `layout` and pane-focus stay tab-level.
  const activePaneState = () => activePaneOf(activeTab());
  // The per-pane callbacks name their tab: every opened tab keeps its grid
  // mounted, so a pane writes into its own tab, shown or not.
  const tabOf = (tabId: string) => tabs().find((t) => t.id === tabId);
  // Focus a pane (clicking / interacting with a cell). Guarded so acting
  // within the already-focused pane doesn't rewrite + persist the tab on every
  // click. Selection clearing is handled by the drawing store's key effect.
  const setActivePaneIndex = (i: number) => {
    if (activeTab().activePane !== i) patchActive({ activePane: i });
  };

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

  // A close-only symbol (an economic series) draws a single-value type: a
  // pane on another type takes the last single-value type picked on such a
  // symbol, and gets its own type back with the next symbol that has OHLC bars
  // (the reference app's style recovery).
  function followCloseOnlyTypes() {
    createEffect(() => {
      for (const t of tabs()) {
        let changed = false;
        const panes = t.panes.map((p) => {
          if (isEconomicSymbol(p.symbol)) {
            if (SINGLE_VALUE_TYPES.has(p.chartType)) return p;
            changed = true;
            return { ...p, chartType: lastSingleValueType(), styleToRecover: p.styleToRecover ?? p.chartType };
          }
          if (!p.styleToRecover) return p;
          changed = true;
          const { styleToRecover, ...rest } = p;
          return { ...rest, chartType: styleToRecover };
        });
        if (changed) untrack(() => patchTab(t.id, { panes }));
      }
    });
  }

  // Symbols saved as bare tickers (before panes kept "EXCHANGE:TICKER") get
  // their primary listing once, in every tab (incl. compare lists); their
  // drawings move to the full-name keys first so nothing is lost. App starts
  // it once, where its effect sits among the others.
  function migrateBareSymbols() {
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
      hiddenPanes: src.hiddenPanes?.map((p) => ({ ...p, id: newPaneId(), indicators: [...p.indicators] })),
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
    void import("../../bindings").then(({ commands }) => commands.openDevtools()).catch(() => undefined);
  }
  function copyTabSymbol(id: string) {
    const t = tabs().find((x) => x.id === id);
    if (t) navigator.clipboard?.writeText(fullSymbolFor(activePaneOf(t).symbol)).catch(() => undefined);
  }

  return {
    tabs,
    setTabs,
    activeTabId,
    activeTab,
    mountedTabs,
    tabById,
    gridTabIds,
    patchTab,
    patchActive,
    patchActivePane,
    patchAllPanes,
    patchSyncGroupPanes,
    activePaneState,
    tabOf,
    setActivePaneIndex,
    layoutSync,
    migrateBareSymbols,
    followCloseOnlyTypes,
    activateTab,
    newTab,
    duplicateTab,
    insertTab,
    reopenClosed,
    stripIndexAt,
    dropTabOnWindow,
    closeTab,
    detachTab,
    closeOthers,
    closeToRight,
    reorderTab,
    togglePinTab,
    reloadTab,
    openDevTools,
    copyTabSymbol,
  };
}

export type AppTabs = ReturnType<typeof createAppTabs>;
