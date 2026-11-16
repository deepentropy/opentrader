/*
 * Settings of a chart embedded in another website (#338).
 *
 * The page loads public/embed.js, which opens the web version in an iframe at
 * `/?view=embed#<settings JSON>`. This module reads those settings, checks each
 * one and fills in the defaults; anything malformed falls back to its default
 * rather than failing the chart. Kept free of app imports: the boot reads it
 * before any store loads.
 */

/** Date ranges a chart can open on (the bottom bar's range tabs). */
export const EMBED_RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"] as const;
export type EmbedRange = (typeof EMBED_RANGES)[number];

export type EmbedStudy = { id: string; inputs?: Record<string, unknown> };

export type EmbedConfig = {
  symbol: string;
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
  popupButton: boolean;
  popupWidth: number;
  popupHeight: number;
};

export const EMBED_DEFAULTS: EmbedConfig = {
  symbol: "NASDAQ:AAPL",
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
  popupButton: false,
  popupWidth: 1000,
  popupHeight: 650,
};

/** Settings applied in place on a running chart (the others reload it). */
export const LIVE_KEYS = ["symbol", "interval", "chartType", "theme"] as const;

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
  "popupButton",
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

/** Checked settings from what the page gave (an object, any shape). */
export function parseEmbedConfig(raw: unknown): EmbedConfig {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const c: EmbedConfig = { ...EMBED_DEFAULTS, studies: [], compare: [], watchlist: [] };
  c.symbol = symbolOf(r.symbol) ?? c.symbol;
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
