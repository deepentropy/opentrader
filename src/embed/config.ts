/*
 * Settings of a chart or widget embedded in another website (#338, #339).
 *
 * The page loads public/embed.js, which opens the web version in an iframe at
 * `/?view=embed#<settings JSON>`; `widget` says which: the chart, a ticker
 * tape, a mini chart or a quote. This module reads those settings, checks each
 * one and fills in the defaults; anything malformed falls back to its default
 * rather than failing the chart. Kept free of app imports: the boot reads it
 * before any store loads.
 */
import { LAYOUT_SPECS, type LayoutId } from "../window/chart/layouts";
import { MAX_LIST_ITEMS } from "../data/watchlist-limit";

/** Date ranges a chart can open on (the bottom bar's range tabs). */
export const EMBED_RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"] as const;
export type EmbedRange = (typeof EMBED_RANGES)[number];

export type EmbedStudy = { id: string; inputs?: Record<string, unknown> };

export const EMBED_WIDGETS = ["chart", "ticker-tape", "mini-chart", "quote"] as const;
export type EmbedWidget = (typeof EMBED_WIDGETS)[number];

/** A time a page gives (#366): a calendar date, a wall-clock time in the
 *  exchange's zone, or an instant (UNIX seconds). */
export type EmbedTime =
  | { date: { y: number; m: number; d: number } }
  | { wall: { y: number; m: number; d: number; minutes: number } }
  | { sec: number };

export const MARKER_POSITIONS = ["above", "below", "inBar"] as const;
export const MARKER_SHAPES = ["arrowUp", "arrowDown", "circle", "square"] as const;

/** A mark on the bar holding `time`; with `symbol`, only on that symbol's chart. */
export type EmbedMarker = {
  time: EmbedTime;
  text?: string;
  color?: string;
  position: (typeof MARKER_POSITIONS)[number];
  shape: (typeof MARKER_SHAPES)[number];
  symbol?: string;
};

/** A shaded period, over the bars from `from` to `to`; with `symbol`, only on that symbol's chart. */
export type EmbedHighlight = { from: EmbedTime; to: EmbedTime; color?: string; label?: string; symbol?: string };

/** At most this many marks and periods: they ride in the iframe's address. */
export const MAX_MARKERS = 500;
export const MAX_HIGHLIGHTS = 50;

/** Colours and font of the page around the embed (its `--opentrader-*` CSS properties). */
export type EmbedColors = Partial<Record<"background" | "text" | "accent" | "up" | "down" | "border" | "font", string>>;
const COLOR_KEYS = ["background", "text", "accent", "up", "down", "border"] as const;

export type EmbedConfig = {
  widget: EmbedWidget;
  symbol: string;
  /** Ticker tape: its symbols, in order (none given: DEFAULT_TAPE). Chart with
   *  a layout: one per chart (none given: every chart shows `symbol`). */
  symbols: string[];
  /** Ticker tape: a scrolling row, or a column. */
  direction: "horizontal" | "vertical";
  hideLogos: boolean;
  interval: string;
  range?: EmbedRange;
  /** Chart: the span it opens framed on (wins over `range`). */
  from?: EmbedTime;
  to?: EmbedTime;
  /** Chart: several charts in a layout template. */
  layout?: LayoutId;
  markers: EmbedMarker[];
  highlights: EmbedHighlight[];
  chartType?: string;
  theme?: "light" | "dark";
  locale?: string;
  /** IANA name, or "exchange" (each symbol's exchange zone). */
  timezone?: string;
  extendedHours: boolean;
  studies: EmbedStudy[];
  hideVolume: boolean;
  compare: string[];
  allowSymbolChange: boolean;
  hideTopToolbar: boolean;
  drawingToolbar: boolean;
  dateRanges: boolean;
  hideLegend: boolean;
  hideSnapshotButton: boolean;
  watchlist: string[];
  details: boolean;
  /** Chart: market movers (most active, gainers, losers) in the right panel. */
  movers: boolean;
  popupButton: boolean;
  popupWidth: number;
  popupHeight: number;
  colors: EmbedColors;
};

/** A ticker tape's symbols when the page names none. */
export const DEFAULT_TAPE = ["AMEX:SPY", "NASDAQ:QQQ", "NASDAQ:AAPL", "NASDAQ:MSFT", "NASDAQ:NVDA", "NASDAQ:AMZN", "NASDAQ:GOOGL", "NASDAQ:META", "NASDAQ:TSLA"];

export const EMBED_DEFAULTS: EmbedConfig = {
  widget: "chart",
  symbol: "NASDAQ:AAPL",
  symbols: [],
  direction: "horizontal",
  hideLogos: false,
  interval: "1D",
  extendedHours: false,
  studies: [],
  markers: [],
  highlights: [],
  hideVolume: false,
  compare: [],
  allowSymbolChange: false,
  hideTopToolbar: false,
  drawingToolbar: false,
  dateRanges: false,
  hideLegend: false,
  hideSnapshotButton: false,
  watchlist: [],
  details: false,
  movers: false,
  popupButton: false,
  popupWidth: 1000,
  popupHeight: 650,
  colors: {},
};

/** A ticker tape's symbols: the page's, or DEFAULT_TAPE. */
export const tapeSymbols = (c: EmbedConfig): string[] => (c.symbols.length ? c.symbols : DEFAULT_TAPE);

/** At most this many symbols in a ticker tape. */
export const MAX_TAPE = 30;

const SYMBOL_RE = /^[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-^!/]+$/;
const BOOL_KEYS = [
  "extendedHours",
  "hideVolume",
  "allowSymbolChange",
  "hideTopToolbar",
  "drawingToolbar",
  "dateRanges",
  "hideLegend",
  "hideSnapshotButton",
  "details",
  "movers",
  "popupButton",
  "hideLogos",
] as const;

const symbolOf = (v: unknown): string | undefined =>
  typeof v === "string" && SYMBOL_RE.test(v.trim()) ? v.trim().toUpperCase() : undefined;

const symbolsOf = (v: unknown): string[] => {
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const s of list) {
    const sym = symbolOf(s);
    if (sym && !out.includes(sym)) out.push(sym);
  }
  return out;
};

const studiesOf = (v: unknown): EmbedStudy[] => {
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  const out: EmbedStudy[] = [];
  for (const s of list) {
    if (typeof s === "string" && s.trim()) out.push({ id: s.trim() });
    else if (s && typeof s === "object" && typeof (s as EmbedStudy).id === "string" && (s as EmbedStudy).id) {
      const inputs = (s as EmbedStudy).inputs;
      out.push({ id: (s as EmbedStudy).id, ...(inputs && typeof inputs === "object" && !Array.isArray(inputs) ? { inputs } : {}) });
    }
  }
  return out;
};

const sizeOf = (v: unknown, fallback: number): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 200 && n <= 4000 ? Math.round(n) : fallback;
};

const boolOf = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "";

// A CSS colour as a page writes it: hex, rgb(a), hsl(a), or a colour name.
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/deg+-]+\)|[a-z]{3,20})$/i;
// A font family list ("Inter, system-ui, sans-serif"): names, quotes, commas.
const FONT_RE = /^[\w\s,'"-]{1,200}$/;

const colorsOf = (v: unknown): EmbedColors => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  const out: EmbedColors = {};
  for (const k of COLOR_KEYS) {
    const c = typeof r[k] === "string" ? (r[k] as string).trim() : "";
    if (c && COLOR_RE.test(c)) out[k] = c;
  }
  const font = typeof r.font === "string" ? r.font.trim() : "";
  if (font && FONT_RE.test(font)) out.font = font;
  return out;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A real calendar date (month 0-based), or null. */
function dateOf(y: number, m: number, d: number): { y: number; m: number; d: number } | null {
  const t = new Date(Date.UTC(y, m, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d ? { y, m, d } : null;
}

/** A page's time: "2026-03-14" (a date), "2026-03-14 10:30" (exchange time), ISO with Z or an offset, or UNIX
 *  seconds (milliseconds read as such). Anything else: undefined. */
export function timeOf(v: unknown): EmbedTime | undefined {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return undefined;
    return { sec: Math.floor(v > 1e11 ? v / 1000 : v) };
  }
  // Already read (settings changed in place are read over the current ones).
  if (v && typeof v === "object") {
    const t = v as Record<string, { y?: unknown; m?: unknown; d?: unknown; minutes?: unknown } | undefined> & { sec?: unknown };
    if (typeof t.sec === "number") return timeOf(t.sec);
    const d = t.date ?? t.wall;
    if (!d || typeof d.y !== "number" || typeof d.m !== "number" || typeof d.d !== "number") return undefined;
    const date = dateOf(d.y, d.m, d.d);
    if (!date) return undefined;
    if (t.date) return { date };
    const minutes = d.minutes;
    return typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 0 && minutes < 1440 ? { wall: { ...date, minutes } } : undefined;
  }
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return timeOf(Number(s));
  let m = DATE_RE.exec(s);
  if (m) {
    const date = dateOf(+m[1], +m[2] - 1, +m[3]);
    return date ? { date } : undefined;
  }
  m = WALL_RE.exec(s);
  if (m) {
    const date = dateOf(+m[1], +m[2] - 1, +m[3]);
    const h = +m[4];
    const mi = +m[5];
    return date && h < 24 && mi < 60 ? { wall: { ...date, minutes: h * 60 + mi } } : undefined;
  }
  if (ZONED_RE.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? { sec: Math.floor(ms / 1000) } : undefined;
  }
  return undefined;
}

/** A page's text on the chart: one line, at most 100 characters. */
const textOf = (v: unknown): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const t = String(v).replace(/\s+/g, " ").trim().slice(0, 100);
  return t || undefined;
};

const colorOf = (v: unknown): string | undefined => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : undefined);

const listOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];

function markersOf(v: unknown): EmbedMarker[] {
  const out: EmbedMarker[] = [];
  for (const r of listOf(v)) {
    const time = timeOf(r.time);
    if (!time) continue;
    const position = MARKER_POSITIONS.find((p) => p === r.position) ?? "above";
    const shape =
      MARKER_SHAPES.find((s) => s === r.shape) ?? (position === "above" ? "arrowDown" : position === "below" ? "arrowUp" : "circle");
    const text = textOf(r.text);
    const color = colorOf(r.color);
    const symbol = symbolOf(r.symbol);
    out.push({ time, position, shape, ...(text ? { text } : {}), ...(color ? { color } : {}), ...(symbol ? { symbol } : {}) });
    if (out.length === MAX_MARKERS) break;
  }
  return out;
}

function highlightsOf(v: unknown): EmbedHighlight[] {
  const out: EmbedHighlight[] = [];
  for (const r of listOf(v)) {
    const from = timeOf(r.from);
    const to = timeOf(r.to ?? r.from);
    if (!from || !to) continue;
    const label = textOf(r.label);
    const color = colorOf(r.color);
    const symbol = symbolOf(r.symbol);
    out.push({ from, to, ...(label ? { label } : {}), ...(color ? { color } : {}), ...(symbol ? { symbol } : {}) });
    if (out.length === MAX_HIGHLIGHTS) break;
  }
  return out;
}

/** Checked settings from what the page gave (an object, any shape). */
export function parseEmbedConfig(raw: unknown): EmbedConfig {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const c: EmbedConfig = { ...EMBED_DEFAULTS, studies: [], compare: [], watchlist: [], markers: [], highlights: [], colors: {} };
  const widget = EMBED_WIDGETS.find((w) => w === r.widget);
  if (widget) c.widget = widget;
  c.symbol = symbolOf(r.symbol) ?? c.symbol;
  if ("symbols" in r) c.symbols = symbolsOf(r.symbols).slice(0, MAX_TAPE);
  if (r.direction === "vertical") c.direction = "vertical";
  if (typeof r.interval === "string" && /^\d*[SDWM]?$/i.test(r.interval.trim()) && r.interval.trim()) {
    const iv = r.interval.trim().toUpperCase();
    // "D" / "W" / "M" are the one-unit intervals.
    c.interval = /^[DWM]$/.test(iv) ? `1${iv}` : iv;
  }
  if (typeof r.range === "string") {
    const range = EMBED_RANGES.find((x) => x.toLowerCase() === (r.range as string).trim().toLowerCase());
    if (range) c.range = range;
  }
  c.from = timeOf(r.from);
  c.to = timeOf(r.to);
  if (!c.from || !c.to) c.from = c.to = undefined;
  if (typeof r.layout === "string" && Object.prototype.hasOwnProperty.call(LAYOUT_SPECS, r.layout)) c.layout = r.layout as LayoutId;
  c.markers = markersOf(r.markers);
  c.highlights = highlightsOf(r.highlights);
  if (typeof r.chartType === "string" && r.chartType.trim()) c.chartType = r.chartType.trim();
  if (r.theme === "light" || r.theme === "dark") c.theme = r.theme;
  if (typeof r.locale === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(r.locale)) c.locale = r.locale;
  if (typeof r.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(r.timezone)) c.timezone = r.timezone;
  for (const k of BOOL_KEYS) if (k in r) c[k] = boolOf(r[k]);
  c.studies = studiesOf(r.studies);
  c.compare = symbolsOf(r.compare);
  // As many as a watchlist holds (#358): the rest is left out.
  c.watchlist = symbolsOf(r.watchlist).slice(0, MAX_LIST_ITEMS);
  c.colors = colorsOf(r.colors);
  c.popupWidth = sizeOf(r.popupWidth, c.popupWidth);
  c.popupHeight = sizeOf(r.popupHeight, c.popupHeight);
  return c;
}

/** Settings from a URL hash (`#` + URI-encoded JSON); defaults when it does not read. */
export function embedConfigFromHash(hash: string): EmbedConfig {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!text) return parseEmbedConfig({});
  try {
    return parseEmbedConfig(JSON.parse(decodeURIComponent(text)));
  } catch {
    return parseEmbedConfig({});
  }
}

/** True in the page an embed loads (`?view=embed`). */
export function isEmbedView(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  return new URLSearchParams(search).get("view") === "embed";
}

let current: EmbedConfig | null | undefined;

/** This page's embed settings, or null outside an embed. */
export function embedConfig(): EmbedConfig | null {
  if (current === undefined) current = isEmbedView() ? embedConfigFromHash(location.hash) : null;
  return current;
}

/** True when the page is an embedded chart. */
export const isEmbed = (): boolean => embedConfig() !== null;
