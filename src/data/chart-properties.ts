/*
 * Chart "Settings" (series-properties) dialog — data model: dialog rows,
 * option lists and factory defaults.
 *
 * Rows carry a stable `id` (default: the label) — drafts are keyed by it, so
 * inserting a row no longer invalidates saved settings (see chart-settings).
 *
 * 7 sidebar tabs (data-qa-id) with their exact FontIcon svgs, one `FormItem[]`
 * per tab, plus one `style.<group>` form per chart type: the Symbol tab shows
 * the form of the pane's chart type above its own "Data modification" rows.
 */
import type { ChartTypeId } from "../window/chart/chart-types";
import { TIMEZONES } from "./timezones";

export type SettingsTabIcon = { viewBox: string; fill: string; inner: string };
export type SettingsTab = { id: string; label: string; icon: SettingsTabIcon };

export const SETTINGS_TABS: SettingsTab[] = [
  { id: "symbol", label: "Symbol", icon: { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" d=\"M12 7h-.75V4h-1.5v3H9a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h.75v3h1.5v-3H12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM9.5 19.5v-11h2v11h-2Zm8-3v-5h2v5h-2Zm.24-6.5H17a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.75v3h1.5v-3H20a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-.76V7h-1.5v3Z\"></path>" } },
  { id: "legend", label: "Status line", icon: { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M7 7h14a1 1 0 1 1 0 2H7a1 1 0 0 1 0-2ZM5 8c0-1.1.9-2 2-2h14a2 2 0 1 1 0 4H7a2 2 0 0 1-2-2Zm13 5H6v1h12v-1Zm0 4H6v1h12v-1ZM6 21h12v1H6v-1Z\"></path>" } },
  { id: "scales", label: "Scales and lines", icon: { viewBox: "0 0 28 28", fill: "none", inner: "<path stroke=\"currentColor\" d=\"M10.5 20.5a2 2 0 1 1-2-2m2 2a2 2 0 0 0-2-2m2 2h14m-16-2v-14m16 16L21 17m3.5 3.5L21 24M8.5 4.5L12 8M8.5 4.5L5 8\"></path>" } },
  { id: "canvas", label: "Canvas", icon: { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M18.965 5a2.5 2.5 0 0 1 1.666.73l1.637 1.637c.489.49.733 1.132.732 1.773a2.5 2.5 0 0 1-.73 1.762l-.789.789L10.171 23H4.998v-5.17l.147-.146 1.116-1.117L16.309 6.519l.785-.787A2.5 2.5 0 0 1 18.964 5M5.998 18.243v3.758h3.759l.615-.616-3.758-3.759zm1.323-1.324 3.76 3.759 9.339-9.34-3.758-3.759zM19.924 6.438a1.5 1.5 0 0 0-2.122 0l-.434.433 3.759 3.758.434-.434a1.5 1.5 0 0 0 0-2.12z\"></path>" } },
  { id: "trading", label: "Trading", icon: { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M17.138 18.207a2.098 2.098 0 0 1-2.461 3.4l-4.68-3.359-4.673 3.357a2.097 2.097 0 0 1-2.463-3.398L9.997 13zm-13.687.808a1.097 1.097 0 0 0-.222 1.555 1.1 1.1 0 0 0 1.512.223l5.256-3.775 5.263 3.776a1.1 1.1 0 0 0 1.289-1.78l-6.552-4.777zM22.677 6.394a2.098 2.098 0 0 1 2.46 3.4L17.998 15l-7.136-5.207a2.097 2.097 0 0 1 2.463-3.397l4.673 3.356zm2.095 1.035a1.1 1.1 0 0 0-1.512-.223l-5.263 3.776-5.256-3.775a1.1 1.1 0 0 0-1.512.223 1.097 1.097 0 0 0 .222 1.555l6.546 4.778 6.552-4.778c.499-.364.6-1.067.223-1.556\"></path>" } },
  { id: "alerts", label: "Alerts", icon: { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" d=\"M20.1 4 25 9.32l-.73.68-4.9-5.32.73-.68ZM7.9 4 3 9.32l.73.68 4.91-5.32L7.91 4ZM14 15v-5h1v6h-4v-1h3Z\"></path><path fill=\"currentColor\" d=\"M5 15a9 9 0 1 1 18 0 9 9 0 0 1-18 0Zm9-8a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z\"></path>" } },
  { id: "events", label: "Events", icon: { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" d=\"M10 6h8V4h1v2h1.5A2.5 2.5 0 0 1 23 8.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 5 19.5v-11A2.5 2.5 0 0 1 7.5 6H9V4h1zM6 19.5A1.5 1.5 0 0 0 7.5 21h13a1.5 1.5 0 0 0 1.5-1.5V11H6zM7.5 7A1.5 1.5 0 0 0 6 8.5V10h16V8.5A1.5 1.5 0 0 0 20.5 7H19v1h-1V7h-8v1H9V7z\"></path>" } },
];

export const DEFAULT_SETTINGS_TAB = 'symbol';

/** Factory up/down colours (candles, bars, renko…). */
export const CANDLE_COLORS = { up: "#089981", down: "#F23645" };
const UP = CANDLE_COLORS.up;
const DOWN = CANDLE_COLORS.down;
/** Factory projection colours (renko / line break / kagi / P&F / range) of
 *  the dark standard theme; the light theme uses LIGHT_PROJECTION_COLORS. */
export const PROJECTION_COLORS = { up: "#336854", down: "#7F323F" };
export const LIGHT_PROJECTION_COLORS = { up: "#A9DCC3", down: "#F5A6AE" };
const UP_PROJ = PROJECTION_COLORS.up;
const DOWN_PROJ = PROJECTION_COLORS.down;

/* ── Control / row model ────────────────────────────────────────────────────
 * Controls map to property-definition renderers:
 *   select      — select (menu of options).
 *   multicheck  — check-list select ("Value, line" / "Hidden").
 *   color       — `color-select`: 34×34 box, palette popup (+ Opacity unless
 *                 `noOpacity`). With `width` and/or `style` it becomes the
 *                 75×34 combined button (`color-with-thickness-select` /
 *                 line-style variant): swatch + line preview, the popup adds
 *                 Thickness (1–4) / Line style sections. `color: ""` = the
 *                 automatic colour (red/teal placeholder swatch).
 *   colorPair   — two `color-select` boxes (up / down, fill / border…).
 *   lineColor   — line colour with a Solid/Gradient type select
 *                 (line-family chart types).
 *   input       — text/number field; `num` makes it a number input
 *                 (100×34 with spin buttons), `unit` sits outside.
 *   slider      — Transparency slider (value = transparency 0–100).
 * Line style enum everywhere: 0 solid, 1 dashed, 2 dotted (menu order). */
export type Control =
  | { c: 'select'; value: string; options: string[]; disabled?: boolean }
  | { c: 'color'; color: string; noOpacity?: boolean; width?: number; style?: number }
  | { c: 'colorPair'; up: string; down: string; noOpacity?: boolean }
  | { c: 'lineColor'; type: 'Solid' | 'Gradient'; color: string; start: string; end: string; width: number; style: number }
  | { c: 'input'; value: string; unit?: string; disabled?: boolean; num?: { min: number; max: number; step: number; int?: boolean } }
  | { c: 'slider'; value: number }
  | { c: 'multicheck'; options: string[]; on: string[] };

/** Show a row only while another row's select (same form) has one of `values`. */
export type VisibleWhen = { id: string; values: string[] };

export type FormRow = {
  /** Stable draft key (default: the label). Required when label is null. */
  id?: string;
  /** Row label (null = a continuation row with only controls). */
  label?: string | null;
  /** Leading checkbox (before the label). */
  cb?: boolean;
  checked?: boolean;
  /** Nest under the previous row (26 px offset). */
  indent?: boolean;
  /** "Grouped" cell: 4 px cell padding (42 px row), e.g. Events rows. */
  grouped?: boolean;
  /** Child row of a checkable set / continuation row (margin-top −8 px):
   *  sits 42 px under its parent. */
  child?: boolean;
  /** Trailing (?) help icon after the label. A string is its hover text;
   *  `true` is an icon without hover text (Positions and orders, Execution
   *  marks). */
  help?: boolean | string;
  /** Muted helper line rendered under the label. */
  desc?: string;
  /** Right-aligned controls, in order. */
  controls?: Control[];
  visibleWhen?: VisibleWhen;
  /** Shown disabled (greyed, not editable): no ported surface (e.g. Trading). */
  inert?: boolean;
  /** Stored chart setting with no dialog row (set from a chart menu). */
  hidden?: boolean;
};

export type FormItem =
  | { kind: 'section'; text: string }
  /** Group separator without a title (16 px). */
  | { kind: 'gap' }
  | ({ kind: 'row' } & FormRow);

const section = (text: string): FormItem => ({ kind: 'section', text });
const gap = (): FormItem => ({ kind: 'gap' });
const row = (r: FormRow): FormItem => ({ kind: 'row', ...r });

export const rowIdOf = (r: FormRow): string => r.id ?? r.label ?? '';

/* ── Option catalogs ───────────────────────────────────────────────────── */
export const PRECISION_OPTIONS = [
  "Default", "Integer",
  "1 decimal", "2 decimals", "3 decimals", "4 decimals", "5 decimals", "6 decimals",
  "7 decimals", "8 decimals", "9 decimals", "10 decimals", "11 decimals", "12 decimals",
  "13 decimals", "14 decimals", "15 decimals",
  "1/2", "1/4", "1/8", "1/16", "1/32", "1/64", "1/128", "1/320",
];
const VISIBILITY = ["Visible on mouse over", "Always visible", "Always invisible"];
const DATE_FORMAT = [
  "Mon Q3 '97", "Mon Q3 1997", "Mon 29 Sep '97", "Mon Sep '97", "Mon Sep 29, 1997",
  "Mon Sep 1997", "Mon Sep 29", "Mon 29 Sep", "Mon 1997-09-29", "Mon 97-09-29",
  "Mon 97/09/29", "Mon 1997/09/29", "Mon 29-09-1997", "Mon 29-09-97", "Mon 29/09/97",
  "Mon 29/09/1997", "Mon 09/29/97", "Mon 09/29/1997",
];
const FONT_SIZES = ["8", "10", "11", "12", "14", "16", "18", "20", "22", "24", "28", "32", "40"];
/** Base price sources, in menu order. */
export const PRICE_SOURCES = ["Open", "High", "Low", "Close", "(H + L)/2", "(H + L + C)/3", "(O + H + L + C)/4"];
const BOX_METHODS = ["ATR", "Traditional", "Percentage LTP"];
/** Session select: Regular / Extended. A "24 hours" option would need
 *  overnight (Blue Ocean) bars, which the Polygon plan does not carry — the
 *  same two sessions as the bottom-bar session menu. */
export const SESSION_OPTIONS = ["Regular", "Extended"];
/** Timezone menu (UTC, Exchange, then the offset-prefixed zones). */
const TIMEZONE_OPTIONS = TIMEZONES.map((t) => t.label);

/* ── Per-chart-type style forms (+ factory defaults) ───────────────────── */

/** Style-form key of each OT chart type. */
export type StyleGroup =
  | 'bar' | 'candle' | 'volCandles' | 'hollowCandle' | 'ha'
  | 'line' | 'lineWithMarkers' | 'stepline'
  | 'area' | 'hlcArea' | 'baseline' | 'column' | 'hilo'
  | 'renko' | 'pb' | 'kagi' | 'pnf' | 'range'
  | 'volFootprint' | 'tpo' | 'svp';

export const styleGroupOf = (t: ChartTypeId): StyleGroup => t as StyleGroup;

/** Chart-style names — the Symbol tab's
 *  first section title. */
export const STYLE_TITLES: Record<StyleGroup, string> = {
  bar: 'Bars', candle: 'Candles', volCandles: 'Volume candles', hollowCandle: 'Hollow candles', ha: 'Heikin Ashi',
  line: 'Line', lineWithMarkers: 'Line with markers', stepline: 'Step line',
  area: 'Area', hlcArea: 'HLC area', baseline: 'Baseline', column: 'Columns', hilo: 'High-low',
  renko: 'Renko', pb: 'Line break', kagi: 'Kagi', pnf: 'Point & figure', range: 'Range',
  volFootprint: 'Volume footprint', tpo: 'Time price opportunity', svp: 'Session volume profile',
};

const prevCloseRow = (checked = false) => row({ cb: true, checked, label: 'Color bars based on previous close' });
const candleRows = (): FormItem[] => [
  row({ cb: true, checked: true, label: 'Body', controls: [{ c: 'colorPair', up: UP, down: DOWN }] }),
  row({ cb: true, checked: true, label: 'Borders', controls: [{ c: 'colorPair', up: UP, down: DOWN }] }),
  row({ cb: true, checked: true, label: 'Wick', controls: [{ c: 'colorPair', up: UP, down: DOWN }] }),
];
const lineRows = (): FormItem[] => [
  row({ label: 'Price source', controls: [{ c: 'select', value: 'Close', options: PRICE_SOURCES }] }),
  row({ label: 'Line', controls: [{ c: 'lineColor', type: 'Gradient', color: '#2962FF', start: '#D500F9', end: '#00BCE5', width: 2, style: 0 }] }),
];
/** Up / Down / Projection rows: fill + border pairs (renko, line break) or
 *  single colours (kagi, P&F, range bars). */
const barSetRows = (border: boolean): FormItem[] => border
  ? [
      row({ label: 'Up bars', controls: [{ c: 'colorPair', up: UP, down: UP }] }),
      row({ label: 'Down bars', controls: [{ c: 'colorPair', up: DOWN, down: DOWN }] }),
      row({ label: 'Projection up bars', controls: [{ c: 'colorPair', up: UP_PROJ, down: UP_PROJ }] }),
      row({ label: 'Projection down bars', controls: [{ c: 'colorPair', up: DOWN_PROJ, down: DOWN_PROJ }] }),
    ]
  : [
      row({ label: 'Up bars', controls: [{ c: 'color', color: UP }] }),
      row({ label: 'Down bars', controls: [{ c: 'color', color: DOWN }] }),
      row({ label: 'Projection up bars', controls: [{ c: 'color', color: UP_PROJ }] }),
      row({ label: 'Projection down bars', controls: [{ c: 'color', color: DOWN_PROJ }] }),
    ];
const num = (value: number | string, min: number, max: number, step = 1, int = false, unit?: string): Control =>
  ({ c: 'input', value: String(value), unit, num: { min, max, step, int } });
/** Box-size inputs (chart-style study inputs).
 *  The method select is labelled "Box size assignment method" for every type,
 *  each size field visible only for its method. */
const boxInputs = (sizeLabel: 'Box size' | 'Reversal amount', sizeDefault: number): FormItem[] => [
  row({ id: 'Style', label: 'Box size assignment method', controls: [{ c: 'select', value: 'ATR', options: BOX_METHODS }] }),
  row({ label: sizeLabel, controls: [num(sizeDefault, 0.000001, 1e9, 0.01)], visibleWhen: { id: 'Style', values: ['Traditional'] } }),
  row({ label: 'ATR length', controls: [num(14, 1, 100, 1, true)], visibleWhen: { id: 'Style', values: ['ATR'] } }),
  row({ label: 'Percentage', controls: [num(1, 0, 100, 0.01, false, '%')], visibleWhen: { id: 'Style', values: ['Percentage LTP'] } }),
];

export const STYLE_FORMS: Record<StyleGroup, FormItem[]> = {
  bar: [
    prevCloseRow(),
    row({ cb: true, checked: false, label: 'HLC bars' }),
    row({ label: 'Up color', controls: [{ c: 'color', color: UP }] }),
    row({ label: 'Down color', controls: [{ c: 'color', color: DOWN }] }),
    row({ cb: true, checked: true, label: 'Thin bars' }),
  ],
  candle: [prevCloseRow(), ...candleRows()],
  volCandles: [prevCloseRow(), ...candleRows()],
  hollowCandle: candleRows(),
  ha: [
    row({ cb: true, checked: false, label: 'Real prices on price scale (instead of Heikin-Ashi price)' }),
    prevCloseRow(),
    ...candleRows(),
  ],
  line: lineRows(),
  lineWithMarkers: lineRows(),
  stepline: lineRows(),
  area: [
    row({ label: 'Price source', controls: [{ c: 'select', value: 'Close', options: PRICE_SOURCES }] }),
    row({ label: 'Line', controls: [{ c: 'color', color: '#2962FF', width: 2, style: 0 }] }),
    // Area fill color1 / color2 (top / bottom), both at `transparency`.
    row({ label: 'Fill', controls: [{ c: 'colorPair', up: 'rgba(41, 98, 255, 0.28)', down: 'rgba(41, 98, 255, 0)' }] }),
  ],
  hlcArea: [
    row({ cb: true, checked: true, label: 'High line', controls: [{ c: 'color', color: '#00BCD4', width: 2 }] }),
    row({ cb: true, checked: true, label: 'Low line', controls: [{ c: 'color', color: '#E91E63', width: 2 }] }),
    row({ label: 'Close line', controls: [{ c: 'color', color: '#2962FF', width: 2 }] }),
    row({ label: 'Fill', controls: [{ c: 'colorPair', up: 'rgba(0, 188, 212, 0.25)', down: 'rgba(233, 30, 99, 0.25)' }] }),
  ],
  baseline: [
    row({ label: 'Price source', controls: [{ c: 'select', value: 'Close', options: PRICE_SOURCES }] }),
    row({ label: 'Top line', controls: [{ c: 'color', color: UP, width: 2, style: 0 }] }),
    row({ label: 'Bottom line', controls: [{ c: 'color', color: DOWN, width: 2, style: 0 }] }),
    row({ label: 'Fill top area', controls: [{ c: 'colorPair', up: 'rgba(8, 153, 129, 0.28)', down: 'rgba(8, 153, 129, 0.05)' }] }),
    row({ label: 'Fill bottom area', controls: [{ c: 'colorPair', up: 'rgba(242, 54, 69, 0.05)', down: 'rgba(242, 54, 69, 0.28)' }] }),
    row({ label: 'Base level', controls: [num(50, 0, 100, 1, true, '%')] }),
  ],
  column: [
    row({ label: 'Price source', controls: [{ c: 'select', value: 'Close', options: PRICE_SOURCES }] }),
    prevCloseRow(true),
    row({ label: 'Up color', controls: [{ c: 'color', color: 'rgba(8, 153, 129, 0.5)' }] }),
    row({ label: 'Down color', controls: [{ c: 'color', color: 'rgba(242, 54, 69, 0.5)' }] }),
  ],
  hilo: [
    row({ cb: true, checked: true, label: 'Body', controls: [{ c: 'color', color: '#2962FF' }] }),
    row({ cb: true, checked: true, label: 'Borders', controls: [{ c: 'color', color: '#2962FF' }] }),
    row({ cb: true, checked: true, label: 'Labels', controls: [{ c: 'color', color: '#2962FF' }] }),
  ],
  renko: [
    ...barSetRows(true),
    row({ cb: true, checked: true, label: 'Wick', controls: [{ c: 'colorPair', up: UP, down: DOWN }] }),
    row({ label: 'Source', controls: [{ c: 'select', value: 'Close', options: ['Close', 'OHLC'] }] }),
    ...boxInputs('Box size', 3),
  ],
  pb: [
    ...barSetRows(true),
    row({ label: 'Number of line', controls: [num(3, 1, 100, 1, true)] }),
  ],
  kagi: [
    ...barSetRows(false),
    ...boxInputs('Reversal amount', 1),
  ],
  pnf: [
    ...barSetRows(false),
    row({ label: 'Source', controls: [{ c: 'select', value: 'Close', options: ['HL', 'Close'] }] }),
    ...boxInputs('Box size', 1),
    row({ label: 'Reversal amount', id: 'Reversal', controls: [num(3, 1, 100, 1, true)] }),
    row({ cb: true, checked: false, label: 'One step back building' }),
  ],
  range: [
    row({ label: 'Style', controls: [{ c: 'select', value: 'Bars', options: ['Bars', 'Candles'] }] }),
    // Bars style: colours + projection + thin bars.
    row({ label: 'Up bars', controls: [{ c: 'color', color: UP }], visibleWhen: { id: 'Style', values: ['Bars'] } }),
    row({ label: 'Down bars', controls: [{ c: 'color', color: DOWN }], visibleWhen: { id: 'Style', values: ['Bars'] } }),
    row({ label: 'Projection up bars', controls: [{ c: 'color', color: UP_PROJ }], visibleWhen: { id: 'Style', values: ['Bars'] } }),
    row({ label: 'Projection down bars', controls: [{ c: 'color', color: DOWN_PROJ }], visibleWhen: { id: 'Style', values: ['Bars'] } }),
    row({ cb: true, checked: true, label: 'Thin bars', visibleWhen: { id: 'Style', values: ['Bars'] } }),
    // Candles style.
    row({ label: 'Body', controls: [{ c: 'colorPair', up: UP, down: DOWN }], visibleWhen: { id: 'Style', values: ['Candles'] } }),
    row({ label: 'Borders', controls: [{ c: 'colorPair', up: UP, down: DOWN }], visibleWhen: { id: 'Style', values: ['Candles'] } }),
    row({ label: 'Wick', controls: [{ c: 'colorPair', up: UP, down: DOWN }], visibleWhen: { id: 'Style', values: ['Candles'] } }),
    row({ label: 'Projection candles', controls: [{ c: 'colorPair', up: UP_PROJ, down: DOWN_PROJ }], visibleWhen: { id: 'Style', values: ['Candles'] } }),
    row({ cb: true, checked: false, label: 'Phantom bars' }),
  ],
  // Volume footprint and TPO: their settings pages need renderers this app
  // does not have (tick-based imbalance / stacked levels / summary rows; TPO
  // letters, blocks, initial balance). No rows until those renderers exist.
  volFootprint: [],
  tpo: [],
  // Session volume profile (three groups, no chart-type title), factory
  // svpStyle / VbPSessions inputs.
  svp: [
    section('Volume Profile'),
    row({ cb: true, checked: false, label: 'Values', controls: [{ c: 'color', color: '#DBDBDB' }] }),
    row({ label: 'Width', controls: [num(100, 1, 100, 1, true, '%')] }),
    row({ label: 'Placement', controls: [{ c: 'select', value: 'Left', options: ['Left', 'Right'] }] }),
    row({ label: 'Up volume', controls: [{ c: 'color', color: 'rgba(38, 198, 218, 0.5)' }] }),
    row({ label: 'Down volume', controls: [{ c: 'color', color: 'rgba(236, 64, 122, 0.5)' }] }),
    row({ label: 'Value area up', controls: [{ c: 'color', color: 'rgba(38, 198, 218, 0.75)' }] }),
    row({ label: 'Value area down', controls: [{ c: 'color', color: 'rgba(236, 64, 122, 0.75)' }] }),
    row({ label: 'Histogram box', controls: [{ c: 'color', color: 'rgba(38, 198, 218, 0.05)' }] }),
    section('Lines'),
    row({ cb: true, checked: false, label: 'VAH', controls: [{ c: 'color', color: '#DBDBDB', width: 2, style: 0 }] }),
    row({ id: 'Extend VAH right', cb: true, checked: false, label: 'Extend right', indent: true, child: true }),
    row({ cb: true, checked: false, label: 'VAL', controls: [{ c: 'color', color: '#DBDBDB', width: 2, style: 0 }] }),
    row({ id: 'Extend VAL right', cb: true, checked: false, label: 'Extend right', indent: true, child: true }),
    row({ cb: true, checked: true, label: 'POC', controls: [{ c: 'color', color: '#DBDBDB', width: 2, style: 0 }] }),
    row({ id: 'Extend POC right', cb: true, checked: false, label: 'Extend right', indent: true, child: true }),
    row({ cb: true, checked: false, label: 'Developing POC', controls: [{ c: 'color', color: '#DBDBDB', width: 1, style: 0 }] }),
    row({ cb: true, checked: false, label: 'Developing VA', controls: [{ c: 'color', color: '#00BCD4', width: 1, style: 0 }] }),
    section('Inputs'),
    row({ label: 'Sessions', controls: [{ c: 'select', value: 'All', options: ['All', 'Each (pre-market, market, post-market)', 'Pre-market only', 'Market only', 'Post-market only', 'Custom'] }] }),
    row({ id: 'Custom session', label: null, child: true, controls: [{ c: 'input', value: '0930-1600' }], visibleWhen: { id: 'Sessions', values: ['Custom'] } }),
    row({ label: 'Volume', controls: [{ c: 'select', value: 'Up/Down', options: ['Up/Down', 'Total', 'Delta'] }] }),
    row({ label: 'Value area volume', controls: [num(70, 0, 100, 1, true)] }),
    row({ label: 'Rows layout', controls: [{ c: 'select', value: 'Number Of Rows', options: ['Number Of Rows', 'Ticks Per Row'] }] }),
    row({ label: 'Row size', controls: [num(24, 1, 100000, 1, true)] }),
  ],
};

/** Style form's draft tab id. */
export const styleTab = (g: StyleGroup) => `style.${g}`;

export const TAB_FORMS: Record<string, FormItem[]> = {
  // ── Symbol (below the chart-type section) ────────────────────────────────
  symbol: [
    section('Data modification'),
    row({ label: 'Session', controls: [{ c: 'select', value: 'Regular', options: SESSION_OPTIONS }] }),
    // Shown while the session is not Regular (intraday only — the dialog also
    // hides it on D/W/M).
    row({ label: 'Pre/post market hours background', controls: [{ c: 'color', color: 'rgba(255, 152, 0, 0.08)' }, { c: 'color', color: 'rgba(41, 98, 255, 0.08)' }], visibleWhen: { id: 'Session', values: ['Extended'] } }),
    row({ cb: true, checked: false, label: 'Adjust data for dividends', help: 'Click here to learn more' }),
    row({ label: 'Precision', controls: [{ c: 'select', value: 'Default', options: PRECISION_OPTIONS }] }),
    row({ label: 'Timezone', controls: [{ c: 'select', value: 'Exchange', options: TIMEZONE_OPTIONS }] }),
  ],

  // ── Status line ──────────────────────────────────────────────────────────
  legend: [
    section('Instrument'),
    row({ cb: true, checked: true, label: 'Logo' }),
    row({ cb: true, checked: true, label: 'Title', controls: [{ c: 'select', value: 'Name', options: ['Name', 'Symbol', 'Symbol and name'] }] }),
    row({ cb: true, checked: true, label: 'Open market status' }),
    row({ cb: true, checked: true, label: 'Chart values' }),
    row({ cb: true, checked: true, label: 'Bar change values' }),
    row({ cb: true, checked: false, label: 'Volume' }),
    row({ cb: true, checked: false, label: 'Last day change values' }),
    // Same property as Trading → "Buy/sell buttons";
    // no trading surface in this app.
    row({ id: 'Buy/sell buttons', cb: true, checked: false, label: 'Buy/sell buttons', desc: 'Displays buy and sell buttons directly on the chart', inert: true }),
    section('Indicators'),
    row({ cb: true, checked: true, label: 'Titles' }),
    row({ cb: true, checked: true, label: 'Inputs', indent: true, child: true }),
    row({ cb: true, checked: true, label: 'Values' }),
    gap(),
    // Legend background: checkbox + transparency slider (factory 50).
    row({ cb: true, checked: true, label: 'Background', controls: [{ c: 'slider', value: 50 }] }),
  ],

  // ── Scales and lines ─────────────────────────────────────────────────────
  scales: [
    section('Price Scale'),
    row({ label: 'Currency and Unit', controls: [{ c: 'select', value: 'Visible on mouse over', options: VISIBILITY }] }),
    row({ label: 'Scale modes (A and L)', controls: [{ c: 'select', value: 'Visible on mouse over', options: VISIBILITY }] }),
    // Value = the pane's live price/bar ratio (seeded by the dialog host).
    row({ cb: true, checked: false, label: 'Lock price to bar ratio', controls: [{ c: 'input', value: '', disabled: true, num: { min: 0, max: 1e12, step: 0.0000001 } }] }),
    // Price scale menu "Scale price chart only" (chart property
    // scalesProperties.scaleSeriesOnly; no Settings row).
    row({ cb: true, checked: false, label: 'Scale price chart only', hidden: true }),
    row({ label: 'Scales placement', controls: [{ c: 'select', value: 'Auto', options: ["Stack on the left", "Stack on the right", "Auto"] }] }),
    section('Price labels & lines'),
    row({ cb: true, checked: true, label: 'No overlapping labels' }),
    row({ cb: true, checked: true, label: 'Plus button', help: 'Click here to learn more' }),
    row({ cb: true, checked: true, label: 'Countdown to bar close' }),
    // Check lists. Symbol: check list + price-line colour / width
    // (priceLineColor "" = bar direction, priceLineWidth 1), then the
    // last-value mode select as a grouped continuation row.
    row({ label: 'Symbol', controls: [{ c: 'multicheck', options: ['Name', 'Value', 'Line'], on: ['Value', 'Line'] }, { c: 'color', color: '', width: 1, noOpacity: true }] }),
    row({ id: 'Symbol value mode', label: null, child: true, controls: [{ c: 'select', value: 'Value according to scale', options: ['Price and percentage value', 'Value according to scale'] }] }),
    row({ label: 'Previous day close', controls: [{ c: 'multicheck', options: ['Value', 'Line'], on: [] }, { c: 'color', color: '#555555', width: 1, noOpacity: true }] }),
    row({ label: 'Indicators and financials', controls: [{ c: 'multicheck', options: ['Name', 'Value'], on: [] }] }),
    row({ label: 'Pre/post/night market', controls: [{ c: 'multicheck', options: ['Value', 'Line'], on: ['Value', 'Line'] }, { c: 'color', color: '#FB8C00' }, { c: 'color', color: '#2962FF' }, { c: 'color', color: '#8E24AA' }] }),
    row({ label: 'High and low', controls: [{ c: 'multicheck', options: ['Value', 'Line'], on: ['Value'] }, { c: 'color', color: '', width: 1, noOpacity: true }] }),
    row({ label: 'Bid and ask', controls: [{ c: 'multicheck', options: ['Value', 'Line'], on: ['Value', 'Line'] }, { c: 'color', color: '#2962FF' }, { c: 'color', color: '#F7525F' }] }),
    section('Time Scale'),
    row({ cb: true, checked: true, label: 'Day of week on labels' }),
    row({ label: 'Date format', controls: [{ c: 'select', value: "Mon 29 Sep '97", options: DATE_FORMAT }] }),
    row({ label: 'Time hours format', controls: [{ c: 'select', value: '24-hours', options: ['24-hours', '12-hours'] }] }),
    row({ cb: true, checked: false, label: 'Save chart left edge position when changing interval' }),
  ],

  // ── Canvas ───────────────────────────────────────────────────────────────
  canvas: [
    section('Chart basic styles'),
    // Solid shows the first swatch only; Gradient shows top + bottom. The
    // background swatch has no Opacity section.
    row({ label: 'Background', controls: [{ c: 'select', value: 'Solid', options: ['Solid', 'Gradient'] }, { c: 'color', color: 'rgb(15, 15, 15)', noOpacity: true }, { c: 'color', color: 'rgb(30, 34, 45)', noOpacity: true }] }),
    // Grid: colour + Opacity + Line style (no thickness). Crosshair: colour +
    // Opacity + Thickness + Line style.
    row({ cb: true, checked: true, label: 'Vertical grid lines', controls: [{ c: 'color', color: 'rgba(242, 242, 242, 0.2)', style: 2 }] }),
    row({ cb: true, checked: true, label: 'Horizontal grid lines', controls: [{ c: 'color', color: 'rgba(242, 242, 242, 0.2)', style: 2 }] }),
    row({ label: 'Crosshair', controls: [{ c: 'color', color: 'rgb(156, 156, 156)', width: 1, style: 1 }] }),
    // Watermark: check-list select (Ticker / Interval / Description /
    // Replay mode) + colour. Replay mode is omitted (no replay in this app).
    row({ label: 'Watermark', controls: [{ c: 'multicheck', options: ['Ticker', 'Interval', 'Description'], on: [] }, { c: 'color', color: 'rgba(80, 83, 94, 0.3)' }] }),
    section('Scales'),
    row({ label: 'Text', controls: [{ c: 'color', color: 'rgb(184, 184, 184)' }, { c: 'select', value: '12', options: FONT_SIZES }] }),
    row({ label: 'Lines', controls: [{ c: 'color', color: 'rgba(242, 242, 242, 0)' }] }),
    section('Buttons'),
    row({ label: 'Navigation', controls: [{ c: 'select', value: 'Visible on mouse over', options: VISIBILITY }] }),
    row({ label: 'Pane', controls: [{ c: 'select', value: 'Visible on mouse over', options: VISIBILITY }] }),
    section('Margins'),
    row({ label: 'Top', controls: [num(10, 0, 25, 1, true, '%')] }),
    row({ label: 'Bottom', controls: [num(8, 0, 25, 1, true, '%')] }),
    row({ label: 'Right', controls: [num(10, 0, 500, 1, true, 'bars')] }),
  ],

  // ── Trading (display-only: no broker surface in this app) ────────────────
  trading: [
    section('General'),
    row({ id: 'Buy/sell buttons', cb: true, checked: false, label: 'Buy/sell buttons', desc: 'Displays buy and sell buttons directly on the chart', inert: true }),
    row({ cb: true, checked: false, label: 'One-click trading', help: 'One-click trading', desc: 'Instantly place, edit, cancel orders, or close positions without confirmation', inert: true }),
    row({ cb: true, checked: false, label: 'Execution sound', controls: [{ c: 'slider', value: 50 }], inert: true }),
    row({ id: 'Execution sound type', label: null, child: true, controls: [{ c: 'select', value: 'Beep-beep', options: ['Beep-beep'], disabled: true }], inert: true }),
    row({ cb: true, checked: false, label: 'Show only rejection notifications', inert: true }),
    section('Appearance'),
    row({ cb: true, checked: false, label: 'Positions and orders', help: true, inert: true }),
    row({ cb: true, checked: true, label: 'Reverse position button', indent: true, child: true, desc: 'Adds the reverse button next to the open position on the chart', inert: true }),
    row({ cb: true, checked: false, label: 'Project order for market orders', desc: 'Shows a project order on the chart before sending a market order', inert: true }),
    row({ cb: true, checked: false, label: 'Profit and loss value', help: 'Click here to learn more', inert: true }),
    row({ cb: true, checked: true, label: 'Positions', indent: true, child: true, controls: [{ c: 'select', value: 'Money', options: ['Money', 'Ticks', '%'], disabled: true }], inert: true }),
    row({ cb: true, checked: true, label: 'Brackets', indent: true, child: true, controls: [{ c: 'select', value: 'Money', options: ['Money', 'Ticks', '%'], disabled: true }], inert: true }),
    row({ cb: true, checked: false, label: 'Execution marks', help: true, inert: true }),
    row({ cb: true, checked: true, label: 'Execution labels', child: true, inert: true }),
    row({ cb: true, checked: false, label: 'Extended price lines across the entire chart width', inert: true }),
    row({ label: 'Order and position alignment', controls: [{ c: 'select', value: 'Right', options: ['Left', 'Center', 'Right'] }], inert: true }),
    row({ cb: true, checked: false, label: 'Orders, executions, and positions in chart snapshots', desc: 'Shows your trades on the chart in snapshots', inert: true }),
  ],

  // ── Alerts ───────────────────────────────────────────────────────────────
  alerts: [
    section('Chart line visibility'),
    // ONE colour (colorAlertsLine, palette without Opacity).
    row({ cb: true, checked: true, label: 'Alert lines', controls: [{ c: 'color', color: UP, noOpacity: true }] }),
    row({ cb: true, checked: true, label: 'Only active alerts' }),
    section('Notifications'),
    row({ cb: true, checked: true, label: 'Automatically hide toasts', help: 'Click here to learn more' }),
  ],

  // ── Events ───────────────────────────────────────────────────────────────
  events: [
    section('Events'),
    row({ cb: true, checked: false, label: 'Ideas', help: 'Click here to learn more', controls: [{ c: 'select', value: 'Ideas of followed users', options: ['Ideas of followed users'], disabled: true }], inert: true }),
    row({ cb: true, checked: true, label: 'Dividends', child: true }),
    row({ cb: true, checked: true, label: 'Splits', child: true }),
    // Session breaks: colour + Opacity + Thickness + Line style.
    row({ cb: true, checked: false, label: 'Session breaks', controls: [{ c: 'color', color: 'rgb(73, 133, 231)', width: 1, style: 1 }] }),
    row({ cb: true, checked: true, label: 'Latest news' }),
    // News notification: disabled (no news notification service).
    row({ cb: true, checked: false, label: 'News notification', inert: true }),
  ],
};

// Per-chart-type style forms live in the same draft, under `style.<group>`.
for (const [g, items] of Object.entries(STYLE_FORMS)) TAB_FORMS[styleTab(g as StyleGroup)] = items;
