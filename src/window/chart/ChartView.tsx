/*
 * ChartView — single chart pane backed by lightweight-charts (v5).
 *
 * Chart and series are imperative state held in plain `let` bindings.
 * Theme + chart-type changes both flow in via Solid effects that swap the
 * active series via createSeriesForType / setDataForType.
 *
 * Drawings: every kind lives in the <DrawingsOverlay> SVG layer fed a
 * Coords bridge (refreshed on every series rebuild) and a `coordEpoch`
 * counter that bumps on pan/zoom. Horizontal-line was the last holdout
 * (native priceLine through Feature 5a); Feature 5c moved it to the
 * overlay for parity with the other 13 kinds.
 */
import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { typeIdOf } from "./indicators/study-id";
import {
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Logical } from "lightweight-charts";
import { readChartTokens, readFontFamily } from "./chart-tokens";
import { chartBackgroundAt } from "./selection-markers";
import { MAIN_SOURCE_ID } from "./object-tree-sources";
import { CrosshairLockAxisPrimitive, CrosshairLockPanePrimitive, CrosshairLockViews, crosshairLockTime } from "./crosshair-lock";
import { textOnColor } from "lightweight-charts-drawing/core/color";
import { SessionBreaksPrimitive, computeSessionBoundaries } from "./session-breaks";
import { SessionBackgroundsPrimitive, computeSessionRuns } from "./session-backgrounds";
import { EventMarkersPrimitive } from "./event-markers";
import { NewsLollipopPrimitive } from "./news-lollipop";
import { HistoryEndPrimitive } from "./history-end-marker";
import { providerCapabilities } from "../../data/providers/capabilities";
import { saveIndicatorDefault } from "../../data/indicator-defaults";
import { CountdownPrimitive, countdownText } from "./countdown";
import { ChartControlBar } from "./ChartControlBar";
import { ZOOM_FACTOR } from "./control-bar";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { appearanceFrom } from "../header/chart-settings";
import { clearActiveChartProbe, setActiveChartProbe } from "./active-chart";
import { CompareSettingsDialog } from "./compare/CompareSettingsDialog";
import {
  getBars,
  getEvents,
  intervalLabel,
  isIntradayInterval,
  isIntradayResolution,
  isSecondResolution,
  splitSymbol,
  type BarsResult,
  type SessionId,
} from "../../data/datafeed";
import { type Candle } from "../../bindings";
import { createSeriesForType, isTransformType, setDataForType, type AnySeries, type ChartTypeId, type OHLC } from "./chart-types";
import { type LegendValues } from "./ChartLegend";
import { chartPriceFormat } from "./price-format";
import { dayKeyer } from "./day-key";
import { cachedSymbolSessions } from "../../data/session";
import { IndicatorSettingsDialog, type DialogTab } from "./IndicatorSettingsDialog";
import { sourcesEdit } from "../shell/source-edits";
import { chartSeconds, profileMetaOf } from "./profiles/vbp-studies";
import { isTpoEntry } from "./profiles/tpo";
import { autoTicksPerRow } from "./profiles/tpo-engine";
import { PriceScaleWatch } from "./scale-watch";
import { IndicatorController, type IndicatorLegendRow } from "./indicators/indicator-controller";
import { getIndicatorEntry } from "./indicators/registry";
import { scriptChartContext } from "./indicators/script-chart";
import { isStrategyId } from "./indicators/strategy-entries";
import { strategyTester } from "../../data/strategy-tester-store";
import { registerChartState, unregisterChartState, type ChartBar } from "../../data/chart-state-registry";
import { ChartContextMenu } from "./ChartContextMenu";
import type { Bar } from "oakscriptjs";
import { makeCoords, type Coords, type FutureAxis } from "../drawings/coords";
import { sessionFutureAxis } from "./indicators/future-slots";
import { DrawingsOverlay } from "../drawings/DrawingsOverlay";
import { cursorForMode } from "../drawings/cursors";
import { attach, type ChartCore, type ChartCx, type ChartMenuState, type ChartViewProps } from "./view/context";
import { barsSpan, AxisFmt, formatAxisTime, formatTick, appearanceOptions } from "./view/helpers";
import { createNavigation } from "./view/navigation";
import { createMenus } from "./view/menus";
import { createPriceAxis } from "./view/price-axis";
import { createPanes } from "./view/panes";
import { createDecorations } from "./view/decorations";
import { createAlertLayer } from "./view/alert-layer";
import { createHistory } from "./view/history";
import { createCompare } from "./view/compare";
import { createSources } from "./view/sources";
import { createSourceMenu } from "./view/source-menu";
import { createSnapshot } from "./view/snapshot";
import { createLive } from "./view/live";
import { createNews } from "./view/news";
import { createPointer } from "./view/pointer";
import { createWindowEvents } from "./view/window-events";
import { createTickerInfo } from "./view/ticker-info";
import { createSymbolLoad } from "./view/symbol-load";
import { createStrategyMarks } from "./view/strategy-marks";
import { createLegend } from "./view/legend";


/** Per-instance id so a pane ignores its own sync-bus broadcasts. */
let paneSyncSeq = 0;

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
  const currentTokens = () => readChartTokens(untrack(appearance));
  // Unique id for the layout-sync bus (crosshair / time / date-range mirroring).
  const paneId = ++paneSyncSeq;
  // Shared context of this view's parts (view/*.ts): live accessors of the
  // state below; each part adds its functions when it is created.
  const cx = {
    props,
    paneId,
    get activeType() { return activeType; }, set activeType(v: ChartCore["activeType"]) { activeType = v; },
    get afterSeriesData() { return afterSeriesData; },
    get appearance() { return appearance; },
    get barWrap() { return barWrap; }, set barWrap(v: ChartCore["barWrap"]) { barWrap = v; },
    get chart() { return chart; }, set chart(v: ChartCore["chart"]) { chart = v; },
    get chartReady() { return chartReady; },
    get controller() { return controller; }, set controller(v: ChartCore["controller"]) { controller = v; },
    get coords() { return coords; },
    get countdown() { return countdown; },
    get crosshairActive() { return crosshairActive; }, set crosshairActive(v: ChartCore["crosshairActive"]) { crosshairActive = v; },
    get crosshairAt() { return crosshairAt; }, set crosshairAt(v: ChartCore["crosshairAt"]) { crosshairAt = v; },
    get crosshairPrice() { return crosshairPrice; }, set crosshairPrice(v: ChartCore["crosshairPrice"]) { crosshairPrice = v; },
    get ctxMenu() { return ctxMenu; },
    get currentTokens() { return currentTokens; },
    get dataExtras() { return dataExtras; },
    get fullSymbol() { return fullSymbol; },
    get gotoWrap() { return gotoWrap; }, set gotoWrap(v: ChartCore["gotoWrap"]) { gotoWrap = v; },
    get hidden() { return hidden; },
    get history() { return history; },
    get historyEnd() { return historyEnd; },
    get host() { return host; }, set host(v: ChartCore["host"]) { host = v; },
    get hostH() { return hostH; }, set hostH(v: ChartCore["hostH"]) { hostH = v; },
    get hostW() { return hostW; }, set hostW(v: ChartCore["hostW"]) { hostW = v; },
    get hoveredStudy() { return hoveredStudy; }, set hoveredStudy(v: ChartCore["hoveredStudy"]) { hoveredStudy = v; },
    get indLegend() { return indLegend; },
    get lastLegendTime() { return lastLegendTime; }, set lastLegendTime(v: ChartCore["lastLegendTime"]) { lastLegendTime = v; },
    get lockViews() { return lockViews; }, set lockViews(v: ChartCore["lockViews"]) { lockViews = v; },
    get mainLastIndex() { return mainLastIndex; },
    get mainPane() { return mainPane; },
    get mainPaneEpoch() { return mainPaneEpoch; },
    get mainScale() { return mainScale; },
    get mainSide() { return mainSide; },
    get leftAxisWidth() { return leftAxisWidth; },
    get syncScaleSides() { return syncScaleSides; },
    get newsLollipop() { return newsLollipop; },
    get onShownHooks() { return onShownHooks; },
    get paneRoot() { return paneRoot; }, set paneRoot(v: ChartCore["paneRoot"]) { paneRoot = v; },
    get pendingRangeSpan() { return pendingRangeSpan; }, set pendingRangeSpan(v: ChartCore["pendingRangeSpan"]) { pendingRangeSpan = v; },
    get pointerOverHost() { return pointerOverHost; }, set pointerOverHost(v: ChartCore["pointerOverHost"]) { pointerOverHost = v; },
    get prevDayClose() { return prevDayClose; }, set prevDayClose(v: ChartCore["prevDayClose"]) { prevDayClose = v; },
    get raw() { return raw; }, set raw(v: ChartCore["raw"]) { raw = v; },
    get rawDaily() { return rawDaily; }, set rawDaily(v: ChartCore["rawDaily"]) { rawDaily = v; },
    get reloadTick() { return reloadTick; },
    get removeStudy() { return removeStudy; },
    get selectStudy() { return selectStudy; },
    get selectedStudy() { return selectedStudy; },
    get series() { return series; }, set series(v: ChartCore["series"]) { series = v; },
    get seriesOnlyScale() { return seriesOnlyScale; },
    get setCompareSettingsFor() { return setCompareSettingsFor; },
    get setCtxMenu() { return setCtxMenu; },
    get setReloadTick() { return setReloadTick; },
    get setSelectedStudy() { return setSelectedStudy; },
    get setSettingsForId() { return setSettingsForId; },
    get setSettingsTab() { return setSettingsTab; },
    get studySelectionBg() { return studySelectionBg; },
    get swapping() { return swapping; }, set swapping(v: ChartCore["swapping"]) { swapping = v; },
    get syncLockPanes() { return syncLockPanes; },
    get toggleSourceHidden() { return toggleSourceHidden; },
    get updateSessionBreaks() { return updateSessionBreaks; },
    get whenShown() { return whenShown; },
    get flagPopup() { return flagPopup; },
    get intervalText() { return intervalText; },
    get legend() { return legend; },
    get legendPriceFormat() { return legendPriceFormat; },
    get rangePersistTimer() { return rangePersistTimer; }, set rangePersistTimer(v: ChartCore["rangePersistTimer"]) { rangePersistTimer = v; },
    get setFlagPopup() { return setFlagPopup; },
    get setIndLegendStore() { return setIndLegendStore; },
    get setLegend() { return setLegend; },
    get setSyncMenu() { return setSyncMenu; },
    get syncMenu() { return syncMenu; },
    get ticker() { return ticker; },
  } as ChartCx;
  // The window-wide chart events (sync, link, go-to, keyboard actions) belong
  // to the shown tab: a hidden tab's pane ignores them. One wrapper per
  // handler, so add/removeEventListener get the same function.
  // Hidden tab (design 1): live data keeps
  // merging into `raw`, but nothing is drawn and the cosmetic timers skip;
  // the tab catches up once when shown (catchUpOnShow): hidden tab pages run
  // no animation frames.
  const hidden = () => props.shown === false;
  /** Work to redo when the tab is shown again (footprint cells, news). */
  const onShownHooks = new Set<() => void>();
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
  // True only while the OS pointer is physically over THIS pane's canvas. A
  // hover-driven crosshair move (the only kind that should broadcast to synced
  // siblings) always has the pointer here; a crosshair set programmatically by
  // an inbound sync fires the SAME crosshairMove event on a pane the pointer is
  // NOT over. Gating the broadcast on this flag stops the follower from echoing
  // the crosshair back — otherwise setCrosshairPosition's move event, which
  // fires a frame after the rAF that clears suppressCrosshairBroadcast, makes
  // the panes bounce the crosshair back and forth (it drifts to a neighbour bar
  // or vanishes even with the mouse held still).
  let pointerOverHost = false;
  // Debounce handle for persisting the visible range to the pane store (set on
  // scroll/zoom, fired once the view settles — see onRangeChange).
  let rangePersistTimer: ReturnType<typeof setTimeout> | undefined;
  let host!: HTMLDivElement;
  // Host size, refreshed by the ResizeObserver (read by refreshBars).
  let hostW = 0;
  let hostH = 0;
  let paneRoot!: HTMLDivElement;
  let gotoWrap!: HTMLDivElement;
  let barWrap!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: AnySeries | null = null;
  // Session-breaks separators (Events tab). One instance per chart, re-attached
  // to the price series whenever it's rebuilt (chart-type change).
  const sessionBreaks = new SessionBreaksPrimitive();
  const sessionBackgrounds = new SessionBackgroundsPrimitive();
  // Dividend / split markers (Events tab). Re-attached to the series on rebuild;
  // fed by the per-symbol events resource + the Events toggles.
  const eventMarkers = new EventMarkersPrimitive();
  // "Countdown to bar close" axis label (Scales tab). Re-attached on rebuild;
  // its text ticks on a 1s timer (see updateCountdown).
  const countdown = new CountdownPrimitive();
  /** "Lock vertical cursor line by time" views (crosshair-lock.ts): the
   *  time label on the main series, the line + padlock in every pane. */
  let lockViews: CrosshairLockViews | null = null;
  let lockAxis: CrosshairLockAxisPrimitive | null = null;
  const lockPanes = new Map<unknown, CrosshairLockPanePrimitive>();
  /** Attach the lock line to every pane (panes come and go). */
  function syncLockPanes() {
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
  let raw: OHLC[] = [];
  // Lets markers fall back to gap-aware positioning when a date isn't on a bar.
  eventMarkers.setBarsAccessor(() => raw);
  eventMarkers.setFutureAccessor(() => futureAxis());
  // Events -> Latest news: one lollipop on the last bar.
  const newsLollipop = new NewsLollipopPrimitive();
  newsLollipop.setLastTimeAccessor(() => (raw.length ? (raw[raw.length - 1].time as number) : null));
  // Per-bar close of the previous trading day (tz-aware), for the legend's
  // "Last day change" value. Recomputed with the session breaks on data change.
  let prevDayClose: (number | null)[] = [];
  /** Underlying daily bars for the daily family (1D/1W/1M). 1W/1M re-aggregate
   *  the *full* set on scroll-back so a boundary week/month never mis-buckets;
   *  empty for second/minute frames. */
  let rawDaily: Candle[] = [];
  /** End-of-history icon left of the first bar, once history is exhausted. */
  const historyEnd = new HistoryEndPrimitive();
  let activeType: ChartTypeId = props.chartType ?? "candle";
  // Type the current `series` was built with (rebuildSeries compares it with
  // the new type to choose how the view carries over).
  let builtType: ChartTypeId | null = null;
  // Future bars on the symbol's trading calendar for the drawings and markers after the last bar (the time scale
  // continues with the bars the symbol would open); null on the brick / line types (synthetic times) and until the
  // sessions are known. Rebuilt only when the symbol, interval, session or sessions change.
  let futureKey = "";
  let futureSpec: unknown = null;
  let futureValue: FutureAxis | null = null;
  function futureAxis(): FutureAxis | null {
    if (isTransformType(activeType)) return null;
    const sessions = cachedSymbolSessions(props.symbol ?? "");
    if (!sessions) return null;
    const interval = props.interval ?? "1D";
    const session = props.session ?? "RTH";
    const spec = sessions.spec(session);
    const key = `${props.symbol}|${interval}|${session}`;
    if (key !== futureKey || futureSpec !== spec) {
      futureKey = key;
      futureSpec = spec;
      futureValue = sessionFutureAxis(interval, spec, sessions.regular);
    }
    return futureValue;
  }
  /** Coords bridge for the SVG overlay; refreshed on every rebuild. */
  const [coords, setCoords] = createSignal<Coords | null>(null);
  /** Bumped on visible-range changes so the overlay re-projects drawings. */
  const [coordEpoch, setCoordEpoch] = createSignal(0);
  // Drawings re-project on time-scale changes (onRangeChange) and resizes;
  // price-scale-only changes (autoscale on new prices, price-axis drag, log /
  // percent mode) come from this series primitive (scale-watch.ts).
  // The focused pane exposes its live price/bar ratio to the Settings dialog.
  const probeOwner = {};
  // Legend eye: hide / show the main series (series `visible` property).
  createEffect(() => {
    const visible = !props.seriesHidden;
    series?.applyOptions({ visible });
  });
  createEffect(() => {
    if (props.active) setActiveChartProbe(probeOwner, { scaleRatio: () => liveScaleRatio(), alertTarget });
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
  const scaleWatch = new PriceScaleWatch(() => {
    setCoordEpoch((n) => n + 1);
    // Pixel-anchored styles follow the price scale (base level, gradient
    // label colour, the last label's percentage row).
    syncBaseline();
    syncGradientLabel();
    updateCountdown();
    lockedSpacingFromScale();
    refreshScaleOverlays();
    refreshPaneBoxes();
  });
  /** Top-left data-window legend (O/H/L/C + change). Null while loading. */
  const [legend, setLegend] = createSignal<LegendValues | null>(null);
  /** TRUE while the crosshair is over a bar, so the live-tick path knows not to
   *  yank the legend back to the latest bar out from under the user's cursor. */
  let crosshairActive = false;
  /** Last crosshair time, so indicator-set/bars changes re-resolve at the same
   *  bar the user is hovering. */
  let lastLegendTime: number | undefined;
  /** Where the crosshair stands in the price pane (the pointer's, or the one
   *  mirrored by sync), null when not shown there. */
  let crosshairAt: { time: number; y: number } | null = null;
  /** Owns the active indicators on this chart; created in onMount. */
  let controller: IndicatorController | null = null;
  /** Bumped once the chart + controller exist so the indicator effects run. */
  const [chartReady, setChartReady] = createSignal(0);
  /** Studies legend rows (one per active indicator). A store reconciled by
   *  row id: a live tick updates the values in place, so the rows (and their
   *  hover buttons) are not recreated on every refresh. */
  const [indLegendStore, setIndLegendStore] = createStore<{ rows: IndicatorLegendRow[] }>({ rows: [] });
  const indLegend = () => indLegendStore.rows;
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
  /** Legend flag colour popup (its flag button), null = closed. */
  const [flagPopup, setFlagPopup] = createSignal<HTMLElement | null>(null);
  /** Legend "Chart syncing" menu (its button rect), null = closed. */
  const [syncMenu, setSyncMenu] = createSignal<DOMRect | null>(null);
  /** Chart background at a height, for the selection markers. */
  const studySelectionBg = createMemo(() => {
    const t = readChartTokens(appearance());
    return chartBackgroundAt(t.bg, t.bgBottom, t.bgGradient);
  });
  function selectStudy(id: string) {
    setSelectedStudy(id);
    if (props.selectedDrawingId || (props.selectedDrawingIds?.length ?? 0) > 0) props.setSelectedDrawingId?.(null);
  }
  /** Eye of a source (legend, More menu, Object tree): the main series, a
   *  compared symbol or a study. The state is saved with the chart. */
  function toggleSourceHidden(id: string) {
    if (id === MAIN_SOURCE_ID) { props.onToggleSeries?.(); return; }
    const cmp = compareEntry(id);
    if (cmp) { props.onCompareChange?.(id, { hidden: !cmp.hidden }); return; }
    if (!controller) return;
    const nowHidden = controller.toggleHidden(id);
    props.onIndicatorSettings?.(id, { hidden: nowHidden || undefined });
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
    if (isStrategyId(id)) applyStrategyMarkers();
  }
  /** Remove a study or a compared symbol (same path as the legend trash). */
  function removeStudy(id: string) {
    if (compareEntry(id)) props.onRemoveCompare?.(id);
    else props.onRemoveIndicator?.(id);
  }

  const { LegendStacks, refreshIndicatorLegend, refreshLegend } = attach(cx, createLegend(cx));
  /** Compared-symbol Settings dialog (entry id; null = closed). */
  const [compareSettingsFor, setCompareSettingsFor] = createSignal<string | null>(null);

  // Expose this chart's latest price + indicator values to the alert engine,
  // keyed by the full name ("NASDAQ:AAPL"). Re-keys on symbol change; provider reads the mutable
  // `raw`/`controller` lazily so values are always current. (chart-state-registry.ts)
  createEffect(() => {
    const key = (props.symbol ?? "").toUpperCase();
    if (!key) return;
    registerChartState(key, {
      lastPrice: () => (raw.length ? raw[raw.length - 1].close : null),
      lastBarTime: () => {
        const t = raw.length ? raw[raw.length - 1].time : null;
        return typeof t === "number" ? t * 1000 : null;
      },
      indicatorLegend: () => controller?.getLegend() ?? [],
      resolution: () => props.interval ?? "",
      session: () => props.session ?? "RTH",
      bars: () => raw as ChartBar[],
      compares: () => cx.compareSources?.() ?? [],
    });
    onCleanup(() => unregisterChartState(key));
  });

  // When this pane becomes the focused one, claim the right-rail data window
  // (its latest bar, unless the crosshair is currently hovering it).
  createEffect(() => {
    if (props.active) refreshLegend(crosshairActive ? lastLegendTime : undefined);
  });

  // Right-click context menu: open position + resolved node list (null = closed).
  // `corner`: the price-scale menu of the axis corner button (opened above it).
  const [ctxMenu, setCtxMenu] = createSignal<ChartMenuState | null>(null);

  const {
    barFits,
    barLeft,
    barShown,
    gotoBox,
    gotoShown,
    installControlBars,
    moveBars,
    resetAvailable,
    resetChartView,
    scrollToRealtime,
    stopScroll,
    zoomSpan,
  } = attach(cx, createNavigation(cx));

  const { alertTarget, openContextMenu } = attach(cx, createMenus(cx));
  /** Study whose plot is under the pointer (crosshair move), null = none. */
  let hoveredStudy: string | null = null;
  /** Price under the crosshair (on the scale of the pane under it), null = pointer not on the chart. */
  let crosshairPrice: number | null = null;



  const {
    PriceAxisOverlays,
    refreshScaleOverlays,
    scaleGeom,
    setAxisHover,
    setChartHovered,
    setPlusY,
  } = attach(cx, createPriceAxis(cx));

  const { PaneControls, drawingPanes, paneAtY, refreshPaneBoxes, setHoverPane, setPaneEpoch } = attach(cx, createPanes(cx));

  /** The newest bar is still forming (its countdown runs): price-based
   *  types draw what it built as projection bars. */
  function lastBarForming(): boolean {
    const last = raw.length > 0 ? raw[raw.length - 1] : null;
    if (!last || typeof last.time !== "number") return false;
    const sessions = cachedSymbolSessions(props.symbol ?? "");
    return countdownText(props.interval ?? "1D", Date.now() / 1000, last.time as number, props.session ?? "RTH", sessions) != null;
  }
  const dataExtras = () => ({
    subMinute: cx.subMinute ?? undefined,
    lastForming: lastBarForming(),
    sessions: cachedSymbolSessions(props.symbol ?? ""),
  });

  /** Style work that depends on the series data: the Baseline base level
   *  and the gradient line's label colour. */
  function afterSeriesData() {
    syncBaseline();
    syncGradientLabel();
    updateHistoryEnd();
  }



  /** Price text of the main series (Precision choice), shared with the legend. */
  const [legendPriceFormat, setLegendPriceFormat] = createSignal<((p: number) => string) | undefined>(undefined);

  /** Time-scale index of the main series' last item. Price-based types have
   *  their own items, and study series add their times to the axis, so it is
   *  not the source bar count there. */
  function mainLastIndex(): number | null {
    if (!chart || !series) return null;
    if (!isTransformType(activeType)) return raw.length > 0 ? raw.length - 1 : null;
    const items = series.data();
    if (items.length === 0) return null;
    return chart.timeScale().timeToIndex(items[items.length - 1].time, true) as number | null;
  }

  // ── The price pane ────────────────────────────────────────────────────
  // The price pane can sit at any position (pane controls, chart drag) and
  // the series can share a study pane (chart drag onto it); the controller
  // keeps the pane layout, the series and the decorations follow it.
  /** The saved place of the series last applied to (or saved from) the
   *  controller. */
  let appliedSeriesPane: string | null = null;
  /** Pane of the main series. */
  function mainPane(): number {
    return controller?.mainPaneIndex() ?? 0;
  }
  /** Bumped when the price pane moves or the series changes pane / scale. */
  const [mainPaneEpoch, setMainPaneEpoch] = createSignal(0);
  /** Side of the series' scale: the chosen side ("Scales placement"); in a
   *  study pane it shares, the pane's scale when it shows prices (a price
   *  study or a compared symbol leads it), else the study keeps its scale and
   *  the series takes the free side (reference "Auto" rule; with "Stack on
   *  the left / right" the reference stacks a second scale on that side,
   *  which the chart library cannot draw: the free side too). */
  function mainSide(): "left" | "right" {
    const placement = currentTokens().scalesPlacement;
    if (!controller?.seriesShares() || controller.seriesSharesPriceScale()) return placement;
    return placement === "right" ? "left" : "right";
  }
  /** Price scale of the main series. */
  function mainScale() {
    if (!chart) return null;
    if (series) return series.priceScale();
    return chart.priceScale(mainSide(), mainPane());
  }
  /** Width of the left price axis (0 when hidden). */
  function leftAxisWidth(): number {
    if (!chart) return 0;
    try { return chart.priceScale("left").width(); } catch { return 0; }
  }
  /** Price axes shown: the chosen side, and the other one while the series
   *  (in a study pane it shares), a compared symbol on a new price scale or a
   *  study pinned to it ("Pin to scale") uses it. */
  function syncScaleSides() {
    if (!chart) return;
    const placement = currentTokens().scalesPlacement;
    const other = placement === "right" ? "left" : "right";
    const used = mainSide() === other || cx.compareUsesOtherSide() || !!controller?.usesSide(other);
    chart.applyOptions(other === "left" ? { leftPriceScale: { visible: used } } : { rightPriceScale: { visible: used } });
  }
  /** The price pane moved or changed (controller hook): the series goes to
   *  its pane and side (its scale keeps its modes), the price pane's other
   *  sources and the decorations follow. */
  function onMainPaneMoved() {
    if (!chart || !series || !controller) return;
    const m = mainPane();
    let pane = -1;
    try { pane = series.getPane().paneIndex(); } catch { /* not laid out */ }
    const side = mainSide();
    const sideNow = (series.options() as { priceScaleId?: string }).priceScaleId;
    if (pane !== m || sideNow !== side) {
      let o: ReturnType<ReturnType<AnySeries["priceScale"]>["options"]> | null = null;
      try { o = series.priceScale().options(); } catch { /* not on a scale */ }
      // Built again in its pane on its side (moving a series with its
      // primitives between panes in place lets them read it while it has no
      // pane), its view and decorations kept.
      rebuildSeries();
      // A scale of its own keeps the modes of its former scale (percent,
      // log, inverted); a shared price scale keeps its own (reference).
      if (o && series && !controller.seriesSharesPriceScale()) series.priceScale().applyOptions({ mode: o.mode, invertScale: o.invertScale, autoScale: o.autoScale });
    }
    // Compared symbols over the series follow it (not syncCompare: it
    // re-applies the saved pane order, which the caller saves after this).
    cx.followMainPane();
    // Studies over the series take its new scale (and pane mode).
    controller.redrawAll();
    // Saved after the move (the save re-runs the chart's effects).
    queueMicrotask(() => {
      const group = controller?.seriesPaneGroup() ?? null;
      if (group !== (props.seriesPane ?? null)) {
        appliedSeriesPane = group;
        props.onSeriesPane?.(group);
      }
    });
    setMainPaneEpoch((n) => n + 1);
    setPaneEpoch((n) => n + 1);
    // The panes are laid out again on the next frame: their boxes then.
    const relayout = () => {
      refreshPaneBoxes();
      refreshScaleOverlays();
    };
    queueMicrotask(relayout);
    requestAnimationFrame(() => requestAnimationFrame(relayout));
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
  }

  function rebuildSeries() {
    if (!chart) return;
    // Preserve the user's scroll position across the series swap. Creating a
    // fresh series and calling setData snaps the time scale back to the latest
    // bars (default rightOffset framing) — so a chart-type or Settings change
    // while scrolled to a historical date would jump the view to today. Capture
    // the visible logical range first and restore it after re-seeding. Null on
    // the empty initial mount (no data yet), where the data-apply effect frames
    // the view instead.
    const savedRange = chart.timeScale().getVisibleLogicalRange();
    // Detach first: removing a series fires range / scale callbacks (locked
    // ratio, baseline, countdown), which must not reach the removed series;
    // the library throws on a detached series' price scale.
    const old = series;
    series = null;
    // The library deletes a pane left empty while other panes exist: with a
    // study pane open, removing the main series would delete its pane, and the
    // new series would land in the study pane (wrong height, study moved to
    // a new pane). Keep the main pane alive across the swap.
    const oldPane = old ? old.getPane() : null;
    const preserved = oldPane?.preserveEmptyPane() ?? false;
    oldPane?.setPreserveEmptyPane(true);
    if (old) chart.removeSeries(old);
    forgetBaseline();
    const tokens = currentTokens();
    series = createSeriesForType(chart, activeType, tokens, mainPane());
    oldPane?.setPreserveEmptyPane(preserved);
    const prevType = builtType;
    builtType = activeType;
    setDataForType(series, activeType, raw, tokens, dataExtras());
    afterSeriesData();
    // Symbol → Precision: the picked decimals ("Default" follows the
    // symbol's tick grid), thousands grouped; the legend uses the same text.
    // The fractional choices (1/2 …) use the fractional format (123'16).
    const fmt = chartPriceFormat(tokens.precision, cachedSymbolSessions(props.symbol ?? ""));
    if (fmt) series.applyOptions({ priceFormat: { type: "custom", formatter: fmt.format, minMove: fmt.minMove } });
    setLegendPriceFormat(() => fmt?.format);
    // Bind the price axis to the series' side (Scales placement; the free
    // side in a study pane it shares).
    series.applyOptions({ priceScaleId: mainSide() });
    syncScaleSides();
    // Legend eye (series `visible`): a rebuilt series keeps the hidden state
    // (the live toggle is the seriesHidden effect below).
    series.applyOptions({ visible: !untrack(() => props.seriesHidden) });
    // A rebuilt series is created in front: back to its place in the order.
    scheduleSourceOrder();
    // Scales → Price labels → Symbol: last-value axis label + price line
    // (picker enum 0/1/2 → library Solid/Dashed/Dotted). "Name" puts the
    // ticker inside the price-scale label (the library's series title).
    // The price line is dotted by default; its colour "" follows
    // the last bar (library default), a picked colour overrides it.
    series.applyOptions({
      lastValueVisible: tokens.symbolLastValue,
      priceLineVisible: tokens.symbolPriceLine,
      priceLineColor: tokens.symbolPriceLineColor,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: Math.max(1, Math.min(4, tokens.symbolPriceLineWidth)) as 1 | 2 | 3 | 4,
      title: tokens.symbolNameLabel ? splitSymbol(props.symbol ?? "").ticker : "",
    });
    // Re-attach the session-breaks separators to the fresh series and refresh
    // their boundaries against the current bars.
    series.attachPrimitive(sessionBreaks);
    series.attachPrimitive(sessionBackgrounds);
    if (lockAxis) series.attachPrimitive(lockAxis);
    // Strategy trade marks belong to the series: re-attach to the new one.
    forgetTradeMarkers();
    applyStrategyMarkers();
    // Study markers and bar colours are drawn on the main series: redraw the
    // studies on the new one (from their last results).
    controller?.redrawAll();
    forgetPriceLines();
    updateSessionBreaks();
    setAlertSeriesEpoch((n) => n + 1);
    updatePrePostLine();
    // Re-attach the dividend/split markers (their data is retained in the
    // instance and refreshed by the events effect below).
    series.attachPrimitive(eventMarkers);
    series.attachPrimitive(newsLollipop);
    series.attachPrimitive(historyEnd);
    // Countdown axis label (state retained; the 1s timer keeps it ticking).
    series.attachPrimitive(countdown);
    series.attachPrimitive(scaleWatch);
    // Re-sync now, not on the next 1s tick — the fresh series was just
    // created with the plain lastValueVisible, which the countdown plate
    // replaces while it's showing.
    updateCountdown();
    const mainCoords = makeCoords(
      chart,
      series,
      () => raw,
      (sec) => (controller ? controller.overlayValuesAt(sec ?? undefined) : []),
      () => ({ timeZone: props.timeZone ?? "UTC", intraday: isIntradayInterval(props.interval ?? "1D") }),
      futureAxis,
    );
    // Volume profile drawings: built from lower-timeframe bars of the chart symbol (as the profile studies).
    mainCoords.lowerTimeframe = {
      bars: (resolution, from) => controller?.drawingLowerBars(resolution, from) as unknown as OHLC[] | undefined,
      barEnd: (time) => {
        const iv = props.interval ?? "1D";
        const sessions = cachedSymbolSessions(props.symbol ?? "");
        if (isIntradayInterval(iv) || !sessions) return time + Math.max(1, chartSeconds(iv));
        if (chartSeconds(iv) > 86400) {
          const i = raw.findIndex((b) => (b.time as number) === time);
          if (i >= 0 && i + 1 < raw.length) return raw[i + 1].time as number;
        }
        const day = sessions.regular.tradingDay(time);
        return sessions.regular.dayBounds(day)?.end ?? time + 86400;
      },
      seconds: /S$/i.test(props.interval ?? ""),
    };
    setCoords(mainCoords);
    if (!crosshairActive) refreshLegend();
    // Renko / line break / kagi / P&F / range emit a DIFFERENT number of
    // items than the source bars (synthetic times ending at the last bar), so
    // a logical range taken on either side of such a switch no longer maps:
    // leaving one, the saved range still counts its synthetic times and
    // points past the last bar. Show the newest items instead of restoring
    // it. The other types keep one bar per source bar, so their view is
    // preserved.
    if (isTransformType(activeType) || (prevType !== null && isTransformType(prevType))) {
      // Frame the newest items at the current bar spacing, right margin kept
      // (set directly: scrollToRealTime animates and loses to later updates).
      const ts = chart.timeScale();
      const items = series.data();
      const lastT = items.length ? items[items.length - 1].time : null;
      const idx = lastT != null ? ts.timeToIndex(lastT, true) : null;
      const c0 = ts.logicalToCoordinate(0 as Logical);
      const c1 = ts.logicalToCoordinate(1 as Logical);
      const spacing = c0 != null && c1 != null ? Math.abs((c1 as number) - (c0 as number)) : 6;
      if (idx != null && spacing > 0) {
        const ro = currentTokens().rightOffset;
        ts.setVisibleLogicalRange({ from: (idx as number) + ro - barsSpan(ts.width(), spacing), to: (idx as number) + ro });
      }
    } else if (savedRange) {
      chart.timeScale().setVisibleLogicalRange({ from: savedRange.from, to: savedRange.to });
    }
  }

  /** Recompute session-break boundaries from the current bars and push the
   *  committed appearance (on/off + colour) onto the primitive. Cheap and
   *  idempotent — safe to call after every data load / appearance change. */
  function updateSessionBreaks() {
    const t = currentTokens();
    const intraday = isIntradayInterval(props.interval ?? "1D");
    const sessions = cachedSymbolSessions(props.symbol ?? "");
    const times = t.sessionBreaksVisible && sessions
      ? computeSessionBoundaries(raw as readonly { time: number }[], intraday, sessions.spec(props.session ?? "RTH"))
      : [];
    sessionBreaks.setData(times, t.sessionBreaksColor, t.sessionBreaksVisible, t.sessionBreaksStyle, t.sessionBreaksWidth);
    // Pre/post-market tint: only when the chart draws extended-hours bars.
    sessionBackgrounds.setColors(t.preMarketBgColor, t.postMarketBgColor);
    sessionBackgrounds.setRuns(
      intraday && sessions && (props.session ?? "RTH") === "ETH"
        ? computeSessionRuns(raw as readonly { time: number }[], sessions)
        : [],
    );
    recomputePrevDayClose();
    updatePrevClosePriceLine();
    updateHighLowLines();
  }

  const {
    applyLockedRatio,
    forgetBaseline,
    forgetPriceLines,
    liveScaleRatio,
    lockedSpacingFromScale,
    setStatusClock,
    syncBaseline,
    syncGradientLabel,
    updateCountdown,
    updateHighLowLines,
    updatePrePostLine,
    updatePrevClosePriceLine,
  } = attach(cx, createDecorations(cx));

  const { installAlertPointer, setAlertSeriesEpoch } = attach(cx, createAlertLayer(cx));


  /** Rebuild {@link prevDayClose}: for each bar, the close of the last bar of the
   *  PREVIOUS trading day (in the chart timezone). O(n) per data change, so the
   *  legend's "Last day change" is an O(1) lookup per crosshair move. On daily+
   *  frames the day always changes, so it equals the prior bar's close. */
  function recomputePrevDayClose() {
    const n = raw.length;
    prevDayClose = new Array(n).fill(null);
    if (n === 0) return;
    const dayOf = dayKeyer(props.timeZone ?? "UTC");
    let curDay = dayOf(raw[0].time as number);
    let lastClosePrevDay: number | null = null;
    for (let i = 0; i < n; i++) {
      const day = dayOf(raw[i].time as number);
      if (day !== curDay) { lastClosePrevDay = raw[i - 1].close; curDay = day; }
      prevDayClose[i] = lastClosePrevDay;
    }
  }

  const {
    broadcastRange,
    maybeLoadOlder,
    updateHistoryEnd,
  } = attach(cx, createHistory(cx));


  const { installPointer, installTimeSync } = attach(cx, createPointer(cx));
  const { installChartEvents, installDataEvents } = attach(cx, createWindowEvents(cx));
  onMount(() => {
    const tokens = currentTokens();
    const base = appearanceOptions(tokens);
    chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      ...base,
      layout: { ...base.layout, fontFamily: readFontFamily() },
      crosshair: { ...base.crosshair, mode: CrosshairMode.Normal },
      timeScale: { ...base.timeScale, timeVisible: false },
      // Disable the library's cursor-anchored mouse-wheel zoom; we replace it
      // below with a right-edge-anchored zoom (see onWheel).
      handleScale: { mouseWheel: false },
    });
    lockViews = new CrosshairLockViews(chart, () => {
      const t = readChartTokens(untrack(appearance));
      return {
        color: t.crosshairColor,
        width: Math.max(1, Math.min(4, t.crosshairWidth)),
        dash: t.crosshairStyle === 0 ? [] : t.crosshairStyle === 2 ? [1, 1] : [4, 4],
        labelBg: t.crosshairLabelBg,
        dark: textOnColor(t.bg).toUpperCase() === "#FFFFFF",
      };
    });
    lockAxis = new CrosshairLockAxisPrimitive(lockViews);
    // Start empty; real candles arrive from the history resource below.
    raw = [];
    rebuildSeries();

    // The controller reads bars from `raw` on demand, so it always recomputes
    // against the freshest dataset without threading bars in.
    controller = new IndicatorController(chart, () => raw as unknown as Bar[], String(paneId));
    controller.setLastBarOpenProbe(lastBarForming);
    controller.setMainSeriesProbe(() => series as ISeriesApi<SeriesType> | null);
    controller.setScaleIdsProbe(() => ({ price: mainSide(), pane: currentTokens().scalesPlacement }));
    controller.setMainPaneHook(onMainPaneMoved);
    controller.setSeriesChangedHook(() => {
      scheduleSourceOrder();
      cx.syncSideScales();
      setAlertSeriesEpoch((n) => n + 1);
    });
    controller.setDrawingsDataHook(() => setCoordEpoch((n) => n + 1));
    controller.setRedrawnHook(() => refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined));
    setChartReady((n) => n + 1);

    hostW = host.clientWidth;
    hostH = host.clientHeight;
    const ro = new ResizeObserver(() => {
      if (!chart) return;
      hostW = host.clientWidth;
      hostH = host.clientHeight;
      console.log(`[resize] hostW=${host.clientWidth} hostH=${host.clientHeight} raw=${raw.length}`);
      chart.applyOptions({
        width: host.clientWidth,
        height: host.clientHeight,
      });
      setCoordEpoch((n) => n + 1);
      // Pane heights and the scale width both move with the pane — re-anchor
      // and re-fit the control bars on resize.
      cx.refreshBarsRef?.();
    });
    ro.observe(host);

    installControlBars();

    const onRangeChange = () => {
      setCoordEpoch((n) => n + 1);
      // Same % scale values are measured from the first visible bar.
      if (!crosshairActive && compareEntries().some((e) => e.placement === "percent")) refreshIndicatorLegend();
      cx.refreshBarsRef?.();
      // High/Low follow the visible bars, on followers too.
      updateHighLowLines();
      // A view set by an inbound sync is not this pane's own: it must not page
      // (the sync loader fetched its history in one request), be persisted
      // (a follower would save a clamped view), or be broadcast.
      if (cx.syncGuard) return;
      maybeLoadOlder();
      // Persist the user's anchor (debounced) so it survives tab switches +
      // reloads. Skipped while a symbol swap is mid-flight (the apply effect is
      // about to set the range itself — capturing the outgoing/transient range
      // here would clobber the new pane's saved view).
      if (!swapping && chart) {
        const lr = chart.timeScale().getVisibleLogicalRange();
        if (lr) {
          // Tag the scheduled write with the pane this range belongs to. The
          // grid reuses one ChartView instance across tab switches (only its
          // props change), so a timer queued for the old tab could otherwise
          // fire after the switch and clobber the new tab's anchor.
          const forSym = props.symbol;
          const forInt = props.interval;
          if (rangePersistTimer !== undefined) clearTimeout(rangePersistTimer);
          rangePersistTimer = setTimeout(() => {
            rangePersistTimer = undefined;
            if (props.symbol !== forSym || props.interval !== forInt) return;
            // Price-based types: the item count changes with the data, so
            // the view is saved relative to the last item.
            const last = isTransformType(activeType) ? mainLastIndex() : null;
            props.onVisibleRange?.(last != null ? { from: lr.from, to: lr.to, last } : { from: lr.from, to: lr.to });
          }, 250);
        }
      }
      broadcastRange(false);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    // Pixel-anchored styles also follow the time scale: the locked ratio,
    // the baseline level and the last label's percentage row.
    const onStyleRange = () => {
      applyLockedRatio();
      syncBaseline();
      if (currentTokens().symbolValuePercent) updateCountdown();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onStyleRange);

    installPointer();

    installAlertPointer();
    installTimeSync();

    installChartEvents();

    onCleanup(() => {
      if (rangePersistTimer !== undefined) clearTimeout(rangePersistTimer);
      ro.disconnect();
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onStyleRange);
      controller?.destroy();
      controller = null;
      chart?.remove();
      chart = null;
      series = null;
    });
  });

  // Chart-type reactivity.
  let firstType = true;
  createEffect(() => {
    const t = props.chartType ?? "candle";
    if (firstType) {
      firstType = false;
      activeType = t;
      return;
    }
    if (t === activeType) return;
    activeType = t;
    rebuildSeries();
  });

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
  // Forced-refetch counter: bumped by "chart-reload-data" (e.g. the bottom
  // bar's ADJ toggle flips the kv adjustment flag, then asks every pane to
  // refetch on the new basis). Folded into the resource key so the same
  // symbol/interval re-fetches.
  const [reloadTick, setReloadTick] = createSignal(0);
  installDataEvents();
  const { applyStrategyMarkers, forgetTradeMarkers, strategyDialogConfig } = attach(cx, createStrategyMarks(cx));
  const [history] = createResource<BarsResult | null, string>(
    () =>
      `${props.symbol ?? "INTC"} ${props.interval ?? "1D"} ${props.session ?? "RTH"} ${reloadTick()}`,
    async (key) => {
      // sym/interval/session — none contain spaces, so a plain split is safe
      // (the trailing reload counter is key-only).
      const [sym, interval, session] = key.split(" ") as [string, string, SessionId];
      try {
        const t0 = performance.now();
        {
          const w = window as unknown as { __clickT?: number };
          if (w.__clickT) console.log(`[fetch-start] ${sym} ${interval}: select→fetch-start ${(t0 - w.__clickT).toFixed(0)}ms`);
        }
        const r = await getBars(sym, interval, session);
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

  // Dividend / split markers, fetched once per symbol (independent of interval).
  const [eventsRes] = createResource(
    () => props.symbol ?? "",
    (sym) => (sym ? getEvents(sym) : Promise.resolve([])),
  );
  // Push markers + visibility onto the primitive when the events load or the
  // Events toggles change. (The primitive retains this across series rebuilds.)
  createEffect(() => {
    const a = appearance();
    // Dividends + Splits default ON — shown until explicitly unchecked.
    eventMarkers.setData(eventsRes() ?? [], a.eventsDividends ?? true, a.eventsSplits ?? true);
  });

  // Time-axis precision: seconds show "14:30:05", intraday "Apr 22 14:30",
  // daily/weekly/monthly just "Apr 22".
  createEffect(() => {
    if (!chart) return;
    const id = props.interval ?? "1D";
    const second = isSecondResolution(id);
    const intraday = isIntradayResolution(id);
    const tz = props.timeZone ?? "UTC";
    // Scales → Date / Time format (per pane). Reading appearance() here re-runs
    // the effect — and re-applies the formatters — when the settings change.
    const a = appearance();
    const axisFmt: AxisFmt = { dateFormat: a.dateFormat, timeFormat: a.timeFormat, dayOfWeek: a.dayOfWeek };
    chart.applyOptions({
      timeScale: {
        timeVisible: second || intraday,
        secondsVisible: second,
        tickMarkFormatter: (t: Time, tt: TickMarkType) => formatTick(t as UTCTimestamp, tt, tz, axisFmt),
      },
      localization: {
        timeFormatter: (t: Time) =>
          formatAxisTime(t as UTCTimestamp, tz, isIntradayInterval(id), /[ST]$/.test(id.toUpperCase()), axisFmt),
      },
    });
    // Day rollover (and thus session-break placement) depends on the timezone,
    // so recompute when interval / timezone changes even without a data reload.
    updateSessionBreaks();
  });

  const { dimmed } = attach(cx, createSymbolLoad(cx));
  // TRUE from a symbol/interval change until the new data is painted. While set,
  // the previous symbol's candles stay on screen under the dim overlay and the
  // live poller is gated (so its ticks can't append onto the outgoing series).
  let swapping = false;
  // Bottom-bar date-range preset ("1D"…"All") waiting for the tab's interval
  // reload to land; the apply effect frames this span instead of keeping the
  // pre-switch scale. Takes precedence over pendingScaleKeep.
  let pendingRangeSpan: string | null = null;

  // Sync the active-indicator set onto the chart whenever it changes (or once
  // the controller exists). The controller adds/removes study layers and stacks
  // oscillator panes; overlay studies render against whatever bars `raw` holds.
  createEffect(() => {
    chartReady();
    // "Hide indicators" suppresses the layers (sync an empty set) while keeping
    // props.indicators intact, so toggling it back restores them verbatim.
    const ids = props.indicatorsHidden ? [] : (props.indicators ?? []);
    // Seed persisted inputs/styles before sync so a freshly-added layer renders
    // with the user's saved values (sync → add reads the seeded maps).
    if (props.indicatorSettings) controller?.seedSettings(props.indicatorSettings);
    // The saved place of the series first: the studies of the pane it
    // shares open in its pane.
    // Only a new saved value (a chart load, a tab shown in this view): the
    // chart's own moves save theirs after the move.
    const seriesPane = props.seriesPane ?? null;
    if (seriesPane !== appliedSeriesPane) {
      appliedSeriesPane = seriesPane;
      untrack(() => controller?.setSeriesGroup(seriesPane));
    }
    controller?.sync(ids);
    // The study pane the series was dragged into is gone (its studies were
    // removed): the saved place goes too ("Hide indicators" keeps it).
    if (!props.indicatorsHidden && controller?.seriesGroupGone()) untrack(() => props.onSeriesPane?.(null));
    // Study panes added / removed: the drawing panes follow.
    setPaneEpoch((n) => n + 1);
    queueMicrotask(refreshPaneBoxes);
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
  });

  // Chart context (timeframe, session, tickerid, background) of the studies.
  createEffect(() => {
    chartReady();
    const t = readChartTokens(appearance());
    controller?.setScriptChart(scriptChartContext(props.symbol, props.interval, props.session, { top: t.bg, bottom: t.bgGradient ? t.bgBottom : t.bg }));
  });

  // Strategies on a Heikin Ashi chart run on its Heikin Ashi bars.
  createEffect(() => {
    chartReady();
    controller?.setHeikinAshi((props.chartType ?? "candle") === "ha");
  });

  // Indicator Visibility tab: studies off the chart interval stop drawing.
  createEffect(() => {
    chartReady();
    const iv = props.interval ?? "1D";
    controller?.setChartInterval(iv);
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
    applyStrategyMarkers();
  });

  // Scales → "Indicators and financials": last-value axis labels on the study
  // series. Re-runs on settings commit; the controller no-ops when unchanged.
  createEffect(() => {
    chartReady();
    const t = readChartTokens(appearance());
    controller?.setLastValueVisible(t.indLastValue);
    controller?.setNameLabelsVisible(t.indNameLabel);
  });

  const {
    compareEntries,
    compareEntry,
    compareLayers,
    compareTitle,
    renderCompareAll,
    setComparePreview,
    syncCompare,
  } = attach(cx, createCompare(cx));
  // Locked cursor line: the library's vertical line (and its time label)
  // give way to the lock views.
  createEffect(() => {
    chartReady();
    const locked = crosshairLockTime() !== null;
    untrack(() => {
      chart?.applyOptions({ crosshair: { vertLine: { visible: !locked, labelVisible: !locked } } });
      syncLockPanes();
    });
  });
  // "Scale price chart only": studies and compared symbols on the main
  // series' scale leave its auto-scale.
  const seriesOnlyScale = () => {
    const t = readChartTokens(appearance());
    void mainPaneEpoch();
    return t.scaleSeriesOnly ? mainSide() : null;
  };
  createEffect(() => {
    chartReady();
    const id = seriesOnlyScale();
    untrack(() => {
      controller?.setSeriesOnlyScale(id);
      for (const layer of compareLayers.values()) layer.setSeriesOnlyScale(id);
    });
  });
  // Studies pinned to a side scale ("Pin to scale") follow the main scale's side.
  createEffect(() => {
    chartReady();
    const side = readChartTokens(appearance()).scalesPlacement;
    untrack(() => {
      controller?.setMainSide(side);
      cx.syncSideScales();
    });
  });
  // Selection markers on the selected study's plots.
  createEffect(() => {
    chartReady();
    const id = selectedStudy();
    const bg = studySelectionBg();
    untrack(() => {
      controller?.setSelected(id, bg);
      for (const [cid, layer] of compareLayers) layer.setSelected(cid === id ? bg : null);
    });
  });
  const { scheduleSourceOrder, sunkIds } = attach(cx, createSources(cx));
  attach(cx, createSourceMenu(cx));
  attach(cx, createSnapshot(cx));


  const { paintLive } = attach(cx, createLive(cx));

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
    if (!chart) return;
    // Untracked: the rebuild reads other signals (pane props, the 15 s status
    // clock...). Tracked, every scroll-position save and clock tick re-ran this
    // effect and rebuilt the series and the studies mid-scroll.
    untrack(() => {
      chart!.applyOptions(appearanceOptions(t));
      // Right margin (bars) nudges the view, so apply it off the initial mount.
      chart!.timeScale().applyOptions({ rightOffset: t.rightOffset });
      rebuildSeries();
      // Compared symbols: scale sides and visibility follow the placement.
      syncCompare();
    });
  });

  // Canvas → Watermark: centered pane text assembled from the checked parts
  // (ticker / interval / description — a checkable-list model). The
  // description line needs the ticker-info name, fetched lazily only while
  // that part is enabled.
  // Status line → Title: the "Name" / "Symbol and name" modes need the
  // ticker-info company name, fetched lazily only while a name mode is
  // committed (same pattern as the watermark description below).
  // Memoized ticker / interval label: `props.symbol` and `props.interval`
  // re-notify whenever the pane object is replaced (e.g. the debounced
  // visible-range save on every scroll). Compared by value, the name and
  // watermark effects below re-run only on a real change instead of clearing
  // and re-fetching the name (the legend flashing the ticker) on each scroll.
  const ticker = createMemo(() => splitSymbol(props.symbol ?? "").ticker);
  /** Full name for reference / news lookups (the provider tells listings apart). */
  const fullSymbol = createMemo(() => props.symbol ?? "");
  const intervalText = createMemo(() => intervalLabel(props.interval ?? "1D"));

  const { NewsCard } = attach(cx, createNews(cx));
  function catchUpOnShow() {
    if (cx.compareLiveDirty) {
      cx.compareLiveDirty = false;
      renderCompareAll();
    }
    if (cx.liveDirty) {
      const appended = cx.liveAppendedWhileHidden;
      cx.liveDirty = false;
      cx.liveAppendedWhileHidden = false;
      paintLive(null, appended);
    }
    updateCountdown();
    setStatusClock(Date.now());
    for (const f of [...onShownHooks]) f();
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
    untrack(updateHistoryEnd);
  });
  onCleanup(() => cx.historyEndClose?.());
  attach(cx, createTickerInfo(cx));

  return (
    <div
      ref={paneRoot}
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
      onContextMenu={openContextMenu}
      onMouseEnter={() => { setChartHovered(true); refreshScaleOverlays(); refreshPaneBoxes(); }}
      onMouseMove={(e) => {
        const r = paneRoot.getBoundingClientRect();
        const pane = paneAtY(e.clientY - r.top);
        setHoverPane(pane);
        const x = e.clientX - r.left;
        // Over a price axis of the pane (either side: the series sharing a
        // study pane has the other side).
        const lw = leftAxisWidth();
        let rw = 0;
        try { rw = chart?.priceScale("right").width() ?? 0; } catch { /* not laid out */ }
        setAxisHover(scaleGeom() && pane !== null && ((lw > 0 && x < lw) || (rw > 0 && x >= r.width - rw)) ? pane : null);
      }}
      onMouseLeave={() => { setChartHovered(false); setAxisHover(null); setHoverPane(null); setPlusY(null); }}
    >
      <div
        ref={host}
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
        formatPrice={legendPriceFormat()}
        panes={drawingPanes()}
        sunk={sunkIds()}
        onPainter={(p) => {
          cx.sunkPainter = p;
          scheduleSourceOrder();
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
        stayMode={!!props.stayMode}
        onPlace={(d) => props.onPlace?.(d)}
        onDisarm={() => props.onDisarm?.()}
        selectedId={props.selectedDrawingId ?? null}
        selectedIds={props.selectedDrawingIds}
        setSelectedId={(id) => props.setSelectedDrawingId?.(id)}
        onToggleSelect={(id) => props.toggleSelectedDrawing?.(id)}
        onUpdate={(d, label) => props.updateDrawing?.(d, label)}
        onUpdateMany={(list) => props.updateDrawings?.(list)}
        onClone={(id) => props.cloneDrawing?.(id)}
        drawingSync={(id) => props.drawingSync?.(id) ?? null}
        onSync={(ids, mode) => props.setDrawingSync?.(ids, mode)}
        onReorder={(id, dir) => props.reorderDrawing?.(id, dir)}
        onRemove={(id) => props.removeDrawing?.(id)}
        onRemoveMany={(ids) => props.removeDrawings?.(ids)}
      />
      <PriceAxisOverlays />
      {/* Latest news card (lollipop tooltip, type "news"): "Latest updates"
          title, newest headline card. */}
      <NewsCard />
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
          "pointer-events": dimmed() ? "auto" : "none",
          opacity: dimmed() ? 1 : 0,
          transition: "opacity 130ms ease",
        }}
      />
      {/* The centred group bar. Like the goto button below, the wrapper stays
          mounted so the pointer-proximity test always has a box to measure. */}
      <ChartControlBar
        ref={(el) => (barWrap = el)}
        bottom={gotoBox().bottom}
        left={barLeft()}
        visible={barShown()}
        fits={barFits()}
        resetAvailable={resetAvailable()}
        maximized={!!props.maximized}
        onZoomIn={() => zoomSpan(1 / ZOOM_FACTOR)}
        onZoomOut={() => zoomSpan(ZOOM_FACTOR)}
        onToggleMaximize={() => props.onToggleMaximize?.()}
        onMoveStart={moveBars}
        onMoveStop={stopScroll}
        onReset={resetChartView}
      />
      {/* "Scroll to the most recent bar". The wrapper is always mounted — its
          box is what the pointer-proximity test measures — and only the button
          fades. Sits above the canvas but below the legends. */}
      <div
        ref={gotoWrap}
        class="ot-control-bar"
        style={{ bottom: `${gotoBox().bottom}px`, right: `${gotoBox().right}px` }}
      >
        <Tooltip text="Scroll to the most recent bar" hotkey="Alt + Shift + →" side="top">
          <div
            class="ot-control-bar__btn"
            classList={{ "ot-control-bar__btn--hidden": !gotoShown() }}
            onClick={scrollToRealtime}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="chart-goto-realtime" />
          </div>
        </Tooltip>
      </div>
      {/* One column: the studies stack under the series
          row whatever its height (it wraps to two lines on narrow panes). */}
      <LegendStacks />
      <Show when={settingsForId()}>
        {(id) => {
          const entry = getIndicatorEntry(id());
          const values = controller?.getInputs(id());
          const styles = controller?.getStyles(id());
          // Read once: the dialog's controls may call back while it closes.
          const strategy = values ? strategyDialogConfig(id(), values) : undefined;
          const tab = settingsTab();
          return (
            <Show when={entry && values && styles}>
              <IndicatorSettingsDialog
                title={isStrategyId(id()) || profileMetaOf(entry) || isTpoEntry(entry) ? (entry!.shortName ?? entry!.name) : entry!.name}
                strategy={strategy}
                profile={profileMetaOf(entry) ?? undefined}
                tpo={isTpoEntry(entry) ? { autoTicksPerRow: autoTicksPerRow(raw as unknown as Bar[], cachedSymbolSessions(props.symbol ?? "")?.mintick ?? 0.01) } : undefined}
                timeZone={cachedSymbolSessions(props.symbol ?? "")?.timeZone}
                initialTab={tab}
                inputConfig={entry!.inputConfig}
                plotConfig={entry!.plotConfig}
                inputs={values!}
                styles={styles!}
                options={controller!.getOptions(id())}
                onApply={({ inputs, styles: s, options }) => {
                  // One undo step (reference texts): the first input changed, else the study's style.
                  const was = controller?.getInputs(id()) ?? {};
                  const changed = (entry!.inputConfig ?? []).find((c) => JSON.stringify(inputs[c.id]) !== JSON.stringify(was[c.id]));
                  const title = indLegend().find((r) => r.id === id())?.title ?? entry!.name;
                  sourcesEdit(changed ? `change ${changed.title || changed.id} property` : `change ${title} style`, () => {
                    controller?.applySettings(id(), inputs, s, options);
                    props.onIndicatorSettings?.(id(), { inputs, styles: s, options });
                  });
                  refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
                  if (isStrategyId(id())) applyStrategyMarkers();
                }}
                onSaveAsDefault={(next) => saveIndicatorDefault(typeIdOf(id()), next)}
                onClose={() => {
                  setSettingsForId(null);
                  setSettingsTab(undefined);
                }}
              />
            </Show>
          );
        }}
      </Show>
      <Show when={compareSettingsFor() ? (props.compare ?? []).find((x) => x.id === compareSettingsFor()) : undefined} keyed>
        {(e) => (
          <CompareSettingsDialog
            entry={e}
            title={compareTitle(e)}
            onApply={({ symbol, style }) => sourcesEdit(`change ${compareTitle(e)} style`, () => props.onCompareChange?.(e.id, symbol !== e.symbol ? { symbol, style } : { style }))}
            onPreview={(next) => setComparePreview(next ? { id: e.id, ...next } : null)}
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
