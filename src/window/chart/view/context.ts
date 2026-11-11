/*
 * Shared context of a chart view's parts (view/*.ts). ChartView keeps the
 * chart's state in one plain core object; createChartCx creates every part
 * with the context and adds its functions to it, all before any effect or
 * handler of them runs, so the parts reach each other through it without
 * optional calls.
 */
import type { LegendValues } from "../ChartLegend";
import type { SetStoreFunction } from "solid-js/store";
import type { Accessor, Resource, Setter } from "solid-js";
import type { IChartApi, MouseEventParams } from "lightweight-charts";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { AnySeries, ChartTypeId, OHLC } from "../chart-types";
import type { Candle } from "../../../bindings";
import type { BarsResult, SessionId } from "../../../data/datafeed";
import type { IndicatorController, IndicatorLegendRow } from "../indicators/indicator-controller";
import type { Coords } from "../../drawings/coords";
import type { CtxNode } from "../ChartContextMenu";
import type { CountdownPrimitive } from "../countdown";
import type { HistoryEndPrimitive } from "../history-end-marker";
import type { NewsLollipopPrimitive } from "../news-lollipop";
import type { CrosshairLockAxisPrimitive, CrosshairLockViews } from "../crosshair-lock";
import type { DialogTab } from "../IndicatorSettingsDialog";
import type { CompareEntry, PaneIndicatorSettings } from "../../shell/tabs";
import type { ChartEdits } from "../../shell/chart-edits";
import type { DrawingStore } from "../../drawings/drawing-store";
import type { PaneEdits } from "./pane-edits";
import type { Draft } from "../../header/chart-settings";
import { appearanceFrom } from "../../header/chart-settings";
import { readChartTokens } from "../chart-tokens";
import { chartBackgroundAt } from "../selection-markers";
import type { CursorMode } from "../../../data/drawing-toolbar";

import type { NavigationApi } from "./navigation";
import type { MenusApi } from "./menus";
import type { PriceAxisApi } from "./price-axis";
import type { PanesApi } from "./panes";
import type { DecorationsApi } from "./decorations";
import type { AlertLayerApi } from "./alert-layer";
import type { HistoryApi } from "./history";
import type { CompareApi } from "./compare";
import type { SourcesApi } from "./sources";
import type { SnapshotApi } from "./snapshot";
import type { LiveApi } from "./live";
import type { NewsApi } from "./news";
import type { EventsApi } from "./events";
import type { EventMarkersPrimitive } from "../event-markers";
import type { PointerApi } from "./pointer";
import type { WindowEventsApi } from "./window-events";
import type { TickerInfoApi } from "./ticker-info";
import type { SymbolLoadApi } from "./symbol-load";
import type { StrategyMarksApi } from "./strategy-marks";
import type { LegendApi } from "./legend";
import type { SourceMenuApi } from "./source-menu";
import type { ScalesApi } from "./scales";
import type { ReplayApi } from "./replay";
import type { TradingLinesApi } from "./trading-lines";
import type { FutureAxisApi } from "./future-axis";
import type { SeriesApi } from "./series";
import type { TimeAxisApi } from "./time-axis";
import type { StudySyncApi } from "./study-sync";
import type { StudySettingsApi } from "./study-settings";
import type { PriceScaleWatch } from "../scale-watch";

export type ChartViewProps = {
  theme?: "dark" | "light";
  symbol?: string;
  /** Interval id ("1", "5", "60", "1D", "1W", "1M", ...). Drives which
   *  Rust command (minute_aggs vs day_aggs) the chart fetches from. */
  interval?: string;
  /** Bottom-bar session (RTH/ETH). Drives datafeed session filtering on
   *  intraday frames (09:30–16:00 ET for RTH); ignored on daily+. */
  session?: SessionId;
  /** Saved id of the chart in its layout (a saved replay is matched by it). */
  chartUid?: string;
  chartType?: ChartTypeId;
  armedTool?: string | null;
  /** Cursor-group interaction mode; drives the chart-host cursor + overlay
   *  erase/laser behaviour. */
  cursorMode?: CursorMode;
  /** A mouse-wheel time zoom happened; `mod` =
   *  Ctrl / Cmd held (focused zoom). Drives the grid's zoom hint. */
  onWheelZoom?: (mod: boolean) => void;
  /** Main series hidden (legend eye; series `visible`). */
  seriesHidden?: boolean;
  /** Indicators legend collapsed (its toggler). */
  indicatorsLegendCollapsed?: boolean;
  /** Legend symbol title clicked ("Change symbol"). */
  onChangeSymbol?: () => void;
  /** Legend interval clicked ("Change interval"). */
  onChangeInterval?: () => void;
  /** Set this pane's interval (the "Switch to a D" button of an interval the symbol has no bars on). */
  onSetInterval?: (interval: string) => void;
  armedGlyph?: string;
  magnet?: boolean;
  magnetMode?: "weak" | "strong";
  magnetSnapsToIndicators?: boolean;
  stayMode?: boolean;
  drawings?: Drawing[];
  onDisarm?: () => void;
  selectedDrawingId?: string | null;
  /** Full multi-selection (ordered, last = primary). */
  selectedDrawingIds?: string[];
  setSelectedDrawingId?: (id: string | null) => void;
  /** Ctrl/Cmd+click membership toggle. */
  toggleSelectedDrawing?: (id: string) => void;
  /** Ordered registry ids of indicators active on this chart. */
  indicators?: string[];
  /** Compared symbols (header "Compare symbols") of this pane. */
  compare?: CompareEntry[];
  /** Legend title of a compared symbol clicked ("Change symbol"). */
  onChangeCompareSymbol?: (id: string) => void;
  /** Persisted stacking order of the panes (study and compared-symbol ids,
   *  `_series` = the price pane). */
  paneOrder?: string[];
  /** Pane group of the study pane the main series was dragged into (absent
   *  = the series has a pane of its own). */
  seriesPane?: string;
  /** Scale the main series is pinned to (series menu "Pin to scale"), absent = the scales side. */
  seriesScale?: string;
  /** Persisted drawing order of the sources, front first (Object tree). */
  sourceOrder?: string[];
  /** When true, suppress all study layers without removing them from the active
   *  set (Hide-all dropdown's "Hide indicators"); restored when toggled off. */
  indicatorsHidden?: boolean;
  /** Lock indicators (Lock options): studies cannot be dragged on the chart. */
  indicatorsLocked?: boolean;
  /** Persisted per-indicator settings (inputs/styles) for THIS pane, keyed by
   *  registry id. Seeded into the controller so studies render with the user's
   *  saved values on load. */
  indicatorSettings?: Record<string, PaneIndicatorSettings>;
  /** Chart syncing group (0..4, undefined = none) and its legend button shown. */
  linkGroup?: number;
  linkSyncVisible?: boolean;
  /** IANA timezone for the time axis (crosshair label + tick marks). */
  timeZone?: string;
  /** The timezone row label ("Exchange", "(UTC-4) New York", …). */
  timeZoneLabel?: string;
  /** TRUE when this is the focused pane. Keyboard chart shortcuts (pan/zoom/
   *  scale/snapshot/reset) are broadcast to every pane but only the active one
   *  acts on them (focused-pane behaviour). */
  active?: boolean;
  /** False while this pane's tab is hidden. App keeps every opened tab's grid
   *  mounted (each tab page stays alive), so a tab switch only shows it. */
  shown?: boolean;
  /** The tab the pane is on (Bar Replay runs per tab) and the pane's index in it. */
  tabId: string;
  paneIndex: number;
  /** The stores the chart edits its pane and drawings through (view/pane-edits.ts), and the key its drawings are
   *  kept under. */
  chartEdits: ChartEdits;
  drawingStore: DrawingStore;
  drawingKey: string;
  /** Focus this chart (acting on its drawings focuses it). */
  onFocus?: () => void;
  /** Number of charts of the layout (the "entire layout" rows and "Move
   *  chart" need several). */
  layoutCount?: number;
  /** Control bar → maximize. `canMaximize` is false in a
   *  single-cell layout, where the group is dropped entirely. */
  canMaximize?: boolean;
  maximized?: boolean;
  onToggleMaximize?: () => void;
  /** This pane's committed chart Settings (the dialog draft). Drives candle /
   *  grid / crosshair / scale / margin / session-break appearance for THIS pane
   *  only; undefined = defaults. */
  settings?: Draft;
  /** Persisted visible logical range (bar-index based) for THIS pane. Restored
   *  when new data loads instead of snapping to the latest bars; undefined or
   *  out-of-bounds falls back to the default framing. `last` = index of the
   *  last item when saved (price-based types: their item count changes). */
  visibleLogicalRange?: { from: number; to: number; last?: number; barSpacing?: number; rightOffset?: number };
  /** First framing of a chart added by a larger template (see PaneChart). */
  initialScale?: { barSpacing: number; rightOffset: number };
};

/** An open chart menu: position, rows, and how it is anchored. */
/** `endX`: x is the menu's end edge (fitToWindow, start and end follow the reading direction). */
export type ChartMenuState = { x: number; y: number; nodes: CtxNode[]; endX?: boolean; endY?: boolean; corner?: boolean };

/** State and functions ChartView itself owns. */
export interface ChartCore {
  props: ChartViewProps;
  /** The chart's edits of its pane and drawings, bound to its tab and pane. */
  edits: PaneEdits;
  /** Unique id of this view (sync bus, live slot, strategy reports). */
  paneId: number;
  activeType: ChartTypeId;
  appearance: Accessor<ReturnType<typeof appearanceFrom>>;
  /** The saved place of the series last applied to (or saved from) the controller. */
  appliedSeriesPane: string | null;
  barWrap: HTMLDivElement;
  chart: IChartApi | null;
  chartReady: Accessor<number>;
  controller: IndicatorController | null;
  /** Coords bridge for the drawings overlay; refreshed on every series rebuild. */
  coords: Accessor<Coords | null>;
  setCoords: Setter<Coords | null>;
  /** Bumped on visible-range and price-scale changes so the overlay re-projects drawings. */
  coordEpoch: Accessor<number>;
  setCoordEpoch: Setter<number>;
  countdown: CountdownPrimitive;
  crosshairActive: boolean;
  /** The crosshair is a sibling pane's, mirrored by Crosshair sync: the legend follows it, the data window does not. */
  crosshairMirrored: boolean;
  /** The chart's crosshair handler (legend, crosshair sync), for a crosshair the chart was told to show (an armed
   *  drawing tool): the chart reports no move for it. */
  emitCrosshair: ((param: MouseEventParams) => void) | null;
  crosshairAt: { time: number; y: number } | null;
  crosshairPrice: number | null;
  ctxMenu: Accessor<ChartMenuState | null>;
  currentTokens: () => ReturnType<typeof readChartTokens>;
  fullSymbol: Accessor<string>;
  gotoWrap: HTMLDivElement;
  hidden: () => boolean;
  history: Resource<BarsResult | null>;
  historyEnd: HistoryEndPrimitive;
  host: HTMLDivElement;
  hostH: number;
  hostW: number;
  hoveredStudy: string | null;
  indLegend: () => IndicatorLegendRow[];
  lastLegendTime: number | undefined;
  /** "Lock vertical cursor line by time" views (crosshair-lock.ts): the time label on the main series, the line
   *  and padlock in every pane (created with the chart). */
  lockViews: CrosshairLockViews | null;
  lockAxis: CrosshairLockAxisPrimitive | null;
  newsLollipop: NewsLollipopPrimitive;
  eventMarkers: EventMarkersPrimitive;
  onShownHooks: Set<() => void>;
  paneRoot: HTMLDivElement;
  pendingRangeSpan: string | null;
  pointerOverHost: boolean;
  raw: OHLC[];
  rawDaily: Candle[];
  reloadTick: Accessor<number>;
  removeStudy: (id: string) => void;
  selectStudy: (id: string) => void;
  selectedStudy: Accessor<string | null>;
  /** Price-scale changes (autoscale, axis drag, log / percent) of the main series: attached to it. */
  scaleWatch: PriceScaleWatch;
  series: AnySeries | null;
  setCompareSettingsFor: Setter<string | null>;
  setCtxMenu: Setter<ChartMenuState | null>;
  setReloadTick: Setter<number>;
  setSelectedStudy: Setter<string | null>;
  /** Study whose Settings dialog is open (null = closed) and the tab it opens on. */
  settingsForId: Accessor<string | null>;
  setSettingsForId: Setter<string | null>;
  settingsTab: Accessor<DialogTab | undefined>;
  setSettingsTab: Setter<DialogTab | undefined>;
  studySelectionBg: Accessor<ReturnType<typeof chartBackgroundAt>>;
  swapping: boolean;
  /** "symbol|interval" of the bars shown, set when they are painted. */
  shownSeries: string;
  syncLockPanes: () => void;
  toggleSourceHidden: (id: string) => void;
  whenShown: <T extends Event>(fn: (e: T) => void) => EventListener;
  flagPopup: Accessor<HTMLElement | null>;
  intervalText: Accessor<string>;
  legend: Accessor<LegendValues | null>;
  rangePersistTimer: ReturnType<typeof setTimeout> | undefined;
  setFlagPopup: Setter<HTMLElement | null>;
  setIndLegendStore: SetStoreFunction<{ rows: IndicatorLegendRow[] }>;
  setLegend: Setter<LegendValues | null>;
  setSyncMenu: Setter<DOMRect | null>;
  syncMenu: Accessor<DOMRect | null>;
  ticker: Accessor<string>;
}

export type ChartCx = ChartCore &
  NavigationApi &
  MenusApi &
  PriceAxisApi &
  PanesApi &
  DecorationsApi &
  AlertLayerApi &
  HistoryApi &
  CompareApi &
  SourcesApi &
  SnapshotApi &
  LiveApi &
  NewsApi &
  EventsApi &
  PointerApi &
  WindowEventsApi &
  LegendApi &
  StrategyMarksApi &
  SymbolLoadApi &
  TickerInfoApi &
  SourceMenuApi &
  ScalesApi &
  ReplayApi &
  TradingLinesApi &
  FutureAxisApi &
  SeriesApi &
  TimeAxisApi &
  StudySyncApi &
  StudySettingsApi;

type Part = (cx: ChartCx) => object;
type Intersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/** The context of a chart view: `core` with every part added, created in the order given (their effects run in
 *  that order). A part reads the others through the context only when called, so all of them are in it before any
 *  effect or handler runs (Solid runs a component's effects after its body). The caller types the result as
 *  ChartCx: a part left out is a compile error. */
export function createChartCx<P extends Part[]>(core: ChartCore, ...parts: P): ChartCore & Intersection<ReturnType<P[number]>> {
  const cx = core as ChartCore & Intersection<ReturnType<P[number]>>;
  // Getters of a part's state (its mutable fields) stay getters on the context.
  for (const part of parts) Object.defineProperties(cx, Object.getOwnPropertyDescriptors(part(cx as unknown as ChartCx)));
  return cx;
}
