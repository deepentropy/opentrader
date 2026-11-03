/*
 * Stock screener settings (the reference app's "Screener settings" dialog and
 * the Charts / Heatmap view toolbars), shared by every screen and window:
 *   General  auto-refresh (off, every 10 seconds, every minute) and the
 *            currency financial values are converted to;
 *   Table    the symbol column's texts (symbol, name or both) and logo, the
 *            currency after values;
 *   Charts   the instrument name in each chart's label, and the toolbar's
 *            date range, chart type, grid and indicators;
 *   Heatmap  the tile's logo, title and value, the color scheme, and the
 *            toolbar's size, color, group and color depth.
 * Kept in kv `ot:screener:settings:v1`; another window's change is followed.
 *
 * Reference defaults, except auto-refresh: the reference starts with it off
 * (a paid feature there); here the table has always refreshed every 10 s, so
 * that stays the default.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "./kv";

const KEY = "ot:screener:settings:v1";

export type AutoRefresh = "off" | "10s" | "1min";
/** The "Convert financials" currencies, in the reference order. */
export const CURRENCIES = ["USD", "EUR", "JPY", "GBP", "AUD", "CAD", "CHF", "CNY", "INR"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Charts view date ranges: label, bar resolution (the reference pairs). */
export const CHART_RANGES = [
  { id: "1D", label: "1 day", resolution: "5", resolutionLabel: "5 minute timeframe" },
  { id: "5D", label: "5 days", resolution: "15", resolutionLabel: "15 minute timeframe" },
  { id: "1M", label: "1 month", resolution: "60", resolutionLabel: "1 hour timeframe" },
  { id: "3M", label: "3 months", resolution: "240", resolutionLabel: "4 hour timeframe" },
  { id: "6M", label: "6 months", resolution: "1D", resolutionLabel: "1 day timeframe" },
  { id: "YTD", label: "Year to date", resolution: "1D", resolutionLabel: "1 day timeframe" },
  { id: "1Y", label: "1 year", resolution: "1W", resolutionLabel: "1 week timeframe" },
  { id: "5Y", label: "5 years", resolution: "1M", resolutionLabel: "1 month timeframe" },
  { id: "All", label: "All data", resolution: "1M", resolutionLabel: "1 month timeframe" },
] as const;
export type ChartRange = (typeof CHART_RANGES)[number]["id"];
export type ChartType = "bars" | "candles" | "line" | "area";
/** Charts view indicators, in the reference menu order (two groups, then Volume). */
export const CHART_INDICATORS = [
  { id: "ema50", label: "EMA 50", kind: "ema", length: 50, color: "#FBC02D" },
  { id: "ema200", label: "EMA 200", kind: "ema", length: 200, color: "#EF6C00" },
  { id: "sma50", label: "SMA 50", kind: "sma", length: 50, color: "#82B1FF" },
  { id: "sma200", label: "SMA 200", kind: "sma", length: 200, color: "#3179F5" },
  { id: "volume", label: "Volume", kind: "volume", length: 0, color: "" },
] as const;
export type ChartIndicator = (typeof CHART_INDICATORS)[number]["id"];

export type HeatScheme = "classic" | "colorBlind" | "mono";
export const HEAT_SCHEMES: { id: HeatScheme; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "colorBlind", label: "Color blind" },
  { id: "mono", label: "Monochrome" },
];

export type ScreenerSettings = {
  autoRefresh: AutoRefresh;
  /** "Convert financials": null = off (values in the symbol's own currency). */
  currency: Currency | null;
  /** Symbol column texts: the ticker, the name, or both (one stays on). */
  showSymbol: boolean;
  showName: boolean;
  showLogo: boolean;
  /** "Currency": the unit after prices and amounts. */
  showCurrency: boolean;
  chartName: boolean;
  chartRange: ChartRange;
  chartType: ChartType;
  /** Charts per screen: null = Auto (columns by width), else columns × rows. */
  chartGrid: { cols: number; rows: number } | null;
  chartIndicators: ChartIndicator[];
  heatLogo: boolean;
  /** Tile title: off, or the name / the symbol. */
  heatTitleOn: boolean;
  heatTitle: "name" | "symbol";
  /** Tile value: off, or the Color by / Size by column's value. */
  heatValueOn: boolean;
  heatValue: "color" | "size";
  heatScheme: HeatScheme;
  /** Heatmap toolbar: option ids of ./screener-heatmap (Size by, Color by, Group by). */
  heatSize: string;
  heatColor: string;
  heatGroup: string;
  /** Color depth: null = Auto, else the step d of the ±3d scale. */
  heatDepth: number | null;
};

export const DEFAULT_SETTINGS: ScreenerSettings = {
  autoRefresh: "10s",
  currency: null,
  showSymbol: true,
  showName: false,
  showLogo: true,
  showCurrency: true,
  chartName: true,
  chartRange: "5D",
  chartType: "area",
  chartGrid: null,
  chartIndicators: ["sma50", "sma200", "volume"],
  heatLogo: true,
  heatTitleOn: true,
  heatTitle: "symbol",
  heatValueOn: true,
  heatValue: "color",
  heatScheme: "classic",
  heatSize: "MarketCap",
  heatColor: "Change",
  heatGroup: "Sector",
  heatDepth: null,
};

function read(raw: string | null): ScreenerSettings {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<ScreenerSettings>) : {};
    return { ...DEFAULT_SETTINGS, ...v };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const state = createRoot(() => {
  const [settings, setSettings] = createSignal<ScreenerSettings>(read(kv.getItem(KEY)));
  return { settings, setSettings };
});

kv.onExternalChange(KEY, (v) => state.setSettings(read(v)));

export const screenerSettings = state.settings;

/** Change some settings (applied at once, saved). */
export function setScreenerSettings(patch: Partial<ScreenerSettings>): void {
  state.setSettings({ ...state.settings(), ...patch });
  kv.setItem(KEY, JSON.stringify(state.settings()));
}

/** Replace every setting (the dialog's Cancel puts the opening ones back). */
export function restoreScreenerSettings(s: ScreenerSettings): void {
  state.setSettings({ ...s });
  kv.setItem(KEY, JSON.stringify(s));
}

/** Milliseconds between table refreshes (null: refreshed only on demand). */
export function refreshMs(a: AutoRefresh): number | null {
  return a === "10s" ? 10_000 : a === "1min" ? 60_000 : null;
}
