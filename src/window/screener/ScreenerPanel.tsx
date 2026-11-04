/*
 * ScreenerPanel: the Stock Screener as a right split-view panel (the reference app
 * Desktop 3.4.1, opened by the right-rail "Screeners" button):
 *   a 4 px resizer at its left edge (drag, width persisted), a 50 px header
 *   (title "Stock Screener", Fullscreen mode, Close), then the screener:
 *   topbar, filter pills, control panel (View type, then Column sets or the
 *   Charts / Heatmap tools, Refresh with its countdown badge, Maximize: the
 *   pills and the control panel fold into the topbar row) and; in a narrow
 *   panel, a "Filters" button (./ScreenerFiltersDialog) in place of the pills
 *   (see `narrow` / `roomy`); in a wide one (958 px), the column sets and the
 *   Charts date range as tabs (./SquareTabs) and
 *   the results as a table, charts (./ScreenerCharts) or a heatmap
 *   (./ScreenerHeatmap); the view type is kept in the screen.
 * The main layout (header toolbar, drawing toolbar, charts, rail) shrinks to
 * the remaining width; Fullscreen mode gives the panel the whole window.
 *
 * The title is a menu: Stock Screener / Script Screener (./ScriptScreener,
 * which reads the same live table), and for the script one "Download results
 * as CSV", "Save results as watchlist", its saved screens (Save screen,
 * Save screen as…, open or delete one) and "About Script Screener".
 *
 * Header (the reference app): "Move split-view to overlay" before the title (the right panel then floats over
 * the charts with its own width, the mode kept for the next opening; "Move overlay to split-view" brings it back),
 * Collapse panel (closes it; the rail button keeps a dot), Fullscreen mode (split view only), Close.
 *
 * Placement (title menu, beyond the reference app which has the right panel
 * only): the right split view, the bottom panel under the charts (a 4 px seam
 * at its top edge, height persisted) or its own window (`dock` "window": the
 * header is the window's title bar, Close closes the window).
 *
 * Data: `screenerOpen(owner)` starts the backend's 10 s polling while the
 * panel is mounted; every `screener-update` re-runs the scan (visible pages),
 * every screen change re-plans it. Screener settings' Auto-refresh decides
 * which updates refresh the results (every one, one a minute, none); the
 * Refresh badge counts down to the next ("Time to refresh").
 */
import { track } from "../../data/analytics";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import type { FieldInfo, ScreenerProgress } from "../../bindings";
import { POLL_MS, onScreenerUpdate, screenerClose, screenerFields, screenerOpen, screenerProgress } from "../../data/screener-api";
import { wheelText } from "../../data/screener-progress";
import {
  columnSets,
  CUSTOM_SET_ID,
  CUSTOM_SET_TITLE,
  fieldOf,
  sameColumn,
  type ColumnRef,
} from "../../data/screener-catalog";
import { activeColumns, isActive, planScreen, type Plan } from "../../data/screener-query";
import { leaveScreen } from "./leave-screen";
import { OVERLAY_MIN_WIDTH, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, screenerPanel, screenerStore, type ScreenerPlacement } from "../../data/screener-store";
import { isTauri } from "../shell/window-bridge";
import { emitTo } from "@tauri-apps/api/event";

/** Event to the main window from the screener's own window: show the screener there, at `placement`. */
export const SCREENER_PLACE_EVENT = "screener-placement";
import type { FlagColor } from "../../data/watchlist";
import { allFlags } from "../../data/symbol-flags";
import { FilterPills, watchlistTickers } from "./FilterPills";
import { PopDivider, PopItem, PopSectionTitle, Popover } from "./Popover";
import { ScreenerTable } from "./ScreenerTable";
import { ChartsToolbar, ScreenerCharts } from "./ScreenerCharts";
import { HeatmapToolbar, ScreenerHeatmap } from "./ScreenerHeatmap";
import { refreshMs, screenerSettings } from "../../data/screener-settings";
import type { ScreenerType, ViewMode } from "../../data/screener-catalog";
import { ScreenerTopbar } from "./ScreenerTopbar";
import { ScreenerFiltersDialog } from "./ScreenerFiltersDialog";
import { SquareTabs, type SquareTab } from "./SquareTabs";
import { createScanController } from "./scan-controller";
import { ScriptScreener } from "./ScriptScreener";
import { scriptScreenStore } from "../../data/script-screen-store";
import { bareTicker, type ScriptColumn, type ScriptRow } from "../../data/script-screen";
import { watchlistStore } from "../../data/watchlist-store";
import { promptNewWatchlist } from "../right-rail/watchlist-prompts";
import { scriptResultsCsv } from "./script-csv";
import { csvFileName, downloadText } from "./screener-csv";
import { showConfirm, showNotice, showRename } from "../../components/Dialogs";

/** The view type menu (the reference app order). */
const VIEWS: { id: ViewMode; title: string; icon: string }[] = [
  { id: "table", title: "Table", icon: "scr-view-table" },
  { id: "chart", title: "Charts", icon: "scr-view-charts" },
  { id: "heatmap", title: "Heatmap", icon: "scr-view-heatmap" },
];

type Props = {
  /** Window label; the backend owner is `${label}:screener`. */
  windowLabel: string;
  /** Same callback as the watchlist row pick (sets the chart symbol). */
  onSymbolPicked: (ticker: string) => void;
  /** Where it is drawn: the right split view (default), the bottom panel, or a window of its own. */
  dock?: "right" | "bottom" | "window";
  /** Window dock: close the window. */
  onCloseWindow?: () => void;
};

export function ScreenerPanel(props: Props) {
  const owner = `${props.windowLabel}:screener`;
  const dock = () => props.dock ?? "right";
  const [fields, setFields] = createSignal<Map<string, FieldInfo> | null>(null);
  const has = (f: string) => fields()?.has(f) ?? false;
  const [lastUpdate, setLastUpdate] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [selected, setSelected] = createSignal<string | null>(null);
  const [setsOpen, setSetsOpen] = createSignal(false);
  const [manualRefresh, setManualRefresh] = createSignal(false);
  const [resetKey, setResetKey] = createSignal(0);
  // Bumped on every refresh (auto or the button): the Charts and Heatmap views reload with it.
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [lastRefresh, setLastRefresh] = createSignal(Date.now());
  const [heatTotal, setHeatTotal] = createSignal<number | null>(null);
  // The backend holds its first complete market table and a scan of it is in: until then the views show the
  // loading wheel, not "no symbols".
  const [backendLoaded, setBackendLoaded] = createSignal(false);
  const [tableReady, setTableReady] = createSignal(false);
  const [viewOpen, setViewOpen] = createSignal(false);
  let viewBtn!: HTMLButtonElement;
  let setsBtn!: HTMLButtonElement;
  let titleBtn!: HTMLButtonElement;
  const [titleOpen, setTitleOpen] = createSignal(false);
  const script = () => scriptScreenStore.kind() === "script";
  // The script screener's shown rows and columns, for the title menu.
  let scriptRows: () => ScriptRow[] = () => [];
  let scriptColumns: () => ScriptColumn[] = () => [];
  let scriptNames: () => ReadonlyMap<string, string> = () => new Map();
  const downloadCsv = () =>
    downloadText(csvFileName(scriptScreenStore.current()?.name ?? "Script screener"), scriptResultsCsv(scriptRows(), scriptColumns(), scriptNames()));
  /** Move the screener: the main window shows it in its new place (App opens its own window for "window"). From its
   *  own window: the main window is told (event), then the window closes. */
  const place = (p: ScreenerPlacement) => {
    if (p === screenerPanel.placement()) return;
    if (dock() === "window") {
      void emitTo("main", SCREENER_PLACE_EVENT, { placement: p }).finally(() => props.onCloseWindow?.());
      return;
    }
    screenerPanel.setPlacement(p);
    screenerPanel.setOpen(true);
  };
  /** The Stock or ETF Screener; leaving a changed screen asks first. */
  const showScreener = (t: ScreenerType) => {
    if (script()) scriptScreenStore.setKind("stock");
    if (screenerStore.type() !== t) leaveScreen(() => screenerStore.setType(t));
  };
  const saveScreenAs = () =>
    showRename({
      title: "Save screen as",
      label: "Screen name",
      maxLength: 64,
      names: scriptScreenStore.saved().map((x) => x.name),
      replaceText: (name) => `"${name}" already exists. Replace it?`,
      initialValue: scriptScreenStore.current()?.name ?? "",
      onSave: (name) => {
        const same = scriptScreenStore.saved().find((x) => x.name === name);
        if (same) scriptScreenStore.remove(same.id);
        scriptScreenStore.saveAs(name);
      },
    });
  const saveScreen = () => {
    if (!scriptScreenStore.save()) saveScreenAs();
  };
  const removeScreen = (id: string, name: string) =>
    showConfirm({
      title: "Delete screen",
      text: `Do you really want to delete "${name}"?`,
      mainText: "Delete",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => scriptScreenStore.remove(id),
    });
  const about = () =>
    showNotice({
      title: "About Script Screener",
      text:
        "Runs one indicator over every symbol of an index or a watchlist and reads it on the newest bar: its plots as " +
        "columns and filters, its alert conditions and the marks it draws as signals. Built-in indicators and your own " +
        "OakScript indicators can be scanned; strategies cannot. Each symbol gets the newest 500 bars of the regular " +
        "session. Daily and longer intervals reuse the charts' cached history; intraday intervals load each symbol " +
        "again on every scan, so they take 200 symbols at most. Market data is delayed by 15 minutes.",
    });
  const saveAsWatchlist = () => {
    const rows = scriptRows().filter((r) => !r.error);
    promptNewWatchlist((name) =>
      watchlistStore.createListWith(
        rows.map((r) => ({ ticker: r.symbol, short: bareTicker(r.symbol), last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null })),
        name,
      ),
    );
  };

  const screen = screenerStore.screen;
  const view = (): ViewMode => screen().viewMode ?? "table";
  const refreshNow = () => {
    setLastRefresh(Date.now());
    setRefreshTick((k) => k + 1);
    ctl.refresh();
  };
  const tickers = createMemo(() => watchlistTickers(screen().watchlistId));
  const plan = createMemo<Plan | null>(() => (fields() ? planScreen(screen(), has, tickers()) : null));
  const ctl = createScanController(plan);

  // Re-plan → reset rows (only when the request really changes).
  createEffect(
    on(
      () => {
        const p = plan();
        return p ? JSON.stringify([p.fields, p.filter, p.sort, p.tickers]) : "";
      },
      (key) => {
        if (!key) return;
        ctl.reset();
        setResetKey((k) => k + 1);
      },
    ),
  );
  createEffect(() => {
    if (!ctl.loading()) setManualRefresh(false);
  });
  createEffect(() => {
    if (backendLoaded() && !ctl.loading()) setTableReady(true);
  });
  // The wheel stands over the views while there is nothing to show: rows of a table still waiting on a download
  // (the daily state, the closes) are shown as they come, and its complete table replaces them.
  const waiting = () => !tableReady() && !((view() === "heatmap" ? heatTotal() : ctl.total()) ?? 0);
  // While the wheel shows: what the table waits on, read every 300 ms.
  const [progress, setProgress] = createSignal<ScreenerProgress | null>(null);
  const wheel = createMemo(() => wheelText(progress()));
  createEffect(() => {
    if (!waiting()) return;
    let stop = false;
    const read = () => void screenerProgress().then((p) => !stop && setProgress(p), () => {});
    read();
    const timer = window.setInterval(read, 300);
    onCleanup(() => {
      stop = true;
      window.clearInterval(timer);
    });
  });

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const list = await screenerFields();
        if (disposed) return;
        setFields(new Map(list.map((f) => [f.id, f])));
        const st = await screenerOpen(owner);
        if (disposed) return;
        track("screener_opened");
        if (st.updatedMs !== null) setLastUpdate(Date.now());
        let stateAsof = st.stateAsof;
        // The first scan ran on an empty table when the backend had no complete one yet (no table, or one still
        // waiting on the ticker list or the daily state): that one is shown at once, whatever the auto-refresh setting.
        let loaded = st.updatedMs !== null && st.complete;
        setBackendLoaded(loaded);
        unlisten = await onScreenerUpdate((u) => {
          setLastUpdate(Date.now());
          // A new daily state brings its fields (the fundamentals): the field list is read again.
          if (u.stateAsof !== stateAsof) {
            stateAsof = u.stateAsof;
            void screenerFields().then((l) => !disposed && setFields(new Map(l.map((f) => [f.id, f]))));
          }
          if (u.error) return;
          const first = !loaded && u.updatedMs !== null && u.complete;
          // Auto-refresh: every update (10 s), the first update a minute after the last refresh, or never.
          const period = refreshMs(screenerSettings().autoRefresh);
          if (first || (period !== null && Date.now() - lastRefresh() >= period - 1000)) refreshNow();
          // After the refresh started: the wheel stays until its scan is in.
          if (first) {
            loaded = true;
            setBackendLoaded(true);
          }
        });
        if (disposed) unlisten();
      } catch (e) {
        console.error("[screener] open failed", e);
      }
    })();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      disposed = true;
      window.clearInterval(tick);
      unlisten?.();
      void screenerClose(owner).catch(() => {});
    });
  });

  // Seconds to the next refresh (the reference app "Time to refresh"); none with auto-refresh off.
  const countdown = () => {
    const t = lastUpdate();
    const period = refreshMs(screenerSettings().autoRefresh);
    if (t === null || period === null) return null;
    const next = period === POLL_MS ? t + POLL_MS : lastRefresh() + period;
    const s = Math.floor((next - now()) / 1000);
    return s > 0 ? s : null;
  };

  // Column set helpers.
  const offeredSets = () =>
    columnSets(screenerStore.type()).filter((s) => s.columns.some((c) => {
      const f = fieldOf(c);
      return f !== null && has(f);
    }));
  const setTitle = () =>
    screen().activeColumnSetId === CUSTOM_SET_ID ? CUSTOM_SET_TITLE : columnSets(screenerStore.type()).find((s) => s.id === screen().activeColumnSetId)?.title ?? "";
  /** Write a new column list: the reference app stores it as the "custom" set and selects it. */
  const setColumns = (fn: (cols: ColumnRef[]) => ColumnRef[]) =>
    screenerStore.update((s) => ({ ...s, customColumns: fn([...activeColumns(s)]), activeColumnSetId: CUSTOM_SET_ID }));

  // Flags of the rows = flags of the symbols in the OpenTrader watchlists.
  const flags = createMemo(() => {
    // Symbol flags (one per symbol), keyed by ticker for the scan rows.
    const m = new Map<string, FlagColor>();
    for (const [sym, c] of Object.entries(allFlags())) m.set(sym.split(":").pop() ?? sym, c);
    return m;
  });

  // Bottom panel: drag the 4 px strip at its top edge; the panel grows upward.
  const beginResizeHeight = (e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = screenerPanel.height();
    const maxH = () => Math.max(PANEL_MIN_HEIGHT, document.documentElement.clientHeight - 200);
    const onMove = (ev: MouseEvent) => screenerPanel.setHeight(Math.min(maxH(), startH + (startY - ev.clientY)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      screenerPanel.setHeight(screenerPanel.height(), true);
    };
    document.body.style.cursor = "ns-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // The right panel over the charts (the header's "Move split-view to overlay") instead of beside them.
  const overlay = () => dock() === "right" && screenerPanel.mode() === "overlay";
  /** The overlay's width: the one dragged last, else half the window (the reference app). */
  const overlayWidth = () => screenerPanel.overlayWidth() ?? Math.max(PANEL_MIN_WIDTH, Math.round(document.documentElement.clientWidth / 2));
  // Resizer: drag the 4 px strip; the panel grows to the left. The split view and the overlay keep their own widths.
  const beginResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const over = overlay();
    const startW = over ? overlayWidth() : screenerPanel.width();
    const set = (px: number, commit = false) => (over ? screenerPanel.setOverlayWidth(px, commit) : screenerPanel.setWidth(px, commit));
    const maxW = () => Math.max(over ? OVERLAY_MIN_WIDTH : PANEL_MIN_WIDTH, document.documentElement.clientWidth - (over ? 100 : 360));
    const onMove = (ev: MouseEvent) => set(Math.min(maxW(), startW + (startX - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      set(over ? overlayWidth() : screenerPanel.width(), true);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Maximize (the control panel's): the head folds into the topbar row, the results take the panel (the reference
  // app's in-panel full screen; the header's Fullscreen mode gives the panel the window). Escape inside the screener
  // goes back.
  const [maximized, setMaximized] = createSignal(false);
  // The screener's width decides its layout (the reference app's container breakpoints, its container = the panel
  // less 20 px): under 702 px the pills fold into a "Filters" button (its dialog holds them) and the view controls
  // show icons only; under 548 px the controls take a row of their own, Refresh and Undo / Redo are not shown and
  // Column sets shows its icon only.
  let panelEl!: HTMLElement;
  const [panelWidth, setPanelWidth] = createSignal(Number.POSITIVE_INFINITY);
  onMount(() => {
    const ro = new ResizeObserver(() => setPanelWidth(panelEl.clientWidth));
    ro.observe(panelEl);
    onCleanup(() => ro.disconnect());
  });
  const narrow = () => panelWidth() - 20 < 702;
  // From 958 px, and not maximized: the column sets and the Charts date range as tabs (#237).
  const tabsView = () => panelWidth() - 20 >= 958 && !maximized();
  const roomy = () => panelWidth() - 20 >= 548;
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  createEffect(() => {
    if (!narrow()) setFiltersOpen(false);
  });
  // Shift+F opens the Filters dialog while the pills are folded (not while typing).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== "f" || !narrow() || script()) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      e.preventDefault();
      setFiltersOpen(true);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  // Escape closes the overlay (the reference app), unless a menu, a dialog or a field takes it.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !overlay()) return;
      if (document.querySelector(".scr-popover,[role=dialog]")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      screenerPanel.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  // The badge on Minimize: each active filter, the market (always set), the watchlist (the reference app's count).
  const filterCount = () => screen().filters.filter(isActive).length + 1 + (screen().watchlistId ? 1 : 0);
  /** The column sets offered as tabs: the custom one first when the screen has it. */
  const setTabs = (): SquareTab[] => [
    ...(screen().customColumns ? [{ id: CUSTOM_SET_ID, label: CUSTOM_SET_TITLE }] : []),
    ...offeredSets().map((s) => ({ id: s.id, label: s.title })),
  ];
  /** The view's tools: Column sets for the table, the Charts or Heatmap buttons. */
  const viewTools = () => (
    <>
      <Show when={view() === "chart"}>
        <ChartsToolbar tabs={tabsView()} />
      </Show>
      <Show when={view() === "heatmap"}>
        <HeatmapToolbar has={has} />
      </Show>
      <Show when={view() === "table" && tabsView()}>
        <SquareTabs
          items={setTabs()}
          active={screen().activeColumnSetId}
          label="Column sets"
          onPick={(id) => screenerStore.update((s) => ({ ...s, activeColumnSetId: id }))}
        />
      </Show>
      <Show when={view() === "table" && !tabsView()}>
        <button
          ref={setsBtn}
          type="button"
          class="scr-light-btn scr-light-btn--ghost scr-sets-btn scr-column-sets-btn"
          classList={{ "is-open": setsOpen() }}
          title="Column sets"
          onClick={() => setSetsOpen(!setsOpen())}
        >
          <Icon name="scr-column-sets" size={28} />
          <span class="scr-light-btn-text">{setTitle()}</span>
          <span class="scr-sets-caret" classList={{ "is-open": setsOpen() }}><Icon name="scr-caret-small" size={18} /></span>
        </button>
      </Show>
    </>
  );
  const refreshButton = () => (
    <div class="scr-refresh-wrap">
      <Show when={countdown()} keyed>
        {(s) => <span class="scr-counter" role="img" aria-label="Time to refresh">{s}</span>}
      </Show>
      <button
        type="button"
        class="scr-light-btn scr-light-btn--secondary is-icon-only"
        classList={{ "is-rotating": manualRefresh() && ctl.loading() }}
        title="Refresh"
        aria-label="Refresh"
        onClick={() => {
          setManualRefresh(true);
          refreshNow();
        }}
      >
        <Icon name="scr-refresh" size={28} />
      </button>
    </div>
  );

  return (
    <div
      class="scr-split"
      classList={{
        "is-fullscreen": dock() === "right" && screenerPanel.fullscreen(),
        "is-overlay": overlay(),
        "is-bottom": dock() === "bottom",
        "is-window": dock() === "window",
      }}
      style={
        dock() === "bottom"
          ? { height: `${screenerPanel.height()}px` }
          : overlay()
            ? { width: `${overlayWidth()}px` }
            : dock() === "right" && !screenerPanel.fullscreen()
              ? { width: `${screenerPanel.width()}px` }
              : undefined
      }
    >
      <Show when={dock() === "right" && !screenerPanel.fullscreen()}>
        <div class="scr-resizer" role="separator" aria-orientation="vertical" onMouseDown={beginResize} />
      </Show>
      <Show when={dock() === "bottom"}>
        <div class="scr-resizer scr-resizer--top" role="separator" aria-orientation="horizontal" onMouseDown={beginResizeHeight} />
      </Show>
      <section
        ref={panelEl}
        class="scr-panel"
        classList={{ "is-narrow": narrow(), "is-tight": !roomy() }}
        aria-label="Stock Screener"
        onKeyDown={(e) => {
          if (e.key === "Escape" && maximized() && !e.defaultPrevented) {
            e.preventDefault();
            setMaximized(false);
          }
        }}
      >
        <header class="scr-panel-header" data-tauri-drag-region={dock() === "window" ? "" : undefined}>
          <div class="scr-panel-title-block">
          <Show when={dock() === "right"}>
            {/* Disabled while the panel has the whole window (the reference app). */}
            <button
              type="button"
              class="scr-light-btn scr-light-btn--ghost is-icon-only"
              title={screenerPanel.fullscreen() ? undefined : overlay() ? "Move overlay to split-view" : "Move split-view to overlay"}
              aria-label={screenerPanel.fullscreen() ? undefined : overlay() ? "Move overlay to split-view" : "Move split-view to overlay"}
              data-qa-id="split-view-button"
              disabled={screenerPanel.fullscreen()}
              onClick={() => screenerPanel.setMode(overlay() ? "split" : "overlay")}
            >
              <Icon name={overlay() ? "scr-overlay-to-split" : "scr-split-to-overlay"} size={28} />
            </button>
          </Show>
          <button
            ref={titleBtn}
            type="button"
            class="scr-panel-title sscr-title-btn"
            classList={{ "is-open": titleOpen() }}
            aria-haspopup="menu"
            onClick={() => setTitleOpen(!titleOpen())}
          >
            {script() ? "Script Screener" : screenerStore.type() === "etf" ? "ETF Screener" : "Stock Screener"}
            <span class="scr-screen-caret" classList={{ "is-open": titleOpen() }}><Icon name="scr-caret" size={18} /></span>
          </button>
          </div>
          <div class="scr-panel-buttons">
            <Show when={dock() !== "window"}>
              <button
                type="button"
                class="scr-light-btn scr-light-btn--ghost is-icon-only"
                title="Collapse panel"
                aria-label="Collapse panel"
                onClick={() => screenerPanel.collapse()}
              >
                <Icon name="st-footer-collapse-panel" size={28} />
              </button>
            </Show>
            <Show when={dock() === "right" && !overlay()}>
            <button
              type="button"
              class="scr-light-btn scr-light-btn--ghost is-icon-only"
              title={screenerPanel.fullscreen() ? "Restore panel" : "Fullscreen mode"}
              aria-label={screenerPanel.fullscreen() ? "Restore panel" : "Fullscreen mode"}
              onClick={() => screenerPanel.setFullscreen(!screenerPanel.fullscreen())}
            >
              <Icon name={screenerPanel.fullscreen() ? "scr-panel-restore" : "scr-panel-fullscreen"} size={28} />
            </button>
            </Show>
            <button
              type="button"
              class="scr-light-btn scr-light-btn--ghost is-icon-only"
              title="Close"
              aria-label="Close"
              onClick={() => (dock() === "window" ? props.onCloseWindow?.() : screenerPanel.setOpen(false))}
            >
              <Icon name="scr-panel-close" size={28} />
            </button>
          </div>
        </header>
        <Show
          when={!script()}
          fallback={
            <ScriptScreener
              onSymbolPicked={props.onSymbolPicked}
              flagOf={(t) => flags().get(t) ?? null}
              onShownRows={(rows, cols, names) => {
                scriptRows = rows;
                scriptColumns = cols;
                scriptNames = names;
              }}
            />
          }
        >
        <div class="scr-body">
          <div class="scr-head">
            <ScreenerTopbar
              maximized={maximized()}
              compact={!roomy()}
              tools={
                <>
                  <Show when={!narrow()}>
                    {viewTools()}
                    <span class="scr-control-divider" />
                  </Show>
                  <Show when={roomy()}>{refreshButton()}</Show>
                </>
              }
              filterCount={filterCount()}
              onMinimize={() => setMaximized(false)}
            />
            <Show when={!maximized()}>
            <Show when={!narrow()}>
              <FilterPills has={has} />
            </Show>
            <div class="scr-head-row" classList={{ "is-row": narrow() && roomy(), "is-stacked": narrow() && !roomy() }}>
            <Show when={narrow()}>
              <div class="scr-filters-btn-wrap">
                <button
                  type="button"
                  class="scr-light-btn scr-light-btn--secondary scr-filters-btn"
                  classList={{ "is-open": filtersOpen() }}
                  title="Filters"
                  onClick={() => setFiltersOpen(true)}
                >
                  <Icon name="scr-filters" size={28} />
                  <span class="scr-light-btn-text">Filters</span>
                </button>
                <span class="scr-counter scr-counter--bold scr-filters-counter">{filterCount()}</span>
              </div>
              <Show when={roomy()}>
                <span class="scr-control-divider scr-control-divider--pills" />
              </Show>
            </Show>
            <div class="scr-control-panel">
              <button
                ref={viewBtn}
                type="button"
                class="scr-light-btn scr-light-btn--ghost scr-sets-btn scr-view-type-btn"
                classList={{ "is-open": viewOpen() }}
                title="View type"
                onClick={() => setViewOpen(!viewOpen())}
              >
                <Icon name={VIEWS.find((v) => v.id === view())!.icon} size={28} />
                <span class="scr-light-btn-text">{VIEWS.find((v) => v.id === view())!.title}</span>
                <span class="scr-sets-caret" classList={{ "is-open": viewOpen() }}><Icon name="scr-caret-small" size={18} /></span>
              </button>
              <span class="scr-control-divider" />
              {viewTools()}
              <div class="scr-header-controls">
                <Show when={!waiting() && view() !== "table" && (view() === "heatmap" ? heatTotal() : ctl.total()) !== null}>
                  <span class="scr-total">{(view() === "heatmap" ? heatTotal() : ctl.total())!.toLocaleString("en-US")} total</span>
                </Show>
                <Show when={roomy()}>{refreshButton()}</Show>
                <button
                  type="button"
                  class="scr-light-btn scr-light-btn--secondary is-icon-only"
                  title="Maximize"
                  aria-label="Maximize"
                  data-qa-id="screener-enter-fullscreen"
                  onClick={() => setMaximized(true)}
                >
                  <Icon name="scr-maximize" size={28} />
                </button>
              </div>
            </div>
            </div>
            </Show>
          </div>
          <Show when={fields() && view() === "chart"}>
            <ScreenerCharts
              ctl={ctl}
              loading={waiting()}
              wheel={wheel()}
              fields={plan()?.fields ?? []}
              onPick={(t) => {
                setSelected(t);
                props.onSymbolPicked(t);
              }}
              flagOf={(t) => flags().get(t) ?? null}
              resetKey={resetKey()}
              refreshTick={refreshTick()}
            />
          </Show>
          <Show when={fields() && view() === "heatmap" && plan()} keyed>
            {(p) => (
              <ScreenerHeatmap
                plan={p}
                loading={waiting()}
                wheel={wheel()}
                has={has}
                onPick={(t) => {
                  setSelected(t);
                  props.onSymbolPicked(t);
                }}
                refreshTick={refreshTick()}
                onTotal={setHeatTotal}
              />
            )}
          </Show>
          <Show when={fields() && view() === "table"}>
            <ScreenerTable
              ctl={ctl}
              loading={waiting()}
              wheel={wheel()}
              columns={plan()?.columns ?? []}
              fields={plan()?.fields ?? []}
              sort={screen().sort}
              onSort={(col, order) => screenerStore.update((s) => ({ ...s, sort: { sortBy: col, sortOrder: order } }))}
              onRowClick={(t) => {
                setSelected(t);
                props.onSymbolPicked(t);
              }}
              selected={selected()}
              flagOf={(t) => flags().get(t) ?? null}
              has={has}
              onAddColumn={(col) => setColumns((c) => [...c, col])}
              onRemoveColumn={(i) => {
                const col = plan()?.columns[i];
                if (col) setColumns((c) => c.filter((x) => !sameColumn(x, col)));
              }}
              onMoveColumn={(i, to) =>
                setColumns((c) => {
                  const col = plan()?.columns[i];
                  const from = col ? c.findIndex((x) => sameColumn(x, col)) : -1;
                  if (from < 0) return c;
                  const [x] = c.splice(from, 1);
                  const dest = to === "start" ? 0 : to === "end" ? c.length : to === "prev" ? Math.max(0, from - 1) : Math.min(c.length, from + 1);
                  c.splice(dest, 0, x);
                  return c;
                })
              }
              onReplaceColumn={(i, col) => {
                const old = plan()?.columns[i];
                if (!old) return;
                screenerStore.update((s) => ({
                  ...s,
                  customColumns: activeColumns(s).map((x) => (sameColumn(x, old) ? col : x)),
                  activeColumnSetId: CUSTOM_SET_ID,
                  sort: sameColumn(s.sort.sortBy, old) ? { ...s.sort, sortBy: col } : s.sort,
                }));
              }}
              resetKey={resetKey()}
            />
          </Show>
        </div>
        </Show>
      </section>

      <Show when={titleOpen()}>
        <Popover anchor={titleBtn} onClose={() => setTitleOpen(false)} width={260}>
          <PopItem title="Stock Screener" selected={!script() && screenerStore.type() === "stock"} onClick={() => { setTitleOpen(false); showScreener("stock"); }} />
          <PopItem title="ETF Screener" selected={!script() && screenerStore.type() === "etf"} onClick={() => { setTitleOpen(false); showScreener("etf"); }} />
          <PopItem title="Script Screener" selected={script()} onClick={() => { setTitleOpen(false); scriptScreenStore.setKind("script"); }} />
          <PopDivider />
          <PopSectionTitle title="Placement" />
          <PopItem title="Right panel" selected={screenerPanel.placement() === "right"} onClick={() => { setTitleOpen(false); place("right"); }} />
          <PopItem title="Bottom panel" selected={screenerPanel.placement() === "bottom"} onClick={() => { setTitleOpen(false); place("bottom"); }} />
          <Show when={isTauri()}>
            <PopItem title="Separate window" selected={screenerPanel.placement() === "window"} onClick={() => { setTitleOpen(false); place("window"); }} />
          </Show>
          <Show when={script()}>
            <PopDivider />
            <PopItem title="Save screen" disabled={!scriptScreenStore.unsaved()} onClick={() => { setTitleOpen(false); saveScreen(); }} />
            <PopItem title="Save screen as…" onClick={() => { setTitleOpen(false); saveScreenAs(); }} />
            <Show when={scriptScreenStore.saved().length > 0}>
              <PopSectionTitle title="Saved screens" />
              <For each={scriptScreenStore.saved()}>
                {(x) => (
                  <PopItem
                    title={x.name}
                    selected={x.id === scriptScreenStore.savedId()}
                    onClick={() => { setTitleOpen(false); scriptScreenStore.open(x.id); }}
                    right={
                      <button
                        type="button"
                        class="scr-text-btn scr-icon-only"
                        aria-label={`Delete ${x.name}`}
                        title="Delete"
                        onClick={(e) => { e.stopPropagation(); setTitleOpen(false); removeScreen(x.id, x.name); }}
                      >
                        <Icon name="scr-trash" size={18} />
                      </button>
                    }
                  />
                )}
              </For>
            </Show>
            <PopDivider />
            <PopItem title="Download results as CSV" disabled={!scriptRows().length} onClick={() => { setTitleOpen(false); downloadCsv(); }} />
            <PopItem title="Save results as watchlist" disabled={!scriptRows().length} onClick={() => { setTitleOpen(false); saveAsWatchlist(); }} />
            <PopDivider />
            <PopItem title="About Script Screener" onClick={() => { setTitleOpen(false); about(); }} />
          </Show>
        </Popover>
      </Show>

      <Show when={filtersOpen()}>
        <ScreenerFiltersDialog has={has} onClose={() => setFiltersOpen(false)} />
      </Show>

      <Show when={viewOpen()}>
        <Popover anchor={viewBtn} onClose={() => setViewOpen(false)} width={160}>
          <PopSectionTitle title="View type" />
          <For each={VIEWS}>
            {(v) => (
              <PopItem
                title={v.title}
                icon={v.icon}
                selected={view() === v.id}
                onClick={() => {
                  setViewOpen(false);
                  screenerStore.update((s) => ({ ...s, viewMode: v.id === "table" ? undefined : v.id }));
                }}
              />
            )}
          </For>
        </Popover>
      </Show>

      <Show when={setsOpen()}>
        <Popover anchor={setsBtn} onClose={() => setSetsOpen(false)} class="scr-sets-menu">
          <PopSectionTitle title="Column sets" />
          <Show when={screen().customColumns}>
            <PopItem
              title={CUSTOM_SET_TITLE}
              selected={screen().activeColumnSetId === CUSTOM_SET_ID}
              onClick={() => {
                screenerStore.update((s) => ({ ...s, activeColumnSetId: CUSTOM_SET_ID }));
                setSetsOpen(false);
              }}
            />
          </Show>
          <For each={offeredSets()}>
            {(set) => (
              <PopItem
                title={set.title}
                selected={screen().activeColumnSetId === set.id}
                onClick={() => {
                  screenerStore.update((s) => ({ ...s, activeColumnSetId: set.id }));
                  setSetsOpen(false);
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
    </div>
  );
}
