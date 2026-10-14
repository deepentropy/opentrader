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
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { typeIdOf } from "./indicators/study-id";
import {
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type ITextWatermarkPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Logical } from "lightweight-charts";
import { readChartTokens, readFontFamily } from "./chart-tokens";
import { chartBackgroundAt } from "./selection-markers";
import { MAIN_SOURCE_ID } from "./object-tree-sources";
import { flagOf, lastFlagColor, setFlag } from "../../data/symbol-flags";
import { FlagColorPopup } from "./FlagColorPopup";
import { ChartSyncMenu, SYNC_GROUPS } from "./ChartSyncMenu";
import { FLAG_HEX } from "../../data/watchlist";
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
import { ZOOM_FACTOR, liveBarSpacing } from "./control-bar";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { appearanceFrom, type PriceSource } from "../header/chart-settings";
import { clearActiveChartProbe, setActiveChartProbe } from "./active-chart";
import { CompareSettingsDialog } from "./compare/CompareSettingsDialog";
import {
  getBars,
  getEvents,
  getTickerInfo,
  initialViewBars,
  intervalLabel,
  isIntradayInterval,
  isIntradayResolution,
  isSecondResolution,
  splitSymbol,
  type BarsResult,
  type SessionId,
} from "../../data/datafeed";
import { type Candle } from "../../bindings";
import {
  CHART_TYPE_ICON,
  createSeriesForType,
  isTransformType,
  setDataForType,
  type AnySeries,
  type ChartTypeId,
  type OHLC,
} from "./chart-types";
import { ChartLegend, type LegendValues } from "./ChartLegend";
import { chartPriceFormat } from "./price-format";
import { dayKeyer } from "./day-key";
import { cachedSymbolSessions } from "../../data/session";
import { IndicatorLegend } from "./IndicatorLegend";
import { IndicatorSettingsDialog, type DialogTab, type StrategyDialogConfig } from "./IndicatorSettingsDialog";
import { chartSeconds, profileMetaOf } from "./profiles/vbp-studies";
import { isTpoEntry } from "./profiles/tpo";
import { autoTicksPerRow } from "./profiles/tpo-engine";
import { DEFAULT_SYMBOL, type StrategyProperties } from "../../backtester/types";
import { PriceScaleWatch } from "./scale-watch";
import { IndicatorController, type IndicatorLegendRow } from "./indicators/indicator-controller";
import { getIndicatorEntry } from "./indicators/registry";
import { OAKSCRIPT_OPEN_EVENT, scriptIdOfStudy } from "./indicators/user-scripts";
import { scriptChartContext } from "./indicators/script-chart";
import { PROPERTIES_INPUT, isStrategyId, strategyDefaults, strategyKeyOf, strategyStyleOf } from "./indicators/strategy-entries";
import { strategyTester } from "../../data/strategy-tester-store";
import { registerChartState, unregisterChartState, type ChartBar } from "../../data/chart-state-registry";
import { publishDataWindow, type DataWindowState } from "../../data/data-window-store";
import { ChartContextMenu } from "./ChartContextMenu";
import type { Bar } from "oakscriptjs";
import { makeCoords, type Coords, type FutureAxis } from "../drawings/coords";
import { sessionFutureAxis } from "./indicators/future-slots";
import { DrawingsOverlay } from "../drawings/DrawingsOverlay";
import { cursorForMode } from "../drawings/cursors";
import { attach, type ChartCore, type ChartCx, type ChartMenuState, type ChartViewProps } from "./view/context";
import {
  toOHLC,
  barsSpan,
  MIN_VISIBLE_BARS,
  SYMBOL_CHANGE_MAX_BACK,
  AxisFmt,
  formatAxisTime,
  formatTick,
  indexOfTime,
  appearanceOptions,
  buildLegend,
} from "./view/helpers";
import { createNavigation } from "./view/navigation";
import { createMenus } from "./view/menus";
import { createPriceAxis } from "./view/price-axis";
import { createPanes } from "./view/panes";
import { createDecorations } from "./view/decorations";
import { createAlertLayer } from "./view/alert-layer";
import { createHistory } from "./view/history";
import { createCompare } from "./view/compare";
import { createSources } from "./view/sources";
import { createSnapshot } from "./view/snapshot";
import { createLive } from "./view/live";
import { createNews } from "./view/news";
import { createPointer } from "./view/pointer";
import { createWindowEvents } from "./view/window-events";


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
    get activeType() {
      return activeType;
    },
    set activeType(v: ChartCore["activeType"]) {
      activeType = v;
    },
    get afterSeriesData() {
      return afterSeriesData;
    },
    get appearance() {
      return appearance;
    },
    get applyStrategyMarkers() {
      return applyStrategyMarkers;
    },
    get barWrap() {
      return barWrap;
    },
    set barWrap(v: ChartCore["barWrap"]) {
      barWrap = v;
    },
    get chart() {
      return chart;
    },
    set chart(v: ChartCore["chart"]) {
      chart = v;
    },
    get chartReady() {
      return chartReady;
    },
    get controller() {
      return controller;
    },
    set controller(v: ChartCore["controller"]) {
      controller = v;
    },
    get coords() {
      return coords;
    },
    get countdown() {
      return countdown;
    },
    get crosshairActive() {
      return crosshairActive;
    },
    set crosshairActive(v: ChartCore["crosshairActive"]) {
      crosshairActive = v;
    },
    get crosshairAt() {
      return crosshairAt;
    },
    set crosshairAt(v: ChartCore["crosshairAt"]) {
      crosshairAt = v;
    },
    get crosshairPrice() {
      return crosshairPrice;
    },
    set crosshairPrice(v: ChartCore["crosshairPrice"]) {
      crosshairPrice = v;
    },
    get ctxMenu() {
      return ctxMenu;
    },
    get currentTokens() {
      return currentTokens;
    },
    get dataExtras() {
      return dataExtras;
    },
    get fullSymbol() {
      return fullSymbol;
    },
    get gotoWrap() {
      return gotoWrap;
    },
    set gotoWrap(v: ChartCore["gotoWrap"]) {
      gotoWrap = v;
    },
    get hidden() {
      return hidden;
    },
    get history() {
      return history;
    },
    get historyEnd() {
      return historyEnd;
    },
    get host() {
      return host;
    },
    set host(v: ChartCore["host"]) {
      host = v;
    },
    get hostH() {
      return hostH;
    },
    set hostH(v: ChartCore["hostH"]) {
      hostH = v;
    },
    get hostW() {
      return hostW;
    },
    set hostW(v: ChartCore["hostW"]) {
      hostW = v;
    },
    get hoveredStudy() {
      return hoveredStudy;
    },
    set hoveredStudy(v: ChartCore["hoveredStudy"]) {
      hoveredStudy = v;
    },
    get indLegend() {
      return indLegend;
    },
    get lastLegendTime() {
      return lastLegendTime;
    },
    set lastLegendTime(v: ChartCore["lastLegendTime"]) {
      lastLegendTime = v;
    },
    get lockViews() {
      return lockViews;
    },
    set lockViews(v: ChartCore["lockViews"]) {
      lockViews = v;
    },
    get mainLastIndex() {
      return mainLastIndex;
    },
    get mainPriceSource() {
      return mainPriceSource;
    },
    get newsLollipop() {
      return newsLollipop;
    },
    get onShownHooks() {
      return onShownHooks;
    },
    get paneRoot() {
      return paneRoot;
    },
    set paneRoot(v: ChartCore["paneRoot"]) {
      paneRoot = v;
    },
    get pendingRangeSpan() {
      return pendingRangeSpan;
    },
    set pendingRangeSpan(v: ChartCore["pendingRangeSpan"]) {
      pendingRangeSpan = v;
    },
    get pointerOverHost() {
      return pointerOverHost;
    },
    set pointerOverHost(v: ChartCore["pointerOverHost"]) {
      pointerOverHost = v;
    },
    get prevDayClose() {
      return prevDayClose;
    },
    set prevDayClose(v: ChartCore["prevDayClose"]) {
      prevDayClose = v;
    },
    get raw() {
      return raw;
    },
    set raw(v: ChartCore["raw"]) {
      raw = v;
    },
    get rawDaily() {
      return rawDaily;
    },
    set rawDaily(v: ChartCore["rawDaily"]) {
      rawDaily = v;
    },
    get refreshIndicatorLegend() {
      return refreshIndicatorLegend;
    },
    get refreshLegend() {
      return refreshLegend;
    },
    get reloadTick() {
      return reloadTick;
    },
    get removeStudy() {
      return removeStudy;
    },
    get selectStudy() {
      return selectStudy;
    },
    get selectedStudy() {
      return selectedStudy;
    },
    get series() {
      return series;
    },
    set series(v: ChartCore["series"]) {
      series = v;
    },
    get seriesOnlyScale() {
      return seriesOnlyScale;
    },
    get setCompareSettingsFor() {
      return setCompareSettingsFor;
    },
    get setCtxMenu() {
      return setCtxMenu;
    },
    get setDimmed() {
      return setDimmed;
    },
    get setReloadTick() {
      return setReloadTick;
    },
    get setSelectedStudy() {
      return setSelectedStudy;
    },
    get setSettingsForId() {
      return setSettingsForId;
    },
    get setSettingsTab() {
      return setSettingsTab;
    },
    get studySelectionBg() {
      return studySelectionBg;
    },
    get swapping() {
      return swapping;
    },
    set swapping(v: ChartCore["swapping"]) {
      swapping = v;
    },
    get syncLockPanes() {
      return syncLockPanes;
    },
    get toggleSourceHidden() {
      return toggleSourceHidden;
    },
    get updateSessionBreaks() {
      return updateSessionBreaks;
    },
    get whenShown() {
      return whenShown;
    },
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
  // Strategy trade marks on `series` (see applyStrategyMarkers).
  let tradeMarkers: ISeriesMarkersPluginApi<Time> | null = null;
  let tradeMarkersSeries: ISeriesApi<any> | null = null;
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
      futureValue = sessionFutureAxis(interval, spec);
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

  function refreshIndicatorLegend(time?: number) {
    setIndLegendStore("rows", reconcile([...(controller?.getLegend(time) ?? []), ...compareLegendRows(time)], { key: "id" }));
  }
  /** Compared-symbol Settings dialog (entry id; null = closed). */
  const [compareSettingsFor, setCompareSettingsFor] = createSignal<string | null>(null);
  /** Top of the legend stack inside its pane (`.ot-legend-stack` top). */
  const LEGEND_TOP = 4;
  /** The legends end 8 px before the right price scale (the plot width): a
   *  title too long for it is cut with an ellipsis, so the legend buttons stay
   *  in view on a narrow chart. */
  const legendMaxWidth = () => {
    const g = scaleGeom();
    const right = g && !g.left ? g.w : 0;
    return `calc(100% - ${8 + legendLeft() + right + 8}px)`;
  };
  /** Studies legend of one pane (0 = the price pane, under the series row). */
  const studyLegend = (pane: number) => (
    <IndicatorLegend
      rows={indLegend().filter((r) => r.pane === pane)}
      showTitles={appearance().legendIndTitles}
      showInputs={appearance().legendIndInputs}
      showValues={appearance().legendIndValues}
      bgColor={appearance().bg}
      bgOpacity={appearance().legendIndBgOpacity}
      onToggleHide={toggleSourceHidden}
      onSettings={(id) => {
        selectStudy(id);
        if (compareEntry(id)) setCompareSettingsFor(id);
        else setSettingsForId(id);
      }}
      onRemove={removeStudy}
      selectedId={selectedStudy()}
      onSelect={selectStudy}
      onMore={(id, r) => (compareEntry(id) ? openCompareMoreMenu(id, r) : openIndicatorMoreMenu(id, r))}
      hasSource={(id) => scriptIdOfStudy(id) !== null}
      onSource={(id) => {
        const scriptId = scriptIdOfStudy(id);
        if (scriptId) window.dispatchEvent(new CustomEvent(OAKSCRIPT_OPEN_EVENT, { detail: { scriptId } }));
      }}
      onIntervalSettings={(id) => {
        selectStudy(id);
        setSettingsTab("visibility");
        setSettingsForId(id);
      }}
      onTitleClick={(id) => { if (compareEntry(id)) props.onChangeCompareSymbol?.(id); }}
    />
  );

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
    applyRangeSpan,
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

  const { alertTarget, openCompareMoreMenu, openContextMenu, openIndicatorMoreMenu, openSeriesMoreMenu } = attach(cx, createMenus(cx));
  /** Study whose plot is under the pointer (crosshair move), null = none. */
  let hoveredStudy: string | null = null;
  /** Price under the crosshair (on the scale of the pane under it), null = pointer not on the chart. */
  let crosshairPrice: number | null = null;


  /** Re-resolve the legend for a crosshair time (or the latest bar when
   *  omitted). Reads the live `raw` + `activeType` closures. */
  /** Price source of a single-value main series (Symbol tab "Price source"). */
  function mainPriceSource(): PriceSource {
    const st = currentTokens().styles;
    return activeType === "line" || activeType === "lineWithMarkers" || activeType === "stepline" ? st[activeType].source
      : activeType === "area" ? st.area.source
      : activeType === "baseline" ? st.baseline.source
      : activeType === "column" ? st.column.source
      : "close";
  }

  function refreshLegend(time?: number) {
    if (raw.length === 0) {
      setLegend(null);
      if (props.active) publishDataWindow(null);
      return;
    }
    let idx = raw.length - 1;
    if (time != null) {
      const hit = indexOfTime(raw, time);
      if (hit >= 0) idx = hit;
    }
    setLegend(buildLegend(raw, idx, activeType, prevDayClose[idx] ?? null, mainPriceSource()));
    publishDataWindowIfOwner(idx, time);
  }

  /** Publish this pane's data-window snapshot for the bar at `idx`, but only
   *  when this pane owns the data window: the crosshair is over it, or it's the
   *  focused pane (so a sibling pane's live tick can't steal it). Indicator
   *  values resolve at the same `time` the legend used. */
  function publishDataWindowIfOwner(idx: number, time?: number) {
    if (!(props.active || crosshairActive)) return;
    const bar = raw[idx];
    const prevClose = idx > 0 ? raw[idx - 1].close : null;
    const changeAbs = prevClose == null ? 0 : bar.close - prevClose;
    const changePct = prevClose ? (changeAbs / prevClose) * 100 : 0;
    const { ticker, exchange } = splitSymbol(props.symbol ?? "");
    const iv = props.interval ?? "";
    const indicators: DataWindowState["indicators"] = (controller?.getLegend(time) ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      plots: r.plots,
    }));
    publishDataWindow({
      ticker,
      exchange,
      interval: iv,
      chartTypeIcon: CHART_TYPE_ICON[activeType],
      time: bar.time as number,
      // Seconds/minutes/hours show a time-of-day row; D/W/M don't.
      intraday: !/^\d+[DWM]$/i.test(iv),
      timeZone: props.timeZone,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      changeAbs,
      changePct,
      dir: bar.close >= bar.open ? "up" : "down",
      volume: bar.volume ?? null,
      indicators,
    });
  }

  const {
    PriceAxisOverlays,
    fitPriceScaleOnce,
    legendLeft,
    refreshScaleOverlays,
    scaleGeom,
    setAxisHover,
    setChartHovered,
    setCurrency,
    setPlusY,
  } = attach(cx, createPriceAxis(cx));

  const { PaneControls, drawingPanes, paneAtY, paneBoxes, refreshPaneBoxes, setHoverPane, setPaneEpoch } = attach(cx, createPanes(cx));

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
    // study pane open, removing the main series would delete pane 0, and the
    // new series would land in the study pane (wrong height, study moved to
    // a new pane). Keep the main pane alive across the swap.
    const mainPane = old ? old.getPane() : null;
    const preserved = mainPane?.preserveEmptyPane() ?? false;
    mainPane?.setPreserveEmptyPane(true);
    if (old) chart.removeSeries(old);
    forgetBaseline();
    const tokens = currentTokens();
    series = createSeriesForType(chart, activeType, tokens);
    mainPane?.setPreserveEmptyPane(preserved);
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
    // Bind the price axis to the chosen side (Scales placement). The visible
    // scale already drives the default; this pins it explicitly too.
    series.applyOptions({ priceScaleId: tokens.scalesPlacement });
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
    tradeMarkersSeries = null;
    tradeMarkers = null;
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
    marketSession,
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
    goToTime,
    holdLinkQuiet,
    maybeLoadOlder,
    scheduleSyncRun,
    startPrefetch,
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
    // Start empty; real candles arrive from the Massive resource below.
    raw = [];
    rebuildSeries();

    // The controller reads bars from `raw` on demand, so it always recomputes
    // against the freshest dataset without threading bars in.
    controller = new IndicatorController(chart, () => raw as unknown as Bar[], String(paneId));
    controller.setLastBarOpenProbe(lastBarForming);
    controller.setMainSeriesProbe(() => series as ISeriesApi<SeriesType> | null);
    controller.setSeriesChangedHook(() => {
      scheduleSourceOrder();
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
  // Strategies: filled orders as trade marks on the price series (the reference app:
  // buy = #2962ff arrow up below the bar, sell = #ff1744 arrow down above it,
  // with the order signal and the signed quantity).
  /** Settings dialog config of a strategy study: effective and script
   *  strategy() properties, trade-mark style, chart currency / interval /
   *  exchange time zone (the backtest's symbol defaults). */
  function strategyDialogConfig(id: string, inputs: Record<string, unknown>): StrategyDialogConfig | undefined {
    if (!isStrategyId(id)) return undefined;
    const defaults = strategyDefaults(id);
    if (!defaults) return undefined;
    const overrides = (inputs[PROPERTIES_INPUT] ?? {}) as Partial<StrategyProperties>;
    return {
      properties: { ...defaults, ...overrides },
      defaults,
      style: strategyStyleOf(inputs),
      chartCurrency: defaults.currency,
      interval: props.interval ?? "1D",
      chartStyle: props.chartType ?? "candle",
      // The engine runs in the charted symbol's exchange zone (chart context).
      timeZone: cachedSymbolSessions(props.symbol ?? "")?.timeZone ?? DEFAULT_SYMBOL.timezone,
    };
  }
  function applyStrategyMarkers() {
    if (!series) return;
    const marks: SeriesMarker<Time>[] = [];
    for (const id of (props.indicators ?? []).filter(isStrategyId)) {
      // Settings > Style: Trades on chart / Signal labels / Quantity; nothing
      // while the study is eye-hidden or off its Visibility intervals.
      const style = strategyStyleOf(controller?.getInputs(id));
      if (!style.tradesOnChart || (controller && !controller.isDrawn(id))) continue;
      const report = strategyTester.run(String(paneId), strategyKeyOf(id))?.report;
      for (const o of report?.filledOrders ?? []) {
        const qty = style.quantity ? `${o.buy ? "+" : "−"}${o.qty}` : "";
        const signal = style.signalLabels ? o.comment : "";
        const text = (o.buy ? [signal, qty] : [qty, signal]).filter(Boolean).join(" ");
        marks.push(
          o.buy
            ? { time: (o.time / 1000) as Time, position: "belowBar", shape: "arrowUp", color: "#2962ff", text }
            : { time: (o.time / 1000) as Time, position: "aboveBar", shape: "arrowDown", color: "#ff1744", text },
        );
      }
    }
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    if (tradeMarkersSeries !== series) {
      tradeMarkers?.detach();
      tradeMarkers = marks.length ? createSeriesMarkers(series, marks) : null;
      tradeMarkersSeries = tradeMarkers ? series : null;
    } else tradeMarkers?.setMarkers(marks);
  }
  createEffect(() => {
    props.indicators;
    applyStrategyMarkers();
  });
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

  // Symbol/interval change → drop the previous series immediately so an
  // in-flight fetch can never leave another symbol's candles (or its last
  // price in the legend) on screen. The history effect below refills once the
  // new bars arrive; until then the pane reads as empty/loading.
  // `props.symbol`/`props.interval` are non-memoized accessors over the
  // active-tab signal, and the render helpers below subscribe this effect to
  // further signals (indicator/legend state). Any of those firing
  // re-runs this effect with an UNCHANGED symbol — and a re-run that lands
  // after the apply effect has painted would blank the freshly-loaded chart
  // (the "every other symbol goes blank" bug). The value guard makes the clear
  // act only on a genuine symbol/interval change, mirroring the drawings effect.
  let firstSymbol = true;
  let lastClearedSym: string | undefined;
  let lastClearedInt: string | undefined;
  // Session counts as a genuine series change (it refetches + re-buckets the
  // bars), so it resets paging and runs the swap transition just like interval.
  let lastClearedSess: SessionId | undefined;
  // Wall-clock of the last genuine symbol/interval change, so the apply effect
  // can log the true end-to-end (selection → painted) time.
  let loadStartMs = 0;
  // TRUE from a symbol/interval change until the new data is painted. While set,
  // the previous symbol's candles stay on screen under the dim overlay and the
  // live poller is gated (so its ticks can't append onto the outgoing series).
  let swapping = false;
  // Pre-switch bar spacing + right offset (bars between the last bar and the
  // right edge), captured when the interval/session changes on the SAME symbol.
  // Both are kept across an interval change and the dates move, e.g.
  // 1D scrolled back 300 bars → 60 still 300 bars back at the same spacing, and
  // back to 1D on the exact previous dates. Null for symbol changes / first load.
  // With Scales → "Save chart left edge position when changing interval" on,
  // `leftTime` (the left edge's bar time) is kept instead of the right offset.
  // A symbol change keeps them too (`symbol`): same bar spacing, same number of
  // bars back from the last bar, at most SYMBOL_CHANGE_MAX_BACK; and the price
  // scale is fitted once to the new symbol, also with auto scale off.
  let pendingScaleKeep: { barSpacing: number; rightOffset: number; leftTime?: number; symbol?: boolean } | null = null;
  // Bottom-bar date-range preset ("1D"…"All") waiting for the tab's interval
  // reload to land; the apply effect frames this span instead of keeping the
  // pre-switch scale. Takes precedence over pendingScaleKeep.
  let pendingRangeSpan: string | null = null;

  createEffect(() => {
    const sym = props.symbol;
    const int = props.interval;
    const sess = props.session;
    if (firstSymbol) {
      firstSymbol = false;
      lastClearedSym = sym;
      lastClearedInt = int;
      lastClearedSess = sess;
      return;
    }
    if (sym === lastClearedSym && int === lastClearedInt && sess === lastClearedSess) return;
    loadStartMs = performance.now();
    {
      const w = window as unknown as { __clickT?: number };
      const sinceClick = w.__clickT ? ` | select→symbol-effect ${(loadStartMs - w.__clickT).toFixed(0)}ms` : "";
      console.log(`[symbol-effect] ${sym} ${int} ${sess}${sinceClick}`);
    }
    // Interval/session switch on the SAME symbol: keep the bar spacing and the
    // right offset (see pendingScaleKeep). Captured now, while the old
    // interval is still painted. A symbol change frames its own window.
    if (chart && sym === lastClearedSym && (int !== lastClearedInt || sess !== lastClearedSess)) {
      const bs = liveBarSpacing(chart);
      const leftTime = currentTokens().saveLeftEdge ? (chart.timeScale().getVisibleRange()?.from as number | undefined) : undefined;
      pendingScaleKeep = bs ? { barSpacing: bs, rightOffset: chart.timeScale().scrollPosition(), leftTime } : null;
    } else {
      // Symbol change: the new symbol opens at the same bar spacing and the
      // same distance from its last bar (no farther back than
      // SYMBOL_CHANGE_MAX_BACK), not on the old symbol's bar numbers.
      const bs = chart && raw.length > 0 ? liveBarSpacing(chart) : null;
      pendingScaleKeep = bs && sym !== lastClearedSym
        ? { barSpacing: bs, rightOffset: Math.max(chart!.timeScale().scrollPosition(), -SYMBOL_CHANGE_MAX_BACK), symbol: true }
        : null;
      // A genuine symbol change drops any queued date-range preset — it rode
      // an interval change on the previous symbol.
      pendingRangeSpan = null;
    }
    lastClearedSym = sym;
    lastClearedInt = int;
    lastClearedSess = sess;
    if (!chart || !series) return;
    // Keep the previous symbol's candles painted (the dim overlay covers them)
    // until the new data lands — a stale-while-loading
    // transition instead of a blank flash. We only invalidate paging and any
    // in-flight page here; the apply effect swaps the data when it arrives.
    // Bumping the generation token makes a page launched for the previous series
    // bail in its `.then` instead of prepending/re-ranging the new one.
    swapping = true;
    cx.fetchGen++;
    cx.loadingMore = false;
    cx.historyExhausted = false;
    updateHistoryEnd();
    cx.prefetch = null;
    cx.liveVolBase = null;
    // Drop any anchor-persist queued for the OUTGOING symbol so it can't land on
    // the incoming pane after the swap (the apply effect restores the new pane's
    // own saved range).
    if (rangePersistTimer !== undefined) {
      clearTimeout(rangePersistTimer);
      rangePersistTimer = undefined;
    }
  });
  // The last resource value this effect actually applied. The render/legend
  // helpers below subscribe the effect to indicator/legend signals, and
  // onRangeChange bumps coordEpoch on every scroll — so this effect can re-run
  // with the SAME resource value. Without a guard a re-run would reset `raw`
  // back to the recent window (dropping scroll-back / time-sync pages) and
  // re-frame to the latest bars — the "scroll snaps back to today" bug. Track
  // the applied value and skip spurious re-runs (mirrors the symbol-clear
  // effect's value guard above).
  let lastAppliedReal: BarsResult | null | undefined = null;
  createEffect(() => {
    const real = history();
    if (!chart || !series) return;
    // Mid-refetch the resource still reports the previous symbol's bars; wait
    // for the new fetch to settle before touching the chart so we don't flash
    // stale data.
    if (history.loading) return;
    // Same dataset as last applied → a spurious re-run (legend/indicator/scroll
    // signal), not new data. Leave the chart (and the user's scroll position +
    // any paged bars) untouched.
    if (real === lastAppliedReal) return;
    lastAppliedReal = real;
    // New symbol resolved with no data (not on Massive, entitlement gap, …).
    // Clear the previous symbol's candles instead of leaving them painted —
    // otherwise switching tabs looks like the price never changes.
    if (!real || real.bars.length === 0) {
      raw = [];
      rawDaily = [];
      cx.liveVolBase = null;
      setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
      updateSessionBreaks();
      if (!crosshairActive) refreshLegend();
      controller?.renderAll();
      renderCompareAll();
      refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
      swapping = false;
      return;
    }
    // The datafeed already aggregated 1W/1M; `real.daily` carries the
    // underlying daily bars (null for second/minute) so scroll-back can
    // re-aggregate the full set.
    rawDaily = real.daily ?? [];
    raw = toOHLC(real.bars);
    // Fresh series (possibly a new ADJ basis) — re-snap the 1W/1M live-volume
    // baseline from the reloaded bars on the next tick.
    cx.liveVolBase = null;
    setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
    updateSessionBreaks();
    // Recompute every active study against the freshly-loaded bars BEFORE
    // framing: study series add their times to the time scale (with a
    // transform type their real times sit between the synthetic ones), so
    // the saved range is checked and the view set on the final axis.
    controller?.renderAll();
    renderCompareAll();
    // Restore the user's last anchored view for this pane (persisted across tab
    // switches + reloads) when it still references loaded bars; otherwise fall
    // back to default framing. Read untracked so this effect re-runs only on new
    // data, not on every scroll that updates the saved range. A range that
    // shows fewer than MIN_VISIBLE_BARS of the loaded bars (e.g. a
    // shorter-history symbol, or a view saved past the last bar) is treated
    // as out of bounds.
    let saved = untrack(() => props.visibleLogicalRange);
    // Price-based types: the view follows the last item (its index moves
    // when the item count changed since the save).
    if (saved && saved.last !== undefined && isTransformType(activeType)) {
      const last = mainLastIndex();
      if (last != null) saved = { from: saved.from + last - saved.last, to: saved.to + last - saved.last, last };
    }
    // A saved view narrower than MIN_VISIBLE_BARS is the 1-bar collapse the old
    // sync path could persist, not a user choice: frame by default instead.
    let savedInBounds = !!saved && saved.to - saved.from >= MIN_VISIBLE_BARS;
    if (savedInBounds) {
      // Overlap, in time-scale indices, between the saved range and the
      // series. Transform types have their own items (data() copies, so only
      // there).
      const ts = chart.timeScale();
      const items: readonly { time: Time }[] = isTransformType(activeType) ? series.data() : raw;
      const first = items.length ? ts.timeToIndex(items[0].time, true) : null;
      const last = items.length ? ts.timeToIndex(items[items.length - 1].time, true) : null;
      const shown = first != null && last != null ? Math.min(saved!.to, last) - Math.max(saved!.from, first) + 1 : 0;
      savedInBounds = shown >= MIN_VISIBLE_BARS;
    }
    // Describes the framing applied, for the [apply] perf log below.
    let framed: string;
    if (pendingRangeSpan) {
      // Bottom-bar date-range tab: frame the preset span on the new interval
      // (overrides the interval-switch scale keep: the user asked for the span).
      const spanId = pendingRangeSpan;
      pendingRangeSpan = null;
      pendingScaleKeep = null;
      framed = `span ${spanId}`;
      applyRangeSpan(spanId);
    } else if (pendingScaleKeep) {
      // Interval/session switch on the same symbol: same bar spacing, same
      // number of bars between the last bar and the right edge. A view deeper
      // than the loaded intraday window pulls older pages in through the
      // scroll-back pager, as a user scroll would.
      const keep = pendingScaleKeep;
      pendingScaleKeep = null;
      const ts = chart.timeScale();
      if (isTransformType(activeType)) {
        // Price-based types: same bar spacing and right offset, counted from
        // their own last item (no time of their own for a left edge).
        const to = (mainLastIndex() ?? raw.length - 1) + keep.rightOffset;
        ts.setVisibleLogicalRange({ from: to - barsSpan(ts.width(), keep.barSpacing), to });
        framed = `keep bs=${keep.barSpacing.toFixed(2)} ro=${keep.rightOffset.toFixed(1)}`;
      } else if (keep.leftTime !== undefined) {
        // Left edge kept: the first bar at / after the old left-edge time
        // stays at the left edge, same bar spacing.
        let lo = 0;
        let hi = raw.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if ((raw[mid].time as number) < keep.leftTime) lo = mid + 1; else hi = mid; }
        const from = lo;
        ts.setVisibleLogicalRange({ from, to: from + barsSpan(ts.width(), keep.barSpacing) });
        framed = `keep-left bs=${keep.barSpacing.toFixed(2)} left=${keep.leftTime}`;
      } else {
        // A shorter history than the kept distance: its first bars stay in view.
        const ro = keep.symbol ? Math.max(keep.rightOffset, -(raw.length - MIN_VISIBLE_BARS)) : keep.rightOffset;
        const to = raw.length - 1 + ro;
        ts.setVisibleLogicalRange({ from: to - barsSpan(ts.width(), keep.barSpacing), to });
        framed = `keep bs=${keep.barSpacing.toFixed(2)} ro=${ro.toFixed(1)}`;
      }
      if (keep.symbol) fitPriceScaleOnce();
    } else if (savedInBounds) {
      chart.timeScale().setVisibleLogicalRange({ from: saved!.from, to: saved!.to });
      framed = `saved ${saved!.from.toFixed(0)}..${saved!.to.toFixed(0)}`;
    } else {
      // The daily family loads its full available history up-front, so frame the
      // most recent `view` bars (1D ≈ 1 year) with the rest preloaded behind, and
      // mark paging exhausted — scrolling back reveals already-loaded bars with no
      // network round-trip. Second/minute (rawDaily empty) keep lazy scroll-back.
      const view = initialViewBars(props.interval ?? "1D");
      // Transform types end the axis with their own last item, not at the
      // source bar count.
      let to = raw.length;
      if (isTransformType(activeType)) {
        const last = mainLastIndex();
        if (last != null) to = last + 1;
      }
      if (view !== null && raw.length > view) {
        chart.timeScale().setVisibleLogicalRange({ from: to - view, to });
      } else {
        chart.timeScale().fitContent();
      }
      framed = view === null ? "all" : String(view);
    }
    if (rawDaily.length > 0) cx.historyExhausted = true;
    updateHistoryEnd();
    {
      const _r = chart.timeScale().getVisibleLogicalRange();
      const now = performance.now();
      const e2e = loadStartMs ? ` | symbol-effect→paint ${(now - loadStartMs).toFixed(0)}ms` : "";
      const w = window as unknown as { __clickT?: number };
      const click = w.__clickT ? ` | SELECT→paint ${(now - w.__clickT).toFixed(0)}ms` : "";
      console.log(
        `[apply] ${props.symbol} ${props.interval}: set ${raw.length} bars (view=${framed}), hostW=${host.clientWidth}, range=${_r ? `${_r.from.toFixed(0)}..${_r.to.toFixed(0)}` : "null"}${e2e}${click}`,
      );
    }
    // This framing is not a user change: keep it off the tab links.
    holdLinkQuiet();
    // New data is painted — end the transition (drop the dim, re-enable the
    // live poller).
    swapping = false;
    // A date-range target that arrived while this pane was loading.
    if (cx.syncTarget) scheduleSyncRun(0);
    // A linked time that arrived while this pane was loading.
    if (cx.pendingLinkTime !== null) {
      const t = cx.pendingLinkTime;
      cx.pendingLinkTime = null;
      void goToTime(t);
    }
    if (!crosshairActive) refreshLegend();
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
    // Warm a read-ahead window now so the first scroll-back doesn't wait on the
    // network (idempotent — startPrefetch dedupes the same gen + beforeSec).
    const firstOldest = (rawDaily.length > 0 ? rawDaily[0]?.time : raw[0]?.time) as
      | number
      | undefined;
    if (firstOldest !== undefined)
      startPrefetch(props.symbol ?? "", props.interval ?? "1D", cx.fetchGen, firstOldest);
  });

  // Dim-and-hold transition: rather than a spinner on a
  // blanked chart, keep the previous candles painted and fade a dim overlay over
  // them while the new symbol loads. Debounced ~160ms so cached/instant loads
  // never flash the overlay; only dim when there's an outgoing chart to hold.
  const [dimmed, setDimmed] = createSignal(false);
  let dimTimer = 0;
  createEffect(() => {
    if (history.loading) {
      clearTimeout(dimTimer);
      dimTimer = window.setTimeout(() => {
        if (raw.length > 0) setDimmed(true);
      }, 160);
    } else {
      clearTimeout(dimTimer);
      setDimmed(false);
    }
  });
  onCleanup(() => clearTimeout(dimTimer));

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
    controller?.sync(ids);
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
    compareLegendRows,
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
    return t.scaleSeriesOnly ? t.scalesPlacement : null;
  };
  createEffect(() => {
    chartReady();
    const id = seriesOnlyScale();
    untrack(() => {
      controller?.setSeriesOnlyScale(id);
      for (const layer of compareLayers.values()) layer.setSeriesOnlyScale(id);
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
  const [legendDesc, setLegendDesc] = createSignal("");

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
  createEffect(() => {
    const mode = appearance().legendTitleMode;
    const sym = fullSymbol();
    setLegendDesc("");
    if (!sym || (mode !== "Name" && mode !== "Symbol and name")) return;
    let alive = true;
    getTickerInfo(sym)
      .then((info) => { if (alive) setLegendDesc(info?.name ?? ""); })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });

  // Price-axis currency label: the symbol's currency (ticker info).
  createEffect(() => {
    const sym = fullSymbol();
    setCurrency("");
    if (!sym) return;
    let alive = true;
    getTickerInfo(sym)
      .then((info) => { if (alive) setCurrency((info?.currency ?? "").toUpperCase()); })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });

  let watermark: ITextWatermarkPluginApi<Time> | null = null;
  const [wmDesc, setWmDesc] = createSignal("");
  createEffect(() => {
    const a = appearance();
    const sym = fullSymbol();
    setWmDesc("");
    if (!a.watermarkDescription || !sym) return;
    let alive = true;
    getTickerInfo(sym)
      .then((info) => { if (alive) setWmDesc(info?.name ?? ""); })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });
  createEffect(() => {
    appearance();
    void props.theme;
    const sym = ticker();
    const ivl = intervalText();
    const desc = wmDesc();
    if (!chart) return;
    const t = currentTokens();
    const head = [
      t.watermarkTicker ? sym : "",
      t.watermarkInterval ? ivl : "",
    ].filter(Boolean).join(", ");
    const lines: { text: string; color: string; fontSize: number }[] = [];
    if (head) lines.push({ text: head, color: t.watermarkColor, fontSize: 54 });
    if (t.watermarkDescription && desc) lines.push({ text: desc, color: t.watermarkColor, fontSize: 24 });
    // Recreate rather than applyOptions: dropping to zero lines must remove
    // the primitive, and recreation keeps one code path for both.
    watermark?.detach();
    watermark = null;
    if (lines.length > 0) watermark = createTextWatermark(chart.panes()[0], { lines });
  });

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
        const g = scaleGeom();
        const x = e.clientX - r.left;
        setAxisHover(g && pane !== null && (g.left ? x < g.w : x >= r.width - g.w) ? pane : null);
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
        leftInset={scaleGeom()?.left ? scaleGeom()!.w : 0}
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
        onUpdate={(d) => props.updateDrawing?.(d)}
        onUpdateMany={(list) => props.updateDrawings?.(list)}
        onClone={(id) => props.cloneDrawing?.(id)}
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
      <div class="ot-legend-stack" style={{ left: `${8 + legendLeft()}px`, "max-width": legendMaxWidth() }}>
        <ChartLegend
          ticker={splitSymbol(props.symbol ?? "").ticker}
          interval={intervalLabel(props.interval ?? "1D")}
          exchange={splitSymbol(props.symbol ?? "").exchange}
          values={legend()}
          formatPrice={legendPriceFormat()}
          titleMode={appearance().legendTitleMode}
          description={legendDesc()}
          showLogo={appearance().legendLogo}
          showTitle={appearance().legendTitle}
          showChartValues={appearance().legendChartValues}
          showBarChange={appearance().legendBarChange}
          showVolume={appearance().legendVolume}
          showLastDayChange={appearance().legendLastDayChange}
          marketStatus={marketSession()}
          showOpenStatus={appearance().legendMarketStatus ?? true}
          hideChangeValues={(props.chartType ?? "candle") === "hilo" || (props.chartType ?? "candle") === "svp"}
          seriesHidden={!!props.seriesHidden}
          onToggleSeries={props.onToggleSeries}
          flagColor={(() => { const f = props.symbol ? flagOf(props.symbol) : null; return f ? FLAG_HEX[f] : null; })()}
          onFlag={(btn) => {
            // Reference marker click: an unflagged symbol is flagged in the
            // last used colour and the colour popup opens; a flagged one is
            // unflagged.
            const sym = props.symbol;
            if (!sym) return;
            if (flagOf(sym)) { setFlag(sym, null); setFlagPopup(null); return; }
            setFlag(sym, lastFlagColor());
            setFlagPopup(btn);
          }}
          onChangeSymbol={props.onChangeSymbol}
          onChangeInterval={props.onChangeInterval}
          onMore={openSeriesMoreMenu}
          linkVisible={!!props.linkSyncVisible}
          linkIcon={props.linkGroup != null ? SYNC_GROUPS[props.linkGroup]?.icon ?? null : null}
          onLink={(r) => setSyncMenu(syncMenu() ? null : r)}
        />
        <Show when={syncMenu()}>
          {(r) => (
            <ChartSyncMenu anchor={r()} group={props.linkGroup} onPick={(g) => props.onLinkGroup?.(g)} onClose={() => setSyncMenu(null)} />
          )}
        </Show>
        <Show when={flagPopup()}>
          {(btn) => (
            <FlagColorPopup
              anchor={btn()}
              value={props.symbol ? flagOf(props.symbol) : null}
              onPick={(c) => { if (props.symbol) setFlag(props.symbol, c); }}
              onClose={() => setFlagPopup(null)}
            />
          )}
        </Show>
        {studyLegend(0)}
      </div>
      {/* Study panes: each pane's legend at its own top-left, same offset
          as the main legend. */}
      <For each={paneBoxes().filter((b) => b.index > 0)}>
        {(b) => (
          <Show when={indLegend().some((r) => r.pane === b.index)}>
            <div class="ot-legend-stack" style={{ top: `${b.top + LEGEND_TOP}px`, left: `${8 + legendLeft()}px`, "max-width": legendMaxWidth() }}>
              {studyLegend(b.index)}
            </div>
          </Show>
        )}
      </For>
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
                  controller?.applySettings(id(), inputs, s, options);
                  props.onIndicatorSettings?.(id(), { inputs, styles: s, options });
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
            onApply={({ symbol, style }) => props.onCompareChange?.(e.id, symbol !== e.symbol ? { symbol, style } : { style })}
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
