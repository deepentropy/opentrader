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

/** Date ranges a chart can open on (the bottom bar's range tabs). */
export const EMBED_RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"] as const;
export type EmbedRange = (typeof EMBED_RANGES)[number];

export type EmbedStudy = { id: string; inputs?: Record<string, unknown> };

export const EMBED_WIDGETS = ["chart", "ticker-tape", "mini-chart", "quote"] as const;
export type EmbedWidget = (typeof EMBED_WIDGETS)[number];

/** Colours and font of the page around the embed (its `--opentrader-*` CSS properties). */
export type EmbedColors = Partial<Record<"background" | "text" | "accent" | "up" | "down" | "border" | "font", string>>;
const COLOR_KEYS = ["background", "text", "accent", "up", "down", "border"] as const;

export type EmbedConfig = {
  widget: EmbedWidget;
  symbol: string;
  /** Ticker tape: its symbols, in order. */
  symbols: string[];
  /** Ticker tape: a scrolling row, or a column. */
  direction: "horizontal" | "vertical";
  hideLogos: boolean;
  interval: string;
  range?: EmbedRange;
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
  symbols: DEFAULT_TAPE,
  direction: "horizontal",
  hideLogos: false,
  interval: "1D",
  extendedHours: false,
  studies: [],
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

/** Checked settings from what the page gave (an object, any shape). */
export function parseEmbedConfig(raw: unknown): EmbedConfig {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const c: EmbedConfig = { ...EMBED_DEFAULTS, studies: [], compare: [], watchlist: [], colors: {} };
  const widget = EMBED_WIDGETS.find((w) => w === r.widget);
  if (widget) c.widget = widget;
  c.symbol = symbolOf(r.symbol) ?? c.symbol;
  if ("symbols" in r) {
    const symbols = symbolsOf(r.symbols).slice(0, MAX_TAPE);
    if (symbols.length) c.symbols = symbols;
  }
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
  if (typeof r.chartType === "string" && r.chartType.trim()) c.chartType = r.chartType.trim();
  if (r.theme === "light" || r.theme === "dark") c.theme = r.theme;
  if (typeof r.locale === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(r.locale)) c.locale = r.locale;
  if (typeof r.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(r.timezone)) c.timezone = r.timezone;
  for (const k of BOOL_KEYS) if (k in r) c[k] = boolOf(r[k]);
  c.studies = studiesOf(r.studies);
  c.compare = symbolsOf(r.compare);
  c.watchlist = symbolsOf(r.watchlist);
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
