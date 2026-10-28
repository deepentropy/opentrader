/*
 * Shared context of a chart view's parts (view/*.ts). ChartView owns the
 * chart, its series and bars; each part is created with this context and adds
 * its own functions to it (attach), so the parts reach each other through it
 * without a creation order. The mutable fields are live accessors of the
 * view's state.
 */
import type { LegendValues } from "../ChartLegend";
import type { SetStoreFunction } from "solid-js/store";
import type { Accessor, Resource, Setter } from "solid-js";
import type { IChartApi, IPriceScaleApi } from "lightweight-charts";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import type { AnySeries, ChartTypeId, OHLC } from "../chart-types";
import { setDataForType } from "../chart-types";
import type { Candle } from "../../../bindings";
import type { BarsResult, SessionId } from "../../../data/datafeed";
import type { IndicatorController, IndicatorLegendRow } from "../indicators/indicator-controller";
import type { Coords } from "../../drawings/coords";
import type { CtxNode } from "../ChartContextMenu";
import type { CountdownPrimitive } from "../countdown";
import type { HistoryEndPrimitive } from "../history-end-marker";
import type { NewsLollipopPrimitive } from "../news-lollipop";
import type { CrosshairLockViews } from "../crosshair-lock";
import type { DialogTab } from "../IndicatorSettingsDialog";
import type { CompareEntry, ComparePatch, PaneIndicatorSettings } from "../../shell/tabs";
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
import type { SyncMode } from "../../drawings/DrawingToolbar";

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
  onToggleSeries?: () => void;
  /** Indicators legend collapsed (its toggler), and the toggle. */
  indicatorsLegendCollapsed?: boolean;
  onToggleIndicatorsLegend?: () => void;
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
  onPlace?: (d: NewDrawing) => string | void;
  onDisarm?: () => void;
  selectedDrawingId?: string | null;
  /** Full multi-selection (ordered, last = primary). */
  selectedDrawingIds?: string[];
  setSelectedDrawingId?: (id: string | null) => void;
  /** Ctrl/Cmd+click membership toggle. */
  toggleSelectedDrawing?: (id: string) => void;
  updateDrawing?: (d: Drawing, label?: string) => void;
  /** Bulk replace (group drag/nudge) — one undo entry. */
  updateDrawings?: (list: Drawing[]) => void;
  cloneDrawing?: (id: string | string[]) => void;
  /** Sync of a drawing of this pane (the scope it is kept in) and its change (drawing menu). */
  drawingSync?: (id: string) => SyncMode | null;
  setDrawingSync?: (ids: string[], mode: SyncMode) => void;
  reorderDrawing?: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  removeDrawing?: (id: string) => void;
  /** Bulk delete (multi-select Delete) — one undo entry. */
  removeDrawings?: (ids: string[]) => void;
  /** Ordered registry ids of indicators active on this chart. */
  indicators?: string[];
  /** Compared symbols (header "Compare symbols") of this pane. */
  compare?: CompareEntry[];
  /** Patch one compared symbol (legend eye, Settings → Ok). */
  onCompareChange?: (id: string, patch: ComparePatch) => void;
  /** Remove one compared symbol (legend trash, More → Remove, Delete pane). */
  onRemoveCompare?: (id: string) => void;
  /** Legend title of a compared symbol clicked ("Change symbol"). */
  onChangeCompareSymbol?: (id: string) => void;
  /** Persisted stacking order of the panes (study and compared-symbol ids,
   *  `_series` = the price pane). */
  paneOrder?: string[];
  /** Pane controls moved a pane: the new stacking order. */
  onPaneOrder?: (order: string[]) => void;
  /** Pane group of the study pane the main series was dragged into (absent
   *  = the series has a pane of its own). */
  seriesPane?: string;
  /** The series joined a study pane (its group) or got a pane of its own (null). */
  onSeriesPane?: (group: string | null) => void;
  /** Scale the main series is pinned to (series menu "Pin to scale"), absent = the scales side. */
  seriesScale?: string;
  /** The series was pinned to a scale (null = back to the scales side). */
  onSeriesScale?: (key: string | null) => void;
  /** Persisted drawing order of the sources, front first (Object tree). */
  sourceOrder?: string[];
  /** The Object tree moved a source: the new drawing order. */
  onSourceOrder?: (order: string[]) => void;
  /** The Object tree moved a drawing: the pane's drawings in their new
   *  order (front first) and the source each one sits in front of. */
  placeDrawings?: (ids: string[], over: Record<string, string | null>) => void;
  /** When true, suppress all study layers without removing them from the active
   *  set (Hide-all dropdown's "Hide indicators"); restored when toggled off. */
  indicatorsHidden?: boolean;
  /** Lock indicators (Lock options): studies cannot be dragged on the chart. */
  indicatorsLocked?: boolean;
  /** Remove an indicator (by registry id) — wired to the studies-legend trash. */
  onRemoveIndicator?: (id: string) => void;
  /** Persist this pane's study order (pane controls move up / down). */
  onReorderIndicators?: (ids: string[]) => void;
  /** Persisted per-indicator settings (inputs/styles) for THIS pane, keyed by
   *  registry id. Seeded into the controller so studies render with the user's
   *  saved values on load. */
  indicatorSettings?: Record<string, PaneIndicatorSettings>;
  /** Persist a study's edited inputs/styles (Settings dialog → Ok). */
  onIndicatorSettings?: (id: string, settings: PaneIndicatorSettings) => void;
  /** Chart syncing group (0..4, undefined = none), its legend button shown,
   *  and the setter. */
  linkGroup?: number;
  linkSyncVisible?: boolean;
  onLinkGroup?: (group: number | undefined) => void;
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
  visibleLogicalRange?: { from: number; to: number; last?: number };
  /** Report this pane's visible logical range after the user scrolls/zooms, so
   *  the anchor persists across tab switches + reloads. Debounced by the caller's
   *  store write; ChartView emits the settled range. */
  onVisibleRange?: (range: { from: number; to: number; last?: number }) => void;
};

/** An open chart menu: position, rows, and how it is anchored. */
export type ChartMenuState = { x: number; y: number; nodes: CtxNode[]; endX?: boolean; endY?: boolean; corner?: boolean };

/** State and functions ChartView itself owns. */
export interface ChartCore {
  props: ChartViewProps;
  /** Unique id of this view (sync bus, live slot, strategy reports). */
  paneId: number;
  activeType: ChartTypeId;
  afterSeriesData: () => void;
  appearance: Accessor<ReturnType<typeof appearanceFrom>>;
  barWrap: HTMLDivElement;
  chart: IChartApi | null;
  chartReady: Accessor<number>;
  controller: IndicatorController | null;
  coords: Accessor<Coords | null>;
  countdown: CountdownPrimitive;
  crosshairActive: boolean;
  crosshairAt: { time: number; y: number } | null;
  crosshairPrice: number | null;
  ctxMenu: Accessor<ChartMenuState | null>;
  currentTokens: () => ReturnType<typeof readChartTokens>;
  dataExtras: () => Parameters<typeof setDataForType>[4];
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
  lockViews: CrosshairLockViews | null;
  mainLastIndex: () => number | null;
  /** Pane of the main series (the price pane; any position). */
  mainPane: () => number;
  /** Bumped when the price pane moves or the series changes pane or scale. */
  mainPaneEpoch: Accessor<number>;
  /** Price scale of the main series. */
  mainScale: () => IPriceScaleApi | null;
  /** Side of the main series' scale (the free side in a study pane it shares). */
  mainSide: () => "left" | "right";
  /** Width of the left price axis (0 when hidden). */
  leftAxisWidth: () => number;
  /** Show the price axes the series and the compared symbols use. */
  syncScaleSides: () => void;
  newsLollipop: NewsLollipopPrimitive;
  /** Apply the price format again (the symbol's tick grid is known). */
  applyPriceFormat: () => void;
  eventMarkers: EventMarkersPrimitive;
  onShownHooks: Set<() => void>;
  paneRoot: HTMLDivElement;
  pendingRangeSpan: string | null;
  pointerOverHost: boolean;
  prevDayClose: (number | null)[];
  raw: OHLC[];
  rawDaily: Candle[];
  reloadTick: Accessor<number>;
  removeStudy: (id: string) => void;
  selectStudy: (id: string) => void;
  selectedStudy: Accessor<string | null>;
  series: AnySeries | null;
  seriesOnlyScale: () => string | null;
  /** Scale key of the main series (pinned, else its side) and its library scale id. */
  seriesKey: () => string;
  seriesLibId: () => string;
  /** Put the series on the scale it should be on. */
  applySeriesScale: () => void;
  setCompareSettingsFor: Setter<string | null>;
  setCtxMenu: Setter<ChartMenuState | null>;
  setReloadTick: Setter<number>;
  setSelectedStudy: Setter<string | null>;
  setSettingsForId: Setter<string | null>;
  setSettingsTab: Setter<DialogTab | undefined>;
  studySelectionBg: Accessor<ReturnType<typeof chartBackgroundAt>>;
  swapping: boolean;
  syncLockPanes: () => void;
  toggleSourceHidden: (id: string) => void;
  updateSessionBreaks: () => void;
  whenShown: <T extends Event>(fn: (e: T) => void) => EventListener;
  flagPopup: Accessor<HTMLElement | null>;
  intervalText: Accessor<string>;
  legend: Accessor<LegendValues | null>;
  legendPriceFormat: Accessor<((p: number) => string) | undefined>;
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
  TradingLinesApi;

/** Add a part's functions (and its state accessors) to the context. */
export function attach<T extends object>(cx: ChartCx, api: T): T {
  Object.defineProperties(cx, Object.getOwnPropertyDescriptors(api));
  return api;
}
