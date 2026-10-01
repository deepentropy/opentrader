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
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type IChartApi,
  type ISeriesApi,
  type ITextWatermarkPluginApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { IPriceLine, Logical } from "lightweight-charts";
import { readChartTokens, readFontFamily } from "./chart-tokens";
import { formatChartTime, formatTickMark } from "./time-format";
import { SessionBreaksPrimitive, computeSessionBoundaries } from "./session-breaks";
import { SessionBackgroundsPrimitive, computeSessionRuns } from "./session-backgrounds";
import { EventMarkersPrimitive } from "./event-markers";
import { NEWS_LOLLIPOP_ID, NEWS_MAX_AGE_MS, NEWS_UPDATE_MS, NewsLollipopPrimitive, formatAgo, formatNewsDate } from "./news-lollipop";
import { getLatestNews, type NewsItem } from "../../data/datafeed-rest";
import { saveIndicatorDefault } from "../../data/indicator-defaults";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CountdownPrimitive, countdownText } from "./countdown";
import { ChartControlBar } from "./ChartControlBar";
import {
  DEFAULT_BAR_SPACING,
  GOTO_MS,
  ZOOM_FACTOR,
  ZOOM_MS,
  barAnchor,
  canShow,
  easeInOutQuint,
  easeOutCubic,
  groupsWidth,
  liveBarSpacing,
  moveEndAfterStop,
  movePixels,
  pointerNearBox,
  type GroupId,
} from "./control-bar";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { hasClipboardDrawing, pasteAsNew } from "../drawings/clipboard";
import { appearanceFrom, type Draft, type NavButtonsBehavior, type PriceSource } from "../header/chart-settings";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import { priceOf } from "./series-transforms";
import { clearActiveChartProbe, setActiveChartProbe } from "./active-chart";
import type { PaneIndicatorSettings } from "../shell/tabs";
import {
  aggregateCandles,
  aggregateUnitFor,
  getBars,
  getBarsBefore,
  getEvents,
  getSecondBarsTail,
  getTickerInfo,
  initialViewBars,
  intervalLabel,
  isIntradayInterval,
  isIntradayResolution,
  isSecondResolution,
  setLiveSymbol,
  splitSymbol,
  subscribeBars,
  type BarsResult,
  type LiveBar,
  type SessionId,
} from "../../data/datafeed";
import { commands, type Candle } from "../../bindings";
import {
  CHART_TYPE_ICON,
  createSeriesForType,
  heikinAshiLast,
  isTransformType,
  legendShowsSingleValue,
  setDataForType,
  type AnySeries,
  type ChartTypeId,
  type OHLC,
} from "./chart-types";
import { ChartLegend, type LegendValues } from "./ChartLegend";
import { layoutSync } from "./layout-sync";
import { dayKeyer, utcToWall, wallTimeToUtc, type WallDate, type WallTime } from "./day-key";
import type { GotoQuery } from "./goto-query";
import { quoteFor } from "../../data/quotes";
import { usMarketSession } from "../../data/market-session";
import { activeLink, crossWindowCrosshairOn, postLinkRange, postLinkTime } from "../../data/tab-link-bus";
import { IndicatorLegend } from "./IndicatorLegend";
import { IndicatorSettingsDialog, type DialogTab, type StrategyDialogConfig } from "./IndicatorSettingsDialog";
import { DEFAULT_SYMBOL, type StrategyProperties } from "../../backtester/types";
import { PriceScaleWatch } from "./scale-watch";
import { IndicatorController, type IndicatorLegendRow } from "./indicators/indicator-controller";
import { getIndicatorEntry } from "./indicators/registry";
import { OAKSCRIPT_UPDATED_EVENT, userIndicatorId, type OakScriptUpdatedDetail } from "./indicators/user-scripts";
import { scriptChartContext } from "./indicators/script-chart";
import { PROPERTIES_INPUT, STRATEGY_UPDATED_EVENT, isStrategyId, strategyDefaults, strategyKeyOf, strategyStyleOf, type StrategyUpdatedDetail } from "./indicators/strategy-entries";
import { strategyTester } from "../../data/strategy-tester-store";
import { registerChartState, unregisterChartState } from "../../data/chart-state-registry";
import { alertStore } from "../../data/alert-store";
import { describeCondition, isPercentOperator } from "../../data/alert-condition";
import { publishDataWindow, type DataWindowState } from "../../data/data-window-store";
import { ChartContextMenu, CtxIcons, type CtxNode } from "./ChartContextMenu";
import { WheelHelper } from "./wheel-helper";
import { TIMEZONES } from "../../data/timezones";
import { watchlistStore } from "../../data/watchlist-store";
import { isFavoriteIndicator, toggleFavoriteIndicator } from "../../data/indicator-favorites";
import type { Bar } from "oakscriptjs";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import { makeCoords, type Coords } from "../drawings/coords";
import { studyPaneCoords, type DrawingPane } from "../drawings/pane-coords";
import { DrawingsOverlay } from "../drawings/DrawingsOverlay";
import { cursorForMode } from "../drawings/cursors";
import type { CursorMode } from "../../data/drawing-toolbar";

type Props = {
  theme?: "dark" | "light";
  symbol?: string;
  /** Interval id ("1", "5", "60", "1D", "1W", "1M", ...). Drives which
   *  Rust command (minute_aggs vs day_aggs) the chart fetches from. */
  interval?: string;
  /** Bottom-bar session (RTH/ETH). Drives datafeed session filtering on
   *  intraday frames (09:30–16:00 ET for RTH); ignored on daily+. */
  session?: SessionId;
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
  /** Legend symbol title clicked ("Change symbol"). */
  onChangeSymbol?: () => void;
  /** Legend interval clicked ("Change interval"). */
  onChangeInterval?: () => void;
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
  updateDrawing?: (d: Drawing) => void;
  /** Bulk replace (group drag/nudge) — one undo entry. */
  updateDrawings?: (list: Drawing[]) => void;
  cloneDrawing?: (id: string) => void;
  reorderDrawing?: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  removeDrawing?: (id: string) => void;
  /** Bulk delete (multi-select Delete) — one undo entry. */
  removeDrawings?: (ids: string[]) => void;
  /** Ordered registry ids of indicators active on this chart. */
  indicators?: string[];
  /** Compared symbols (header "Compare symbols") overlaid as line series on a
   *  shared, auto-scaled overlay price scale. */
  compare?: string[];
  /** When true, suppress all study layers without removing them from the active
   *  set (Hide-all dropdown's "Hide indicators"); restored when toggled off. */
  indicatorsHidden?: boolean;
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
   *  out-of-bounds falls back to the default framing. */
  visibleLogicalRange?: { from: number; to: number };
  /** Report this pane's visible logical range after the user scrolls/zooms, so
   *  the anchor persists across tab switches + reloads. Debounced by the caller's
   *  store write; ChartView emits the settled range. */
  onVisibleRange?: (range: { from: number; to: number }) => void;
};

/** Scroll-back: when the visible range's left edge comes within this many bars
 *  of index 0, page one older window in and prepend it (mirrors the mock). */
const LOAD_MORE_THRESHOLD = 12;
/** Fewest bars a restored saved view may show. A narrower range is the 1-bar
 *  collapse the old sync path could persist, not a user choice. Same floor as
 *  the wheel zoom (onWheel). */
const MIN_VISIBLE_BARS = 5;
/** Fewest bars a date-range sync target frames (the time scale's minimum
 *  visible bar count). */
const SYNC_MIN_BARS = 2;
/** Depth cap for history loaded on behalf of date-range / time sync (display
 *  bars); the user's own scroll-back pager is not capped. Measured 29/09/2026
 *  (.tmp/goto-sync): a 1m pane at ~94k bars blocks the main thread up to
 *  ~190 ms per load, at 250k bars up to 853 ms. 100k = about one year of 1m
 *  regular-session bars (20k reached only ~50 sessions back). */
const SYNC_LOAD_MAX_BARS = 100_000;
/** Pause after the last landed history page before studies recompute. */
const INDICATOR_RENDER_DEBOUNCE_MS = 150;

/** Time-axis formatting from the Settings dialog (Scales tab). */
type AxisFmt = { dateFormat?: string; timeFormat?: string; dayOfWeek?: boolean };

/** Crosshair time-axis label, in the chosen IANA timezone: the chart
 *  date-time text ("Wed 23 Sep '26   14:00"; date only on daily+ bars). */
function formatAxisTime(time: UTCTimestamp, timeZone: string, intraday: boolean, seconds: boolean, fmt: AxisFmt = {}): string {
  return formatChartTime(time as number, timeZone, intraday, seconds, fmt);
}

/** Time-axis tick label in the chosen IANA timezone (tick-mark text). */
function formatTick(time: UTCTimestamp, type: TickMarkType, timeZone: string, fmt: AxisFmt = {}): string {
  const kind =
    type === TickMarkType.Year ? "Year"
    : type === TickMarkType.Month ? "Month"
    : type === TickMarkType.DayOfMonth ? "DayOfMonth"
    : type === TickMarkType.TimeWithSeconds ? "TimeWithSeconds"
    : "Time";
  return formatTickMark(time as number, kind, timeZone, fmt.timeFormat);
}

// Binary-search the (time-ascending) bar array for an exact timestamp match,
// returning its index or -1. Maps a crosshair time back to its bar.
function indexOfTime(bars: OHLC[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid].time as number;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Non-series chart options derived from this pane's committed appearance tokens
 *  (Canvas tab: background, grid, crosshair, scale text/lines, price margins).
 *  Shared by createChart and the theme/appearance effect so both stay in lockstep.
 *  `rightOffset` is applied only off the initial mount (it nudges the view
 *  framing, so we don't force it at create time). */
/** Map a Symbol → Precision selection to a lightweight-charts price format.
 *  Returns null for "Default" (keep the library default) and for the fractional
 *  formats (1/2, 1/4, …), which 'price' can't express — those stay a GAP. */
function parsePriceFormat(s: string): { precision: number; minMove: number } | null {
  if (!s || s === "Default") return null;
  if (s === "Integer") return { precision: 0, minMove: 1 };
  const m = /^(\d+)\s+decimal/.exec(s);
  if (m) { const n = +m[1]; return { precision: n, minMove: 1 / 10 ** n }; }
  return null;
}

/** Colour at fraction `t` (0..1) between two hex / rgb(a) colours. */
function mixColor(a: string, b: string, t: number): string {
  const parse = (c: string): number[] => {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c.trim());
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    const h = /^#([0-9a-f]{6})/i.exec(c.trim());
    return h ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)] : [0, 0, 0];
  };
  const x = parse(a);
  const y = parse(b);
  const v = x.map((n, i) => Math.round(n + (y[i] - n) * t));
  return `rgb(${v[0]}, ${v[1]}, ${v[2]})`;
}

/** Text colour from background: brightness .199R + .687G + .114B below 150
 *  gets white text, otherwise black. */
function textColorOn(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  const h = /^#([0-9a-f]{6})/i.exec(color.trim());
  const [r, g, b] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : h
      ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)]
      : [0, 0, 0];
  return 0.199 * r + 0.687 * g + 0.114 * b < 150 ? "#ffffff" : "#000000";
}

function appearanceOptions(t: ReturnType<typeof readChartTokens>) {
  // Picker enum (0 solid / 1 dashed / 2 dotted) → lightweight-charts LineStyle
  // (Solid 0, Dotted 1, Dashed 2).
  const cross = [LineStyle.Solid, LineStyle.Dashed, LineStyle.Dotted][t.crosshairStyle] ?? LineStyle.Dashed;
  const crossWidth = Math.max(1, Math.min(4, t.crosshairWidth)) as 1 | 2 | 3 | 4;
  const background = t.bgGradient
    ? { type: ColorType.VerticalGradient as const, topColor: t.bg, bottomColor: t.bgBottom }
    : { type: ColorType.Solid as const, color: t.bg };
  // Scales placement: show only the chosen side. A series with no explicit
  // priceScaleId binds to the visible scale ('right' if visible, else 'left'),
  // so toggling visibility before (re)building the series moves the price axis.
  const onLeft = t.scalesPlacement === "left";
  // Scales → "No overlapping labels" = the library's alignLabels (the
  // restacking of colliding labels).
  const scaleOpts = {
    borderColor: t.scaleLinesColor,
    scaleMargins: { top: t.marginTop, bottom: t.marginBottom },
    alignLabels: t.alignLabels,
  };
  return {
    layout: {
      background,
      textColor: t.scaleTextColor,
      fontSize: t.scaleFontSize,
      // No logo on the chart: the library's attribution notice and link are
      // in the README ("Third-party notices"), as its licence allows.
      attributionLogo: false,
      // The library defaults are light-theme (#E0E3EB separator) — theme the
      // stacked-pane divider like the rest of the chrome.
      panes: {
        separatorColor: t.paneSeparator,
        separatorHoverColor: "rgba(178, 181, 189, 0.2)",
        enableResize: true,
      },
    },
    grid: {
      // Grid "dotted" maps to SparseDotted (1px on / 4 off): the target dotted
      // grid is 1 on / 3 off, and the library's Dotted (1 on / 1 off) reads
      // twice as heavy.
      vertLines: {
        color: t.gridVertColor,
        visible: t.gridVertVisible,
        style: [LineStyle.Solid, LineStyle.Dashed, LineStyle.SparseDotted][t.gridVertStyle] ?? LineStyle.Solid,
      },
      horzLines: {
        color: t.gridHorzColor,
        visible: t.gridHorzVisible,
        style: [LineStyle.Solid, LineStyle.Dashed, LineStyle.SparseDotted][t.gridHorzStyle] ?? LineStyle.Solid,
      },
    },
    crosshair: {
      vertLine: { color: t.crosshairColor, style: cross, width: crossWidth, labelBackgroundColor: t.crosshairLabelBg },
      horzLine: { color: t.crosshairColor, style: cross, width: crossWidth, labelBackgroundColor: t.crosshairLabelBg },
    },
    rightPriceScale: { ...scaleOpts, visible: !onLeft },
    leftPriceScale: { ...scaleOpts, visible: onLeft },
    timeScale: { borderColor: t.scaleLinesColor },
  };
}

// Resolve the legend's values for the bar at `idx`. Change is close minus the
// previous bar's close; colours follow the bar's direction for O/H/L/C and the
// change sign for the single-line value. (Reference: mock buildLegend.)
function buildLegend(bars: OHLC[], idx: number, type: ChartTypeId, prevDayClose: number | null, src: PriceSource = "close"): LegendValues {
  const bar = bars[idx];
  const single = legendShowsSingleValue(type);
  // Single-value types show their price source (Symbol tab "Price source").
  const value = (b: OHLC) => (single ? priceOf(b, src) : b.close);
  const prevClose = idx > 0 ? value(bars[idx - 1]) : null;
  const changeAbs = prevClose == null ? 0 : value(bar) - prevClose;
  const changePct = prevClose ? (changeAbs / prevClose) * 100 : 0;
  const ldAbs = prevDayClose == null ? 0 : bar.close - prevDayClose;
  const ldPct = prevDayClose ? (ldAbs / prevDayClose) * 100 : 0;
  return {
    single,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: value(bar),
    changeAbs,
    changePct,
    barDir: bar.close >= bar.open ? "up" : "down",
    changeDir: changeAbs >= 0 ? "up" : "down",
    volume: bar.volume,
    lastDayChangeAbs: ldAbs,
    lastDayChangePct: ldPct,
    lastDayChangeDir: ldAbs >= 0 ? "up" : "down",
  };
}

// Context for the right-click menu's dynamic pieces (price/symbol/counts).
type ChartMenuCtx = {
  symbol: string;
  price: string;
  drawingCount: number;
  indicatorCount: number;
  cursorLockByTime: boolean;
  /** FALSE grays "Paste" (nothing on the drawings clipboard). */
  canPaste: boolean;
};
type ChartMenuActions = {
  resetView: () => void;
  copyPrice: () => void;
  paste: () => void;
  addAlert: () => void;
  buy: () => void;
  sell: () => void;
  addOrder: () => void;
  toggleCursorLock: () => void;
  tableView: () => void;
  objectTree: () => void;
  saveTemplateAs: () => void;
  removeDrawings: () => void;
  removeIndicators: () => void;
  settings: () => void;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Build the chart context-menu node list: static order/separators/
 *  shortcuts/icons; the price/symbol/counts are interpolated from the live
 *  chart. */
function buildChartContextMenu(ctx: ChartMenuCtx, a: ChartMenuActions): CtxNode[] {
  const sym = ctx.symbol;
  const p = ctx.price;
  const nodes: CtxNode[] = [
    { kind: "item", id: "reset", label: "Reset chart view", shortcut: "Alt + R", icon: CtxIcons.reset, onSelect: a.resetView },
    { kind: "separator" },
    { kind: "item", id: "copy-price", label: `Copy price ${p}`, onSelect: a.copyPrice },
    { kind: "item", id: "paste", label: "Paste", shortcut: "Ctrl + V", disabled: !ctx.canPaste, onSelect: a.paste },
    { kind: "separator" },
    { kind: "item", id: "alert", label: `Add alert on ${sym} at ${p}…`, shortcut: "Alt + A", icon: CtxIcons.alert, onSelect: a.addAlert },
    { kind: "item", id: "buy", label: `Buy 1 ${sym} @ ${p} limit`, shortcut: "Alt + Shift + B", icon: CtxIcons.buy, onSelect: a.buy },
    { kind: "item", id: "sell", label: `Sell 1 ${sym} @ ${p} stop`, icon: CtxIcons.sell, onSelect: a.sell },
    { kind: "item", id: "order", label: `Add order on ${sym} at ${p}…`, shortcut: "Shift + T", icon: CtxIcons.order, onSelect: a.addOrder },
    { kind: "separator" },
    { kind: "item", id: "lock-cursor", label: "Lock vertical cursor line by time", checked: ctx.cursorLockByTime, onSelect: a.toggleCursorLock },
    { kind: "separator" },
    { kind: "item", id: "table-view", label: "Table view", onSelect: a.tableView },
    { kind: "item", id: "object-tree", label: "Object tree", onSelect: a.objectTree },
    {
      kind: "item", id: "chart-template", label: "Chart template",
      submenu: [{ kind: "item", id: "template-save-as", label: "Save as…", onSelect: a.saveTemplateAs }],
    },
  ];
  const removeRows: CtxNode[] = [];
  if (ctx.drawingCount > 0) removeRows.push({ kind: "item", id: "remove-drawings", label: `Remove ${plural(ctx.drawingCount, "drawing")}`, onSelect: a.removeDrawings });
  if (ctx.indicatorCount > 0) removeRows.push({ kind: "item", id: "remove-indicators", label: `Remove ${plural(ctx.indicatorCount, "indicator")}`, onSelect: a.removeIndicators });
  if (removeRows.length) nodes.push({ kind: "separator" }, ...removeRows);
  nodes.push(
    { kind: "separator" },
    { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings, onSelect: a.settings },
  );
  return nodes;
}

/** Pane-control icons (15 px) and their menu icons (28 px). */
const PANE_ICONS = {
  close: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 15 15\" width=\"15\" height=\"15\"><path fill=\"currentColor\" d=\"M6.5 2a.5.5 0 0 0-.5.5V3h3v-.5a.5.5 0 0 0-.5-.5h-2ZM10 3h3v1h-1.05l-.86 8.65A1.5 1.5 0 0 1 9.59 14H5.4a1.5 1.5 0 0 1-1.49-1.35L3.05 4H2V3h3v-.5C5 1.67 5.67 1 6.5 1h2c.83 0 1.5.67 1.5 1.5V3ZM4.05 4l.86 8.55a.5.5 0 0 0 .5.45H9.6a.5.5 0 0 0 .5-.45L10.94 4h-6.9Z\"/></svg>",
  up: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 15 15\" width=\"15\" height=\"15\"><path fill=\"currentColor\" d=\"M11.83 6.12l-.66.76L8 4.1V12H7V4.1L3.83 6.88l-.66-.76L7.5 2.34l4.33 3.78z\"/></svg>",
  down: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 15 15\" width=\"15\" height=\"15\"><path fill=\"currentColor\" d=\"M11.83 8.88l-.66-.76L8 10.9V3H7v7.9L3.83 8.12l-.66.76 4.33 3.78 4.33-3.78z\"/></svg>",
  more: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 15 15\" width=\"15\" height=\"15\"><circle fill=\"currentColor\" cx=\"12.75\" cy=\"7.5\" r=\"1.25\"/><circle fill=\"currentColor\" cx=\"7.5\" cy=\"7.5\" r=\"1.25\"/><circle fill=\"currentColor\" cx=\"2.25\" cy=\"7.5\" r=\"1.25\"/></svg>",
  collapse: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 15 15\" width=\"15\" height=\"15\" fill=\"none\"><path stroke=\"currentColor\" d=\"M11 2 7.5 5 4 2\" class=\"bracket-up\"/><path stroke=\"currentColor\" d=\"M4 13l3.5-3 3.5 3\" class=\"bracket-down\"/></svg>",
  restore: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 15 15\" width=\"15\" height=\"15\" fill=\"none\"><path stroke=\"currentColor\" d=\"m4 5 3.5-3L11 5\" class=\"bracket-up\"/><path stroke=\"currentColor\" d=\"M11 10l-3.5 3L4 10\" class=\"bracket-down\"/></svg>",
};
const PANE_MENU_ICONS = {
  del: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 28 28\" width=\"28\" height=\"28\"><path fill=\"currentColor\" d=\"M18 7h5v1h-2.01l-1.33 14.64a1.5 1.5 0 0 1-1.5 1.36H9.84a1.5 1.5 0 0 1-1.49-1.36L7.01 8H5V7h5V6c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v1Zm-6-2a1 1 0 0 0-1 1v1h6V6a1 1 0 0 0-1-1h-4ZM8.02 8l1.32 14.54a.5.5 0 0 0 .5.46h8.33a.5.5 0 0 0 .5-.46L19.99 8H8.02Z\"/></svg>",
  up: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 28 28\" width=\"28\" height=\"28\"><path fill=\"currentColor\" d=\"M13.5 6.35l6.32 5.27-.64.76L14 8.07V21h-1V8.07l-5.18 4.31-.64-.76 6.32-5.27z\"/></svg>",
  down: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 28 28\" width=\"28\" height=\"28\"><path fill=\"currentColor\" d=\"M14 7v12.93l5.18-4.31.64.76-6.32 5.27-6.32-5.27.64-.76L13 19.93V7h1z\"/></svg>",
  collapse: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 28 28\" width=\"28\" height=\"28\" fill=\"none\"><path stroke=\"currentColor\" d=\"M20.53 3.73 14 9.33 7.47 3.73M7.47 24.27l6.53 -5.60 6.53 5.60\"/></svg>",
  restore: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 28 28\" width=\"28\" height=\"28\" fill=\"none\"><path stroke=\"currentColor\" d=\"m7.47 9.33 6.53 -5.60L20.53 9.33M20.53 18.67l-6.53 5.60L7.47 18.67\"/></svg>",
};

/** Per-instance id so a pane ignores its own sync-bus broadcasts. */
let paneSyncSeq = 0;

export function ChartView(props: Props) {
  // This pane's committed appearance (Settings dialog draft → folded subset).
  // Compared BY VALUE: focusing a pane in a multi-chart layout replaces the
  // tabs() signal, handing this memo a new settings object with identical
  // content. A reference-only memo would then notify on every focus and re-run
  // the theme effect below, which re-applies `rightOffset` — snapping the view
  // back to the latest bar (the "click jumps the synced chart to today" bug).
  // The structural equals makes the memo notify only on a genuine settings
  // change. AppearanceOverride is flat primitives, so JSON compare is sound.
  const appearance = createMemo(() => appearanceFrom(props.settings), undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  // Current tokens WITHOUT subscribing to `appearance()` — so the imperative
  // helpers (createChart, rebuildSeries, the data-apply effect) read the live
  // value but only the dedicated theme/appearance effect below re-runs when the
  // pane's settings change (otherwise a commit would re-frame the chart).
  const currentTokens = () => readChartTokens(untrack(appearance));
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
  /** Work to redo when the tab is shown again (footprint cells, news). */
  const onShownHooks = new Set<() => void>();
  /** Live bars merged while hidden and not drawn yet. */
  let liveDirty = false;
  let liveAppendedWhileHidden = false;
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
  // Suppress flags: set while APPLYING an inbound sync so the resulting
  // crosshair / range event isn't re-broadcast (which would echo-loop).
  let suppressCrosshairBroadcast = false;
  let suppressRangeBroadcast = false;
  // "Date range" sync rules: ONLY the active pane drives, it broadcasts only
  // when a whole bar enters/leaves the view, and followers apply the LATEST
  // target in a later task, loading any missing history to the target in one
  // request first.
  // Whole-bar key (first/last visible bar times) of the last broadcast.
  let lastRangeKey = "";
  // Latest inbound target; a newer one replaces it before it is applied.
  let syncTarget: { from: number; to: number } | null = null;
  let syncTimer: number | undefined;
  // True while the sync loader awaits its history request.
  let syncLoading = false;
  // Guard while an inbound range lands. The library applies setVisibleRange on
  // its NEXT paint and fires the range-change callback there, so the guard is
  // held for two frames: no broadcast, no persist, no scroll-back pager for a
  // view the pane did not choose itself.
  let syncGuard = false;
  let syncGuardSeq = 0;
  const holdSyncGuard = () => {
    syncGuard = true;
    const my = ++syncGuardSeq;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (my === syncGuardSeq) syncGuard = false;
    }));
  };
  // Held for two frames after new data framed the view (load, tab switch,
  // interval switch): that view is not a user change, so it is not sent to
  // linked tabs (only the active chart's range changes are sent, and a tab
  // switch reloads nothing).
  let linkQuiet = false;
  let linkQuietSeq = 0;
  const holdLinkQuiet = () => {
    linkQuiet = true;
    const my = ++linkQuietSeq;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (my === linkQuietSeq) linkQuiet = false;
    }));
  };
  // A linked time that arrived while this pane was loading its bars.
  let pendingLinkTime: number | null = null;
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
  // "High and low" price lines (Scales tab) over the LOADED data's extremes.
  // Series-owned, so a series rebuild drops them; refs + the memo key reset there.
  let highLine: IPriceLine | null = null;
  let lowLine: IPriceLine | null = null;
  let highLowKey = "";
  // "Previous day close" price line (Scales tab) at the last bar's previous
  // trading-day close. Same series-owned lifecycle as high/low above.
  let prevClosePriceLine: IPriceLine | null = null;
  let prevCloseKey = "";
  // "Pre/post/night market" price line + label (Scales tab). Same
  // series-owned lifecycle.
  let prePostLine: IPriceLine | null = null;
  let prePostKey = "";
  let raw: OHLC[] = [];
  // Lets markers fall back to gap-aware positioning when a date isn't on a bar.
  eventMarkers.setBarsAccessor(() => raw);
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
  /** Scroll-back paging guards — block overlapping fetches and latch once the
   *  backend reports no older bars. Reset on symbol/interval change. */
  let loadingMore = false;
  let historyExhausted = false;
  /** Read-ahead buffer: the window older than the current oldest bar, fetched in
   *  the background after each load (and once after the initial load) so the
   *  next scroll-back prepends instantly instead of waiting on the network.
   *  Keyed by the fetch generation + the `beforeSec` it pages before, so a stale
   *  buffer is never consumed; holds the in-flight/resolved promise so the
   *  consumer awaits the same way whether it has landed yet or not. */
  let prefetch: { gen: number; beforeSec: number; rows: Promise<Candle[] | null> } | null = null;
  /** Monotonic fetch generation, bumped on every symbol/interval change. A page
   *  captures it at launch and bails in its `.then` if it moved — so a page
   *  started for an earlier series can never prepend/re-range a later one (an
   *  A→B→A switch re-matches the symbol, which is why an equality check wasn't
   *  enough and the chart could park on year-old bars). */
  let fetchGen = 0;
  let activeType: ChartTypeId = props.chartType ?? "candle";
  // Type the current `series` was built with (rebuildSeries compares it with
  // the new type to choose how the view carries over).
  let builtType: ChartTypeId | null = null;
  // 1-minute sub-bars feeding the volume-footprint cells (fetched on demand
  // when that type is active on an intraday frame; null otherwise).
  let subMinute: OHLC[] | null = null;
  /** 1W/1M live-volume baseline: the forming bar's cumulative volume BEFORE the
   *  current trading day's ticks (the tick's day volume is added on top). Reset
   *  when the tick's day advances, the bar rolls over, or the series reloads. */
  let liveVolBase: { barTime: number; dayTime: number; base: number } | null = null;
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
    if (props.active) setActiveChartProbe(probeOwner, { scaleRatio: () => liveScaleRatio() });
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
  /** Locked ratio, other direction: a price-scale change (axis drag, pane
   *  resize) sets the bar spacing that keeps the ratio
   *  (spacing = height ÷ range × ratio). */
  function lockedSpacingFromScale() {
    const t = currentTokens();
    if (!t.lockRatio || !chart || !series || lockApplying) return;
    const ratio = t.lockRatioValue;
    const r = series.priceScale().getVisibleRange();
    const h = chart.paneSize(0).height;
    if (!(ratio !== undefined && ratio > 0) || !r || !(h > 0)) return;
    const len = Math.abs(r.to - r.from);
    if (!(len > 0)) return;
    const want = (h / len) * ratio;
    const cur = liveScaleRatio();
    if (cur !== undefined && Math.abs(cur - ratio) <= ratio * 1e-6) return;
    lockApplying = true;
    try { chart.timeScale().applyOptions({ barSpacing: want }); } finally { lockApplying = false; }
  }
  /** Top-left data-window legend (O/H/L/C + change). Null while loading. */
  const [legend, setLegend] = createSignal<LegendValues | null>(null);
  /** TRUE while the crosshair is over a bar, so the live-tick path knows not to
   *  yank the legend back to the latest bar out from under the user's cursor. */
  let crosshairActive = false;
  /** Last crosshair time, so indicator-set/bars changes re-resolve at the same
   *  bar the user is hovering. */
  let lastLegendTime: number | undefined;
  /** Owns the active indicators on this chart; created in onMount. */
  let controller: IndicatorController | null = null;
  /** Bumped once the chart + controller exist so the indicator effects run. */
  const [chartReady, setChartReady] = createSignal(0);
  /** Studies legend rows (one per active indicator). */
  const [indLegend, setIndLegend] = createSignal<IndicatorLegendRow[]>([]);
  /** Registry id of the study whose Settings dialog is open (null = closed). */
  const [settingsForId, setSettingsForId] = createSignal<string | null>(null);
  /** Tab the next Settings dialog opens on (report toolbar gear = Properties). */
  const [settingsTab, setSettingsTab] = createSignal<DialogTab | undefined>(undefined);

  function refreshIndicatorLegend(time?: number) {
    setIndLegend(controller?.getLegend(time) ?? []);
  }
  /** Top of the legend stack inside its pane (`.ot-legend-stack` top). */
  const LEGEND_TOP = 4;
  /** Studies legend of one pane (0 = the price pane, under the series row). */
  const studyLegend = (pane: number) => (
    <IndicatorLegend
      rows={indLegend().filter((r) => r.pane === pane)}
      showTitles={appearance().legendIndTitles}
      showInputs={appearance().legendIndInputs}
      showValues={appearance().legendIndValues}
      bgColor={appearance().bg}
      bgOpacity={appearance().legendIndBgOpacity}
      onToggleHide={(id) => {
        controller?.toggleHidden(id);
        refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
        if (isStrategyId(id)) applyStrategyMarkers();
      }}
      onSettings={(id) => setSettingsForId(id)}
      onRemove={(id) => props.onRemoveIndicator?.(id)}
      onMore={openIndicatorMoreMenu}
    />
  );

  // Expose this chart's latest price + indicator values to the alert engine,
  // keyed by bare ticker. Re-keys on symbol change; provider reads the mutable
  // `raw`/`controller` lazily so values are always current. (chart-state-registry.ts)
  createEffect(() => {
    const key = splitSymbol(props.symbol ?? "").ticker.toUpperCase();
    if (!key) return;
    registerChartState(key, {
      lastPrice: () => (raw.length ? raw[raw.length - 1].close : null),
      lastBarTime: () => {
        const t = raw.length ? raw[raw.length - 1].time : null;
        return typeof t === "number" ? t * 1000 : null;
      },
      indicatorLegend: () => controller?.getLegend() ?? [],
    });
    onCleanup(() => unregisterChartState(key));
  });

  // When this pane becomes the focused one, claim the right-rail data window
  // (its latest bar, unless the crosshair is currently hovering it).
  createEffect(() => {
    if (props.active) refreshLegend(crosshairActive ? lastLegendTime : undefined);
  });

  // Right-click context menu: open position + resolved node list (null = closed).
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; nodes: CtxNode[] } | null>(null);
  // Backs the "Lock vertical cursor line by time" toggle (visual state only).
  const [cursorLock, setCursorLock] = createSignal(false);
  // Backs the price-scale menu's "Scale price chart only" toggle — visual
  // state only (no lightweight-charts backing; accepted no-op like the
  // trading rows of the pane menu).
  const [scaleSeriesOnly, setScaleSeriesOnly] = createSignal(false);

  // Control bars (see control-bar.ts + the onMount block). `gotoShown` is the
  // back button's visibility, `barShown` the control bar's; the boxes
  // are the wrappers' pane-relative anchors, recomputed as panes/scales move.
  const [gotoShown, setGotoShown] = createSignal(false);
  const [gotoBox, setGotoBox] = createSignal({ bottom: 32, right: 16 });
  const [barShown, setBarShown] = createSignal(false);
  const [barLeft, setBarLeft] = createSignal(0);
  const [barFits, setBarFits] = createSignal<Set<GroupId>>(new Set());
  const [resetAvailable, setResetAvailable] = createSignal(false);
  /** Set by onMount so the actions below can re-resolve bar visibility. */
  let refreshBarsRef: (() => void) | undefined;

  /** Right-edge-anchored zoom, in bar-spacing terms: holds `rightOffset` and
   *  scales the span, so `span` is the reciprocal of the bar-spacing factor. */
  let zoomAnim: number | null = null;
  const zoomSpan = (factor: number) => {
    if (!chart) return;
    const ts = chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const span0 = r.to - r.from;
    if (span0 <= 0) return;
    if (zoomAnim !== null) cancelAnimationFrame(zoomAnim);
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / ZOOM_MS);
      // Progress is linear in log(barSpacing) — the pinch compounds, so the
      // eased fraction is an exponent, not a lerp.
      const span = span0 * Math.pow(factor, easeOutCubic(k));
      const cur = chart?.timeScale().getVisibleLogicalRange();
      if (cur) chart!.timeScale().setVisibleLogicalRange({ from: cur.to - Math.max(5, span), to: cur.to });
      zoomAnim = k < 1 ? requestAnimationFrame(step) : null;
    };
    zoomAnim = requestAnimationFrame(step);
  };

  /** Animate the view back to the last bar: 1s of easeInOutQuint onto the
   *  configured right margin. Falls back to 10 bars when that margin is
   *  negative. */
  let gotoAnim: number | null = null;
  const scrollToRealtime = () => {
    if (!chart) return;
    const ts = chart.timeScale();
    let target = currentTokens().rightOffset;
    if (target < 0) target = 10;
    const from = ts.scrollPosition();
    if (gotoAnim !== null) cancelAnimationFrame(gotoAnim);
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / GOTO_MS);
      ts.scrollToPosition(from + (target - from) * easeInOutQuint(k), false);
      gotoAnim = k < 1 ? requestAnimationFrame(step) : null;
    };
    gotoAnim = requestAnimationFrame(step);
  };

  // ── Held scrolling ─────────────────────────────────────────────────────────
  // Both scroll gestures run through one move implementation with a single
  // animation slot, so starting either replaces the other and one `stopMove`
  // ends whichever is live — via that run's OWN stop rule (immediate for
  // moveByBar, a deceleration ramp for move). Same shape here.
  //
  // `position(elapsed, remaining)` returns signed BARS from the start offset;
  // `remaining` is Infinity until stopped, which is what lets `move` coast.
  let scrollAnim: number | null = null;
  let scrollStarted = 0;
  let scrollEnd = Infinity;
  let scrollStopAfter: (elapsed: number) => number = () => 0;

  const runScroll = (
    position: (elapsed: number, remaining: number) => number,
    stopAfter: (elapsed: number) => number,
    snapToBar: boolean,
  ) => {
    if (!chart) return;
    const ts = chart.timeScale();
    if (scrollAnim !== null) cancelAnimationFrame(scrollAnim);
    const from = snapToBar ? Math.round(ts.scrollPosition()) : ts.scrollPosition();
    scrollStarted = performance.now();
    scrollEnd = Infinity;
    scrollStopAfter = stopAfter;
    const step = (now: number) => {
      const at = Math.min(scrollEnd, now);
      ts.scrollToPosition(from + position(at - scrollStarted, scrollEnd - at), false);
      if (now >= scrollEnd) {
        scrollAnim = null;
        refreshBarsRef?.();
        return;
      }
      scrollAnim = requestAnimationFrame(step);
    };
    scrollAnim = requestAnimationFrame(step);
  };

  /** Stop move: end the live run on its own terms. */
  const stopScroll = () => {
    if (scrollAnim === null) return;
    scrollEnd = performance.now() + scrollStopAfter(performance.now() - scrollStarted);
  };

  /** Move by bar — plain ←/→ and the control bar's scroll buttons. Holds at
   *  one bar for the first 300ms, then adds another every 100ms. Stops dead on
   *  release. `dir` -1 walks into history ("Scroll to the left"). It snaps
   *  to a whole bar first when the last bar isn't flush with the edge. */
  const moveBars = (dir: -1 | 1) =>
    runScroll((elapsed) => dir * (Math.floor(Math.max(0, elapsed - 300) / 100) + 1), () => 0, true);

  /** Move — held Ctrl+←/→. Accelerates to a top speed and coasts; releasing
   *  ramps back to zero rather than cutting out. The move is measured in
   *  pixels, so bar spacing (fixed for the run) converts. */
  const startPan = (dir: -1 | 1) => {
    if (!chart) return;
    const bs = liveBarSpacing(chart);
    if (!bs) return;
    runScroll((elapsed, remaining) => dir * (movePixels(elapsed, remaining) / bs), moveEndAfterStop, false);
  };

  /** Scroll to first bar. History is paged in, so this jumps to the oldest bar
   *  loaded and lets maybeLoadOlder pull the next page — repeat presses keep
   *  walking back. Not animated. */
  const scrollToFirstBar = () => {
    if (!chart || raw.length === 0) return;
    const ts = chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    ts.setVisibleLogicalRange({ from: 0, to: r.to - r.from });
  };

  /** Reset scales (the Alt+R / context-menu / control-bar action):
   *  default bar spacing, default right margin, price scale back to auto.
   *
   *  Bar spacing and right offset are driven through the visible range, not
   *  `applyOptions`: the library only reacts to options that *changed*, and both
   *  already hold their default values (zooming moves internal state, not the
   *  option), so re-applying them would silently do nothing. Span and edge set
   *  the same two quantities and always land. */
  /** Reset time scale (Ctrl+Alt+Q): default bar spacing + right offset,
   *  price scale untouched. */
  const resetTimeScale = () => {
    if (!chart) return;
    if (zoomAnim !== null) cancelAnimationFrame(zoomAnim);
    if (gotoAnim !== null) cancelAnimationFrame(gotoAnim);
    if (scrollAnim !== null) {
      cancelAnimationFrame(scrollAnim);
      scrollAnim = null;
    }
    const t = currentTokens();
    const ts = chart.timeScale();
    const len = series?.data().length ?? 0;
    if (len > 0) {
      const span = ts.width() / DEFAULT_BAR_SPACING;
      const to = len - 1 + t.rightOffset;
      ts.setVisibleLogicalRange({ from: to - span, to });
    }
  };
  /** "Reset chart view" (Alt+R): time scale + price auto-scale. */
  const resetChartView = () => {
    if (!chart) return;
    resetTimeScale();
    chart.priceScale(currentTokens().scalesPlacement).applyOptions({ autoScale: true });
    refreshBarsRef?.();
  };

  /** Reset available: true when bar spacing, right offset OR price
   *  auto-scale is off default — that's exactly when the reset button shows. */
  const scalesOffDefault = () => {
    if (!chart) return false;
    if (timeScaleOffDefault()) return true;
    return !chart.priceScale(currentTokens().scalesPlacement).options().autoScale;
  };
  /** Time-scale reset available: bar spacing or right offset off default. */
  const timeScaleOffDefault = () => {
    if (!chart) return false;
    const bs = liveBarSpacing(chart);
    // Derived from width/span, so sub-pixel drift is expected; 0.05px of bar
    // spacing is far below anything a user could set deliberately.
    if (bs !== null && Math.abs(bs - DEFAULT_BAR_SPACING) > 0.05) return true;
    return Math.abs(chart.timeScale().scrollPosition() - currentTokens().rightOffset) > 0.01;
  };

  onCleanup(() => {
    if (gotoAnim !== null) cancelAnimationFrame(gotoAnim);
    if (zoomAnim !== null) cancelAnimationFrame(zoomAnim);
    if (scrollAnim !== null) cancelAnimationFrame(scrollAnim);
  });

  /** Right-click on the PRICE AXIS → the price-scale menu (Auto, Lock ratio,
   *  Scale price chart only, Invert, the four mode radios, Move scale,
   *  Labels/Lines submenus, Plus button, Session on intraday, More
   *  settings…). Rows we have no surface for (bid-ask
   *  labels+lines, no-overlapping-labels) are omitted;
   *  Lock ratio / Scale price chart only / Plus button are accepted no-ops
   *  like the trading items of the pane menu. */
  function openPriceScaleMenu(e: MouseEvent) {
    if (!chart) return;
    const t = currentTokens();
    const ps = chart.priceScale(t.scalesPlacement);
    const cur = ps.options();
    const setMode = (mode: PriceScaleMode) => () => ps.applyOptions({ mode });
    const patch = (p: Record<string, unknown>) =>
      window.dispatchEvent(new CustomEvent("chart-patch-scale-settings", { detail: { patch: p } }));
    // Ratio: bar spacing × price range ÷ pane height.
    const ratio = liveScaleRatio() ?? null;
    const nodes: CtxNode[] = [
      { kind: "item", id: "auto", label: "Auto (fits data to screen)", checked: cur.autoScale,
        onSelect: () => ps.applyOptions({ autoScale: !cur.autoScale }) },
      // Locking stores the current ratio in the Scales row (the lock keeps
      // the ratio in effect when it is turned on).
      { kind: "item", id: "lock-ratio", label: "Lock price to bar ratio", checked: t.lockRatio,
        shortcut: ratio != null ? String(Number(ratio.toFixed(7))) : undefined,
        onSelect: () => patch(t.lockRatio ? { lockRatio: false } : { lockRatio: true, lockRatioValue: ratio ?? undefined }) },
      { kind: "item", id: "series-only", label: "Scale price chart only",
        checked: scaleSeriesOnly(), onSelect: () => setScaleSeriesOnly((v) => !v) },
      { kind: "item", id: "invert", label: "Invert scale", shortcut: "Alt + I",
        checked: cur.invertScale, onSelect: () => ps.applyOptions({ invertScale: !cur.invertScale }) },
      { kind: "separator" },
      { kind: "item", id: "mode-regular", label: "Regular",
        checked: cur.mode === PriceScaleMode.Normal, onSelect: setMode(PriceScaleMode.Normal) },
      { kind: "item", id: "mode-percent", label: "Percent", shortcut: "Alt + P",
        checked: cur.mode === PriceScaleMode.Percentage, onSelect: setMode(PriceScaleMode.Percentage) },
      { kind: "item", id: "mode-indexed", label: "Indexed to 100",
        checked: cur.mode === PriceScaleMode.IndexedTo100, onSelect: setMode(PriceScaleMode.IndexedTo100) },
      { kind: "item", id: "mode-log", label: "Logarithmic", shortcut: "Alt + L",
        checked: cur.mode === PriceScaleMode.Logarithmic, onSelect: setMode(PriceScaleMode.Logarithmic) },
      { kind: "separator" },
      { kind: "item", id: "move-scale",
        label: t.scalesPlacement === "right" ? "Move scale to left" : "Move scale to right",
        onSelect: () => patch({ scalesPlacement: t.scalesPlacement === "right" ? "left" : "right" }) },
      { kind: "separator" },
      { kind: "item", id: "labels", label: "Labels", submenu: [
        { kind: "item", id: "lbl-symname", label: "Symbol name label",
          checked: t.symbolNameLabel, onSelect: () => patch({ symbolNameLabel: !t.symbolNameLabel }) },
        { kind: "item", id: "lbl-symbol", label: "Symbol last price label",
          checked: t.symbolLastValue, onSelect: () => patch({ symbolLastValue: !t.symbolLastValue }) },
        { kind: "item", id: "lbl-prevclose", label: "Previous day close price label",
          checked: t.prevCloseLabel, onSelect: () => patch({ prevCloseLabel: !t.prevCloseLabel }) },
        { kind: "item", id: "lbl-prepost", label: "Pre/post market price label",
          checked: t.prePostLabel, onSelect: () => patch({ prePostLabel: !t.prePostLabel }) },
        { kind: "item", id: "lbl-hilo", label: "High and low price labels",
          checked: t.highLowLabels, onSelect: () => patch({ highLowLabels: !t.highLowLabels }) },
        { kind: "item", id: "lbl-ind", label: "Indicators and financials value labels",
          checked: t.indLastValue, onSelect: () => patch({ indLastValue: !t.indLastValue }) },
        { kind: "item", id: "lbl-countdown", label: "Countdown to bar close",
          checked: t.countdownVisible, onSelect: () => patch({ countdown: !t.countdownVisible }) },
      ] },
      { kind: "item", id: "lines", label: "Lines", submenu: [
        { kind: "item", id: "line-price", label: "Price line",
          checked: t.symbolPriceLine, onSelect: () => patch({ symbolPriceLine: !t.symbolPriceLine }) },
        { kind: "item", id: "line-prevclose", label: "Previous day close price line",
          checked: t.prevCloseLine, onSelect: () => patch({ prevCloseLine: !t.prevCloseLine }) },
        { kind: "item", id: "line-prepost", label: "Pre/post market price line",
          checked: t.prePostLine, onSelect: () => patch({ prePostLine: !t.prePostLine }) },
        { kind: "item", id: "line-hilo", label: "High and low price lines",
          checked: t.highLowLines, onSelect: () => patch({ highLowLines: !t.highLowLines }) },
      ] },
      { kind: "item", id: "plus-button", label: "Plus button", checked: t.plusButton,
        onSelect: () => patch({ plusButton: !t.plusButton }) },
    ];
    if (isIntradayInterval(props.interval ?? "1D")) {
      nodes.push({ kind: "separator" });
      nodes.push({ kind: "item", id: "session", label: "Session", submenu: [
        { kind: "item", id: "session-rth", label: "Regular", checked: (props.session ?? "RTH") === "RTH",
          onSelect: () => window.dispatchEvent(new CustomEvent("chart-set-session", { detail: { id: "RTH" } })) },
        { kind: "item", id: "session-eth", label: "Extended", checked: props.session === "ETH",
          onSelect: () => window.dispatchEvent(new CustomEvent("chart-set-session", { detail: { id: "ETH" } })) },
      ] });
    }
    nodes.push({ kind: "separator" });
    nodes.push(moreScaleSettingsNode());
    setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
  }

  /** Scale properties action (both axis menus): Settings on the Scales tab. */
  const moreScaleSettingsNode = (): CtxNode => ({
    kind: "item", id: "more-settings", label: "More settings…", icon: CtxIcons.settings,
    onSelect: () => window.dispatchEvent(new CustomEvent("chart-open-settings", { detail: { tab: "scales" } })),
  });

  /** Right-click on the TIME AXIS → the time-axis menu: "Reset time scale" +
   *  separator only when the time scale is off default, "Time zone"
   *  submenu (the bottom-bar list), "Session breaks" (checkable, disabled on
   *  D/W/M), "Session" submenu on intraday, separator, "More settings…". */
  function openTimeScaleMenu(e: MouseEvent) {
    const t = currentTokens();
    const intraday = isIntradayInterval(props.interval ?? "1D");
    const tzLabel = props.timeZoneLabel ?? "Exchange";
    const nodes: CtxNode[] = [];
    if (timeScaleOffDefault()) {
      nodes.push({ kind: "item", id: "reset-time-scale", label: "Reset time scale", shortcut: "Ctrl + Alt + Q",
        icon: CtxIcons.reset, onSelect: () => resetTimeScale() });
      nodes.push({ kind: "separator" });
    }
    nodes.push({ kind: "item", id: "time-zone", label: "Time zone", submenu: TIMEZONES.map((z) => ({
      kind: "item" as const, id: `tz-${z.label}`, label: z.label, checked: z.label === tzLabel,
      onSelect: () => window.dispatchEvent(new CustomEvent("chart-set-timezone", { detail: { label: z.label } })),
    })) });
    nodes.push({ kind: "item", id: "session-breaks", label: "Session breaks", checked: t.sessionBreaksVisible,
      disabled: !intraday,
      onSelect: () => window.dispatchEvent(new CustomEvent("chart-patch-scale-settings",
        { detail: { patch: { sessionBreaks: !t.sessionBreaksVisible } } })) });
    if (intraday) {
      nodes.push({ kind: "item", id: "session", label: "Session", submenu: [
        { kind: "item", id: "session-rth", label: "Regular", checked: (props.session ?? "RTH") === "RTH",
          onSelect: () => window.dispatchEvent(new CustomEvent("chart-set-session", { detail: { id: "RTH" } })) },
        { kind: "item", id: "session-eth", label: "Extended", checked: props.session === "ETH",
          onSelect: () => window.dispatchEvent(new CustomEvent("chart-set-session", { detail: { id: "ETH" } })) },
      ] });
    }
    nodes.push({ kind: "separator" });
    nodes.push(moreScaleSettingsNode());
    setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
  }

  /** Price text of the chart menus (same decimals as "Copy price"). */
  const menuPrice = (v: number) => {
    const a = Math.abs(v);
    return v.toFixed(a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
  };

  /** Legend series "More" → the series actions menu, opened under the button
   *  (button left, bottom + 3). No cursor price here, so the prices are the
   *  last close. Rows with no OT
   *  feature are left out: Add order, Add financial metric, Symbol info,
   *  Metrics, Table view, Visual order, Move to, Pin to scale, Add text note. */
  function openSeriesMoreMenu(anchor: DOMRect) {
    const full = props.symbol ?? "";
    const sym = splitSymbol(full).ticker;
    const last = raw.length ? raw[raw.length - 1].close : null;
    const p = last == null ? "—" : menuPrice(last);
    const hidden = !!props.seriesHidden;
    const row = { ticker: full, short: full.split(":").pop() || full, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null };
    // Watchlist submenu: the active list first (Alt + W),
    // then the other lists by name; a row adds or removes the symbol and the
    // menu stays open; separator; "Create new list…".
    const activeId = watchlistStore.activeId();
    const lists = [
      ...watchlistStore.lists().filter((l) => l.id === activeId),
      ...watchlistStore.lists().filter((l) => l.id !== activeId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
    const listRows: CtxNode[] = lists.map((l) => ({
      kind: "item" as const, id: `wl-${l.id}`, label: l.name,
      shortcut: l.id === activeId ? "Alt + W" : undefined,
      checked: () => watchlistStore.listHas(l.id, full),
      keepOpen: true,
      onSelect: () => {
        if (watchlistStore.listHas(l.id, full)) watchlistStore.removeRowFrom(l.id, full);
        else if (l.id === activeId) watchlistStore.addSymbols([row], null);
        else watchlistStore.addRowTo(l.id, row);
      },
    }));
    const nodes: CtxNode[] = [
      { kind: "item", id: "alert", label: `Add alert on ${sym} at ${p}…`, shortcut: "Alt + A", icon: CtxIcons.alert,
        onSelect: () => window.dispatchEvent(new CustomEvent("chart-open-alert-dialog", { detail: { symbol: sym, price: last ?? undefined } })) },
      { kind: "item", id: "add-indicator", label: `Add indicator/strategy on ${sym}…`, icon: CtxIcons.addIndicator,
        onSelect: () => window.dispatchEvent(new CustomEvent("chart-open-indicators")) },
      { kind: "separator" },
      { kind: "item", id: "copy-price", label: `Copy price ${p}`,
        onSelect: () => { if (last != null) void navigator.clipboard?.writeText(p); } },
      { kind: "item", id: "paste", label: "Paste", shortcut: "Ctrl + V", disabled: !hasClipboardDrawing(),
        onSelect: () => {
          const nd = pasteAsNew();
          if (!nd) return;
          const id = props.onPlace?.(nd);
          if (id) props.setSelectedDrawingId?.(id);
        } },
      { kind: "separator" },
      { kind: "item", id: "hide", label: hidden ? "Show" : "Hide", icon: hidden ? CtxIcons.show : CtxIcons.hide,
        onSelect: () => props.onToggleSeries?.() },
      { kind: "separator" },
      { kind: "item", id: "watchlist", label: `Add ${sym} to watchlist`, submenu: [
        ...listRows,
        { kind: "separator" },
        { kind: "item", id: "wl-create", label: "Create new list…", onSelect: () => { watchlistStore.createListWith(row); } },
      ] },
      { kind: "separator" },
      { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings,
        onSelect: () => window.dispatchEvent(new CustomEvent("chart-open-settings")) },
    ];
    setCtxMenu({ x: anchor.left, y: anchor.bottom + 3, nodes });
  }

  /** Legend study "More" → the study actions menu.
   *  Rows with no OT feature are left out: Add alert on the study, Add
   *  indicator/strategy on the study, Visual order, Visibility on intervals,
   *  Move to, Pin to scale, Copy. */
  function openIndicatorMoreMenu(id: string, anchor: DOMRect) {
    const row = indLegend().find((r) => r.id === id);
    if (!row) return;
    const nodes: CtxNode[] = [];
    // No favorites row for studies that cannot be starred (compare/overlay).
    if (getIndicatorEntry(id)) {
      const fav = isFavoriteIndicator(id);
      nodes.push(
        { kind: "item", id: "favorite", label: fav ? "Remove this indicator from favorites" : "Add this indicator to favorites",
          icon: CtxIcons.favorite, onSelect: () => toggleFavoriteIndicator(id) },
        { kind: "separator" },
      );
    }
    nodes.push(
      { kind: "item", id: "hide", label: row.eyeHidden ? "Show" : "Hide", icon: row.eyeHidden ? CtxIcons.show : CtxIcons.hide,
        onSelect: () => {
          controller?.toggleHidden(id);
          refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
          if (isStrategyId(id)) applyStrategyMarkers();
        } },
      { kind: "item", id: "remove", label: "Remove", shortcut: "Del", icon: CtxIcons.remove,
        onSelect: () => props.onRemoveIndicator?.(id) },
      { kind: "separator" },
      { kind: "item", id: "object-tree", label: "Object tree",
        onSelect: () => window.dispatchEvent(new CustomEvent("chart-open-panel", { detail: { id: "object_tree" } })) },
      { kind: "separator" },
      { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings, onSelect: () => setSettingsForId(id) },
    );
    setCtxMenu({ x: anchor.left, y: anchor.bottom + 3, nodes });
  }

  /** Right-click → open the chart context menu at the cursor. "Copy price" /
   *  "Buy …@ price" use the price under the cursor (yToPrice via the coord
   *  bridge); the counts come from the live drawings + indicators. */
  function openContextMenu(e: MouseEvent) {
    e.preventDefault();
    // Over the price-axis strip → the price-scale menu, not the pane menu.
    if (chart && host) {
      const placement = currentTokens().scalesPlacement;
      const sw = chart.priceScale(placement).width();
      const xRel = e.clientX - host.getBoundingClientRect().left;
      const overScale = placement === "right" ? xRel >= host.clientWidth - sw : xRel <= sw;
      if (overScale) { openPriceScaleMenu(e); return; }
      // Over the time-axis strip (the bottom of the chart host) → the time-axis menu.
      const yFromBottom = host.getBoundingClientRect().bottom - e.clientY;
      if (yFromBottom <= chart.timeScale().height()) { openTimeScaleMenu(e); return; }
    }
    const yRel = host ? e.clientY - host.getBoundingClientRect().top : 0;
    const rawPrice = coords()?.yToPrice(yRel) ?? null;
    const a = Math.abs(rawPrice ?? 0);
    const decimals = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    const priceStr = rawPrice == null ? "—" : rawPrice.toFixed(decimals);
    const openPanel = (id: string) => window.dispatchEvent(new CustomEvent("chart-open-panel", { detail: { id } }));
    const noop = () => {};
    const ds = props.drawings ?? [];
    const nodes = buildChartContextMenu(
      {
        symbol: splitSymbol(props.symbol ?? "").ticker,
        price: priceStr,
        drawingCount: ds.length,
        indicatorCount: (props.indicators ?? []).length,
        cursorLockByTime: cursorLock(),
        canPaste: hasClipboardDrawing(),
      },
      {
        resetView: () => resetChartView(),
        copyPrice: () => { if (rawPrice != null) void navigator.clipboard?.writeText(priceStr); },
        // Paste the in-app drawings clipboard (Ctrl+C on a drawing), same as
        // the overlay's Ctrl+V path: place at the copied data coords + select.
        paste: () => {
          const nd = pasteAsNew();
          if (!nd) return;
          const id = props.onPlace?.(nd);
          if (id) props.setSelectedDrawingId?.(id);
        },
        addAlert: () =>
          window.dispatchEvent(
            new CustomEvent("chart-open-alert-dialog", {
              detail: { symbol: splitSymbol(props.symbol ?? "").ticker, price: rawPrice ?? undefined },
            }),
          ),
        // Accepted no-ops: Buy / Sell / Add order / Table view need a trading
        // backend + table view this port doesn't have.
        buy: noop,
        sell: noop,
        addOrder: noop,
        toggleCursorLock: () => setCursorLock((v) => !v),
        tableView: noop,
        objectTree: () => openPanel("object_tree"),
        saveTemplateAs: () => window.dispatchEvent(new CustomEvent("chart-save-template")),
        // Bulk path when available — one undo entry for the whole set.
        removeDrawings: () => {
          if (ds.length > 1 && props.removeDrawings) props.removeDrawings(ds.map((d) => d.id));
          else for (const d of ds) props.removeDrawing?.(d.id);
        },
        removeIndicators: () => window.dispatchEvent(new CustomEvent("chart-clear-indicators")),
        settings: () => window.dispatchEvent(new CustomEvent("chart-open-settings")),
      },
    );
    setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
  }

  /** Re-resolve the legend for a crosshair time (or the latest bar when
   *  omitted). Reads the live `raw` + `activeType` closures. */
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
    const st = currentTokens().styles;
    const src: PriceSource =
      activeType === "line" || activeType === "lineWithMarkers" || activeType === "stepline" ? st[activeType].source
      : activeType === "area" ? st.area.source
      : activeType === "baseline" ? st.baseline.source
      : activeType === "column" ? st.column.source
      : "close";
    setLegend(buildLegend(raw, idx, activeType, prevDayClose[idx] ?? null, src));
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

  // ── Price-axis overlays (Scales tab rows) ────────────────────────────
  // These are DOM on the price axis: the currency label at its top
  // ("Currency and Unit"), the A / L buttons at its bottom ("Scale modes (A
  // and L)"), both "Visible on mouse over" by default = while the pointer is
  // over the chart; and the crosshair "+" button (Scales → "Plus button").
  // Pane index whose price axis is under the pointer (A / L buttons
  // "Visible on mouse over" = that axis hovered; currency label = any price
  // axis of the chart hovered).
  const [axisHover, setAxisHover] = createSignal<number | null>(null);
  const [scaleGeom, setScaleGeom] = createSignal<{ w: number; h: number; left: boolean } | null>(null);
  const [scaleModes, setScaleModes] = createSignal({ auto: true, log: false });
  const [plusY, setPlusY] = createSignal<number | null>(null);
  // The plus is drawn inside the pane and hit-tested there, so the button
  // takes no pointer events (the crosshair keeps tracking under it) and the
  // host hit-tests its rect in the capture phase.
  let plusEl: HTMLButtonElement | undefined;
  let plusPressed = false;
  const [currency, setCurrency] = createSignal("");
  function refreshScaleOverlays() {
    if (!chart) return;
    const side = currentTokens().scalesPlacement;
    const ps = chart.priceScale(side);
    const w = ps.width();
    const h = chart.paneSize(0).height;
    setScaleGeom((g) => (g && g.w === w && g.h === h && g.left === (side === "left") ? g : { w, h, left: side === "left" }));
    const o = ps.options();
    const next = { auto: !!o.autoScale, log: o.mode === PriceScaleMode.Logarithmic };
    setScaleModes((m) => (m.auto === next.auto && m.log === next.log ? m : next));
  }
  const overlayVisible = (b: NavButtonsBehavior, hovered: boolean) => b === "alwaysOn" || (b === "visibleOnMouseOver" && hovered);
  function toggleAutoScale() {
    if (!chart) return;
    const ps = chart.priceScale(currentTokens().scalesPlacement);
    ps.applyOptions({ autoScale: !ps.options().autoScale });
    refreshScaleOverlays();
  }
  function toggleLogScale() {
    if (!chart) return;
    const ps = chart.priceScale(currentTokens().scalesPlacement);
    const log = ps.options().mode === PriceScaleMode.Logarithmic;
    ps.applyOptions({ mode: log ? PriceScaleMode.Normal : PriceScaleMode.Logarithmic });
    refreshScaleOverlays();
  }
  /** Plus button → crosshair menu: "Add
   *  alert on SYMBOL at PRICE…", then (no trading items: no broker) "Draw
   *  horizontal line at PRICE". */
  function openPlusMenu(r: DOMRect, y: number) {
    if (!series) return;
    const price = series.coordinateToPrice(y);
    if (price == null) return;
    const p = price as number;
    const priceStr = series.priceFormatter().format(p);
    const sym = splitSymbol(props.symbol ?? "").ticker;
    const nodes: CtxNode[] = [
      { kind: "item", id: "plus-alert", label: `Add alert on ${sym} at ${priceStr}…`, icon: CtxIcons.alert,
        onSelect: () => window.dispatchEvent(new CustomEvent("chart-open-alert-dialog", { detail: { symbol: sym, price: p } })) },
      { kind: "separator" },
      { kind: "item", id: "plus-hline", label: `Draw horizontal line at ${priceStr}`, icon: <Icon name="draw-horizontal-line" size={18} />,
        onSelect: () => {
          const last = raw.length > 0 ? raw[raw.length - 1] : null;
          if (!last) return;
          const id = props.onPlace?.({ kind: "horizontal-line", points: [{ time: last.time as number, price: p }], style: defaultStyleFor("horizontal-line") } as never);
          if (id) props.setSelectedDrawingId?.(id);
        } },
    ];
    setCtxMenu({ x: r.left, y: r.top, nodes });
  }

  // ── Pane controls (Canvas → Buttons → Pane) ───────────────────────────
  // Pane controls: shown on a pane while the pointer
  // is over it (or always / never), only with more than one pane. 24 px
  // buttons 4 px apart, 4 px from the pane top and the price axis; a pane
  // narrower than 666.65 px shows the single "Manage panes" button (menu),
  // narrower than 356 px none. Buttons: move up / down (study panes; the
  // price pane stays on top here), delete (study panes), collapse (to
  // max(2·4 + 24, 33) px) / restore. "Maximize pane" is not offered: it would
  // hide the other panes, and the chart library keeps every pane ≥ ~30 px.
  type PaneBox = { index: number; top: number; height: number };
  const [paneBoxes, setPaneBoxes] = createSignal<PaneBox[]>([]);
  const [hoverPane, setHoverPane] = createSignal<number | null>(null);
  const [collapsedPanes, setCollapsedPanes] = createSignal<Map<number, number>>(new Map());
  const PANE_COLLAPSED_H = 33;
  function refreshPaneBoxes() {
    if (!chart || !paneRoot) return;
    const root = paneRoot.getBoundingClientRect();
    const boxes: PaneBox[] = chart.panes().map((pn, index) => {
      const el = pn.getHTMLElement();
      const r = el ? el.getBoundingClientRect() : null;
      return { index, top: r ? r.top - root.top : 0, height: r ? r.height : pn.getHeight() };
    });
    setPaneBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(boxes) ? prev : boxes));
  }
  function paneAtY(y: number): number | null {
    for (const b of paneBoxes()) if (y >= b.top && y < b.top + b.height) return b.index;
    return null;
  }
  // Panes the drawings live in (Drawing.owner): pane 0 = the main series, a
  // study pane = its first study, with that pane's price scale. Rebuilt when
  // the pane boxes, the studies or their panes change.
  const [paneEpoch, setPaneEpoch] = createSignal(0);
  const drawingPanes = createMemo<DrawingPane[]>(() => {
    const main = coords();
    const boxes = paneBoxes();
    void paneEpoch();
    if (!main) return [];
    const out: DrawingPane[] = [];
    for (const b of boxes) {
      if (b.index === 0) {
        out.push({ key: null, top: b.top, height: b.height, coords: main });
        continue;
      }
      const owner = untrack(() => controller?.ownerOfPane(b.index) ?? null);
      if (!owner) continue;
      out.push({
        key: owner,
        top: b.top,
        height: b.height,
        coords: studyPaneCoords(main, () => controller?.studySeries(owner) ?? null, (sec) => controller?.paneValuesAt(owner, sec) ?? []),
      });
    }
    return out;
  });
  function movePane(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (!controller || i < 1 || j < 1 || j >= (chart?.panes().length ?? 0)) return;
    const a = controller.idsInPane(i);
    const b = controller.idsInPane(j);
    controller.swapPanes(i, j);
    setPaneEpoch((n) => n + 1);
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
    // Persist: stacked panes are claimed in list order, so swap the two
    // panes' studies in the pane's indicator list.
    const list = [...(props.indicators ?? [])];
    const posA = a.map((id) => list.indexOf(id)).filter((k) => k >= 0);
    const posB = b.map((id) => list.indexOf(id)).filter((k) => k >= 0);
    if (posA.length && posB.length) {
      // The combined slots now hold the upper pane's studies first.
      const slots = [...posA, ...posB].sort((x, y) => x - y);
      const ordered = dir > 0 ? [...b, ...a] : [...a, ...b];
      slots.forEach((slot, k) => { list[slot] = ordered[k]; });
      props.onReorderIndicators?.(list);
    }
    setCollapsedPanes(new Map());
    queueMicrotask(refreshPaneBoxes);
  }
  function deletePane(i: number) {
    if (!controller) return;
    for (const id of controller.idsInPane(i)) props.onRemoveIndicator?.(id);
  }
  function toggleCollapse(i: number) {
    if (!chart) return;
    const pn = chart.panes()[i];
    if (!pn) return;
    const m = new Map(collapsedPanes());
    if (m.has(i)) { pn.setHeight(m.get(i)!); m.delete(i); }
    else { m.set(i, pn.getHeight()); pn.setHeight(PANE_COLLAPSED_H); }
    setCollapsedPanes(m);
    queueMicrotask(refreshPaneBoxes);
  }
  const paneActions = (i: number) => {
    const n = chart?.panes().length ?? 0;
    const collapsed = collapsedPanes().has(i);
    const othersOpen = paneBoxes().some((b) => b.index !== i && !collapsedPanes().has(b.index));
    return {
      up: i >= 2,
      down: i >= 1 && i < n - 1,
      close: i >= 1,
      collapse: !collapsed && othersOpen,
      restore: collapsed,
    };
  };
  function openPaneMenu(e: MouseEvent, i: number) {
    const a = paneActions(i);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const nodes: CtxNode[] = [];
    const ico = (svg: string) => <span class="ot-pane-menu-icon" innerHTML={svg} />;
    if (a.collapse) nodes.push({ kind: "item", id: "pane-collapse", label: "Collapse pane", shortcut: "Ctrl + Double click", icon: ico(PANE_MENU_ICONS.collapse), onSelect: () => toggleCollapse(i) });
    if (a.restore) nodes.push({ kind: "item", id: "pane-restore", label: "Restore pane", shortcut: "Ctrl + Double click", icon: ico(PANE_MENU_ICONS.restore), onSelect: () => toggleCollapse(i) });
    if (a.up) nodes.push({ kind: "item", id: "pane-up", label: "Move pane up", icon: ico(PANE_MENU_ICONS.up), onSelect: () => movePane(i, -1) });
    if (a.down) nodes.push({ kind: "item", id: "pane-down", label: "Move pane down", icon: ico(PANE_MENU_ICONS.down), onSelect: () => movePane(i, 1) });
    if (a.close) nodes.push({ kind: "item", id: "pane-delete", label: "Delete pane", icon: ico(PANE_MENU_ICONS.del), onSelect: () => deletePane(i) });
    // The menu attaches under the button, right-aligned (clientX = right).
    setCtxMenu({ x: r.right, y: r.bottom + 3, nodes });
  }

  /** The newest bar is still forming (its countdown runs): price-based
   *  types draw what it built as projection bars. */
  function lastBarForming(): boolean {
    const last = raw.length > 0 ? raw[raw.length - 1] : null;
    if (!last || typeof last.time !== "number") return false;
    return countdownText(props.interval ?? "1D", Date.now() / 1000, last.time as number, props.session ?? "RTH") != null;
  }
  const dataExtras = () => ({ subMinute: subMinute ?? undefined, lastForming: lastBarForming() });

  /** Style work that depends on the series data: the Baseline base level
   *  and the gradient line's label colour. */
  function afterSeriesData() {
    syncBaseline();
    syncGradientLabel();
  }

  /** Baseline: the base level sits at `Base level` % of the pane height
   *  from the bottom (height · (100 − level) / 100)
   *  and draws a sparse-dotted waterline there. The library takes a PRICE,
   *  so the price under that pixel row is re-derived whenever the visible
   *  price range can have moved. */
  let baselineWaterline: IPriceLine | null = null;
  let baselineLevelPrice: number | null = null;
  function syncBaseline() {
    if (!chart || !series || activeType !== "baseline") return;
    const b = currentTokens().styles.baseline;
    const h = chart.paneSize(0).height;
    if (!(h > 0)) return;
    const y = (h * Math.abs(100 - b.level)) / 100;
    const price = series.coordinateToPrice(y);
    if (price == null || !Number.isFinite(price as number)) return;
    if (baselineLevelPrice !== null && Math.abs((price as number) - baselineLevelPrice) < 1e-9) return;
    baselineLevelPrice = price as number;
    series.applyOptions({ baseValue: { type: "price", price: price as number } } as never);
    if (!baselineWaterline) {
      baselineWaterline = series.createPriceLine({ price: price as number, color: "#8c8c8c", lineStyle: LineStyle.SparseDotted, lineWidth: 1, axisLabelVisible: false, title: "" });
    } else {
      baselineWaterline.applyOptions({ price: price as number });
    }
  }

  /** Gradient line: the last-value label takes the gradient colour at the
   *  last price's height. */
  function syncGradientLabel() {
    if (!chart || !series || (activeType !== "line" && activeType !== "lineWithMarkers" && activeType !== "stepline")) return;
    const s = currentTokens().styles[activeType];
    if (s.type !== "Gradient") return;
    const last = raw.length > 0 ? raw[raw.length - 1] : null;
    const h = chart.paneSize(0).height;
    const y = last ? series.priceToCoordinate(last.close) : null;
    if (y == null || !(h > 0)) return;
    series.applyOptions({ color: mixColor(s.start, s.end, Math.max(0, Math.min(1, (y as number) / h))) } as never);
  }

  /** Main series scale ratio: bar spacing ×
   *  visible price range ÷ pane height — price units per bar at a 1:1 pixel
   *  aspect. Undefined before the chart has data. */
  function liveScaleRatio(): number | undefined {
    if (!chart || !series) return undefined;
    const ts = chart.timeScale();
    const c0 = ts.logicalToCoordinate(0 as Logical);
    const c1 = ts.logicalToCoordinate(1 as Logical);
    const r = series.priceScale().getVisibleRange();
    const h = chart.paneSize(0).height;
    if (c0 == null || c1 == null || !r || !(h > 0)) return undefined;
    return (Math.abs((c1 as number) - (c0 as number)) * Math.abs(r.to - r.from)) / h;
  }

  /** "Lock price to bar ratio": while locked, a bar-spacing change resizes
   *  the price range around its centre so the ratio holds
   *  (range = height ÷ (spacing ÷ ratio)). */
  let lockApplying = false;
  function applyLockedRatio() {
    const t = currentTokens();
    if (!t.lockRatio || !chart || !series || lockApplying) return;
    const ratio = t.lockRatioValue;
    if (!(ratio !== undefined && ratio > 0)) return;
    const ts = chart.timeScale();
    const c0 = ts.logicalToCoordinate(0 as Logical);
    const c1 = ts.logicalToCoordinate(1 as Logical);
    const r = series.priceScale().getVisibleRange();
    const h = chart.paneSize(0).height;
    if (c0 == null || c1 == null || !r || !(h > 0)) return;
    const spacing = Math.abs((c1 as number) - (c0 as number));
    if (!(spacing > 0)) return;
    const len = (h * ratio) / spacing;
    if (Math.abs(Math.abs(r.to - r.from) - len) <= len * 1e-6) return;
    const mid = (r.from + r.to) / 2;
    lockApplying = true;
    try {
      series.priceScale().setAutoScale(false);
      series.priceScale().setVisibleRange({ from: mid - len / 2, to: mid + len / 2 });
    } finally {
      lockApplying = false;
    }
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
    // The old series took its baseline waterline with it.
    baselineWaterline = null;
    baselineLevelPrice = null;
    const tokens = currentTokens();
    series = createSeriesForType(chart, activeType, tokens);
    mainPane?.setPreserveEmptyPane(preserved);
    const prevType = builtType;
    builtType = activeType;
    setDataForType(series, activeType, raw, tokens, dataExtras());
    afterSeriesData();
    // Symbol → Precision: override the price format when the user picked one
    // ("Default" leaves the library's magnitude-derived precision).
    const pf = parsePriceFormat(tokens.precision);
    if (pf) series.applyOptions({ priceFormat: { type: "price", precision: pf.precision, minMove: pf.minMove } });
    // Bind the price axis to the chosen side (Scales placement). The visible
    // scale already drives the default; this pins it explicitly too.
    series.applyOptions({ priceScaleId: tokens.scalesPlacement });
    // Legend eye (series `visible`): a rebuilt series keeps the hidden state
    // (the live toggle is the seriesHidden effect below).
    series.applyOptions({ visible: !untrack(() => props.seriesHidden) });
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
    // Strategy trade marks belong to the series: re-attach to the new one.
    tradeMarkersSeries = null;
    tradeMarkers = null;
    applyStrategyMarkers();
    // The old series took its price lines with it — force a rebuild.
    highLine = null;
    lowLine = null;
    highLowKey = "";
    prevClosePriceLine = null;
    prevCloseKey = "";
    prePostLine = null;
    prePostKey = "";
    alertLines = [];
    updateSessionBreaks();
    updateAlertLines();
    updatePrePostLine();
    // Re-attach the dividend/split markers (their data is retained in the
    // instance and refreshed by the events effect below).
    series.attachPrimitive(eventMarkers);
    series.attachPrimitive(newsLollipop);
    // Countdown axis label (state retained; the 1s timer keeps it ticking).
    series.attachPrimitive(countdown);
    series.attachPrimitive(scaleWatch);
    // Re-sync now, not on the next 1s tick — the fresh series was just
    // created with the plain lastValueVisible, which the countdown plate
    // replaces while it's showing.
    updateCountdown();
    setCoords(
      makeCoords(
        chart,
        series,
        () => raw,
        (sec) => (controller ? controller.overlayValuesAt(sec ?? undefined) : []),
        () => ({ timeZone: props.timeZone ?? "UTC", intraday: isIntradayInterval(props.interval ?? "1D") }),
      ),
    );
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
        ts.setVisibleLogicalRange({ from: (idx as number) + ro - ts.width() / spacing, to: (idx as number) + ro });
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
    const times = t.sessionBreaksVisible
      ? computeSessionBoundaries(raw as readonly { time: number }[], intraday, props.timeZone ?? "UTC")
      : [];
    sessionBreaks.setData(times, t.sessionBreaksColor, t.sessionBreaksVisible, t.sessionBreaksStyle, t.sessionBreaksWidth);
    // Pre/post-market tint: only when the chart draws extended-hours bars.
    sessionBackgrounds.setColors(t.preMarketBgColor, t.postMarketBgColor);
    sessionBackgrounds.setRuns(
      intraday && (props.session ?? "RTH") === "ETH" ? computeSessionRuns(raw as readonly { time: number }[]) : [],
    );
    recomputePrevDayClose();
    updatePrevClosePriceLine();
    updateHighLowLines();
  }

  /** Scales → "Previous day close": one price line at the close of the LAST
   *  bar's previous trading day (the tail of {@link prevDayClose}, so it
   *  follows the recompute above). Memo key skips the createPriceLine churn
   *  like the high/low updater below. The badge is the row's gray by
   *  default; the line carries no title. */
  function updatePrevClosePriceLine() {
    if (!series) return;
    const t = currentTokens();
    const price = raw.length > 0 ? prevDayClose[raw.length - 1] : null;
    const enabled = (t.prevCloseLabel || t.prevCloseLine) && price != null;
    if (!enabled) {
      if (prevClosePriceLine) { series.removePriceLine(prevClosePriceLine); prevClosePriceLine = null; }
      prevCloseKey = "";
      return;
    }
    const key = `${price}|${t.prevCloseLabel}|${t.prevCloseLine}|${t.prevCloseColor}|${t.prevCloseWidth}`;
    if (key === prevCloseKey && prevClosePriceLine) return;
    prevCloseKey = key;
    if (prevClosePriceLine) series.removePriceLine(prevClosePriceLine);
    prevClosePriceLine = series.createPriceLine({
      price: price!,
      color: t.prevCloseColor,
      title: "",
      lineStyle: LineStyle.Dotted,
      lineWidth: Math.max(1, Math.min(4, t.prevCloseWidth)) as 1 | 2 | 3 | 4,
      lineVisible: t.prevCloseLine,
      axisLabelVisible: t.prevCloseLabel,
    });
  }

  /** Scales → "Pre/post/night market": the latest extended-hours trade as a
   *  "Pre"/"Post" price label + dotted line: shown only while the market is in
   *  pre- or post-market, and only when the chart does not draw that trade
   *  itself (daily/weekly/monthly, or intraday on the regular session).
   *  Colour by session; label text black/white from the background. No
   *  overnight ("night") price: the data plan has none. */
  const [marketSession, setMarketSession] = createSignal(usMarketSession());
  onMount(() => {
    const id = window.setInterval(() => { if (!hidden()) setMarketSession(usMarketSession()); }, 15_000);
    onCleanup(() => window.clearInterval(id));
  });

  function updatePrePostLine() {
    if (!series) return;
    const t = currentTokens();
    const session = marketSession();
    const q = quoteFor(splitSymbol(props.symbol ?? "").ticker);
    const onChartAlready =
      isIntradayInterval(props.interval ?? "1D") && (props.session ?? "RTH") === "ETH";
    const price =
      q && q.extChangePercent != null && q.last > 0 ? q.last * (1 + q.extChangePercent / 100) : null;
    const enabled =
      (t.prePostLabel || t.prePostLine) &&
      (session === "pre" || session === "post") &&
      !onChartAlready &&
      price != null;
    if (!enabled) {
      if (prePostLine) { series.removePriceLine(prePostLine); prePostLine = null; }
      prePostKey = "";
      return;
    }
    const color = session === "pre" ? t.preMarketColor : t.postMarketColor;
    const key = `${session}|${t.prePostLabel}|${t.prePostLine}|${color}`;
    if (key === prePostKey && prePostLine) {
      prePostLine.applyOptions({ price: price! });
      return;
    }
    prePostKey = key;
    if (prePostLine) series.removePriceLine(prePostLine);
    prePostLine = series.createPriceLine({
      price: price!,
      color,
      title: session === "pre" ? "Pre" : "Post",
      // Dotted, width 1 (drawn 1 px on / 3 px off; the
      // library's SparseDotted 1/4 is the closest, as for the grid).
      lineStyle: LineStyle.SparseDotted,
      lineWidth: 1,
      lineVisible: t.prePostLine,
      axisLabelVisible: t.prePostLabel,
      axisLabelColor: color,
      axisLabelTextColor: textColorOn(color),
    });
  }

  createEffect(() => {
    chartReady();
    appearance();
    marketSession();
    const q = quoteFor(splitSymbol(props.symbol ?? "").ticker);
    q?.last;
    q?.extChangePercent;
    props.interval;
    props.session;
    // Hidden tab: no redraw on each quote (the snapshot poll moves the
    // pre/post price every few seconds); this effect re-runs when shown.
    if (hidden()) return;
    updatePrePostLine();
  });

  /** Scales → "High and low": two price lines at the highest high / lowest
   *  low of the VISIBLE bars (not of all loaded bars), honouring the row's
   *  label/line modes + colorPair.
   *  Runs on data changes, live extreme pushes and every visible-range change,
   *  so an unchanged key is a no-op and a moved extreme only re-prices the two
   *  existing lines. */
  function updateHighLowLines() {
    if (!series) return;
    const t = currentTokens();
    const enabled = (t.highLowLabels || t.highLowLines) && raw.length > 0;
    if (!enabled) {
      if (highLine) { series.removePriceLine(highLine); highLine = null; }
      if (lowLine) { series.removePriceLine(lowLine); lowLine = null; }
      highLowKey = "";
      return;
    }
    // Visible slice of `raw` by time (bar times are ascending). Before the
    // first layout there is no visible range: fall back to every loaded bar.
    let i0 = 0;
    let i1 = raw.length - 1;
    const vr = chart?.timeScale().getVisibleRange();
    if (vr) {
      const from = vr.from as number;
      const to = vr.to as number;
      let lo = 0, hi = raw.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((raw[m].time as number) < from) lo = m + 1; else hi = m; }
      i0 = lo;
      lo = i0; hi = raw.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((raw[m].time as number) <= to) lo = m + 1; else hi = m; }
      i1 = lo - 1;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = i0; i <= i1; i++) {
      const r = raw[i];
      if (r.high > hi) hi = r.high;
      if (r.low < lo) lo = r.low;
    }
    if (!(hi > -Infinity && lo < Infinity)) return;
    const styleKey = `${t.highLowLabels}|${t.highLowLines}|${t.highLowColor}|${t.highLowWidth}|${t.up}|${t.down}`;
    const key = `${hi}|${lo}|${styleKey}`;
    if (key === highLowKey && highLine && lowLine) return;
    const sameStyle = highLine && lowLine && highLowKey.endsWith(`|${styleKey}`);
    highLowKey = key;
    if (sameStyle) {
      highLine!.applyOptions({ price: hi });
      lowLine!.applyOptions({ price: lo });
      return;
    }
    // High/low views (dark): dotted line, colour = the
    // row colour or #808080, label background = the row colour or #142E61
    // with a contrasting text colour.
    const lineStyle = LineStyle.Dotted;
    const labelBg = t.highLowColor || "#142e61";
    const mk = (price: number, title: string) =>
      series!.createPriceLine({
        price,
        color: t.highLowColor || "#808080",
        title,
        lineStyle,
        lineWidth: Math.max(1, Math.min(4, t.highLowWidth)) as 1 | 2 | 3 | 4,
        lineVisible: t.highLowLines,
        axisLabelVisible: t.highLowLabels,
        axisLabelColor: labelBg,
        axisLabelTextColor: textColorOn(labelBg),
      });
    if (highLine) series.removePriceLine(highLine);
    if (lowLine) series.removePriceLine(lowLine);
    highLine = mk(hi, "High");
    lowLine = mk(lo, "Low");
  }

  // ── Alert lines (Settings → Alerts tab) ────────────────────────────────
  // A dashed price line for every price-level alert on the charted
  // symbol, coloured by the rule's state (colorPair up = active, down =
  // inactive; "Only active alerts" hides the inactive ones). Read-only — no
  // drag-to-edit. Series-owned, so a series rebuild drops them; rebuildSeries
  // resets the refs and re-creates.
  let alertLines: IPriceLine[] = [];

  /** Rules on this pane's symbol whose condition is a plain price level
   *  (price <op> value; percent operators excluded). Reads the rule FIELDS, so
   *  a tracking caller re-runs on enable/name/level edits, not just on list
   *  membership changes. */
  function alertLineSpecs(): { level: number; title: string; enabled: boolean }[] {
    const key = splitSymbol(props.symbol ?? "").ticker.toUpperCase();
    const out: { level: number; title: string; enabled: boolean }[] = [];
    if (!key) return out;
    for (const r of alertStore.rules()) {
      if (r.symbol !== key || isPercentOperator(r.op)) continue;
      const val = r.left.kind === "value" ? r.left : r.right.kind === "value" ? r.right : null;
      const other = r.left.kind === "value" ? r.right : r.left;
      if (!val || other.kind !== "price") continue;
      out.push({ level: val.value, title: r.name || describeCondition(r), enabled: r.enabled });
    }
    return out;
  }

  /** Drop + re-create the alert price lines from the current rules + committed
   *  appearance. Rules are read untracked — the dedicated effect below owns the
   *  reactivity, so imperative callers (rebuildSeries) don't leak subscriptions
   *  into their own effects. */
  function updateAlertLines() {
    if (!series) return;
    for (const l of alertLines.splice(0)) {
      try { series.removePriceLine(l); } catch { /* series swapped mid-flight */ }
    }
    const t = currentTokens();
    if (!t.alertLinesVisible) return;
    for (const spec of untrack(alertLineSpecs)) {
      if (t.alertLinesOnlyActive && !spec.enabled) continue;
      alertLines.push(
        series.createPriceLine({
          price: spec.level,
          color: t.alertLineColor,
          title: spec.title,
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: true,
        }),
      );
    }
  }

  // Refresh on rule changes (add/remove/edit/enable), symbol change (via the
  // specs' symbol read), settings commit, and once the chart exists. Series
  // rebuilds re-create the lines inside rebuildSeries itself.
  createEffect(() => {
    chartReady();
    appearance(); // visibility / colours / only-active commit
    alertLineSpecs(); // subscribe to the rules + this pane's symbol
    updateAlertLines();
  });

  /** Scales → "Countdown to bar close": refresh the axis label's remaining
   *  time (1s cadence — see the onMount timer). Anchored at the last close,
   *  coloured by the last bar's direction, sitting just under the last-price
   *  label. */
  function updateCountdown() {
    const t = currentTokens();
    const last = raw.length > 0 ? raw[raw.length - 1] : null;
    // The countdown shows for time-based styles only (renko, line break,
    // kagi, P&F and range bars have no bar close to count to).
    const timeBased = !isTransformType(activeType);
    const text = last && timeBased
      ? countdownText(
          props.interval ?? "1D",
          Date.now() / 1000,
          typeof last.time === "number" ? (last.time as number) : undefined,
          props.session ?? "RTH",
        )
      : null;
    const showCountdown = t.countdownVisible && text != null;
    // Value shown in the label: the series' own last value (Heikin-Ashi close
    // on an HA chart) unless "Real prices on price scale" is on.
    const haReal = activeType === "ha" && t.styles.ha.realPrices;
    let labelPrice = last?.close ?? 0;
    let labelUp = last ? last.close >= last.open : true;
    if (activeType === "ha" && !haReal && last) {
      const ha = heikinAshiLast(raw);
      if (ha) { labelPrice = ha.close; labelUp = ha.close >= ha.open; }
    }
    // "Price and percentage value": a second row with the change from the
    // first visible bar (regular scale).
    let pctText = "";
    if (t.symbolValuePercent && timeBased && last && chart) {
      const lr = chart.timeScale().getVisibleLogicalRange();
      const idx = lr ? Math.max(0, Math.min(raw.length - 1, Math.ceil(lr.from))) : 0;
      const base = raw[idx]?.close;
      if (base) {
        const pct = ((last.close - base) / Math.abs(base)) * 100;
        pctText = `${pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;
      }
    }
    const labelOn = t.symbolLastValue && last != null;
    const active = last != null && (showCountdown || (labelOn && (pctText !== "" || haReal)));
    countdown.setState({
      visible: active,
      price: labelPrice,
      // Row 1 of the combined label — empty when the Symbol price-label
      // setting is off (the plate then shows the countdown row alone). The
      // "Name" option prefixes the ticker, like the library label it replaces.
      priceText:
        active && labelOn && series
          ? (t.symbolNameLabel ? `${splitSymbol(props.symbol ?? "").ticker} ` : "") +
            series.priceFormatter().format(labelPrice)
          : "",
      pctText: active && labelOn ? pctText : "",
      text: showCountdown ? text ?? "" : "",
      backColor: labelUp ? t.up : t.down,
      textColor: "#ffffff",
      fontSize: t.scaleFontSize,
      fontFamily: readFontFamily(),
    });
    // The plate REPLACES the library's last-value label while it shows (ONE
    // label: price row + percentage row + countdown row) — toggle
    // the library label off/on as the market opens/closes. Read-compare so
    // the 1s timer doesn't spam applyOptions.
    if (series) {
      const wantLabel = t.symbolLastValue && !active;
      if (series.options().lastValueVisible !== wantLabel) {
        series.applyOptions({ lastValueVisible: wantLabel });
      }
    }
  }

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

  /** One older window, or `null` on a transient backend error — so a failed
   *  fetch lets the user retry on the next scroll rather than latching
   *  "history exhausted" (which an empty result legitimately means). Never
   *  rejects, so it's safe to leave a background prefetch unawaited. */
  function fetchOlder(sym: string, int: string, beforeSec: number, spanDays?: number): Promise<Candle[] | null> {
    // Read the live session so older pages match the displayed series. A session
    // change bumps fetchGen + clears the prefetch buffer (see the symbol/session
    // effect), so an in-flight page for the old session is discarded on landing.
    return getBarsBefore(sym, int, beforeSec, props.session ?? "RTH", spanDays).then((r) => r, () => null);
  }

  /** Indicator recompute after a history prepend, debounced. Every study
   *  recomputes over ALL bars, so running it on each landed page made a deep
   *  scroll-back O(n²); the older section shows without studies for a moment
   *  and they fill in once paging pauses. */
  let indicatorRenderTimer: number | undefined;
  function scheduleIndicatorRender() {
    window.clearTimeout(indicatorRenderTimer);
    indicatorRenderTimer = window.setTimeout(() => {
      indicatorRenderTimer = undefined;
      controller?.renderAll();
      refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
    }, INDICATOR_RENDER_DEBOUNCE_MS);
  }
  onCleanup(() => window.clearTimeout(indicatorRenderTimer));

  /** Read-ahead: fetch the window older than `beforeSec` into {@link prefetch}
   *  so the next scroll-back prepends instantly. No-op once history is exhausted
   *  or when that exact window is already buffering. */
  function startPrefetch(sym: string, int: string, gen: number, beforeSec: number) {
    if (historyExhausted) return;
    if (prefetch && prefetch.gen === gen && prefetch.beforeSec === beforeSec) return;
    prefetch = { gen, beforeSec, rows: fetchOlder(sym, int, beforeSec) };
  }

  /** Scroll-back: when the visible range's left edge nears the oldest loaded
   *  bar, take one older window — from the read-ahead buffer if it's ready, else
   *  fetched inline — prepend it, shift the visible range by the number of bars
   *  added so the candles under the cursor stay put, then pipeline the *next*
   *  window so the following scroll-back is instant too. Guards against
   *  overlapping/duplicate fetches and a stale page landing after a
   *  symbol/interval switch. Mirrors the mock (ChartView.tsx:685-747). */
  function maybeLoadOlder() {
    if (!chart || !series || loadingMore || historyExhausted) return;
    // Don't page while the initial/refetch window is still loading: the live
    // poller can seed `raw` with a single forming bar before history lands, and
    // paging off that would compute a bogus `before` (the newest bar) and
    // duplicate the recent window. Wait until real history has populated `raw`.
    if (history.loading) return;
    // The daily family pages its underlying daily bars (so 1W/1M re-aggregate);
    // second/minute page the displayed bars directly.
    const isDaily = rawDaily.length > 0;
    const oldestSrc: { time: unknown }[] = isDaily ? rawDaily : raw;
    if (oldestSrc.length === 0) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range || range.from > LOAD_MORE_THRESHOLD) return;
    // Don't page when the whole loaded series is in view — the initial
    // fitContent() (and a fully zoomed-out chart) sits at from≈0 / to≈len-1.
    // The old guard tested the visible SPAN, but scrolling/zooming left into the
    // whitespace past bar 0 inflates the span (`from` goes negative) and wrongly
    // suppressed paging — the very gesture meant to load older bars. Instead,
    // only block while the newest bar is still on-screen (right edge near the
    // last index); once the latest bars scroll off the right, page.
    if (range.to >= raw.length - 1 - LOAD_MORE_THRESHOLD) return;

    loadingMore = true;
    const reqSym = props.symbol ?? "";
    const reqInt = props.interval ?? "1D";
    const reqGen = fetchGen;
    const beforeSec = oldestSrc[0].time as number;
    // Consume the buffered window when it matches this exact request; otherwise
    // fetch inline (the user scrolled before the read-ahead landed).
    const buffered =
      prefetch && prefetch.gen === reqGen && prefetch.beforeSec === beforeSec ? prefetch.rows : null;
    prefetch = null;
    const usedBuffer = buffered !== null;
    const tFetch = performance.now();
    console.log(
      `[scrollback] TRIGGER fired (from=${range.from.toFixed(1)}, raw=${raw.length}, beforeSec=${beforeSec}) — source: ${usedBuffer ? "prefetch buffer" : "INLINE fetch"}`,
    );
    const source = buffered ?? fetchOlder(reqSym, reqInt, beforeSec);
    void source
      .then((rows) => {
        const ms = (performance.now() - tFetch).toFixed(0);
        console.log(
          `[scrollback] page landed in ${ms}ms (${usedBuffer ? "buffered" : "inline"}, ${rows?.length ?? "null"} rows)`,
        );
        // The series moved on while the page was in flight — discard it. We key
        // off the generation token, not a symbol/interval equality check: an
        // A→B→A switch re-matches the symbol and would let a stale page from
        // the first A view prepend into and re-range the second, parking the
        // chart on year-old bars. The token never re-matches.
        if (!chart || !series) return;
        if (reqGen !== fetchGen) return;
        if (rows === null) return; // transient error — allow a later retry
        // Another prepend (the date-range sync loader) landed first: this page
        // would overlap it.
        if (((isDaily ? rawDaily[0]?.time : raw[0]?.time) as number | undefined) !== beforeSec) return;
        const older = rows.filter((r) => (r.time as number) < beforeSec);
        if (older.length === 0) {
          historyExhausted = true;
          return;
        }
        const prevRange = ts.getVisibleLogicalRange();
        // Brick types re-derive their items from the whole history (item
        // count unrelated to the bars added): keep the visible TIME window.
        const prevTimes = isTransformType(activeType) ? ts.getVisibleRange() : null;
        const prevLen = raw.length;
        if (isDaily) {
          rawDaily = [...older, ...rawDaily];
          const unit = aggregateUnitFor(reqInt);
          raw = toOHLC(unit ? aggregateCandles(rawDaily, unit) : rawDaily);
        } else {
          raw = [...toOHLC(older), ...raw];
        }
        setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
        updateSessionBreaks();
        scheduleIndicatorRender();
        if (!crosshairActive) refreshLegend();
        // Pin the view by the bars actually added — aggregation can change the
        // count for 1W/1M, so use the length delta, not the raw page length.
        const delta = raw.length - prevLen;
        if (prevTimes) {
          ts.setVisibleRange(prevTimes);
        } else if (prevRange && delta > 0) {
          ts.setVisibleLogicalRange({ from: prevRange.from + delta, to: prevRange.to + delta });
        }
        // Pipeline the next older window so the following scroll-back is instant.
        const nextOldest = (isDaily ? rawDaily[0]?.time : raw[0]?.time) as number | undefined;
        if (nextOldest !== undefined) startPrefetch(reqSym, reqInt, reqGen, nextOldest);
      })
      .finally(() => {
        loadingMore = false;
      });
  }

  /** Index of the newest loaded bar at or before `targetSec` (binary search on
   *  the time-ascending `raw`); 0 when the target predates every bar. */
  function indexAtOrBefore(targetSec: number): number {
    let lo = 0,
      hi = raw.length - 1,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((raw[mid].time as number) <= targetSec) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Index of the oldest loaded bar at or after `targetSec` (lower bound);
   *  the newest bar when the target is past every bar. */
  function indexAtOrAfter(targetSec: number): number {
    let lo = 0,
      hi = raw.length - 1,
      ans = raw.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((raw[mid].time as number) >= targetSec) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  // ── Date-range sync, driver side ────────────────────────────────────────
  /** Broadcast this pane's visible dates when it is the ACTIVE pane and a
   *  whole bar entered or left the view (only the active chart drives).
   *  Dates, not logical indices, so panes on
   *  other intervals line up. `force` re-sends an unchanged range (pane just
   *  became active, or sync was just switched on). A change the user made is
   *  also sent to linked tabs when the group's Date range channel is on,
   *  independent of this layout's own toggle. */
  function broadcastRange(force: boolean) {
    if (!chart || !props.active || swapping || suppressRangeBroadcast) return;
    const toLayout = layoutSync().dateRange;
    const toLink = !force && !linkQuiet && !!activeLink()?.channels.dateRange;
    if (!toLayout && !toLink) return;
    const r = chart.timeScale().getVisibleRange();
    if (!r) return;
    const key = `${r.from}:${r.to}`;
    if (!force && key === lastRangeKey) return;
    lastRangeKey = key;
    if (toLayout) {
      window.dispatchEvent(
        new CustomEvent("chart-sync-range", { detail: { from: r.from as number, to: r.to as number, sourceId: paneId } }),
      );
    }
    if (toLink) postLinkRange(r.from as number, r.to as number);
  }
  // Every chart re-syncs to the newly active chart's range when the active
  // chart changes or date-range sync is switched on.
  createEffect(() => {
    chartReady();
    if (!props.active || !layoutSync().dateRange) return;
    untrack(() => broadcastRange(true));
  });

  // ── Date-range sync, follower side ──────────────────────────────────────
  /** Queue an inbound date-range target. Only the latest target is kept, and
   *  it is applied in a later task so the driving pane's gesture never waits
   *  on its followers (a newer target supersedes the previous request). */
  function queueSyncRange(from: number, to: number) {
    syncTarget = { from, to };
    scheduleSyncRun(0);
  }
  function scheduleSyncRun(delayMs: number) {
    if (syncTimer !== undefined) return;
    syncTimer = window.setTimeout(() => {
      syncTimer = undefined;
      void runSyncRange();
    }, delayMs);
  }
  onCleanup(() => window.clearTimeout(syncTimer));

  /** True when the target predates the loaded bars and more can be loaded for
   *  sync. The daily family holds its full history already. */
  function needsSyncLoad(fromSec: number): boolean {
    return (
      rawDaily.length === 0 &&
      !historyExhausted &&
      raw.length > 0 &&
      raw.length < SYNC_LOAD_MAX_BARS &&
      (raw[0].time as number) > fromSec
    );
  }

  /** Trading days from `fromSec` up to `beforeSec` (the backend sizes history
   *  windows in trading days): weekdays plus a holiday margin. */
  function tradingDaysBetween(fromSec: number, beforeSec: number): number {
    const cal = Math.max(0, (beforeSec - fromSec) / 86400);
    return Math.max(1, Math.ceil((cal * 5) / 7) + 2 + Math.ceil(cal / 36));
  }

  /** Distinct local calendar days among the loaded bars (≥ 1). */
  function loadedSessionDays(): number {
    if (raw.length === 0) return 1;
    const dayOf = dayKeyer(props.timeZone ?? "UTC");
    let days = 1;
    let cur = dayOf(raw[0].time as number);
    for (let i = 1; i < raw.length; i++) {
      const d = dayOf(raw[i].time as number);
      if (d !== cur) {
        days++;
        cur = d;
      }
    }
    return days;
  }

  /** Load history back to the target time in ONE request that reaches it,
   *  keeping the current view on the same bars meanwhile.
   *  `target` is re-read after each await, so a newer target that arrived
   *  during the load is honoured; normally one round, more only when the
   *  trading-day estimate fell short (holidays) or the target moved further
   *  back. Every round must add older bars, else the loop stops. Sync-driven
   *  depth is capped at SYNC_LOAD_MAX_BARS. Returns false when the series
   *  changed underneath (the caller must stop). */
  async function loadHistoryTo(target: () => number | null, wanted: () => boolean): Promise<boolean> {
    const reqGen = fetchGen;
    const reqSym = props.symbol ?? "";
    const reqInt = props.interval ?? "1D";
    let t = target();
    while (t != null && needsSyncLoad(t) && wanted()) {
      const beforeSec = raw[0].time as number;
      // Size the request so the depth cap holds: bars per day measured on the
      // loaded bars, window clipped to the bars still allowed.
      const perDay = Math.max(1, raw.length / loadedSessionDays());
      const allowedDays = Math.floor((SYNC_LOAD_MAX_BARS - raw.length) / perDay);
      if (allowedDays < 1) break;
      const spanDays = Math.min(tradingDaysBetween(t, beforeSec), allowedDays);
      syncLoading = true;
      loadingMore = true;
      let rows: Candle[] | null = null;
      try {
        rows = await fetchOlder(reqSym, reqInt, beforeSec, spanDays);
      } finally {
        syncLoading = false;
        loadingMore = false;
      }
      if (reqGen !== fetchGen || !chart || !series) return false;
      if (rows === null) break; // transient error: frame what is loaded
      const older = rows.filter((r) => (r.time as number) < beforeSec);
      if (older.length === 0) {
        historyExhausted = true;
        break;
      }
      const ts = chart.timeScale();
      const prevRange = ts.getVisibleLogicalRange();
      const prevTimes = isTransformType(activeType) ? ts.getVisibleRange() : null;
      const prevLen = raw.length;
      raw = toOHLC(older).concat(raw);
      prefetch = null;
      // The prepend itself fires a range change (same logical range, older
      // dates) before the view is put back below: guard it too, so it is not
      // persisted, paged or sent to synced panes / linked tabs.
      holdSyncGuard();
      setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
      updateSessionBreaks();
      scheduleIndicatorRender();
      if (!crosshairActive) refreshLegend();
      const delta = raw.length - prevLen;
      if (prevTimes) {
        holdSyncGuard();
        ts.setVisibleRange(prevTimes);
      } else if (prevRange && delta > 0) {
        holdSyncGuard();
        ts.setVisibleLogicalRange({ from: prevRange.from + delta, to: prevRange.to + delta });
      }
      t = target();
    }
    const nextOldest = (rawDaily.length > 0 ? rawDaily[0]?.time : raw[0]?.time) as number | undefined;
    if (nextOldest !== undefined) startPrefetch(reqSym, reqInt, reqGen, nextOldest);
    return true;
  }

  /** Apply the latest date-range target: load missing history (one request),
   *  then frame the target once. */
  async function runSyncRange() {
    if (!syncTarget || syncLoading || !chart || !series) return;
    // No data yet (first load / symbol swap): the apply effect re-runs this
    // once the bars land.
    if (raw.length === 0 || history.loading || swapping) return;
    // The scroll-back pager or a time-sync jump is prepending: wait for it, so
    // two loaders never prepend overlapping windows.
    if (loadingMore) {
      scheduleSyncRun(50);
      return;
    }
    if (!(await loadHistoryTo(() => syncTarget?.from ?? null, () => true))) return;
    const t = syncTarget;
    syncTarget = null;
    if (t) applySyncRange(t.from, t.to);
  }

  /** Bar index holding a synced time on this pane: the bar of that day on
   *  daily/weekly/monthly (DWM targets snap to the trading day), the first
   *  bar at/after it on intraday frames. */
  function syncIndex(sec: number): number {
    const iv = props.interval ?? "1D";
    const dwm = !isIntradayResolution(iv) && !isSecondResolution(iv);
    return dwm ? indexAtOrBefore(sec) : indexAtOrAfter(sec);
  }

  /** Frame [fromSec, toSec] on this pane:
   *  the same dates as the driving pane, bar spacing adapting to fit (the
   *  library's min bar spacing then keeps the right edge). `driver`: the
   *  user's own move (Go to custom range), not guarded like an inbound sync.
   *  `indexOf`: bar index of a time (default: the sync rule). */
  function applySyncRange(fromSec: number, toSec: number, driver = false, indexOf: (sec: number) => number = syncIndex) {
    const guard = () => { if (!driver) holdSyncGuard(); };
    if (!chart || raw.length === 0) return;
    const ts = chart.timeScale();
    const last = raw.length - 1;
    // Target entirely older than the loaded history (history floor or the sync
    // depth cap): show the oldest bars at the current zoom instead of
    // collapsing onto one bar.
    if (toSec < (raw[0].time as number)) {
      const cur = ts.getVisibleLogicalRange();
      const span = cur ? Math.max(MIN_VISIBLE_BARS, cur.to - cur.from) : 100;
      guard();
      ts.setVisibleLogicalRange({ from: -0.5, to: span - 0.5 });
      return;
    }
    const i = indexOf(fromSec);
    let l = Math.max(i, indexOf(toSec));
    if (l - i + 1 < SYNC_MIN_BARS) l = i + SYNC_MIN_BARS - 1;
    // A range reaching the latest bar keeps the pane's right margin.
    if (l >= last) l = Math.max(l, last + (ts.options().rightOffset ?? 0));
    guard();
    ts.setVisibleLogicalRange({ from: i - 0.5, to: l + 0.5 });
  }

  /** Bar index for a "Go to" date (the reference app `_gotoTimeImpl`): intraday, the bar
   *  holding the time (the reference app aligns the target to its bar start), else the first
   *  bar after it; the first bar at/after the date on DWM. */
  function gotoDateIndex(sec: number): number {
    const iv = props.interval ?? "1D";
    if (!isIntradayResolution(iv) && !isSecondResolution(iv)) return indexAtOrAfter(sec);
    const step = parseInt(iv, 10) * (/S$/.test(iv) ? 1 : 60);
    const i = indexAtOrBefore(sec);
    const t = raw[i].time as number;
    return t <= sec && sec < t + step ? i : indexAtOrAfter(sec);
  }

  type GotoOpts = {
    /** Centre the target even when it is already in view (the reference app Go to). */
    alignIfVisible?: boolean;
    /** The user's own move (Go to): the new view is persisted and sent to
     *  synced panes / linked tabs like a scroll. Sync followers leave it off. */
    driver?: boolean;
    /** Bar index of the target (default: the sync rule). */
    index?: (sec: number) => number;
  };

  /** Bumped per goToTime / goToRange call so a newer jump supersedes an
   *  in-flight older one. */
  let gotoGen = 0;
  /** Receiving side of "Time" sync (target aligned to the centre, no
   *  alignment when already visible): when the
   *  clicked time is already in view nothing moves; otherwise the pane loads
   *  history back to it if needed (one request, capped) and centres it at the
   *  current bar spacing. It only scrolls: the crosshair is the crosshair
   *  sync's business. The Go to dialog uses it with `alignIfVisible` and
   *  `driver` (the reference app `gotoTime`). */
  async function goToTime(targetSec: number, opts: GotoOpts = {}) {
    if (!chart || !series || raw.length === 0) return;
    const ts = chart.timeScale();
    const indexOf = opts.index ?? syncIndex;
    const loaded = (raw[0].time as number) <= targetSec || rawDaily.length > 0 || historyExhausted;
    const cur = ts.getVisibleLogicalRange();
    if (loaded && cur && !opts.alignIfVisible) {
      const idx = indexOf(targetSec);
      if (idx >= cur.from && idx <= cur.to) return;
    }
    // Another loader is prepending: retry once it is done.
    if (loadingMore) {
      window.setTimeout(() => void goToTime(targetSec, opts), 50);
      return;
    }
    const myGoto = ++gotoGen;
    // Darken while the target history loads (same dim-and-hold treatment as a
    // symbol load), debounced so an in-memory jump never flashes it.
    const dimTimer = needsSyncLoad(targetSec) ? window.setTimeout(() => setDimmed(true), 160) : 0;
    try {
      if (!(await loadHistoryTo(() => targetSec, () => myGoto === gotoGen))) return;
      if (myGoto !== gotoGen || !chart) return;
      const r = ts.getVisibleLogicalRange();
      const span = r ? r.to - r.from : 120;
      const idx = indexOf(targetSec);
      if (!opts.driver) holdSyncGuard();
      ts.setVisibleLogicalRange({ from: idx - span / 2, to: idx + span / 2 });
    } finally {
      clearTimeout(dimTimer);
      // Only the latest jump clears the dim.
      if (myGoto === gotoGen) setDimmed(false);
    }
  }

  /** Go to "Custom range" (the reference app `setTimeFrame` with a time range): load history
   *  back to `fromSec` if needed, then frame [fromSec, toSec] like a date-range
   *  sync target. The user's own move: persisted and sent to synced panes. */
  async function goToRange(fromSec: number, toSec: number) {
    if (!chart || !series || raw.length === 0) return;
    if (loadingMore) {
      window.setTimeout(() => void goToRange(fromSec, toSec), 50);
      return;
    }
    const myGoto = ++gotoGen;
    const dimTimer = needsSyncLoad(fromSec) ? window.setTimeout(() => setDimmed(true), 160) : 0;
    try {
      if (!(await loadHistoryTo(() => fromSec, () => myGoto === gotoGen))) return;
      if (myGoto !== gotoGen || !chart) return;
      // The reference app `gotoTimeRange`: both ends go to the first bar at/after their time.
      applySyncRange(fromSec, toSec, true, indexAtOrAfter);
    } finally {
      clearTimeout(dimTimer);
      if (myGoto === gotoGen) setDimmed(false);
    }
  }

  // Countdown tick: 1s cadence, reading the live closures (interval / raw /
  // tokens) so it follows symbol/interval/settings changes without re-wiring.
  onMount(() => {
    const timer = window.setInterval(() => { if (!hidden()) updateCountdown(); }, 1000);
    onCleanup(() => window.clearInterval(timer));
  });

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
    // Start empty; real candles arrive from the Massive resource below.
    raw = [];
    rebuildSeries();

    // The controller reads bars from `raw` on demand, so it always recomputes
    // against the freshest dataset without threading bars in.
    controller = new IndicatorController(chart, () => raw as unknown as Bar[], String(paneId));
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
      refreshBarsRef?.();
    });
    ro.observe(host);

    // ── Control bars ────────────────────────────────────────────────────────
    // The centred group bar and the bottom-right "Scroll to the most recent
    // bar" button (see control-bar.ts for the shared geometry). The rules:
    //   • the goto button shows only while `rightOffset < 0`, i.e. the last bar
    //     has left the right edge. Empty right margin still reads as realtime.
    //   • both also need the Navigation setting to allow it: `alwaysOn` pins
    //     them on, `alwaysOff` off, and the default consults a box padded 100px
    //     around each wrapper (73px on top). Each bar tests its OWN box. A held
    //     button or an armed tool freezes the state instead of hiding.
    //   • the anchor follows the bottom-most pane tall enough to hold the bar.
    let nearGoto = false; // back button can be visible
    let nearBar = false; // control bar visible
    let gotoPoll: number | undefined;

    const refreshBars = () => {
      if (!chart || hidden()) return;
      const behavior = currentTokens().navButtons;
      // Host size cached by the ResizeObserver: reading clientWidth/Height here
      // forced a synchronous layout on every pan frame (the drawings overlay
      // has just re-projected its SVG in the same task).
      const anchor = barAnchor(chart, hostH, hostW);
      if (anchor) {
        setGotoBox((p) => (p.bottom === anchor.bottom && p.right === anchor.right ? p : { bottom: anchor.bottom, right: anchor.right }));
        const fits = anchor.fits((id) => (id === "maximize" ? !!props.canMaximize : true));
        setBarFits((p) => (p.size === fits.size && [...p].every((id) => fits.has(id)) ? p : fits));
        const left = anchor.centre(groupsWidth(fits));
        setBarLeft(left);
      }
      setGotoShown(canShow(behavior, nearGoto) && chart.timeScale().scrollPosition() < 0);
      setBarShown(canShow(behavior, nearBar));
      setResetAvailable(scalesOffDefault());
    };

    // The goto button is polled at 1s to catch new bars pushing the last bar
    // off-screen. It can't show while the pointer is away (and the pinned modes
    // don't depend on scroll at all), so only poll where it can change the
    // answer — same result, no idle timer per pane.
    const syncGotoPoll = () => {
      const want = currentTokens().navButtons === "alwaysOn" || nearGoto;
      if (want && gotoPoll === undefined) gotoPoll = window.setInterval(refreshBars, 1000);
      else if (!want && gotoPoll !== undefined) {
        window.clearInterval(gotoPoll);
        gotoPoll = undefined;
      }
    };
    refreshBarsRef = () => {
      syncGotoPoll();
      refreshBars();
    };

    const onBarPointer = (e: MouseEvent) => {
      if (currentTokens().navButtons !== "visibleOnMouseOver") return;
      const g = pointerNearBox(e, gotoWrap.getBoundingClientRect(), !!props.armedTool);
      const b = pointerNearBox(e, barWrap.getBoundingClientRect(), !!props.armedTool);
      if ((g === undefined || g === nearGoto) && (b === undefined || b === nearBar)) return;
      if (g !== undefined) nearGoto = g;
      if (b !== undefined) nearBar = b;
      syncGotoPoll();
      refreshBars();
    };
    // Bound to the pane root, not the canvas host: the buttons are siblings of
    // the host, so hovering one would fire `mouseleave` on the host, hide it,
    // put the cursor back over the canvas and flicker forever. The pane root
    // wraps both.
    paneRoot.addEventListener("mousemove", onBarPointer);
    paneRoot.addEventListener("mouseleave", onBarPointer);
    onCleanup(() => {
      paneRoot.removeEventListener("mousemove", onBarPointer);
      paneRoot.removeEventListener("mouseleave", onBarPointer);
      if (gotoPoll !== undefined) window.clearInterval(gotoPoll);
    });

    // Navigation setting changes flip the pinned modes on/off, so re-resolve.
    createEffect(() => {
      const behavior = appearance().navButtons ?? "visibleOnMouseOver";
      if (behavior !== "visibleOnMouseOver") {
        nearGoto = false;
        nearBar = false;
      }
      refreshBarsRef?.();
    });

    const onRangeChange = () => {
      setCoordEpoch((n) => n + 1);
      refreshBarsRef?.();
      // High/Low follow the visible bars, on followers too.
      updateHighLowLines();
      // A view set by an inbound sync is not this pane's own: it must not page
      // (the sync loader fetched its history in one request), be persisted
      // (a follower would save a clamped view), or be broadcast.
      if (syncGuard) return;
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
            props.onVisibleRange?.({ from: lr.from, to: lr.to });
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

    // ── Right-edge-anchored wheel zoom ──────────────────────────────────────
    // The wheel zoom pins the most recent bar to the right edge, so history
    // expands/contracts to the LEFT only — unlike lightweight-charts' default
    // cursor-anchored zoom. We hold the visible range's right edge (`to`) fixed
    // and scale the left edge (`from`). The whole wheel goes through the wheel
    // helper (./wheel-helper): vertical → zoom (bar spacing x (1 + t/10),
    // |t| <= 1 per event); Ctrl → "focused zoom", the bar under the cursor
    // stays put; horizontal (and Shift + vertical, swapped by the helper) →
    // scrollChart(-80 x deltaX) px. The library's own wheel scroll is replaced,
    // so the event stops here. Capture phase: we run before the canvas listener.
    const wheel = new WheelHelper();
    const axisWheel = new WheelHelper();
    const onWheel = (e: WheelEvent) => {
      if (!chart) return;
      if (onPriceAxisWheel(e)) return;
      const ts = chart.timeScale();
      let range = ts.getVisibleLogicalRange();
      if (!range) return;
      let span = range.to - range.from;
      if (span <= 0) return;
      const w = wheel.process(e);
      const zoom = -w.deltaY;
      if (zoom === 0 && w.deltaX === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (w.deltaX !== 0) {
        // Scroll by -80 · deltaX: the content moves that many pixels
        // (positive = to the right, i.e. toward older bars).
        const px = -80 * w.deltaX;
        const shift = px / (ts.width() / span);
        ts.setVisibleLogicalRange({ from: range.from - shift, to: range.to - shift });
        range = ts.getVisibleLogicalRange() ?? range;
        span = range.to - range.from;
      }
      if (zoom === 0) return;
      const t = Math.sign(zoom) * Math.min(1, Math.abs(zoom));
      props.onWheelZoom?.(e.ctrlKey || e.metaKey);
      // Wheel up (t > 0) → zoom in (smaller span); down → zoom out.
      const newSpan = Math.max(5, span / (1 + t / 10));
      if (e.ctrlKey || e.metaKey) {
        // Focused zoom: the logical index under the cursor keeps its screen
        // position. x clamped to [1, width - 2].
        const g = scaleGeom();
        const r = host.getBoundingClientRect();
        const x = Math.max(1, Math.min(e.clientX - r.left - (g?.left ? g.w : 0), ts.width() - 2));
        const at = ts.coordinateToLogical(x);
        if (at === null) return;
        const f = (at - range.from) / span;
        ts.setVisibleLogicalRange({ from: at - f * newSpan, to: at - f * newSpan + newSpan });
        return;
      }
      // With the right edge ON data the wheel zoom holds the right edge
      // exactly (fixedFrac 1.0 both ways); with the right edge PAST the last
      // bar (right margin / whitespace) a zoom-in holds the LEFT edge and eats
      // the margin instead. Zoom-out in the whitespace state is applied with
      // the same left-edge rule, the only rule consistent with the other
      // three cases. Kagi/PnF draw a synthetic column axis where raw bar
      // counts don't map, so they keep the plain right-edge anchor.
      const lastIndex =
        activeType === "kagi" || activeType === "pnf" ? Infinity : raw.length - 1;
      if (lastIndex >= 0 && range.to > lastIndex && Number.isFinite(lastIndex)) {
        // Left edge held; a zoom-in eats the margin. Once the margin is gone
        // the right edge clamps at the last bar and the remainder comes off
        // the left — the last bar never scrolls out of view mid-zoom.
        const to = Math.max(range.from + newSpan, lastIndex);
        ts.setVisibleLogicalRange({ from: to - newSpan, to });
      } else {
        ts.setVisibleLogicalRange({ from: range.to - newSpan, to: range.to });
      }
    };
    // Wheel over a price axis (on with handleScale.mouseWheel): scales that pane's price like an axis drag from
    // the cursor — startScale(y), scaleTo(y + 15 · deltaY), deltaY from its own
    // wheel helper: the price range is scaled around its centre by
    // (s0 + 0.2(h − 1)) / (s1 + 0.2(h − 1)), s = h − y (≥ 0), at least 0.1.
    // Not in percent / indexed-to-100 mode (the chart gets the wheel then).
    // TRUE when handled.
    function onPriceAxisWheel(e: WheelEvent): boolean {
      const g = scaleGeom();
      if (!chart || !g) return false;
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (g.left ? x >= g.w : x < r.width - g.w) return false;
      const box = paneBoxes().find((b) => e.clientY - r.top >= b.top && e.clientY - r.top < b.top + b.height);
      if (!box) return false;
      const ps = chart.priceScale(currentTokens().scalesPlacement, box.index);
      const mode = ps.options().mode;
      if (mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100) return false;
      const range = ps.getVisibleRange();
      if (!range || !(range.to > range.from)) return false;
      const t = axisWheel.process(e).deltaY;
      if (t === 0) return false;
      e.preventDefault();
      e.stopPropagation();
      const h = box.height;
      const y = e.clientY - r.top - box.top;
      const s0 = h - y;
      const s1 = Math.max(0, h - (y + 15 * t));
      const k = Math.max(0.1, (s0 + 0.2 * (h - 1)) / (s1 + 0.2 * (h - 1)));
      // LWC keeps a log scale's range in its log space and setVisibleRange
      // stores the given numbers as they are, so a log scale is scaled (and
      // set) in that space, with LWC's own formula (toLog / logFormulaFor-
      // PriceRange: offsets 4 / 1e-4 unless the range is under 1).
      const log = mode === PriceScaleMode.Logarithmic;
      const diff = range.to - range.from;
      const digits = diff < 1 && diff >= 1e-15 ? Math.ceil(Math.abs(Math.log10(diff))) : 0;
      const lo = 4 + digits;
      const co = digits ? 1 / Math.pow(10, lo) : 0.0001;
      const toLog = (p: number) => (Math.abs(p) < 1e-15 ? 0 : Math.sign(p) * (Math.log10(Math.abs(p) + co) + lo));
      const a = log ? toLog(range.from) : range.from;
      const b = log ? toLog(range.to) : range.to;
      const mid = (a + b) / 2;
      const half = ((b - a) / 2) * k;
      ps.setVisibleRange({ from: mid - half, to: mid + half });
      return true;
    }
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    onCleanup(() => host.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions));

    // Track whether the OS pointer is over this pane (crosshair broadcast gate).
    // Capture phase so a canvas stopPropagation can't hide the events from us.
    const onDragMove = () => (pointerOverHost = true);
    const onPointerEnter = () => (pointerOverHost = true);
    // The pointer left this pane: stop owning the crosshair, and tell synced
    // siblings to clear (the terminal crosshairMove the library fires on leave
    // is gated off by pointerOverHost, so emit the clear ourselves — order-proof
    // regardless of whether pointerleave or the library's mouseleave runs first).
    const onPointerLeave = () => {
      pointerOverHost = false;
      if (layoutSync().crosshair || crossWindowCrosshairOn()) {
        window.dispatchEvent(
          new CustomEvent("chart-sync-crosshair", { detail: { time: null, price: null, sourceId: paneId } }),
        );
      }
    };
    host.addEventListener("pointermove", onDragMove, true);
    host.addEventListener("pointerenter", onPointerEnter, true);
    host.addEventListener("pointerleave", onPointerLeave, true);
    onCleanup(() => {
      host.removeEventListener("pointermove", onDragMove, true);
      host.removeEventListener("pointerenter", onPointerEnter, true);
      host.removeEventListener("pointerleave", onPointerLeave, true);
    });

    // Plus button hit test: a left press inside its rect belongs to the
    // button (no pan, no time click); the release inside it opens the menu.
    const inPlus = (e: MouseEvent) => {
      if (!plusEl || plusY() === null) return null;
      const r = plusEl.getBoundingClientRect();
      if (!(e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom)) return null;
      // The news lollipop (a chart source) wins over the plus icon.
      if (chart && paneRoot) {
        const root = paneRoot.getBoundingClientRect();
        const leftAxis = currentTokens().scalesPlacement === "left" ? chart.priceScale("left").width() : 0;
        if (newsLollipop.hitTest(e.clientX - root.left - leftAxis, e.clientY - root.top)) return null;
      }
      return r;
    };
    const onPlusDown = (e: MouseEvent) => {
      if (e.button !== 0 || !inPlus(e)) return;
      plusPressed = true;
      e.stopPropagation();
      e.preventDefault();
    };
    const onPlusUp = (e: MouseEvent) => {
      if (!plusPressed) return;
      e.stopPropagation();
      if (e.type !== "click") return;
      plusPressed = false;
      const r = inPlus(e);
      const y = plusY();
      if (r && y !== null) openPlusMenu(r, y);
    };
    const plusEvents = ["pointerdown", "mousedown"] as const;
    const plusUpEvents = ["pointerup", "mouseup", "click"] as const;
    for (const t of plusEvents) host.addEventListener(t, onPlusDown, true);
    for (const t of plusUpEvents) host.addEventListener(t, onPlusUp, true);
    onCleanup(() => {
      for (const t of plusEvents) host.removeEventListener(t, onPlusDown, true);
      for (const t of plusUpEvents) host.removeEventListener(t, onPlusUp, true);
    });

    // Shift+Click on empty chart → arm the Measure tool (Shift+drag-to-
    // measure; this app's measure is two-click, so the click arms it and the
    // user clicks the two endpoints). Only on the focused pane and when no tool
    // is already armed. Capture phase + preventDefault so it doesn't also start
    // a chart drag. Clicks on a drawing go to the overlay, not here.
    const onShiftMeasure = (e: PointerEvent) => {
      if (!props.active || props.armedTool || e.button !== 0 || !e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("select-drawing-tool", { detail: { toolId: "measure" } }));
    };
    host.addEventListener("pointerdown", onShiftMeasure, true);
    onCleanup(() => host.removeEventListener("pointerdown", onShiftMeasure, true));

    // Ctrl+double click on an empty pane area → collapse / restore that pane
    // (no source under the cursor, no drawing tool, empty selection). The plain double click (maximize pane)
    // is not offered here. Only drawings are excluded as sources: a series /
    // study hit (which would open its settings) is not tested.
    const onCtrlDblClick = (e: MouseEvent) => {
      if (!(e.ctrlKey || e.metaKey) || props.armedTool) return;
      if (props.selectedDrawingId || (props.selectedDrawingIds?.length ?? 0) > 0) return;
      if ((e.target as Element | null)?.closest?.("[data-drawing-id]")) return;
      const g = scaleGeom();
      if (!g) return;
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (g.left ? x < g.w : x > r.width - g.w) return; // price axis, not the pane
      const box = paneBoxes().find((b) => y >= b.top && y < b.top + b.height);
      if (!box) return;
      const a = paneActions(box.index);
      if (!a.collapse && !a.restore) return;
      toggleCollapse(box.index);
    };
    host.addEventListener("dblclick", onCtrlDblClick);
    onCleanup(() => host.removeEventListener("dblclick", onCtrlDblClick));

    // Legend tracks the crosshair: hovering a bar shows that bar's values;
    // moving off the pane (no `time`) falls back to the latest bar.
    const onCrosshair = (param: MouseEventParams) => {
      crosshairActive = param.time != null;
      lastLegendTime = param.time as number | undefined;
      refreshLegend(lastLegendTime);
      refreshIndicatorLegend(lastLegendTime);
      // Sync-in-layout (panes) OR "Sync crosshair across windows": mirror the
      // crosshair by time. tab-link-bus relays this same window event to the
      // other windows; each receiver applies it only when its own layout's
      // Crosshair sync is on.
      if (
        pointerOverHost &&
        !suppressCrosshairBroadcast &&
        (layoutSync().crosshair || crossWindowCrosshairOn())
      ) {
        // Resolve a broadcastable (time, price) for BOTH crosshair lines:
        //   • time  → vertical line. `param.time` is undefined when the cursor
        //     is over future/empty whitespace (right of the last bar), even
        //     though the cursor is still ON the chart and its own crosshair is
        //     drawn. Broadcasting null there made every synced pane CLEAR its
        //     crosshair (it vanished). Extrapolate the time from the logical
        //     index + the last bar step so siblings keep tracking. A null
        //     `point` means the cursor truly left the pane → broadcast null so
        //     receivers clear.
        //   • price → horizontal line. Send the price UNDER THE CURSOR so the
        //     horizontal line mirrors too; previously receivers pinned it to
        //     the latest close (the line never followed the source cursor).
        let time: number | null = (param.time as number | undefined) ?? null;
        let price: number | null = null;
        if (param.point) {
          if (time == null && param.logical != null && raw.length >= 2) {
            const last = raw.length - 1;
            const step = (raw[last].time as number) - (raw[last - 1].time as number);
            time = (raw[last].time as number) + ((param.logical as number) - last) * step;
          }
          const p = series?.coordinateToPrice(param.point.y);
          if (p != null) price = p as number;
        }
        window.dispatchEvent(
          new CustomEvent("chart-sync-crosshair", {
            detail: { time, price, sourceId: paneId },
          }),
        );
      }
    };
    chart.subscribeCrosshairMove(onCrosshair);
    // Plus button: follows the crosshair on the main pane while the pointer
    // is over the chart, not while a drawing
    // tool is armed.
    const onPlusCrosshair = (param: MouseEventParams<Time>) => {
      const onMain = param.point && ((param as { paneIndex?: number }).paneIndex ?? 0) === 0;
      setPlusY(onMain && pointerOverHost && !props.armedTool ? param.point!.y : null);
    };
    chart.subscribeCrosshairMove(onPlusCrosshair);
    // Latest news lollipop: hover state + crosshair lines hidden on hover.
    let newsHovered = false;
    const onNewsCrosshair = (param: MouseEventParams<Time>) => {
      const hov = param.hoveredObjectId === NEWS_LOLLIPOP_ID;
      if (hov === newsHovered) return;
      newsHovered = hov;
      newsLollipop.setState({ hovered: hov });
      chart?.applyOptions({ crosshair: { vertLine: { visible: !hov }, horzLine: { visible: !hov } } });
    };
    chart.subscribeCrosshairMove(onNewsCrosshair);
    // Click on the lollipop toggles its card; any other chart click closes it
    // (click outside). A DOM click, not the library's click event:
    // the library drops a click that follows another within 500 ms (it is
    // counted as a double click).
    const onNewsClick = (e: MouseEvent) => {
      if (e.button !== 0 || !chart || !paneRoot) return;
      const root = paneRoot.getBoundingClientRect();
      const leftAxis = currentTokens().scalesPlacement === "left" ? chart.priceScale("left").width() : 0;
      if (newsLollipop.hitTest(e.clientX - root.left - leftAxis, e.clientY - root.top)) toggleNewsCard();
      else if (newsCardOpen()) setNewsCardOpen(false);
    };
    host.addEventListener("click", onNewsClick, true);
    // The card closes on scroll / zoom.
    const onNewsRange = () => { if (newsCardOpen()) setNewsCardOpen(false); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onNewsRange);

    // "Time" sync, driver side: every left mouse-up inside the plot area of a
    // pane that was pressed there, including the end of a drag, sends the time
    // under the pointer. Not on a drawing, not while a tool is armed, and not
    // at all while date-range sync is on. Whitespace right of the last bar
    // extrapolates the time from the bar step (rough time). The same click is
    // sent to linked tabs when the group's Time channel is on and its Date
    // range channel is off (the Linker drops time when date range is on).
    let pressedHere = false;
    const onTimePress = (e: PointerEvent) => {
      // Shift+press arms Measure, Alt+press toggles maximize: not time clicks.
      pressedHere = e.button === 0 && !e.shiftKey && !e.altKey;
    };
    const onTimeRelease = (e: PointerEvent) => {
      const pressed = pressedHere;
      pressedHere = false;
      if (!pressed || e.button !== 0 || !chart || raw.length === 0) return;
      const toLayout = layoutSync().time && !layoutSync().dateRange;
      const link = activeLink();
      const toLink = !!link && link.channels.time && !link.channels.dateRange;
      if ((!toLayout && !toLink) || props.armedTool) return;
      if ((e.target as Element | null)?.closest?.("[data-drawing-id]")) return;
      const ts = chart.timeScale();
      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left - chart.priceScale("left").width();
      const y = e.clientY - rect.top;
      if (x < 0 || x >= ts.width() || y >= rect.height - ts.height()) return;
      let time = ts.coordinateToTime(x) as number | null;
      if (time == null) {
        const logical = ts.coordinateToLogical(x);
        if (logical == null || raw.length < 2) return;
        const last = raw.length - 1;
        const step = (raw[last].time as number) - (raw[last - 1].time as number);
        time = (raw[last].time as number) + ((logical as number) - last) * step;
      }
      if (toLayout) window.dispatchEvent(new CustomEvent("chart-sync-time", { detail: { time, sourceId: paneId } }));
      if (toLink) postLinkTime(time);
    };
    host.addEventListener("pointerdown", onTimePress, true);
    window.addEventListener("pointerup", whenShown(onTimeRelease), true);
    onCleanup(() => {
      host.removeEventListener("pointerdown", onTimePress, true);
      window.removeEventListener("pointerup", whenShown(onTimeRelease), true);
    });

    // ── Layout-sync bus (inbound) ──────────────────────────────────────────
    // Apply crosshair / range broadcasts from sibling panes. The suppress
    // flags stop the resulting local event from re-broadcasting (echo loop);
    // they clear on the next frame so genuine user moves still propagate.
    const onSyncCrosshair = (e: Event) => {
      const d = (e as CustomEvent<{ time: number | null; price?: number | null; sourceId: number }>).detail;
      if (!chart || !series || d.sourceId === paneId || !layoutSync().crosshair) return;
      suppressCrosshairBroadcast = true;
      try {
        if (d.time == null) {
          chart.clearCrosshairPosition();
        } else if (raw.length === 0 || (d.time as number) < (raw[0].time as number)) {
          // Hide the mirrored crosshair on a chart whose loaded history
          // doesn't reach the synced time. Without this, setCrosshairPosition
          // clamps to the FIRST loaded bar and the label stands there stale
          // (e.g. a 1D hover at 13 Feb left the 5m/1m panes labelled at their
          // oldest bars, 21 Jul / 23 Jul).
          chart.clearCrosshairPosition();
        } else {
          // Vertical line aligns by time; the horizontal line uses the source
          // cursor's price (so it mirrors too). Fall back to the latest close
          // only if no price was sent (older broadcast / off-scale cursor).
          const price = d.price != null ? d.price : (raw.length ? raw[raw.length - 1].close : 0);
          chart.setCrosshairPosition(price, d.time as UTCTimestamp, series);
        }
      } catch {
        /* time out of range / series swapped mid-apply — ignore */
      }
      requestAnimationFrame(() => (suppressCrosshairBroadcast = false));
    };
    const onSyncRange = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; to: number; sourceId: number }>).detail;
      if (!chart || d.sourceId === paneId || !layoutSync().dateRange) return;
      queueSyncRange(d.from, d.to);
    };
    // Tab link (tab-link-bus): a linked tab's range lands on the ACTIVE pane,
    // and this layout's own Date range sync spreads it (with its link events
    // muted).
    const onLinkRange = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; to: number }>).detail;
      if (!chart || !props.active) return;
      queueSyncRange(d.from, d.to);
      if (layoutSync().dateRange) {
        window.dispatchEvent(new CustomEvent("chart-sync-range", { detail: { from: d.from, to: d.to, sourceId: paneId } }));
      }
    };
    // Tab link time: every pane when this layout's Time sync is on, else the
    // active pane only.
    const onLinkTime = (e: Event) => {
      const d = (e as CustomEvent<{ time: number }>).detail;
      if (!chart || !series || !(props.active || layoutSync().time)) return;
      if (raw.length === 0 || history.loading || swapping) pendingLinkTime = d.time;
      else void goToTime(d.time);
    };
    // "Time" sync, receiving side: see goToTime.
    const onSyncTime = (e: Event) => {
      const d = (e as CustomEvent<{ time: number; sourceId: number }>).detail;
      if (!chart || !series || d.sourceId === paneId || !layoutSync().time || layoutSync().dateRange) return;
      void goToTime(d.time);
    };
    window.addEventListener("chart-sync-crosshair", whenShown(onSyncCrosshair));
    window.addEventListener("chart-sync-range", whenShown(onSyncRange));
    window.addEventListener("chart-sync-time", whenShown(onSyncTime));
    window.addEventListener("chart-link-range", whenShown(onLinkRange));
    window.addEventListener("chart-link-time", whenShown(onLinkTime));
    onCleanup(() => {
      window.removeEventListener("chart-link-range", whenShown(onLinkRange));
      window.removeEventListener("chart-link-time", whenShown(onLinkTime));
      window.removeEventListener("chart-sync-crosshair", whenShown(onSyncCrosshair));
      window.removeEventListener("chart-sync-range", whenShown(onSyncRange));
      window.removeEventListener("chart-sync-time", whenShown(onSyncTime));
    });

    // "Go to" dialog (bottom-bar GoToDateDialog). The dialog sends wall-clock
    // dates; each pane reads them in its own time zone (the reference app converts in the
    // chart time zone). DWM targets are calendar dates.
    const isDwm = () => {
      const iv = props.interval ?? "1D";
      return !isIntradayResolution(iv) && !isSecondResolution(iv);
    };
    const wallSec = (w: WallDate, h = 0, mi = 0) => wallTimeToUtc(props.timeZone ?? "UTC", w.y, w.m, w.d, h, mi);
    // Date tab (the reference app `gotoTime`): the active chart only; history loads back to
    // the date, and the target is centred even when already in view.
    const onGoToDate = (e: Event) => {
      const d = (e as CustomEvent<{ date?: WallDate; minutes?: number }>).detail;
      if (!d?.date || !chart || !props.active) return;
      const sec = isDwm()
        ? Date.UTC(d.date.y, d.date.m, d.date.d) / 1000
        : wallSec(d.date, Math.floor((d.minutes ?? 0) / 60), (d.minutes ?? 0) % 60);
      if (raw.length === 0 || history.loading || swapping) return;
      void goToTime(sec, { alignIfVisible: true, driver: true, index: gotoDateIndex });
    };
    window.addEventListener("chart-goto-date", whenShown(onGoToDate));
    onCleanup(() => window.removeEventListener("chart-goto-date", whenShown(onGoToDate)));

    // Custom range tab (the reference app `setTimeFrame`): the active chart, or every chart
    // when Interval sync is on. Frames [From, To] (date + time; DWM: dates).
    const onGoToRange = (e: Event) => {
      const d = (e as CustomEvent<{ from?: WallTime; to?: WallTime }>).detail;
      if (!chart || !d?.from || !d?.to || !(props.active || layoutSync().interval)) return;
      if (raw.length === 0 || history.loading || swapping) return;
      const at = (w: WallTime) =>
        isDwm() ? Date.UTC(w.y, w.m, w.d) / 1000 : wallSec(w, Math.floor(w.minutes / 60), w.minutes % 60);
      void goToRange(at(d.from), at(d.to));
    };
    // The dialog asks the active chart, when it opens, for its first and last
    // fully visible bars (the reference app `visibleBarsStrictRange`: the Custom range
    // start values) and whether it is DWM (date only, time fields disabled).
    const onGoToQuery = (e: Event) => {
      const q = (e as CustomEvent<GotoQuery>).detail;
      if (!chart || !props.active || !q) return;
      q.dateOnly = isDwm();
      const lr = chart.timeScale().getVisibleLogicalRange();
      if (!lr || raw.length === 0) return;
      const first = Math.max(0, Math.ceil(lr.from));
      const lastBar = Math.min(raw.length - 1, Math.floor(lr.to));
      if (first > lastBar) return;
      // DWM bars sit on their date (noon UTC is inside the day in any zone
      // the exchange date is read in).
      const wall = (sec: number): WallTime =>
        isDwm() ? { ...utcToWall("UTC", sec + 43200), minutes: 0 } : utcToWall(props.timeZone ?? "UTC", sec);
      q.visible = { from: wall(raw[first].time as number), to: wall(raw[lastBar].time as number) };
    };
    window.addEventListener("chart-goto-query", whenShown(onGoToQuery));
    onCleanup(() => window.removeEventListener("chart-goto-query", whenShown(onGoToQuery)));
    window.addEventListener("chart-goto-range", whenShown(onGoToRange));
    onCleanup(() => window.removeEventListener("chart-goto-range", whenShown(onGoToRange)));

    // Bottom-bar date-range tabs: frame the preset span (the tab also set the
    // preset interval, usually triggering a reload — the span is remembered
    // and applied by the data-apply effect once the new bars land). Only the
    // focused pane reacts, matching the interval change it rides with.
    const onSetRangeSpan = (e: Event) => {
      if (!props.active) return;
      const id = (e as CustomEvent<{ span?: string }>).detail?.span;
      if (!id) return;
      pendingRangeSpan = id;
      // No reload coming (the tab's interval was already active) → apply now.
      if (!swapping && !history.loading) {
        if (applyRangeSpan(id)) pendingRangeSpan = null;
      }
    };
    window.addEventListener("chart-set-range", whenShown(onSetRangeSpan));
    onCleanup(() => window.removeEventListener("chart-set-range", whenShown(onSetRangeSpan)));

    // ── Keyboard chart actions ─────────────────────────────────────────────
    // App.tsx broadcasts these as window events; only the FOCUSED pane reacts
    // (props.active), so multi-pane layouts pan/zoom/scale the chart the user
    // is on — not all of them at once.
    //
    // Pan (←/→, Ctrl+←/→) is not here: both are HELD gestures that build speed,
    // so they run through the scroll animation above (chart-scroll-start/stop).
    //
    // Alt+I/L/P toggles read the LIVE scale options (the price-scale context
    // menu writes the same options, so a tracked local would go stale) and
    // target the placement scale, not a hardcoded "right".
    const applyScale = (mode: "invert" | "log" | "percent") => {
      if (!chart) return;
      const ps = chart.priceScale(currentTokens().scalesPlacement);
      const cur = ps.options();
      if (mode === "invert") {
        ps.applyOptions({ invertScale: !cur.invertScale });
        return;
      }
      const target = mode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Percentage;
      ps.applyOptions({ mode: cur.mode === target ? PriceScaleMode.Normal : target });
    };
    // Snapshot (Alt+S): grab the chart canvas and copy it to the clipboard
    // ("Copy chart image"); fall back to a PNG download where the async
    // clipboard image API isn't available. "open" is the local backing for
    // "Open image in new tab": temp file + OS default viewer.
    const takeSnapshot = (action: "copy" | "download" | "open" = "copy") => {
      if (!chart) return;
      const canvas = chart.takeScreenshot();
      const ticker = splitSymbol(props.symbol ?? "").ticker || "chart";
      if (action === "open") {
        const b64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
        void commands.openSnapshot(b64).then((r) => {
          if (r.status === "error") console.warn("[snapshot] open failed:", r.error);
        });
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob) return;
        if (action === "copy") {
          try {
            if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
              void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              return;
            }
          } catch {
            /* fall through to download */
          }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${ticker}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    };

    // Ctrl+↑/↓ is the same action as the control bar's zoom buttons, so
    // both go through zoomSpan (animated, the measured step).
    const onZoom = (e: Event) => {
      if (!props.active) return;
      zoomSpan((e as CustomEvent<{ dir: "in" | "out" }>).detail.dir === "in" ? 1 / ZOOM_FACTOR : ZOOM_FACTOR);
    };
    const onGotoRealtime = () => { if (props.active) scrollToRealtime(); };
    const onGotoFirst = () => { if (props.active) scrollToFirstBar(); };
    // Held ←/→ ("bar") and Ctrl+←/→ ("smooth"). One stop for both, as a
    // single stop move. Start is pane-gated; stop is not — a pane that started a
    // run must still be able to end it if focus moved in between.
    const onScrollStart = (e: Event) => {
      if (!props.active) return;
      const d = (e as CustomEvent<{ dir: -1 | 1; mode: "bar" | "smooth" }>).detail;
      if (d.mode === "smooth") startPan(d.dir);
      else moveBars(d.dir);
    };
    const onScrollStop = () => stopScroll();
    const onScale = (e: Event) => {
      if (!props.active) return;
      applyScale((e as CustomEvent<{ mode: "invert" | "log" | "percent" }>).detail.mode);
    };
    const onSnapshot = (e: Event) => {
      if (!props.active) return;
      takeSnapshot((e as CustomEvent<{ action?: "copy" | "download" | "open" }>).detail?.action ?? "copy");
    };
    const onReset = () => { if (props.active) resetChartView(); };
    const onResetTime = () => {
      if (!props.active) return;
      resetTimeScale();
      refreshBarsRef?.();
    };
    window.addEventListener("chart-zoom", whenShown(onZoom));
    window.addEventListener("chart-scale", whenShown(onScale));
    window.addEventListener("chart-snapshot", whenShown(onSnapshot));
    window.addEventListener("chart-reset", whenShown(onReset));
    window.addEventListener("chart-reset-time", whenShown(onResetTime));
    window.addEventListener("chart-goto-realtime", whenShown(onGotoRealtime));
    window.addEventListener("chart-goto-first", whenShown(onGotoFirst));
    window.addEventListener("chart-scroll-start", whenShown(onScrollStart));
    window.addEventListener("chart-scroll-stop", whenShown(onScrollStop));
    onCleanup(() => {
      window.removeEventListener("chart-zoom", whenShown(onZoom));
      window.removeEventListener("chart-scale", whenShown(onScale));
      window.removeEventListener("chart-snapshot", whenShown(onSnapshot));
      window.removeEventListener("chart-reset", whenShown(onReset));
      window.removeEventListener("chart-reset-time", whenShown(onResetTime));
      window.removeEventListener("chart-goto-realtime", whenShown(onGotoRealtime));
      window.removeEventListener("chart-goto-first", whenShown(onGotoFirst));
      window.removeEventListener("chart-scroll-start", whenShown(onScrollStart));
      window.removeEventListener("chart-scroll-stop", whenShown(onScrollStop));
    });

    onCleanup(() => {
      if (rangePersistTimer !== undefined) clearTimeout(rangePersistTimer);
      ro.disconnect();
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onStyleRange);
      chart?.unsubscribeCrosshairMove(onCrosshair);
      chart?.unsubscribeCrosshairMove(onPlusCrosshair);
      chart?.unsubscribeCrosshairMove(onNewsCrosshair);
      host.removeEventListener("click", onNewsClick, true);
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(onNewsRange);
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
  onMount(() => {
    const onReload = () => {
      // The reload flips the fetch basis (e.g. the ADJ toggle): invalidate the
      // scroll-back generation + drop the read-ahead buffer so a page fetched
      // under the previous basis can never prepend into the reloaded series
      // (mixed raw/adjusted bars on split tickers).
      fetchGen++;
      prefetch = null;
      setReloadTick((n) => n + 1);
    };
    window.addEventListener("chart-reload-data", onReload);
    onCleanup(() => window.removeEventListener("chart-reload-data", onReload));
  });

  // OakScript indicators: the editor recompiled a script, or its async worker
  // run produced a fresh result — redraw the affected study. Structural means
  // the overlay flag flipped, so the study's pane assignment must be rebuilt.
  onMount(() => {
    const onOakScriptUpdated = (e: Event) => {
      const detail = (e as CustomEvent<OakScriptUpdatedDetail>).detail;
      if (!detail) return;
      const uid = userIndicatorId(detail.scriptId);
      if (!(props.indicators ?? []).includes(uid)) return;
      if (detail.structural) controller?.refresh(uid);
      else controller?.renderAll();
      refreshIndicatorLegend();
    };
    window.addEventListener(OAKSCRIPT_UPDATED_EVENT, onOakScriptUpdated);
    onCleanup(() => window.removeEventListener(OAKSCRIPT_UPDATED_EVENT, onOakScriptUpdated));
  });
  // Strategy Tester requests for the active chart: open a study's Settings
  // dialog, or merge input values into a study (strategy properties).
  onMount(() => {
    const onOpenSettings = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; tab?: DialogTab }>).detail;
      const id = d?.id;
      if (!props.active || props.shown === false || !id || !(props.indicators ?? []).includes(id)) return;
      setSettingsTab(d.tab);
      setSettingsForId(id);
    };
    const onPatchInputs = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; patch: Record<string, unknown> }>).detail;
      if (!props.active || props.shown === false || !d || !controller || !(props.indicators ?? []).includes(d.id)) return;
      const inputs = { ...(controller.getInputs(d.id) ?? {}), ...d.patch };
      const styles = controller.getStyles(d.id) ?? {};
      const options = controller.getOptions(d.id);
      controller.applySettings(d.id, inputs, styles, options);
      props.onIndicatorSettings?.(d.id, { inputs, styles, options });
    };
    window.addEventListener("chart-open-study-settings", onOpenSettings);
    window.addEventListener("chart-patch-study-inputs", onPatchInputs);
    onCleanup(() => {
      window.removeEventListener("chart-open-study-settings", onOpenSettings);
      window.removeEventListener("chart-patch-study-inputs", onPatchInputs);
    });
  });
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
      timeZone: DEFAULT_SYMBOL.timezone,
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
  // Strategies: a backtest of this chart finished — redraw its trade marks.
  onMount(() => {
    const onStrategyUpdated = (e: Event) => {
      const detail = (e as CustomEvent<StrategyUpdatedDetail>).detail;
      if (!detail || detail.chartId !== String(paneId)) return;
      controller?.renderAll();
      refreshIndicatorLegend();
      applyStrategyMarkers();
    };
    window.addEventListener(STRATEGY_UPDATED_EVENT, onStrategyUpdated);
    onCleanup(() => window.removeEventListener(STRATEGY_UPDATED_EVENT, onStrategyUpdated));
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
  /** Map backend `Candle[]` → the chart's `OHLC[]`, dropping any null-field
   *  bars. Shared by the initial apply effect and the scroll-back pager. */
  function toOHLC(rows: Candle[]): OHLC[] {
    return rows
      .filter((c) => c.time != null && c.open != null && c.high != null && c.low != null && c.close != null)
      .map((c) => ({
        time: c.time as unknown as UTCTimestamp,
        open: c.open as number,
        high: c.high as number,
        low: c.low as number,
        close: c.close as number,
        volume: c.volume ?? undefined,
      }));
  }

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
  let pendingScaleKeep: { barSpacing: number; rightOffset: number; leftTime?: number } | null = null;
  // Bottom-bar date-range preset ("1D"…"All") waiting for the tab's interval
  // reload to land; the apply effect frames this span instead of keeping the
  // pre-switch scale. Takes precedence over pendingScaleKeep.
  let pendingRangeSpan: string | null = null;

  /** Frame a date-range preset: [last bar − span, last bar]. "All" fits the
   *  whole series; "YTD" starts at 01/01 of the last bar's year. Returns false
   *  when the chart/data isn't ready (the caller retries after load). */
  function applyRangeSpan(id: string): boolean {
    if (!chart || raw.length === 0) return false;
    const ts = chart.timeScale();
    if (id === "All") {
      ts.fitContent();
      return true;
    }
    const to = raw[raw.length - 1].time as number;
    let from: number;
    if (id === "YTD") {
      const d = new Date(to * 1000);
      from = Date.UTC(d.getUTCFullYear(), 0, 1) / 1000;
    } else {
      // Calendar-day spans (weekend-inclusive so 5D covers a trading week).
      const days: Record<string, number> = { "1D": 1, "5D": 7, "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "5Y": 1830 };
      const span = days[id];
      if (!span) return false;
      from = to - span * 86400;
    }
    try {
      ts.setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });
    } catch {
      return false;
    }
    return true;
  }
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
      pendingScaleKeep = null;
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
    fetchGen++;
    loadingMore = false;
    historyExhausted = false;
    prefetch = null;
    liveVolBase = null;
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
      liveVolBase = null;
      setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
      updateSessionBreaks();
      if (!crosshairActive) refreshLegend();
      controller?.renderAll();
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
    liveVolBase = null;
    setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
    updateSessionBreaks();
    // Recompute every active study against the freshly-loaded bars BEFORE
    // framing: study series add their times to the time scale (with a
    // transform type their real times sit between the synthetic ones), so
    // the saved range is checked and the view set on the final axis.
    controller?.renderAll();
    // Restore the user's last anchored view for this pane (persisted across tab
    // switches + reloads) when it still references loaded bars; otherwise fall
    // back to default framing. Read untracked so this effect re-runs only on new
    // data, not on every scroll that updates the saved range. A range that
    // shows fewer than MIN_VISIBLE_BARS of the loaded bars (e.g. a
    // shorter-history symbol, or a view saved past the last bar) is treated
    // as out of bounds.
    const saved = untrack(() => props.visibleLogicalRange);
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
      if (keep.leftTime !== undefined) {
        // Left edge kept: the first bar at / after the old left-edge time
        // stays at the left edge, same bar spacing.
        let lo = 0;
        let hi = raw.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if ((raw[mid].time as number) < keep.leftTime) lo = mid + 1; else hi = mid; }
        const from = lo;
        ts.setVisibleLogicalRange({ from, to: from + ts.width() / keep.barSpacing });
        framed = `keep-left bs=${keep.barSpacing.toFixed(2)} left=${keep.leftTime}`;
      } else {
        const to = raw.length - 1 + keep.rightOffset;
        ts.setVisibleLogicalRange({ from: to - ts.width() / keep.barSpacing, to });
        framed = `keep bs=${keep.barSpacing.toFixed(2)} ro=${keep.rightOffset.toFixed(1)}`;
      }
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
        const items = series.data();
        const last = items.length ? chart.timeScale().timeToIndex(items[items.length - 1].time, true) : null;
        if (last != null) to = (last as number) + 1;
      }
      if (view !== null && raw.length > view) {
        chart.timeScale().setVisibleLogicalRange({ from: to - view, to });
      } else {
        chart.timeScale().fitContent();
      }
      framed = view === null ? "all" : String(view);
    }
    if (rawDaily.length > 0) historyExhausted = true;
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
    if (syncTarget) scheduleSyncRun(0);
    // A linked time that arrived while this pane was loading.
    if (pendingLinkTime !== null) {
      const t = pendingLinkTime;
      pendingLinkTime = null;
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
      startPrefetch(props.symbol ?? "", props.interval ?? "1D", fetchGen, firstOldest);
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

  // OakScript chart context (timeframe, session, tickerid) of the studies.
  createEffect(() => {
    chartReady();
    controller?.setScriptChart(scriptChartContext(props.symbol, props.interval, props.session));
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
    controller?.setLastValueVisible(readChartTokens(appearance()).indLastValue);
  });

  // ── Compare symbols (header "Compare symbols") ─────────────────────────
  // Each compared symbol is a line series on a shared overlay price scale
  // ("compare"), auto-scaled independently of the main series so differently-
  // priced symbols share one visual frame. A percent scale is the usual
  // compare mode; the overlay autoscale is the local stand-in. Series are keyed by symbol so the
  // effect only fetches/creates/removes the delta on each change.
  const compareSeries = new Map<string, ISeriesApi<"Line">>();
  const COMPARE_COLORS = ["#ff9800", "#9c27b0", "#00bcd4", "#8bc34a", "#e91e63", "#3f51b5"];
  // Interval|session|reload basis the current compare lines were fetched under.
  // When it moves, every existing line holds the OLD timeframe/ADJ basis —
  // drop them all so the add loop below refetches on the current one. Live
  // ticks for compare symbols stay out of scope (lines refresh on fetch only).
  let compareBasis = "";
  createEffect(() => {
    chartReady();
    const want = props.compare ?? [];
    const interval = props.interval ?? "1D";
    const session = props.session ?? "RTH";
    const basis = `${interval}|${session}|${reloadTick()}`;
    if (!chart) return;
    if (basis !== compareBasis) {
      compareBasis = basis;
      for (const [sym, s] of [...compareSeries]) {
        try { chart.removeSeries(s); } catch { /* already gone */ }
        compareSeries.delete(sym);
      }
    }
    // Remove series no longer wanted.
    for (const [sym, s] of [...compareSeries]) {
      if (!want.includes(sym)) {
        try { chart.removeSeries(s); } catch { /* already gone */ }
        compareSeries.delete(sym);
      }
    }
    // Add series newly wanted; fetch this pane's resolution/session.
    want.forEach((sym, i) => {
      if (compareSeries.has(sym) || !chart) return;
      const s = chart.addSeries(LineSeries, {
        color: COMPARE_COLORS[i % COMPARE_COLORS.length],
        lineWidth: 2,
        priceScaleId: "compare",
        lastValueVisible: true,
        priceLineVisible: false,
      });
      compareSeries.set(sym, s);
      getBars(sym, interval, session)
        .then((r) => {
          // Pane may have moved on / the series removed before the fetch lands.
          if (compareSeries.get(sym) !== s) return;
          s.setData(
            r.bars
              .filter((c) => c.time != null && c.close != null)
              .map((c) => ({ time: c.time as unknown as UTCTimestamp, value: c.close as number })),
          );
        })
        .catch(() => { /* symbol not found / transient — leave the empty line */ });
    });
    // Keep the overlay scale out of the main scale's margins. The scale only
    // exists once at least one compare series uses it — applying options
    // before that throws ("incorrect ID").
    if (compareSeries.size > 0) {
      try {
        chart.priceScale("compare").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      } catch { /* scale not materialized yet */ }
    }
  });
  onCleanup(() => {
    for (const s of compareSeries.values()) {
      try { chart?.removeSeries(s); } catch { /* chart already disposed */ }
    }
    compareSeries.clear();
  });

  // ── Feature 9: live ticks from Massive WS ─────────────────────────
  // Mirror the chart's `symbol` into the Rust WS task's subscription set,
  // under THIS pane's slot (multi-pane layouts each hold their own symbol).
  // The task diffs against its previous state and emits the minimal
  // subscribe/unsubscribe frames.
  createEffect(() => {
    const sym = props.symbol ?? null;
    setLiveSymbol(sym, String(paneId)).catch((e) => console.warn("[chart] setLiveSymbol failed:", e));
  });

  /** Merge one resolution-bucketed live bar (from the datafeed) into the
   *  chart's active bucket: extend the forming bar or append a new one.
   *
   *  Only candle/bar series get incremental updates this turn — the other
   *  chart types (line/area/baseline/Heikin-Ashi…) would need a per-type
   *  live-transform; tickets land in 3a-extras follow-ups. */
  /** Repaint after live-bar mutations: candle-family series take the cheap
   *  incremental `update`; every other type re-derives its per-type data from
   *  `raw` (line/area/HA/renko/… — a full setData at the 5s tick cadence is
   *  cheap and keeps ALL chart types live, not just candles). Studies + the
   *  legend recompute so indicators track the live bar; session breaks only
   *  need refreshing when a NEW bar appended (a day may have rolled over). */
  /** paintLive, or (hidden tab) remember that `raw` moved on and draw it
   *  once when the tab is shown. */
  function paintLiveOrDefer(next: OHLC | null, appended: boolean) {
    if (hidden()) {
      liveDirty = true;
      liveAppendedWhileHidden = liveAppendedWhileHidden || appended;
      return;
    }
    paintLive(next, appended);
  }
  function paintLive(next: OHLC | null, appended: boolean) {
    if (!series) return;
    const st = currentTokens().styles;
    if (
      next &&
      // Per-bar colours (prev-close colouring, hollow candles) are computed
      // in setDataForType; a bare update() would paint the live bar with the
      // series-default colours.
      ((activeType === "candle" && !st.candle.prevClose) || (activeType === "bar" && !st.bar.prevClose))
    ) {
      // ISeriesApi<"Candlestick"|"Bar">.update accepts CandlestickData; our
      // OHLC is shape-compatible (time + o/h/l/c).
      (series as { update: (d: OHLC) => void }).update(next);
    } else {
      setDataForType(series, activeType, raw, currentTokens(), dataExtras());
      afterSeriesData();
    }
    // Recompute active studies against the mutated bars so indicator lines
    // track the live bar instead of lagging until the next reload.
    controller?.renderAll();
    refreshIndicatorLegend(crosshairActive ? lastLegendTime : undefined);
    if (appended) updateSessionBreaks();
    // A forming bar can push a new visible extreme without appending.
    else updateHighLowLines();
    // Keep the legend on the latest bar unless the user is hovering one.
    if (!crosshairActive) refreshLegend();
  }

  /** Merge one live bar into `raw`. Returns the merged bar + whether it
   *  appended (null = stale/ignored). `repaint=false` lets batch callers (the
   *  seconds refetch loop) merge many bars and paint once at the end. */
  function applyLiveBar(bar: LiveBar, repaint = true): { next: OHLC; appended: boolean } | null {
    // Mid-transition the outgoing symbol's candles are still painted; ignore
    // ticks (which are for the incoming symbol) until the swap completes.
    if (swapping) return null;
    const lastTime = raw.length > 0 ? (raw[raw.length - 1].time as number) : -1;
    let next: OHLC;
    let appended = false;
    if (lastTime === bar.time) {
      const last = raw[raw.length - 1];
      // Volume semantics per source: 1-minute buckets + 1D day bars carry the
      // bucket's authoritative cumulative volume → replace. 1W/1M ticks carry
      // TODAY'S day volume only, not the forming week/month's cumulative —
      // replacing would drop the prior days, so accumulate over a per-day
      // baseline (the bar's volume when the current day first ticked =
      // cumulative-before-today; re-snapped when the day advances). Coarser
      // intraday buckets only see the CURRENT minute's volume, so `max` keeps
      // the freshest value without double-counting the 5s snapshot repeats
      // (undercounts multi-minute buckets — the honest floor).
      const iv = props.interval ?? "1D";
      let vol: number;
      if (bar.volumeIsIncrement) {
        // A 1-second stream bar inside a wider seconds bucket: its volume is
        // that second only → add. The 30s REST tail merge (replace, below)
        // re-anchors the bucket to the authoritative total.
        vol = (last.volume ?? 0) + bar.volume;
      } else if (iv === "1" || iv === "1D" || isSecondResolution(iv)) {
        // Authoritative buckets: 1m/1D snapshots and the seconds tail refetch
        // both carry the bucket's full cumulative volume → replace. (Seconds
        // must NOT accumulate — every 30s tail merge would re-add the overlap.)
        vol = bar.volume;
      } else if (!isIntradayResolution(iv)) {
        const day = bar.dayTime ?? 0;
        if (!liveVolBase || liveVolBase.barTime !== bar.time || liveVolBase.dayTime !== day) {
          // Cold daily loads include today's PARTIAL bar in the aggregate;
          // subtract it so the baseline is strictly cumulative-before-today.
          // (The warm path excludes today, so the lookup simply misses.)
          const todaysPartial = rawDaily.find((c) => (c.time as number) === day)?.volume ?? 0;
          liveVolBase = {
            barTime: bar.time,
            dayTime: day,
            base: Math.max(0, (last.volume ?? 0) - todaysPartial),
          };
        }
        vol = liveVolBase.base + bar.volume;
      } else {
        vol = Math.max(last.volume ?? 0, bar.volume);
      }
      next = {
        time: bar.time as UTCTimestamp,
        open: last.open,
        high: Math.max(last.high, bar.high),
        low: Math.min(last.low, bar.low),
        close: bar.close,
        volume: vol,
      };
      raw[raw.length - 1] = next;
    } else if (bar.time > lastTime) {
      next = {
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
      raw.push(next);
      appended = true;
      // A fresh 1W/1M bar starts with today's volume only → baseline 0, so a
      // same-day merge tick doesn't re-snap the baseline onto today's volume
      // and double-count it.
      liveVolBase = { barTime: bar.time, dayTime: bar.dayTime ?? 0, base: 0 };
    } else {
      return null; // stale bar (older than last) — ignore
    }
    if (repaint) paintLiveOrDefer(next, appended);
    return { next, appended };
  }

  let unlistenAggregate: UnlistenFn | null = null;
  // Pane unmounted before the listen promise resolved — the late handle must
  // be released immediately or the Tauri listener leaks for the window's life.
  let aggregateDisposed = false;
  onMount(() => {
    // The datafeed filters by symbol and buckets by the current resolution;
    // accessors are read per-tick so the listener follows symbol/interval changes.
    subscribeBars(() => props.symbol, () => props.interval ?? "1D", applyLiveBar, () => props.session ?? "RTH").then((u) => {
      if (aggregateDisposed) { u(); return; }
      unlistenAggregate = u;
    });
  });

  // Volume footprint sub-bars: fetch the 1-minute window when the type is
  // active on an intraday frame (5 trading days — the datafeed's 1m lookback;
  // older bars render as plain candles). Cleared when the type/symbol moves on.
  createEffect(() => {
    const type = props.chartType ?? "candle";
    const sym = props.symbol;
    const id = props.interval ?? "1D";
    const sess = props.session ?? "RTH";
    subMinute = null;
    if (type !== "volFootprint" || !sym || !isIntradayInterval(id) || isSecondResolution(id)) return;
    let alive = true;
    const refresh = () => {
      getBars(sym, "1", sess)
        .then((r) => {
          if (!alive || (props.chartType ?? "candle") !== "volFootprint") return;
          subMinute = toOHLC(r.bars);
          if (series && !swapping) {
            setDataForType(series, activeType, raw, currentTokens(), { ...dataExtras(), subMinute });
            afterSeriesData();
          }
        })
        .catch(() => { /* footprint stays candle-only on fetch failure */ });
    };
    refresh();
    // The forming bar's cells go stale between fetches (live ticks reuse the
    // cached sub-bars) — refresh on a 60s cadence while the type is active;
    // the effect re-runs on type/symbol/interval/session change, so the timer
    // follows the pane's state.
    let lastRefresh = Date.now();
    const timer = window.setInterval(() => {
      if (swapping || hidden()) return;
      lastRefresh = Date.now();
      refresh();
    }, 60_000);
    // Hidden for a full cadence: refresh as soon as the tab is shown.
    const onShow = () => {
      if (swapping || Date.now() - lastRefresh < 60_000) return;
      lastRefresh = Date.now();
      refresh();
    };
    onShownHooks.add(onShow);
    onCleanup(() => { alive = false; window.clearInterval(timer); onShownHooks.delete(onShow); });
  });

  // Seconds REST refresh. When the key is entitled to the 1-second stream,
  // live bars arrive through subscribeBars and this refetch re-anchors them to
  // the authoritative REST buckets; without the stream (or while it is
  // disconnected) this is the only live path — the per-minute snapshot
  // aggregate cannot form sub-minute bars. It refetches the TAIL (last ~10
  // minutes) on a cadence and merges it through the live-bar merge. A tail
  // that doesn't overlap the loaded series (gap — e.g. the app slept past the
  // tail window) falls back to the full 1-3 day window refetch.
  createEffect(() => {
    const sym = props.symbol;
    const id = props.interval ?? "1D";
    const sess = props.session ?? "RTH";
    if (!sym || !isSecondResolution(id)) return;
    const TAIL_SEC = 600;
    /** Batch-merge refreshed bars at/after `lastTime`, then paint ONCE
     *  (per-bar repaints would re-derive the series data dozens of times per
     *  poll). Full-redraw path (next=null) so every series type repaints. */
    const mergeRows = (rows: OHLC[], lastTime: number) => {
      let appendedAny = false;
      let merged = false;
      for (const b of rows) {
        if ((b.time as number) < lastTime) continue;
        const res = applyLiveBar(
          {
            time: b.time as number,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume ?? 0,
          },
          false,
        );
        if (res) {
          merged = true;
          appendedAny = appendedAny || res.appended;
        }
      }
      if (merged) paintLiveOrDefer(null, appendedAny);
    };
    const stale = () => swapping || sym !== props.symbol || id !== (props.interval ?? "1D");
    const fullRefetch = () =>
      getBars(sym, id, sess)
        .then((r) => {
          if (stale()) return;
          const lastTime = raw.length > 0 ? (raw[raw.length - 1].time as number) : undefined;
          if (lastTime === undefined) return;
          mergeRows(toOHLC(r.bars), lastTime);
        })
        .catch(() => { /* transient fetch failure — next poll retries */ });
    const timer = window.setInterval(() => {
      if (swapping || history.loading || raw.length === 0) return;
      const lastTime = raw[raw.length - 1].time as number;
      const tail = getSecondBarsTail(sym, id, lastTime - TAIL_SEC, sess);
      if (!tail) return;
      tail
        .then((rows) => {
          if (stale()) return;
          const ohlc = toOHLC(rows);
          if (ohlc.length === 0) return; // nothing new (closed market) — skip
          // Overlap check: the tail must reach back to (or past) the loaded
          // series' newest bar, else there's a gap only a full window can fill.
          if ((ohlc[0].time as number) > lastTime) {
            void fullRefetch();
            return;
          }
          mergeRows(ohlc, lastTime);
        })
        .catch(() => { /* transient fetch failure — next poll retries */ });
    }, 30_000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => {
    aggregateDisposed = true;
    unlistenAggregate?.();
    // Clear only THIS pane's slot — sibling panes keep their live symbols.
    setLiveSymbol(null, String(paneId)).catch(() => {});
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
    if (!chart) return;
    chart.applyOptions(appearanceOptions(t));
    // Right margin (bars) nudges the view, so apply it off the initial mount.
    chart.timeScale().applyOptions({ rightOffset: t.rightOffset });
    rebuildSeries();
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
  const intervalText = createMemo(() => intervalLabel(props.interval ?? "1D"));
  const [legendDesc, setLegendDesc] = createSignal("");

  // -- Latest news (Events tab) ------------------------------------------
  // Latest updates: the newest headline of the symbol, refreshed
  // every 5 min; none if it is older than 31 days; not on seconds
  // intervals. A headline that arrives after the first load raises the red
  // "new" dot until the lollipop is clicked.
  const [news, setNews] = createSignal<NewsItem | null>(null);
  const [newsHasNew, setNewsHasNew] = createSignal(false);
  const [newsCardOpen, setNewsCardOpen] = createSignal(false);
  const newsAvailable = createMemo(() => !isSecondResolution(props.interval ?? "1D"));
  createEffect(() => {
    const sym = ticker();
    const on = appearance().latestNews ?? true;
    const available = newsAvailable();
    setNews(null);
    setNewsHasNew(false);
    setNewsCardOpen(false);
    if (!sym || !on || !available) return;
    let alive = true;
    let lastId: string | null | undefined;
    const load = () =>
      getLatestNews(sym, 1)
        .then((list) => {
          if (!alive) return;
          const it = list[0] ?? null;
          const fresh = it && Date.now() - it.published < NEWS_MAX_AGE_MS ? it : null;
          if (lastId !== undefined && fresh && fresh.id !== lastId) setNewsHasNew(true);
          lastId = fresh?.id ?? null;
          setNews(fresh);
        })
        .catch(() => {});
    load();
    let lastLoad = Date.now();
    const timer = setInterval(() => {
      if (hidden()) return;
      lastLoad = Date.now();
      load();
    }, NEWS_UPDATE_MS);
    const onShow = () => {
      if (Date.now() - lastLoad < NEWS_UPDATE_MS) return;
      lastLoad = Date.now();
      load();
    };
    onShownHooks.add(onShow);
    onCleanup(() => { alive = false; clearInterval(timer); onShownHooks.delete(onShow); });
  });
  function catchUpOnShow() {
    if (liveDirty) {
      const appended = liveAppendedWhileHidden;
      liveDirty = false;
      liveAppendedWhileHidden = false;
      paintLive(null, appended);
    }
    updateCountdown();
    setMarketSession(usMarketSession());
    for (const f of [...onShownHooks]) f();
  }
  let wasShown = !hidden();
  createEffect(() => {
    const shown = !hidden();
    if (shown && !wasShown) untrack(catchUpOnShow);
    wasShown = shown;
  });

  // Interval change closes the card.
  createEffect(() => { void props.interval; setNewsCardOpen(false); });
  createEffect(() => {
    newsLollipop.setState({ visible: news() !== null, hasNew: newsHasNew(), active: newsCardOpen() });
  });
  function toggleNewsCard() {
    if (!newsCardOpen()) setNewsHasNew(false);
    setNewsCardOpen(!newsCardOpen());
  }
  /** Card anchor (viewport px): point = lollipop centre - 10.5 - 8, card
   *  centred on it, bottom 6 px above it (measured on the earnings card). */
  const newsCardPos = () => {
    if (!newsCardOpen() || !chart || !paneRoot) return null;
    void scaleGeom();
    const c = newsLollipop.center(chart.paneSize(0).height);
    if (!c) return null;
    const r = paneRoot.getBoundingClientRect();
    const leftAxis = currentTokens().scalesPlacement === "left" ? chart.priceScale("left").width() : 0;
    const x = r.left + leftAxis + c.x;
    const pointY = r.top + c.y - 10.5 - 8;
    const width = 300;
    return {
      left: Math.max(0, Math.min(window.innerWidth - width, Math.round(x - width / 2))),
      bottom: Math.round(window.innerHeight - (pointY - 6)),
      maxHeight: Math.max(0, Math.round(pointY - 6 - 15)),
    };
  };
  createEffect(() => {
    const mode = appearance().legendTitleMode;
    const sym = ticker();
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
    const sym = ticker();
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
    const sym = ticker();
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
      }}
      onContextMenu={openContextMenu}
      onMouseEnter={() => { refreshScaleOverlays(); refreshPaneBoxes(); }}
      onMouseMove={(e) => {
        const r = paneRoot.getBoundingClientRect();
        const pane = paneAtY(e.clientY - r.top);
        setHoverPane(pane);
        const g = scaleGeom();
        const x = e.clientX - r.left;
        setAxisHover(g && pane !== null && (g.left ? x < g.w : x >= r.width - g.w) ? pane : null);
      }}
      onMouseLeave={() => { setAxisHover(null); setHoverPane(null); setPlusY(null); }}
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
        symbol={splitSymbol(props.symbol ?? "").ticker}
        coords={coords()}
        panes={drawingPanes()}
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
      <Show when={scaleGeom()}>
        {(g) => (
          <>
            {/* Currency label (12 px row). */}
            <Show when={currency() && overlayVisible(appearance().currencyUnit ?? "visibleOnMouseOver", axisHover() !== null)}>
              <div class="ot-price-currency" style={{ [g().left ? "left" : "right"]: "0px", width: `${g().w}px` }}>
                <div class="ot-price-currency-box" style={{ "background-color": readChartTokens(appearance()).bg }}>
                  <div class="ot-price-currency-row" style={{ "font-size": `${readChartTokens(appearance()).scaleFontSize}px` }} title="Currency">
                    <span>{currency()}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 5" width="7" height="5" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="1.2" d="M1 1.5l2.5 2 2.5-2" /></svg>
                  </div>
                </div>
              </div>
            </Show>
            {/* Auto / Log buttons (price-scale mode buttons). */}
            <Show when={overlayVisible(appearance().scaleModes ?? "visibleOnMouseOver", axisHover() === 0)}>
              <div class="ot-price-modes" style={{ [g().left ? "left" : "right"]: "0px", top: `${g().h - 30}px`, width: `${g().w}px` }}>
                <div class="ot-price-mode-wrap">
                  <button type="button" class={`ot-price-mode${scaleModes().auto ? " is-on" : ""}`} title="Auto (fits data to screen)" aria-label="Toggle auto scale" onClick={toggleAutoScale}>A</button>
                </div>
                <div class="ot-price-mode-wrap">
                  <button type="button" class={`ot-price-mode${scaleModes().log ? " is-on" : ""}`} title="Logarithmic" aria-label="Toggle log scale" onClick={toggleLogScale}>L</button>
                </div>
              </div>
            </Show>
            {/* Crosshair plus button (on the pane side of
                the crosshair price label). */}
            <Show when={appearance().plusButton !== false && plusY() !== null ? plusY() : null}>
              {(y) => {
                const size = () => readChartTokens(appearance()).scaleFontSize + 10;
                return (
                  <button
                    ref={plusEl}
                    type="button"
                    tabIndex={-1}
                    class={`ot-price-plus${g().left ? " is-left" : ""}`}
                    style={{
                      [g().left ? "left" : "right"]: `${g().w}px`,
                      top: `${Math.round(y() - size() / 2)}px`,
                      width: `${size()}px`,
                      height: `${size()}px`,
                      background: readChartTokens(appearance()).crosshairLabelBg,
                    }}
                    aria-label="Plus"
                  >
                    <svg viewBox="0 0 22 22" width={size()} height={size()} aria-hidden="true">
                      <path fill="currentColor" d="M10.5 7h1v8h-1zM7 10.5h8v1H7z" />
                      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1" />
                    </svg>
                  </button>
                );
              }}
            </Show>
          </>
        )}
      </Show>
      {/* Latest news card (lollipop tooltip, type "news"): "Latest updates"
          title, newest headline card. */}
      <Show when={news() && newsCardPos()}>
        {(pos) => (
          <div
            class="ot-news-card"
            style={{ left: `${pos().left}px`, bottom: `${pos().bottom}px`, "max-height": `${pos().maxHeight}px` }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div class="ot-news-card-title">
              <svg class="ot-news-card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
                <path fill="currentColor" d="M24.5 14A10.5 10.5 0 1 0 14 24.5V26a12 12 0 1 1 0-24 12 12 0 0 1 0 24v-1.5c5.8 0 10.5-4.7 10.5-10.5" />
                <path fill="currentColor" d="m17.03 7.5 1.02.9-4.02 4.93h5.29l-8.35 7.17-1.02-.9 4.02-4.93H8.68z" />
              </svg>
              <span class="ot-news-card-heading">Latest updates</span>
            </div>
            <div class="ot-news-card-main">
              {/* OT has no news view yet, so the headline opens the article
                  in the browser. */}
              <button
                type="button"
                class="ot-news-item"
                onClick={() => {
                  const url = news()?.url;
                  setNewsCardOpen(false);
                  if (url) void openUrl(url).catch((e) => console.warn("[news] open article failed", e));
                }}
              >
                <div class="ot-news-item-header">
                  <span><time title={formatNewsDate(news()!.published)}>{formatAgo(news()!.published, Date.now())}</time></span>
                  <span>{news()!.publisher}</span>
                </div>
                <div class="ot-news-item-title">{news()!.title}</div>
                <div class="ot-news-item-footer">
                  <div>See all</div>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
                    <path fill="currentColor" d="M2.77 0v.01h.01l3 3.67.26.32-.25.32-3 3.67h-.01L2.77 8 2 7.37 4.72 4 2 .63z" />
                  </svg>
                </div>
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={scaleGeom() && paneBoxes().length > 1 && (host?.clientWidth ?? 0) >= 356}>
        <For each={paneBoxes()}>
          {(b) => {
            const shown = () => {
              const mode = appearance().paneButtons ?? "visibleOnMouseOver";
              return mode === "alwaysOn" || (mode === "visibleOnMouseOver" && hoverPane() === b.index);
            };
            const compact = () => (host?.clientWidth ?? 0) < 666.65;
            const a = () => paneActions(b.index);
            // Pane buttons: common tooltip; collapse / restore carry the
            // "Ctrl + Double click" hint (data-tooltip-hotkey). The tooltip
            // side is not verified.
            const btn = (svg: string, title: string, run: () => void, active = false, hint = false) => (
              <Tooltip text={title} hotkey={hint ? "Ctrl" : undefined} hotkeyText={hint ? "{0} + Double click" : undefined} side="bottom">
                <div class={`ot-pane-btn${active ? " is-active" : ""}`} aria-label={title} onMouseDown={(e) => e.stopPropagation()} onClick={run} innerHTML={svg} />
              </Tooltip>
            );
            return (
              <Show when={shown()}>
                <div class="ot-pane-controls" style={{ top: `${b.top + 4}px`, [scaleGeom()!.left ? "left" : "right"]: `${scaleGeom()!.w + 4}px` }}>
                  <Show
                    when={!compact()}
                    fallback={
                      <Tooltip text="Manage panes" side="bottom">
                        <div class="ot-pane-btn" aria-label="Manage panes" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => openPaneMenu(e, b.index)} innerHTML={PANE_ICONS.more} />
                      </Tooltip>
                    }
                  >
                    <Show when={a().up}>{btn(PANE_ICONS.up, "Move pane up", () => movePane(b.index, -1))}</Show>
                    <Show when={a().down}>{btn(PANE_ICONS.down, "Move pane down", () => movePane(b.index, 1))}</Show>
                    <Show when={a().close}>{btn(PANE_ICONS.close, "Delete pane", () => deletePane(b.index))}</Show>
                    <Show when={a().collapse}>{btn(PANE_ICONS.collapse, "Collapse pane", () => toggleCollapse(b.index), false, true)}</Show>
                    <Show when={a().restore}>{btn(PANE_ICONS.restore, "Restore pane", () => toggleCollapse(b.index), true, true)}</Show>
                  </Show>
                </div>
              </Show>
            );
          }}
        </For>
      </Show>
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
      <div class="ot-legend-stack">
        <ChartLegend
          ticker={splitSymbol(props.symbol ?? "").ticker}
          interval={intervalLabel(props.interval ?? "1D")}
          exchange={splitSymbol(props.symbol ?? "").exchange}
          values={legend()}
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
          onChangeSymbol={props.onChangeSymbol}
          onChangeInterval={props.onChangeInterval}
          onMore={openSeriesMoreMenu}
        />
        {studyLegend(0)}
      </div>
      {/* Study panes: each pane's legend at its own top-left, same offset
          as the main legend. */}
      <For each={paneBoxes().filter((b) => b.index > 0)}>
        {(b) => (
          <Show when={indLegend().some((r) => r.pane === b.index)}>
            <div class="ot-legend-stack" style={{ top: `${b.top + LEGEND_TOP}px` }}>
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
                title={isStrategyId(id()) ? (entry!.shortName ?? entry!.name) : entry!.name}
                strategy={strategy}
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
                onSaveAsDefault={(next) => saveIndicatorDefault(id(), next)}
                onClose={() => {
                  setSettingsForId(null);
                  setSettingsTab(undefined);
                }}
              />
            </Show>
          );
        }}
      </Show>
      <Show when={ctxMenu()}>
        {(m) => (
          <ChartContextMenu x={m().x} y={m().y} nodes={m().nodes} onClose={() => setCtxMenu(null)} />
        )}
      </Show>
    </div>
  );
}
