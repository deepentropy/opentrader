/*
 * Screener heatmap (the reference app's Heatmap view): the toolbar's Size by,
 * Color by and Group by options, the tile colour scale and the treemap
 * layout. Pure: ScreenerHeatmap draws what these return.
 *
 * Options are the reference lists restricted to the columns the backend has
 * (Chg % 1h / 4h and the pre/post-market changes have no data source: the
 * live table holds the day's bar only).
 */
import type { ColumnRef, ScreenerType } from "./screener-catalog";

export type HeatScale = "signed" | "gap" | "relVol" | "volatility" | "beta";
export type HeatOption = {
  id: string;
  /** Menu text. */
  short: string;
  /** Text of the column when it is a tile's value (Mono size: its column). */
  valueShort: string;
  column: ColumnRef;
  /** Group of the menu (a divider between groups). */
  group: number;
  /** Size by "Mono size": every tile the same size. */
  mono?: boolean;
  /** Color by: how values map to colours. */
  scale?: HeatScale;
  /** Only in this screener (unset: both). */
  type?: ScreenerType;
};

const R1D = { resolution: "TimeResolution1D" };
/** A performance option: `label` written whole ("Perf %, 1W"). */
const perf = (interval: string, period: string, label: string): HeatOption => ({
  id: `Perf${period}`,
  short: label,
  valueShort: label,
  column: { id: "Performance", params: { interval } },
  group: 1,
  scale: "signed",
});

/** Volume and turnover of the day, the current week and the current month. */
const PERIODS = ["1D", "1W", "1M"] as const;

/** The size options by period, each written whole. */
const VOLUME_LABELS = { "1D": "Vol, 1D", "1W": "Vol, 1W", "1M": "Vol, 1M" } as const;
const TURNOVER_LABELS = { "1D": "Price × vol, 1D", "1W": "Price × vol, 1W", "1M": "Price × vol, 1M" } as const;
const BETA_LABELS = { "1Y": "Beta, 1Y", "3Y": "Beta, 3Y", "5Y": "Beta, 5Y" } as const;

export const HEAT_SIZE: HeatOption[] = [
  { id: "MarketCap", short: "Mkt cap", valueShort: "Mkt cap", column: { id: "MarketCap", params: {} }, group: 0, type: "stock" },
  { id: "AUM", short: "AUM", valueShort: "AUM", column: { id: "AssetsUnderManagement", params: {} }, group: 0, type: "etf" },
  ...PERIODS.map((r): HeatOption => ({
    id: r === "1D" ? "Volume" : `Volume${r}`, short: VOLUME_LABELS[r], valueShort: VOLUME_LABELS[r], column: { id: "Volume", params: { resolution: `TimeResolution${r}` } }, group: 1,
  })),
  ...PERIODS.map((r): HeatOption => ({
    id: r === "1D" ? "VolumePrice" : `VolumePrice${r}`, short: TURNOVER_LABELS[r], valueShort: TURNOVER_LABELS[r],
    column: { id: "VolumePrice", params: { resolution: `TimeResolution${r}` } }, group: 2,
  })),
  { id: "Mono", short: "Mono size", valueShort: "Mkt cap", column: { id: "MarketCap", params: {} }, group: 3, mono: true, type: "stock" },
  { id: "MonoEtf", short: "Mono size", valueShort: "AUM", column: { id: "AssetsUnderManagement", params: {} }, group: 3, mono: true, type: "etf" },
];

export const HEAT_COLOR: HeatOption[] = [
  { id: "Change", short: "Chg %, 1D", valueShort: "Chg %, 1D", column: { id: "Change", params: R1D }, group: 0, scale: "signed" },
  perf("Interval1W", "1W", "Perf %, 1W"),
  perf("Interval1M", "1M", "Perf %, 1M"),
  perf("Interval3M", "3M", "Perf %, 3M"),
  perf("Interval6M", "6M", "Perf %, 6M"),
  perf("IntervalYTD", "YTD", "Perf %, YTD"),
  perf("Interval1Y", "1Y", "Perf %, 1Y"),
  { id: "RelativeVolume", short: "Rel vol", valueShort: "Rel vol", column: { id: "RelativeVolume", params: R1D }, group: 2, scale: "relVol", type: "stock" },
  { id: "Volatility", short: "Volatility, 1D", valueShort: "Volatility, 1D", column: { id: "Volatility", params: { interval: "Interval1D" } }, group: 2, scale: "volatility" },
  { id: "Gap", short: "Gap %", valueShort: "Gap %", column: { id: "Gap", params: R1D }, group: 2, scale: "gap", type: "stock" },
  ...(["1Y", "3Y", "5Y"] as const).map((y): HeatOption => ({
    id: `Beta${y}`, short: BETA_LABELS[y], valueShort: BETA_LABELS[y], column: { id: "Beta", params: { interval: `Interval${y}` } }, group: 3, scale: "beta", type: "etf",
  })),
];

/** Group by (the ETF Screener's "Asset class" has no data source). */
export const HEAT_GROUP: { id: string; short: string; column: ColumnRef | null; type?: ScreenerType }[] = [
  { id: "None", short: "No group", column: null },
  { id: "Sector", short: "Sector", column: { id: "Sector", params: {} }, type: "stock" },
];

const ofType = <T extends { type?: ScreenerType }>(list: T[], type: ScreenerType) => list.filter((o) => !o.type || o.type === type);
export const heatSizes = (type: ScreenerType) => ofType(HEAT_SIZE, type);
export const heatColors = (type: ScreenerType) => ofType(HEAT_COLOR, type);
/** Group by options; the reference default is the first group (Sector), "No group" when there is none. */
export const heatGroups = (type: ScreenerType) => ofType(HEAT_GROUP, type);

/** A toolbar option of the screener, else its first one (a setting chosen in the other screener). */
export function heatOption(kind: "size" | "color", id: string, type: ScreenerType = "stock"): HeatOption {
  const list = kind === "size" ? heatSizes(type) : heatColors(type);
  return list.find((o) => o.id === id) ?? list[0];
}
export function heatGroup(id: string, type: ScreenerType) {
  const list = heatGroups(type);
  return list.find((g) => g.id === id) ?? list[list.length - 1];
}

// ── Treemap ───────────────────────────────────────────────────────────────

export type Rect = { x: number; y: number; w: number; h: number };
export type Placed<T> = Rect & { item: T };

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): items, largest first, are
 * laid in rows along the shorter side of the remaining space, a row growing
 * while that keeps its tiles closer to squares. Areas are proportional to the
 * weights; items without a positive weight are left out.
 */
export function squarify<T>(items: { weight: number; item: T }[], box: Rect): Placed<T>[] {
  const list = items.filter((i) => i.weight > 0 && Number.isFinite(i.weight)).sort((a, b) => b.weight - a.weight);
  const total = list.reduce((s, i) => s + i.weight, 0);
  const out: Placed<T>[] = [];
  if (!list.length || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  const areas = list.map((i) => i.weight * scale);
  let rest = { ...box };
  let start = 0;
  while (start < list.length) {
    const side = Math.min(rest.w, rest.h);
    let end = start + 1;
    let sum = areas[start];
    let best = worst(areas, start, end, sum, side);
    while (end < list.length) {
      const nextSum = sum + areas[end];
      const w = worst(areas, start, end + 1, nextSum, side);
      if (w > best) break;
      best = w;
      sum = nextSum;
      end++;
    }
    // Lay items start..end-1 as one row along the shorter side.
    const thick = sum / side;
    let offset = 0;
    for (let k = start; k < end; k++) {
      const len = areas[k] / thick;
      out.push(
        rest.w >= rest.h
          ? { x: rest.x, y: rest.y + offset, w: thick, h: len, item: list[k].item }
          : { x: rest.x + offset, y: rest.y, w: len, h: thick, item: list[k].item },
      );
      offset += len;
    }
    rest = rest.w >= rest.h ? { x: rest.x + thick, y: rest.y, w: rest.w - thick, h: rest.h } : { x: rest.x, y: rest.y + thick, w: rest.w, h: rest.h - thick };
    start = end;
  }
  return out;
}

/** Worst aspect ratio of a row of areas[from..to) laid along `side`. */
function worst(areas: number[], from: number, to: number, sum: number, side: number): number {
  let max = 0;
  let min = Infinity;
  for (let k = from; k < to; k++) {
    max = Math.max(max, areas[k]);
    min = Math.min(min, areas[k]);
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

// ── Colour scale ──────────────────────────────────────────────────────────

/** Dark-theme bucket colours, lowest to highest (7 buckets). */
export const SCHEME_COLORS: Record<"classic" | "colorBlind" | "mono" | "positive", string[]> = {
  classic: ["#F23645", "#B22833", "#801922", "#2B2B2B", "#1A3326", "#056636", "#089950"],
  colorBlind: ["#F57C00", "#AA6324", "#593A1B", "#2B2B2B", "#142E61", "#143EB2", "#2962FF"],
  mono: ["#EBEBEB", "#C9C9C9", "#A8A8A8", "#8C8C8C", "#707070", "#555555", "#1A1A1A"],
  positive: ["#2B2B2B", "#142E61", "#143A87", "#143EB2", "#1E53E5", "#5B9CF6", "#90BFF9"],
};

/** 7 buckets: [lo, hi) ranges (±Infinity at the ends) and the legend values. */
export type ColorScale = { ranges: [number, number][]; centres: number[]; percent: boolean; positive: boolean };

const SIGNED_SNAP = [0.3, 0.6, 0.9, 1.2, 1.5, 3, 3.5, 6.5, 8, 9.5, 15.5, 30.5, 45.5, 60.5, 75.5, 90.5];
const GAP_SNAP = [0.3, 0.45, 0.6, 0.75, 0.9, 1.2, 1.5, 3, 4.5, 6, 7.5, 9, ...Array.from({ length: 30 }, (_, i) => 12 + 3 * i)];
const VOLATILITY_SNAP = [5, 10, 20, 25, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 2500, 3000];

/** Nearest step (clamped to the ends; a tie goes to the lower step). */
function nearest(x: number, steps: number[]): number {
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - x) < Math.abs(best - x)) best = s;
  return best;
}

/** Extremum of a column's values: the largest |value| for 10 values or fewer, else the 95th percentile. */
export function extremum(values: number[]): number {
  const abs = values.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  if (!abs.length) return 0;
  if (abs.length <= 10) return abs[abs.length - 1];
  return abs[Math.max(0, Math.floor(abs.length * 0.95) - 1)];
}

/** Ranges with each boundary halfway between consecutive centres (a value goes to its nearest centre). */
function byCentres(centres: number[]): [number, number][] {
  return centres.map((c, k) => [k === 0 ? -Infinity : (centres[k - 1] + c) / 2, k === centres.length - 1 ? Infinity : (c + centres[k + 1]) / 2]);
}

/**
 * The colour scale of a Color by column over the shown values (the reference
 * rules): `depth` null = Auto, else a fixed step d.
 */
export function colorScale(scale: HeatScale, values: number[], depth: number | null): ColorScale {
  const k3 = [-3, -2, -1, 0, 1, 2, 3];
  if (scale === "relVol") {
    let centres: number[];
    if (depth !== null) centres = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((x) => x * depth);
    else {
      const ext = extremum(values);
      if (ext <= 0) return { ranges: [], centres: [], percent: false, positive: true };
      const target = ext / 6.5;
      const p = 10 ** Math.floor(Math.log10(target));
      const n = [p, 10 * p].flatMap((q) => [1, 1.25, 1.5, 2, 2.5, 3, 4, 5].map((m) => m * q)).find((x) => x >= target) ?? 50 * p;
      centres = [0, 1, 2, 3, 4, 5, 6].map((k) => k * n);
    }
    return { ranges: byCentres(centres).map(([lo, hi], i) => [i === 0 ? 0 : lo, hi]), centres, percent: false, positive: true };
  }
  if (scale === "volatility") {
    const centres =
      depth !== null ? [0, 1, 2, 4, 6, 8, 10].map((x) => x * depth) : [0, 0.05, 0.1, 0.3, 0.5, 0.8, 1].map((x) => x * nearest(extremum(values), VOLATILITY_SNAP));
    return { ranges: byCentres(centres).map(([lo, hi], i) => [i === 0 ? 0 : lo, hi]), centres, percent: true, positive: true };
  }
  if (depth !== null) {
    const centres = scale === "beta" ? [-1, -0.5, -0.1, 0, 0.1, 0.5, 1].map((k) => k * depth) : k3.map((k) => k * depth);
    return { ranges: byCentres(centres), centres, percent: scale !== "beta", positive: false };
  }
  const ext = extremum(values);
  if (scale === "gap") {
    const s = nearest(ext, GAP_SNAP) / 3;
    const centres = k3.map((k) => k * s);
    return { ranges: byCentres(centres), centres, percent: true, positive: false };
  }
  const S = nearest(ext, SIGNED_SNAP);
  const percent = scale !== "beta";
  if (ext <= 3.25) {
    const s = S / 3;
    const centres = k3.map((k) => k * s);
    return { ranges: byCentres(centres), centres, percent, positive: false };
  }
  // Widened: a ±0.5 neutral band, then three steps of e up to S.
  const e = (S - 0.5) / 3;
  const o = 0.5 + e;
  const t = 0.5 + 2 * e;
  const ranges: [number, number][] = [[-Infinity, -t], [-t, -o], [-o, -0.5], [-0.5, 0.5], [0.5, o], [o, t], [t, Infinity]];
  const centres = [-(t + e / 2), -(o + e / 2), -(0.5 + e / 2), 0, 0.5 + e / 2, o + e / 2, t + e / 2];
  return { ranges, centres, percent, positive: false };
}

/** Bucket of a value (0..6): a missing value is 0 (neutral on signed scales); below a positive-only scale = 0. */
export function bucketOf(sc: ColorScale, v: number | null | undefined): number {
  const x = typeof v === "number" && Number.isFinite(v) ? v : 0;
  for (let i = 0; i < sc.ranges.length; i++) if (x >= sc.ranges[i][0] && x < sc.ranges[i][1]) return i;
  return sc.positive || !sc.ranges.length ? 0 : x < 0 ? 0 : sc.ranges.length - 1;
}

/** Legend text: 2 decimals with trailing zeros cut, U+2212 minus, no "+", "%" on percent columns. */
export function legendLabel(v: number, percent: boolean): string {
  const body = Math.abs(v).toFixed(2).replace(/\.?0+$/, "");
  return `${v < 0 && body !== "0" ? "−" : ""}${body}${percent ? "%" : ""}`;
}

/** Colour depth menu: Auto, then the steps d (shown as "−3d% to 3d%"). */
export const COLOR_DEPTHS = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 5, 10];
