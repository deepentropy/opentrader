/*
 * ChartView — single chart pane backed by lightweight-charts (v5).
 *
 * The chart's imperative state (chart, series, bars, controller) is one plain
 * core object; the view's parts (view/*.ts) are all created with it into one
 * context (createChartCx) and read and write it there. The chart is created
 * on mount, before any part's effect runs; theme and chart-type changes
 * rebuild the series (view/series.ts).
 *
 * Drawings: every kind lives in the <DrawingsOverlay> SVG layer fed a
 * Coords bridge (refreshed on every series rebuild) and a `coordEpoch`
 * counter that bumps on pan/zoom. Horizontal-line was the last holdout
 * (native priceLine through Feature 5a); Feature 5c moved it to the
 * overlay for parity with the other 13 kinds.
 */
import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { CrosshairMode, createChartEx, type IChartApi, type MouseEventParams } from "lightweight-charts";
import { trackPendingRange } from "./pending-range";
import { readChartTokens, readFontFamily } from "./chart-tokens";
import { chartNumberOptions, localizeLibraryNumbers } from "./price-format";
import { chartBackgroundAt } from "./selection-markers";
import { MAIN_SOURCE_ID } from "./object-tree-sources";
import { CrosshairLockAxisPrimitive, CrosshairLockPanePrimitive, CrosshairLockViews, crosshairLockTime } from "./crosshair-lock";
import { textOnColor } from "lightweight-charts-drawing/core/color";
import { EventMarkersPrimitive } from "./event-markers";
import { NewsLollipopPrimitive } from "./news-lollipop";
import { HistoryEndPrimitive } from "./history-end-marker";
import { providerCapabilities } from "../../data/providers/capabilities";
import { CountdownPrimitive } from "./countdown";
import { ChartControlBar } from "./ChartControlBar";
import { ZOOM_FACTOR } from "./control-bar";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { appearanceFrom, uiTheme } from "../header/chart-settings";
import { clearActiveChartProbe, setActiveChartProbe } from "./active-chart";
import { CompareSettingsDialog } from "./compare/CompareSettingsDialog";
import {
  getBars,
  DAILY_ONLY_MESSAGE,
  intervalLabel,
  isLocalSymbol,
  isSupportedResolution,
  symbolServesResolution,
  splitSymbol,
  type BarsResult,
  type SessionId,
} from "../../data/datafeed";
import { localIntervalMessage } from "../../data/local-series";
import { isTransformType, transformBarsOf } from "./chart-types";
import { type LegendValues } from "./ChartLegend";
import { type DialogTab } from "./IndicatorSettingsDialog";
import { PriceScaleWatch } from "./scale-watch";
import { type IndicatorLegendRow } from "./indicators/indicator-controller";
import { isStrategyId } from "./indicators/strategy-entries";
import { strategyTester } from "../../data/strategy-tester-store";
import { registerChartState, unregisterChartState, type ChartBar } from "../../data/chart-state-registry";
import { ChartContextMenu } from "./ChartContextMenu";
import { type Coords } from "../drawings/coords";
import { DrawingsOverlay } from "../drawings/DrawingsOverlay";
import { cursorForMode } from "../drawings/cursors";
import { createChartCx, type ChartCore, type ChartCx, type ChartMenuState, type ChartViewProps, type ShownSeries } from "./view/context";
import { appearanceOptions } from "./view/helpers";
import { createNavigation } from "./view/navigation";
import { createMenus } from "./view/menus";
import { createPriceAxis } from "./view/price-axis";
import { createPanes } from "./view/panes";
import { createDecorations } from "./view/decorations";
import { createAlertLayer } from "./view/alert-layer";
import { createHistory } from "./view/history";
import { createBarSlice } from "./view/bar-slice";
import { createCompare } from "./view/compare";
import { createScales } from "./view/scales";
import { createSources } from "./view/sources";
import { createSourceMenu } from "./view/source-menu";
import { createSnapshot } from "./view/snapshot";
import { createLive } from "./view/live";
import { createNews } from "./view/news";
import { createEvents } from "./view/events";
import { createPointer } from "./view/pointer";
import { createWindowEvents } from "./view/window-events";
import { createTickerInfo } from "./view/ticker-info";
import { createSymbolLoad } from "./view/symbol-load";
import { createReplay } from "./view/replay";
import { createTradingLines } from "./view/trading-lines";
import { createStrategyMarks } from "./view/strategy-marks";
import { createLegend } from "./view/legend";
import { createFutureAxis } from "./view/future-axis";
import { createSeries } from "./view/series";
import { createTimeAxis } from "./view/time-axis";
import { createStudySync } from "./view/study-sync";
import { createStudySettings } from "./view/study-settings";
import { createPaneEdits } from "./view/pane-edits";

/** Per-instance id so a pane ignores its own sync-bus broadcasts. */
let paneSyncSeq = 0;

/** "Interval is not supported" icon (120 × 120). */
const INTERVAL_UNSUPPORTED_ICON = "M19 53a41.13 41.13 0 0 1 39-40.95V24h4V12.05A41.13 41.13 0 0 1 101 53H86v4h14.92c-.4 9.6-2.33 14.5-5.23 19.07-1.07 1.69-2.89 2.86-5.24 4.27l-.35.22c-2.12 1.26-4.64 2.77-6.34 5.07a20.08 20.08 0 0 0-2.46 4.78c-.3.81-.6 1.64-.86 2.42l-.01.03-.79 2.2a11.1 11.1 0 0 1-1.62 3.13c-.5.58-.96.81-1.59.81-1.02 0-1.42-.3-1.68-.6a8.03 8.03 0 0 1-1.11-2.25 9.58 9.58 0 0 0-2.06-3.45c-1.22-1.2-2.87-1.79-5.04-1.7a5.18 5.18 0 0 0-3.37 1.38 7.62 7.62 0 0 0-1.82 2.8 30.91 30.91 0 0 0-1.44 5.91l-.11.67c-.41 2.28-.81 4.2-1.51 5.55a3.5 3.5 0 0 1-1.03 1.3c-.33.22-.76.39-1.42.39a1.3 1.3 0 0 1-1.04-.46 5.71 5.71 0 0 1-1.08-2.15c-.68-2.13-1-5.03-1.35-8.26l-.02-.18c-.34-3.16-.73-6.64-1.66-9.35-.91-2.69-2.67-5.42-6.17-5.6-2.58-.13-4.56.41-6.15 1.42-1.53.97-2.54 2.3-3.3 3.36l-.33.45c-.66.92-1.12 1.56-1.7 2.05-.55.45-1.23.78-2.44.72-.29-.01-.74-.15-1.36-.67a10.78 10.78 0 0 1-2.05-2.46c-1.45-2.26-2.86-5.51-4.1-9.37A91.79 91.79 0 0 1 19.12 57H34v-4H19Zm-4 0C15 28.24 35.24 8 60 8s45 20.24 45 45c0 12.9-2.15 19.26-5.93 25.21-1.66 2.61-4.33 4.23-6.56 5.56l-.08.05c-2.35 1.41-4.24 2.55-5.45 4.2a16.23 16.23 0 0 0-1.94 3.82c-.29.75-.55 1.51-.82 2.3l-.02.06-.82 2.28a14.83 14.83 0 0 1-2.31 4.3 5.9 5.9 0 0 1-4.64 2.22 5.9 5.9 0 0 1-4.7-1.98c-.86-1-1.36-2.26-1.72-3.16l-.05-.13-.04-.1a5.95 5.95 0 0 0-1.13-2.07c-.29-.28-.8-.61-2.08-.56-.38.01-.62.13-.83.33-.25.23-.54.65-.82 1.35a27.9 27.9 0 0 0-1.22 5.17l-.05.28-.05.33c-.4 2.18-.88 4.7-1.9 6.69a7.45 7.45 0 0 1-2.28 2.72 6.32 6.32 0 0 1-3.72 1.13 5.29 5.29 0 0 1-3.97-1.73 9.55 9.55 0 0 1-1.97-3.66c-.8-2.53-1.15-5.78-1.48-8.8l-.04-.43c-.36-3.28-.72-6.28-1.47-8.48-.76-2.23-1.63-2.85-2.59-2.9-1.88-.1-3.02.3-3.8.8a8.33 8.33 0 0 0-2.21 2.32l-.28.38c-.62.89-1.42 2-2.44 2.86A7.23 7.23 0 0 1 30.42 95a6.33 6.33 0 0 1-3.73-1.59c-1.05-.87-2-2.04-2.86-3.37-1.72-2.68-3.26-6.3-4.55-10.32A93.67 93.67 0 0 1 15 53Zm43-12V66.16l1.23.51 12.86 5.38 1.54-3.69L62 63.5V41h-4Z";

export function ChartView(props: ChartViewProps) {
  // This pane's committed appearance (Settings dialog draft → folded subset).
  // Compared BY VALUE: focusing a pane in a multi-chart layout replaces the
  // tabs() signal, handing this memo a new settings object with identical
  // content. A reference-only memo would then notify on every focus and re-run
  // the theme effect below, which re-applies `rightOffset` — snapping the view
  // back to the latest bar (the "click jumps the synced chart to today" bug).
  // The structural equals makes the memo notify only on a genuine settings
  // change. AppearanceOverride is flat primitives, so JSON compare is sound.
  // A pane with no stored settings takes the app theme's defaults, so the
  // memo also tracks the theme.
  const appearance = createMemo(() => (void props.theme, appearanceFrom(props.settings)), undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  // Current tokens WITHOUT subscribing to `appearance()` — so the imperative
  // helpers (createChart, rebuildSeries, the data-apply effect) read the live
  // value but only the dedicated theme/appearance effect below re-runs when the
  // pane's settings change (otherwise a commit would re-frame the chart).
  // Read once per appearance and theme: reading the CSS variables made every live tick recalculate styles (#249).
  let tokens: { appearance: unknown; theme: string; value: ReturnType<typeof readChartTokens> } | null = null;
  const currentTokens = () => {
    const a = untrack(appearance);
    const theme = uiTheme();
    if (tokens?.appearance !== a || tokens.theme !== theme) tokens = { appearance: a, theme, value: readChartTokens(a) };
    return tokens.value;
  };
  // Unique id for the layout-sync bus (crosshair / time / date-range mirroring).
  const paneId = ++paneSyncSeq;
  // The window-wide chart events (sync, link, go-to, keyboard actions) belong
  // to the shown tab: a hidden tab's pane ignores them. One wrapper per
  // handler, so add/removeEventListener get the same function.
  // Hidden tab (design 1): live data keeps
  // merging into `raw`, but nothing is drawn and the cosmetic timers skip;
  // the tab catches up once when shown (catchUpOnShow): hidden tab pages run
  // no animation frames.
  const hidden = () => props.shown === false;
  const gatedHandlers = new Map<unknown, EventListener>();
  const whenShown = <T extends Event>(fn: (e: T) => void): EventListener => {
    let g = gatedHandlers.get(fn);
    if (!g) {
      g = (e: Event) => {
        if (props.shown !== false) fn(e as T);
      };
      gatedHandlers.set(fn, g);
    }
    return g;
  };
  const lockPanes = new Map<unknown, CrosshairLockPanePrimitive>();
  /** Attach the lock line to every pane (panes come and go). */
  function syncLockPanes() {
    const { chart, lockViews } = cx;
    if (!chart || !lockViews) return;
    const panes = chart.panes();
    for (const [pane, prim] of [...lockPanes]) {
      if (!panes.includes(pane as never)) lockPanes.delete(pane);
      else if (crosshairLockTime() === null) {
        try { (pane as { detachPrimitive(p: unknown): void }).detachPrimitive(prim); } catch { /* pane gone */ }
        lockPanes.delete(pane);
      }
    }
    if (crosshairLockTime() === null) return;
    for (const pane of panes) {
      if (lockPanes.has(pane)) continue;
      const prim = new CrosshairLockPanePrimitive(lockViews);
      pane.attachPrimitive(prim);
      lockPanes.set(pane, prim);
    }
  }
  // Drawings re-project on time-scale changes (onRangeChange) and resizes;
  // price-scale-only changes (autoscale on new prices, price-axis drag, log /
  // percent mode) come from this series primitive (scale-watch.ts).
  const [coords, setCoords] = createSignal<Coords | null>(null);
  const [coordEpoch, setCoordEpoch] = createSignal(0);
  const scaleWatch = new PriceScaleWatch(() => {
    setCoordEpoch((n) => n + 1);
    // Pixel-anchored styles follow the price scale (base level, gradient
    // label colour, the last label's percentage row).
    cx.syncBaseline();
    cx.syncGradientLabel();
    cx.updateCountdown();
    cx.lockedSpacingFromScale();
    cx.refreshScaleOverlays();
    cx.refreshPaneBoxes();
  });
  /** Top-left data-window legend (O/H/L/C + change). Null while loading. */
  const [legend, setLegend] = createSignal<LegendValues | null>(null);
  /** Bumped once the chart + controller exist so the indicator effects run. */
  const [chartReady, setChartReady] = createSignal(0);
  /** Studies legend rows (one per active indicator). A store reconciled by
   *  row id: a live tick updates the values in place, so the rows (and their
   *  hover buttons) are not recreated on every refresh. */
  const [indLegendStore, setIndLegendStore] = createStore<{ rows: IndicatorLegendRow[] }>({ rows: [] });
  /** Registry id of the study whose Settings dialog is open (null = closed). */
  const [settingsForId, setSettingsForId] = createSignal<string | null>(null);
  /** Tab the next Settings dialog opens on (report toolbar gear = Properties). */
  const [settingsTab, setSettingsTab] = createSignal<DialogTab | undefined>(undefined);
  /** Selected study or compared symbol (reference: one selected source per
   *  chart, studies never multi-selected). Selected by a click on its legend
   *  title or on one of its plots, or by opening its settings; selecting it
   *  clears the drawing selection and selecting a drawing clears it. Delete /
   *  Backspace remove it, Escape or a click on the empty chart clear it. */
  const [selectedStudy, setSelectedStudy] = createSignal<string | null>(null);
  const [shownSeries, setShownSeries] = createSignal<ShownSeries | null>(null);
  /** Legend flag colour popup (its flag button), null = closed. */
  const [flagPopup, setFlagPopup] = createSignal<HTMLElement | null>(null);
  /** Legend "Chart syncing" menu (its button rect), null = closed. */
  const [syncMenu, setSyncMenu] = createSignal<DOMRect | null>(null);
  /** Chart background at a height, for the selection markers. */
  const studySelectionBg = createMemo(() => {
    const t = readChartTokens(appearance());
    return chartBackgroundAt(t.bg, t.bgBottom, t.bgGradient);
  });
  /** Compared-symbol Settings dialog (entry id; null = closed). */
  const [compareSettingsFor, setCompareSettingsFor] = createSignal<string | null>(null);
  // Right-click context menu: open position + resolved node list (null = closed).
  // `corner`: the price-scale menu of the axis corner button (opened above it).
  const [ctxMenu, setCtxMenu] = createSignal<ChartMenuState | null>(null);
  // Forced-refetch counter: bumped by "chart-reload-data" (e.g. the bottom
  // bar's ADJ toggle flips the kv adjustment flag, then asks every pane to
  // refetch on the new basis). Folded into the resource key so the same
  // symbol/interval re-fetches.
  const [reloadTick, setReloadTick] = createSignal(0);
  // Memoized ticker / interval label: `props.symbol` and `props.interval`
  // re-notify whenever the pane object is replaced (e.g. the debounced
  // visible-range save on every scroll). Compared by value, the name and
  // watermark effects re-run only on a real change instead of clearing
  // and re-fetching the name (the legend flashing the ticker) on each scroll.
  const ticker = createMemo(() => splitSymbol(props.symbol ?? "").ticker);
  /** Full name for reference / news lookups (the provider tells listings apart). */
  const fullSymbol = createMemo(() => props.symbol ?? "");
  const intervalText = createMemo(() => intervalLabel(props.interval ?? "1D"));

  // Real-data fetch — routed through the datafeed, which picks the source per
  // resolution (REST second/minute aggs, S3 daily flat files) and aggregates
  // 1W/1M. Returns a BarsResult (display bars + underlying daily for
  // scroll-back); null on error so the pane reads as empty rather than stale.
  // Source is a PRIMITIVE string key, not an object literal: createResource
  // compares the source by `===`, so a fresh `{ sym, interval }` object would
  // refetch on every upstream invalidation even when the values are unchanged.
  // In multi-pane layouts, focusing a pane replaces the `tabs()` signal, which
  // re-runs every pane's symbol/interval getters — with an object source that
  // spun the loading wheel on each pane though the symbol never changed. A
  // value-comparable string key dedupes those no-op invalidations.
  const historyKey = () =>
    `${props.symbol ?? "AAPL"} ${props.interval ?? "1D"} ${props.session ?? "RTH"} ${reloadTick()}`;
  /** See ChartCore.nextBars. */
  let nextBars: ChartCore["nextBars"] = null;
  const [history] = createResource<BarsResult | null, string>(
    historyKey,
    async (key) => {
      // sym/interval/session — none contain spaces, so a plain split is safe
      // (the trailing reload counter is key-only).
      const [sym, interval, session] = key.split(" ") as [string, string, SessionId];
      if (nextBars) {
        const given = nextBars;
        nextBars = null;
        if (given.series === `${sym} ${interval} ${session}`) return given.result;
      }
      try {
        const t0 = performance.now();
        {
          const w = window as unknown as { __clickT?: number };
          if (w.__clickT) console.log(`[fetch-start] ${sym} ${interval}: select→fetch-start ${(t0 - w.__clickT).toFixed(0)}ms`);
        }
        // A server that cannot be reached (e.g. no network yet at app start)
        // is tried again until it answers, as long as the pane still shows
        // this series: the chart fills in by itself once connected.
        const r = await getBars(sym, interval, session, () => untrack(historyKey) === key);
        console.log(
          `[history] ${sym} ${interval}: ${r.bars.length} bars (daily ${r.daily?.length ?? 0}) in ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return r;
      } catch (e) {
        console.warn("[chart] real history fetch failed; keeping synthetic", e);
        return null;
      }
    },
  );

  function selectStudy(id: string) {
    setSelectedStudy(id);
    if (props.selectedDrawingId || (props.selectedDrawingIds?.length ?? 0) > 0) props.setSelectedDrawingId?.(null);
  }
  /** Eye of a source (legend, More menu, Object tree): the main series, a
   *  compared symbol or a study. The state is saved with the chart. */
  function toggleSourceHidden(id: string) {
    if (id === MAIN_SOURCE_ID) { cx.edits.toggleSeriesHidden(); return; }
    const cmp = cx.compareEntry(id);
    if (cmp) { cx.edits.patchCompare(id, { hidden: !cmp.hidden }); return; }
    if (!cx.controller) return;
    const nowHidden = cx.controller.toggleHidden(id);
    cx.edits.setIndicatorSettings(id, { hidden: nowHidden || undefined });
    cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    if (isStrategyId(id)) cx.applyStrategyMarkers();
  }
  /** Remove a study or a compared symbol (same path as the legend trash). */
  function removeStudy(id: string) {
    if (cx.compareEntry(id)) cx.edits.removeCompare(id);
    else cx.edits.removeIndicator(id);
  }

  // The view's state, read and written by its parts through the context.
  const core: ChartCore = {
    props,
    edits: createPaneEdits(props),
    paneId,
    appearance,
    currentTokens,
    hidden,
    whenShown,
    /** Work to redo when the tab is shown again (footprint cells, news). */
    onShownHooks: new Set<() => void>(),
    // Set by their refs when the view renders, before any effect runs.
    host: undefined!,
    paneRoot: undefined!,
    gotoWrap: undefined!,
    barWrap: undefined!,
    hostW: 0,
    hostH: 0,
    chart: null,
    series: null,
    controller: null,
    activeType: props.chartType ?? "candle",
    raw: [],
    allBars: [],
    rawDaily: [],
    appliedSeriesPane: null,
    history,
    reloadTick,
    setReloadTick,
    chartReady,
    swapping: false,
    shownSeries,
    setShownSeries,
    pendingRangeSpan: null,
    get nextBars() {
      return nextBars;
    },
    set nextBars(v: ChartCore["nextBars"]) {
      nextBars = v;
    },
    rangePersistTimer: undefined,
    coords,
    setCoords,
    coordEpoch,
    setCoordEpoch,
    scaleWatch,
    // Dividend / split / earnings lollipops (Events tab), the latest news lollipop, the end-of-history icon and
    // the "Countdown to bar close" axis label: re-attached to the series on every rebuild.
    eventMarkers: new EventMarkersPrimitive(),
    newsLollipop: new NewsLollipopPrimitive(),
    historyEnd: new HistoryEndPrimitive(),
    countdown: new CountdownPrimitive(),
    lockViews: null,
    lockAxis: null,
    syncLockPanes,
    pointerOverHost: false,
    crosshairActive: false,
    crosshairMirrored: false,
    emitCrosshair: null,
    crosshairAt: null,
    crosshairPrice: null,
    lastLegendTime: undefined,
    hoveredStudy: null,
    legend,
    setLegend,
    indLegend: () => indLegendStore.rows,
    setIndLegendStore,
    selectedStudy,
    setSelectedStudy,
    selectStudy,
    toggleSourceHidden,
    removeStudy,
    studySelectionBg,
    settingsForId,
    setSettingsForId,
    settingsTab,
    setSettingsTab,
    setCompareSettingsFor,
    ctxMenu,
    setCtxMenu,
    flagPopup,
    setFlagPopup,
    syncMenu,
    setSyncMenu,
    ticker,
    fullSymbol,
    intervalText,
  };
  // Markers fall back to gap-aware positioning when a date isn't on a bar.
  core.eventMarkers.setBarsAccessor(() => cx.raw);
  core.eventMarkers.setBricksAccessor(() => (isTransformType(cx.activeType) ? transformBarsOf(cx.series) : null));
  core.newsLollipop.setLastTimeAccessor(() => (cx.latestBar()?.time as number | undefined) ?? null);

  // The chart is created first: every part's effects find it on their first run.
  onMount(() => {
    const tokens = currentTokens();
    const base = appearanceOptions(tokens);
    const host = cx.host;
    const chart = createChartEx(host, cx.timeScaleBehavior, {
      width: host.clientWidth,
      height: host.clientHeight,
      ...base,
      layout: { ...base.layout, fontFamily: readFontFamily() },
      crosshair: { ...base.crosshair, mode: CrosshairMode.Normal },
      // A new bar landing on a future bar scrolls the view as any new bar does.
      timeScale: { ...base.timeScale, timeVisible: false, allowShiftVisibleRangeOnWhitespaceReplacement: true },
      // Disable the library's cursor-anchored mouse-wheel zoom; we replace it
      // below with a right-edge-anchored zoom (see onWheel).
      handleScale: { mouseWheel: false },
      // createChart's default for its time scale (the time formatter replaces it).
      localization: { dateFormat: "dd MMM 'yy", ...chartNumberOptions() },
    }) as IChartApi;
    // The indexed-to-100 scale's values in the language's marks ("103,25").
    localizeLibraryNumbers(chart);
    trackPendingRange(chart);
    cx.chart = chart;
    cx.lockViews = new CrosshairLockViews(chart, () => {
      const t = currentTokens();
      return {
        color: t.crosshairColor,
        width: Math.max(1, Math.min(4, t.crosshairWidth)),
        dash: t.crosshairStyle === 0 ? [] : t.crosshairStyle === 2 ? [1, 1] : [4, 4],
        labelBg: t.crosshairLabelBg,
        dark: textOnColor(t.bg).toUpperCase() === "#FFFFFF",
      };
    });
    cx.lockAxis = new CrosshairLockAxisPrimitive(cx.lockViews);
    // Start empty; real candles arrive from the history resource.
    cx.loadBars([]);
    cx.rebuildSeries();

    cx.controller = cx.createController(chart);
    setChartReady((n) => n + 1);

    cx.hostW = host.clientWidth;
    cx.hostH = host.clientHeight;
    const ro = new ResizeObserver(() => {
      if (!cx.chart) return;
      cx.hostW = host.clientWidth;
      cx.hostH = host.clientHeight;
      console.log(`[resize] hostW=${host.clientWidth} hostH=${host.clientHeight} raw=${cx.raw.length}`);
      cx.chart.applyOptions({
        width: host.clientWidth,
        height: host.clientHeight,
      });
      setCoordEpoch((n) => n + 1);
      // Pane heights and the scale width both move with the pane — re-anchor
      // and re-fit the control bars on resize.
      cx.refreshControlBars();
    });
    ro.observe(host);

    cx.installControlBars();

    const onRangeChange = () => {
      setCoordEpoch((n) => n + 1);
      // Same % scale values are measured from the first visible bar.
      if (!cx.crosshairActive && cx.compareEntries().some((e) => e.placement === "percent")) cx.refreshIndicatorLegend();
      cx.refreshControlBars();
      // High/Low follow the visible bars, on followers too.
      cx.updateHighLowLines();
      // A view set by an inbound sync is not this pane's own: it must not page
      // (the sync loader fetched its history in one request), be persisted
      // (a follower would save a clamped view), or be broadcast.
      if (cx.syncGuard) return;
      // The slice of the loaded bars the chart is given follows the view (bar-slice.ts), then history pages in.
      cx.followSlice();
      cx.maybeLoadOlder();
      cx.maybeLoadNewer();
      // Persist the user's anchor (debounced) so it survives tab switches +
      // reloads. Skipped while a symbol swap is mid-flight (the apply effect is
      // about to set the range itself — capturing the outgoing/transient range
      // here would clobber the new pane's saved view), and in a window of past
      // bars (a reload opens on the latest bars, where its indices mean nothing).
      if (!cx.swapping && cx.chart && cx.pastWindowEnd === null && cx.sliceAtEnd()) {
        const lr = cx.chart.timeScale().getVisibleLogicalRange();
        if (lr) {
          // Tag the scheduled write with the pane this range belongs to. The
          // grid reuses one ChartView instance across tab switches (only its
          // props change), so a timer queued for the old tab could otherwise
          // fire after the switch and clobber the new tab's anchor.
          const forSym = props.symbol;
          const forInt = props.interval;
          if (cx.rangePersistTimer !== undefined) clearTimeout(cx.rangePersistTimer);
          cx.rangePersistTimer = setTimeout(() => {
            cx.rangePersistTimer = undefined;
            if (props.symbol !== forSym || props.interval !== forInt || !cx.chart) return;
            // Price-based types: the item count changes with the data, so
            // the view is saved relative to the last item.
            const last = isTransformType(cx.activeType) ? cx.mainLastIndex() : null;
            // Bar spacing and right offset too: a chart a larger template
            // adds opens at them (reference app).
            const scale = { barSpacing: cx.chart.timeScale().options().barSpacing, rightOffset: cx.chart.timeScale().scrollPosition() };
            cx.edits.setVisibleRange(last != null ? { from: lr.from, to: lr.to, last, ...scale } : { from: lr.from, to: lr.to, ...scale });
          }, 250);
        }
      }
      cx.broadcastRange(false);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    // Pixel-anchored styles also follow the time scale: the locked ratio,
    // the baseline level and the last label's percentage row.
    const onStyleRange = () => {
      cx.applyLockedRatio();
      cx.syncBaseline();
      if (currentTokens().symbolValuePercent) cx.updateCountdown();
      cx.extendFutureBars();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onStyleRange);

    cx.installPointer();
    cx.installAlertPointer();
    cx.installTimeSync();
    cx.installChartEvents();

    onCleanup(() => {
      if (cx.rangePersistTimer !== undefined) clearTimeout(cx.rangePersistTimer);
      ro.disconnect();
      cx.chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      cx.chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onStyleRange);
      cx.controller?.destroy();
      cx.controller = null;
      cx.chart?.remove();
      cx.chart = null;
      cx.series = null;
    });
  });

  // Every part, in the order their effects run.
  const cx: ChartCx = createChartCx(
    core,
    createLegend,
    createNavigation,
    createMenus,
    createPriceAxis,
    createPanes,
    createDecorations,
    createAlertLayer,
    createHistory,
    createBarSlice,
    createPointer,
    createWindowEvents,
    createFutureAxis,
    createSeries,
    createStrategyMarks,
    createTimeAxis,
    createSymbolLoad,
    createStudySync,
    createCompare,
    createScales,
    createSources,
    createSourceMenu,
    createSnapshot,
    createLive,
    createReplay,
    createTradingLines,
    createNews,
    createEvents,
    createTickerInfo,
    createStudySettings,
  );
  cx.installDataEvents();

  // The focused pane exposes its live price/bar ratio to the Settings dialog.
  const probeOwner = {};
  createEffect(() => {
    if (props.active) setActiveChartProbe(probeOwner, { scaleRatio: () => cx.liveScaleRatio(), alertTarget: cx.alertTarget });
    else clearActiveChartProbe(probeOwner);
  });
  onCleanup(() => clearActiveChartProbe(probeOwner));
  // Strategy Tester: the active pane's id selects which chart's report shows.
  createEffect(() => {
    // Every open tab keeps its grid mounted: only the SHOWN tab's active pane counts.
    if (props.active && props.shown !== false) strategyTester.setActiveChartId(String(paneId));
  });
  onCleanup(() => {
    if (strategyTester.activeChartId() === String(paneId)) strategyTester.setActiveChartId(null);
    strategyTester.dropChart(String(paneId));
  });

  // Expose this chart's latest price + indicator values to the alert engine,
  // keyed by the full name ("NASDAQ:AAPL"). Re-keys on symbol change; provider reads the mutable
  // `raw`/`controller` lazily so values are always current. (chart-state-registry.ts)
  createEffect(() => {
    const key = (props.symbol ?? "").toUpperCase();
    if (!key) return;
    registerChartState(key, {
      lastPrice: () => cx.latestBar()?.close ?? null,
      lastBarTime: () => {
        const t = cx.latestBar()?.time;
        return typeof t === "number" ? t * 1000 : null;
      },
      indicatorLegend: () => cx.controller?.getLegend() ?? [],
      resolution: () => props.interval ?? "",
      session: () => props.session ?? "RTH",
      // Every loaded bar (the chart may be given a slice of them, bar-slice.ts).
      bars: () => (cx.replayActive ? cx.raw : cx.allBars) as ChartBar[],
      compares: () => cx.compareSources(),
      loading: () => cx.swapping,
    });
    onCleanup(() => unregisterChartState(key));
  });

  // When this pane becomes the focused one, claim the right-rail data window
  // (its latest bar, unless the crosshair is currently hovering it).
  createEffect(() => {
    if (props.active) cx.refreshLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  });

  // Locked cursor line: the library's vertical line (and its time label)
  // give way to the lock views.
  createEffect(() => {
    chartReady();
    const locked = crosshairLockTime() !== null;
    untrack(() => {
      cx.chart?.applyOptions({ crosshair: { vertLine: { visible: !locked, labelVisible: !locked } } });
      syncLockPanes();
    });
  });
  // "Scale price chart only": studies and compared symbols on the main
  // series' scale leave its auto-scale.
  createEffect(() => {
    chartReady();
    const id = cx.seriesOnlyScale();
    untrack(() => {
      cx.controller?.setSeriesOnlyScale(id);
      for (const layer of cx.compareLayers.values()) layer.setSeriesOnlyScale(id);
    });
  });
  // Studies pinned to a side scale ("Pin to scale") follow the main scale's side.
  createEffect(() => {
    chartReady();
    const side = readChartTokens(appearance()).scalesPlacement;
    untrack(() => {
      cx.controller?.setMainSide(side);
      cx.syncSideScales();
    });
  });
  // Selection markers on the selected study's plots.
  createEffect(() => {
    chartReady();
    const id = selectedStudy();
    const bg = studySelectionBg();
    untrack(() => {
      cx.controller?.setSelected(id, bg);
      for (const [cid, layer] of cx.compareLayers) layer.setSelected(cid === id ? bg : null);
    });
  });

  // Theme + per-pane appearance reactivity. Re-runs when the theme toggles or
  // this pane's Settings change (Ok / Apply to all): re-apply the canvas options
  // and re-seed the series so candle/grid/crosshair/scale/margin colours take
  // effect live. Skips the first run — createChart already seeded both on mount.
  let firstTheme = true;
  createEffect(() => {
    void props.theme;
    appearance(); // subscribe: re-run when this pane's committed settings change
    const t = currentTokens();
    if (firstTheme) {
      firstTheme = false;
      return;
    }
    const { chart } = cx;
    if (!chart) return;
    // Untracked: the rebuild reads other signals (pane props, the 15 s status
    // clock...). Tracked, every scroll-position save and clock tick re-ran this
    // effect and rebuilt the series and the studies mid-scroll.
    untrack(() => {
      chart.applyOptions(appearanceOptions(t));
      // Right margin (bars) nudges the view, so apply it off the initial mount.
      chart.timeScale().applyOptions({ rightOffset: t.rightOffset });
      cx.rebuildSeries();
      // Compared symbols: scale sides and visibility follow the placement.
      cx.syncCompare();
    });
  });

  function catchUpOnShow() {
    if (cx.compareLiveDirty) {
      cx.compareLiveDirty = false;
      cx.renderCompareAll();
    }
    if (cx.liveDirty) {
      const appended = cx.liveAppendedWhileHidden;
      cx.liveDirty = false;
      cx.liveAppendedWhileHidden = false;
      cx.paintLive(null, appended);
    }
    cx.updateCountdown();
    cx.setStatusClock(Date.now());
    for (const f of [...cx.onShownHooks]) f();
  }
  let wasShown = !hidden();
  createEffect(() => {
    const shown = !hidden();
    if (shown && !wasShown) untrack(catchUpOnShow);
    wasShown = shown;
  });

  // End-of-history icon: the history floor arrives with the entitlement
  // probe; the icon colour follows the chart background.
  createEffect(() => {
    void providerCapabilities();
    void appearance();
    untrack(cx.updateHistoryEnd);
  });

  const {
    ExtraAxisOverlays,
    EventCard,
    LegendStacks,
    NewsCard,
    PaneControls,
    PriceAxisOverlays,
    ReplaySelectLayer,
    StudySettingsDialog,
    TradingLinesLayer,
  } = cx;

  return (
    <div
      ref={(el) => (cx.paneRoot = el)}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        "min-width": 0,
        "min-height": 0,
        overflow: "hidden",
        cursor: props.armedTool ? "crosshair" : undefined,
        // The legend plates are backed with THIS chart's background (a chart
        // keeps custom colours when the app theme changes).
        "--ot-chart-bg": appearance().bg,
      }}
      onContextMenu={cx.openContextMenu}
      onMouseEnter={() => { cx.setChartHovered(true); cx.refreshScaleOverlays(); cx.refreshPaneBoxes(); }}
      onMouseMove={(e) => {
        const r = cx.paneRoot.getBoundingClientRect();
        const pane = cx.paneAtY(e.clientY - r.top);
        cx.setHoverPane(pane);
        const x = e.clientX - r.left;
        // Over a price axis of the pane (either side: the series sharing a
        // study pane has the other side).
        const lw = cx.leftAxisWidth();
        let rw = 0;
        try { rw = cx.chart?.priceScale("right").width() ?? 0; } catch { /* not laid out */ }
        cx.setAxisHover(cx.scaleGeom() && pane !== null && ((lw > 0 && x < lw) || (rw > 0 && x >= r.width - rw)) ? pane : null);
      }}
      onMouseLeave={() => { cx.setChartHovered(false); cx.setAxisHover(null); cx.setHoverPane(null); cx.setPlusY(null); }}
    >
      <div
        ref={(el) => (cx.host = el)}
        style={{
          position: "absolute",
          inset: 0,
          // Cursor-group mode drives the on-canvas pointer (dot/arrow glyphs);
          // an armed tool forces the crosshair. Eraser/laser are handled by the
          // overlay, which captures the pane in those modes.
          cursor: cursorForMode(props.cursorMode ?? "cross", !!props.armedTool),
        }}
      />
      <DrawingsOverlay
        active={props.active}
        shown={props.shown}
        interval={props.interval}
        symbol={props.symbol ?? ""}
        coords={coords()}
        leftInset={cx.legendLeft()}
        formatPrice={cx.legendPriceFormat()}
        panes={cx.drawingPanes()}
        sunk={cx.sunkIds()}
        onPainter={(p) => {
          cx.sunkPainter = p;
          cx.scheduleSourceOrder();
        }}
        coordEpoch={coordEpoch()}
        drawings={props.drawings ?? []}
        armedTool={props.armedTool ?? null}
        cursorMode={props.cursorMode ?? "cross"}
        armedGlyph={props.armedGlyph}
        magnet={!!props.magnet}
        anchorBg={(() => { const t = readChartTokens(appearance()); return { top: t.bg, bottom: t.bgBottom, gradient: t.bgGradient }; })()}
        magnetMode={props.magnetMode ?? "weak"}
        magnetSnapsToIndicators={!!props.magnetSnapsToIndicators}
        onArmedCursor={(at) => {
          // An armed drawing tool: the chart's crosshair (lines, scale labels, sync) at the cursor's bar (#179).
          const { chart, series } = cx;
          if (!chart || !series) return;
          const time = at ? chart.timeScale().coordinateToTime(at.x) : null;
          const y = at ? series.priceToCoordinate(at.price) : null;
          if (!at || time === null || y === null) {
            chart.clearCrosshairPosition();
            cx.emitCrosshair?.({ time: undefined, logical: undefined, point: undefined, seriesData: new Map(), paneIndex: cx.mainPane() } as unknown as MouseEventParams);
            return;
          }
          chart.setCrosshairPosition(at.price, time, series);
          // The legend and the crosshair sync follow it as they follow the mouse.
          const logical = chart.timeScale().coordinateToLogical(at.x);
          cx.emitCrosshair?.({ time, logical: logical ?? undefined, point: { x: at.x, y }, seriesData: new Map(), paneIndex: cx.mainPane() } as unknown as MouseEventParams);
        }}
        stayMode={!!props.stayMode}
        onPlace={(d) => cx.edits.placeDrawing(d)}
        onDisarm={() => props.onDisarm?.()}
        selectedId={props.selectedDrawingId ?? null}
        selectedIds={props.selectedDrawingIds}
        setSelectedId={(id) => props.setSelectedDrawingId?.(id)}
        onToggleSelect={(id) => props.toggleSelectedDrawing?.(id)}
        onUpdate={(d, label) => cx.edits.updateDrawing(d, label)}
        onUpdateMany={(list) => cx.edits.updateDrawings(list)}
        onClone={(id) => cx.edits.cloneDrawing(id)}
        drawingSync={(id) => cx.edits.drawingSync(id) ?? null}
        onSync={(ids, mode) => cx.edits.setDrawingSync(ids, mode)}
        onReorder={(id, dir) => cx.edits.reorderDrawing(id, dir)}
        onRemove={(id) => cx.edits.removeDrawing(id)}
        onRemoveMany={(ids) => cx.edits.removeDrawings(ids)}
      />
      <TradingLinesLayer epoch={coordEpoch()} />
      <ReplaySelectLayer />
      <PriceAxisOverlays />
      <ExtraAxisOverlays />
      {/* Latest news card (lollipop tooltip, type "news"): "Latest updates"
          title, newest headline card. */}
      <NewsCard />
      <EventCard />
      {/* An interval the symbol has no bars on (an economic series below D). */}
      <Show when={isSupportedResolution(props.interval ?? "1D") && !symbolServesResolution(props.symbol, props.interval ?? "1D")}>
        <div class="ot-interval-unsupported">
          <div class="ot-interval-unsupported__card">
            <svg class="ot-interval-unsupported__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
              <path fill="currentColor" fill-rule="evenodd" d={INTERVAL_UNSUPPORTED_ICON} />
            </svg>
            <strong class="ot-interval-unsupported__title">Interval is not supported</strong>
            <div class="ot-interval-unsupported__text">{isLocalSymbol(props.symbol) ? localIntervalMessage(props.symbol!) : DAILY_ONLY_MESSAGE}</div>
            <button type="button" class="ot-interval-unsupported__button" onClick={() => props.onSetInterval?.("1D")}>
              Switch to a D
            </button>
          </div>
        </div>
      </Show>
      <PaneControls />
      {/* Dim-and-hold transition overlay: darkens (and blocks) the outgoing
          chart while the new symbol's data loads, then fades out on swap.
          Sits above the canvas + drawings but below the legends, so the ticker
          header stays readable during the transition. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          "z-index": 4,
          background: "rgba(0, 0, 0, 0.38)",
          "pointer-events": cx.dimmed() ? "auto" : "none",
          opacity: cx.dimmed() ? 1 : 0,
          transition: "opacity 130ms ease",
        }}
      />
      {/* The centred group bar. Like the goto button below, the wrapper stays
          mounted so the pointer-proximity test always has a box to measure. */}
      <ChartControlBar
        ref={(el) => (cx.barWrap = el)}
        bottom={cx.gotoBox().bottom}
        left={cx.barLeft()}
        visible={cx.barShown()}
        fits={cx.barFits()}
        resetAvailable={cx.resetAvailable()}
        maximized={!!props.maximized}
        onZoomIn={() => cx.zoomSpan(1 / ZOOM_FACTOR)}
        onZoomOut={() => cx.zoomSpan(ZOOM_FACTOR)}
        onToggleMaximize={() => props.onToggleMaximize?.()}
        onMoveStart={cx.moveBars}
        onMoveStop={cx.stopScroll}
        onReset={cx.resetChartView}
      />
      {/* "Scroll to the most recent bar". The wrapper is always mounted — its
          box is what the pointer-proximity test measures — and only the button
          fades. Sits above the canvas but below the legends. */}
      <div
        ref={(el) => (cx.gotoWrap = el)}
        class="ot-control-bar"
        style={{ bottom: `${cx.gotoBox().bottom}px`, right: `${cx.gotoBox().right}px` }}
      >
        <Tooltip text="Scroll to the most recent bar" hotkey="Alt + Shift + →" side="top">
          <div
            class="ot-control-bar__btn"
            classList={{ "ot-control-bar__btn--hidden": !cx.gotoShown() }}
            onClick={cx.scrollToRealtime}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="chart-goto-realtime" />
          </div>
        </Tooltip>
      </div>
      {/* One column: the studies stack under the series
          row whatever its height (it wraps to two lines on narrow panes). */}
      <LegendStacks />
      <StudySettingsDialog />
      <Show when={compareSettingsFor() ? (props.compare ?? []).find((x) => x.id === compareSettingsFor()) : undefined} keyed>
        {(e) => (
          <CompareSettingsDialog
            entry={e}
            title={cx.compareTitle(e)}
            onApply={({ symbol, style }) => cx.edits.editSources({ compare: { [e.id]: symbol !== e.symbol ? { symbol, style } : { style } } }, `change ${cx.compareTitle(e)} style`)}
            onPreview={(next) => cx.setComparePreview(next ? { id: e.id, ...next } : null)}
            onClose={() => setCompareSettingsFor(null)}
          />
        )}
      </Show>
      <Show when={ctxMenu()}>
        {(m) => (
          <ChartContextMenu x={m().x} y={m().y} endX={m().endX} endY={m().endY} nodes={m().nodes} onClose={() => setCtxMenu(null)} />
        )}
      </Show>
    </div>
  );
}
