/*
 * Compared symbols (header "Compare symbols"): per-symbol style model.
 *
 * A compared symbol has the style rows of a chart series: 12 chart styles,
 * each with the rows of the main series' Symbol tab, then "Price line" and
 * "Override min tick" (the compare Settings dialog, Style tab). The factory
 * values are the compare study's own (not the main series'), measured on the
 * reference app 01/10/2026.
 *
 * Values live in a Draft keyed `${style}:${rowId}` holding every style's
 * rows, so switching the style in the dialog keeps the other styles' values.
 */
import { DEFAULT_VISIBILITY, type IntervalVisibility } from "lightweight-charts-drawing/core/types";
import { PRECISION_OPTIONS, PRICE_SOURCES, rowIdOf, type Control, type FormItem, type FormRow } from "../../../data/chart-properties";
import {
  DEFAULT_SERIES_STYLES,
  keyOf,
  type CtrlValue,
  type Draft,
  type LineSpec,
  type PriceSource,
  type SeriesStyles,
} from "../../header/chart-settings";
import type { ChartTypeId } from "../chart-types";

/** Chart styles of a compared symbol, in the Style select's order. */
export type CompareStyleId =
  | "bar" | "candle" | "hollowCandle" | "column"
  | "line" | "lineWithMarkers" | "stepline"
  | "area" | "hlcArea" | "baseline" | "hlcBars" | "hilo";

export const COMPARE_STYLES: ReadonlyArray<{ id: CompareStyleId; title: string }> = [
  { id: "bar", title: "Bars" },
  { id: "candle", title: "Candles" },
  { id: "hollowCandle", title: "Hollow candles" },
  { id: "column", title: "Columns" },
  { id: "line", title: "Line" },
  { id: "lineWithMarkers", title: "Line with markers" },
  { id: "stepline", title: "Step line" },
  { id: "area", title: "Area" },
  { id: "hlcArea", title: "HLC area" },
  { id: "baseline", title: "Baseline" },
  { id: "hlcBars", title: "HLC bars" },
  { id: "hilo", title: "High-low" },
];
export const DEFAULT_COMPARE_STYLE: CompareStyleId = "line";

/** Line colour of a new compared symbol, by add order on the chart. Only
 *  these four were observed; the sequence repeats after them. */
export const COMPARE_COLORS = ["#3179F5", "#00C853", "#FF9800", "#26C6DA"];

/** Override min tick choices (the Precision list of the chart settings). */
export const MIN_TICK_OPTIONS = PRECISION_OPTIONS;

// Factory colours of the compare study.
const UP = "#22AB94";
const DOWN = "#ec407a";
const BLUE = "#2962FF";
const ORANGE = "#F57C00";

const row = (r: FormRow): FormItem => ({ kind: "row", ...r });
const source = (): FormItem => row({ label: "Price source", controls: [{ c: "select", value: "Close", options: PRICE_SOURCES }] });
const prevClose = (checked: boolean) => row({ cb: true, checked, label: "Color bars based on previous close" });
const candleRows = (): FormItem[] => [
  row({ cb: true, checked: true, label: "Body", controls: [{ c: "colorPair", up: UP, down: DOWN }] }),
  row({ cb: true, checked: true, label: "Borders", controls: [{ c: "colorPair", up: UP, down: DOWN }] }),
  row({ cb: true, checked: true, label: "Wick", controls: [{ c: "colorPair", up: UP, down: DOWN }] }),
];
const line = (color: string, style = 0): Control => ({ c: "color", color, width: 2, style });

/** Style rows of each compare style. `color` = the symbol's line colour
 *  (the Line style's factory colour). */
export function compareForms(color: string): Record<CompareStyleId, FormItem[]> {
  return {
    bar: [
      prevClose(false),
      row({ cb: true, checked: false, label: "HLC bars" }),
      row({ label: "Up color", controls: [{ c: "color", color: UP }] }),
      row({ label: "Down color", controls: [{ c: "color", color: DOWN }] }),
      row({ cb: true, checked: true, label: "Thin bars" }),
    ],
    candle: [prevClose(false), ...candleRows()],
    hollowCandle: candleRows(),
    column: [
      source(),
      prevClose(true),
      row({ label: "Up color", controls: [{ c: "color", color: "rgba(8, 153, 129, 0.5)" }] }),
      row({ label: "Down color", controls: [{ c: "color", color: "rgba(242, 54, 69, 0.5)" }] }),
    ],
    line: [source(), row({ label: "Line", controls: [line(color)] })],
    lineWithMarkers: [source(), row({ label: "Line", controls: [line(ORANGE)] })],
    stepline: [source(), row({ label: "Line", controls: [line(ORANGE)] })],
    area: [
      source(),
      row({ label: "Line", controls: [line(BLUE)] }),
      // color1 / color2 at transparency 95.
      row({ label: "Fill", controls: [{ c: "colorPair", up: "rgba(41, 98, 255, 0.05)", down: "rgba(41, 98, 255, 0.05)" }] }),
    ],
    hlcArea: [
      row({ cb: true, checked: true, label: "High line", controls: [{ c: "color", color: "#00BCD4", width: 2 }] }),
      row({ cb: true, checked: true, label: "Low line", controls: [{ c: "color", color: "#E91E63", width: 2 }] }),
      row({ label: "Close line", controls: [{ c: "color", color: BLUE, width: 2 }] }),
      row({ label: "Fill", controls: [{ c: "colorPair", up: "rgba(0, 188, 212, 0.25)", down: "rgba(233, 30, 99, 0.25)" }] }),
    ],
    baseline: [
      source(),
      row({ label: "Top line", controls: [line("#42BD7F")] }),
      // Bottom line dashed.
      row({ label: "Bottom line", controls: [line("#F7525F", 1)] }),
      row({ label: "Fill top area", controls: [{ c: "colorPair", up: "rgba(66, 189, 127, 0.05)", down: "rgba(66, 189, 127, 0.05)" }] }),
      row({ label: "Fill bottom area", controls: [{ c: "colorPair", up: "rgba(247, 82, 95, 0.05)", down: "rgba(247, 82, 95, 0.05)" }] }),
      row({ label: "Base level", controls: [{ c: "input", value: "50", unit: "%", num: { min: 0, max: 100, step: 1, int: true } }] }),
    ],
    hlcBars: [
      row({ label: "Bars", controls: [{ c: "color", color: BLUE }] }),
      row({ cb: true, checked: true, label: "Thin bars" }),
    ],
    hilo: [
      row({ cb: true, checked: true, label: "Body", controls: [{ c: "color", color: BLUE }] }),
      row({ cb: true, checked: true, label: "Borders", controls: [{ c: "color", color: BLUE }] }),
      row({ cb: true, checked: true, label: "Labels", controls: [{ c: "color", color: BLUE }] }),
    ],
  };
}

/** Persisted style of one compared symbol. */
export type CompareStyleState = {
  style: CompareStyleId;
  /** Every style's rows, keyed `${style}:${rowId}`. */
  rows: Draft;
  priceLine: boolean;
  /** "Override min tick" choice ("Default" = the symbol's tick grid). */
  minTick: string;
  visibility: IntervalVisibility;
};

function ctrlDefault(c: Control): CtrlValue {
  switch (c.c) {
    case "select": return { kind: "select", value: c.value };
    case "color": {
      const v: CtrlValue = { kind: "color", color: c.color };
      if (c.width !== undefined) v.width = c.width;
      if (c.style !== undefined) v.style = c.style;
      return v;
    }
    case "colorPair": return { kind: "colorPair", up: c.up, down: c.down };
    case "lineColor": return { kind: "lineColor", type: c.type, color: c.color, start: c.start, end: c.end, width: c.width, style: c.style };
    case "input": return { kind: "input", value: c.value };
    case "slider": return { kind: "slider", value: c.value };
    case "multicheck": return { kind: "multicheck", on: [...c.on] };
  }
}

function defaultRows(color: string): Draft {
  const d: Draft = {};
  for (const [style, items] of Object.entries(compareForms(color))) {
    for (const it of items) {
      if (it.kind !== "row") continue;
      d[keyOf(style, rowIdOf(it))] = { checked: it.cb ? !!it.checked : null, controls: (it.controls ?? []).map(ctrlDefault) };
    }
  }
  return d;
}

const cloneVisibility = (v: IntervalVisibility): IntervalVisibility => ({
  ticks: v.ticks,
  seconds: { ...v.seconds },
  minutes: { ...v.minutes },
  hours: { ...v.hours },
  days: { ...v.days },
  weeks: { ...v.weeks },
  months: { ...v.months },
  ranges: v.ranges,
});

/** Factory style of a compared symbol drawn in `color`. */
export function defaultCompareStyle(color: string): CompareStyleState {
  return { style: DEFAULT_COMPARE_STYLE, rows: defaultRows(color), priceLine: false, minTick: "Default", visibility: cloneVisibility(DEFAULT_VISIBILITY) };
}

export function cloneCompareStyle(s: CompareStyleState): CompareStyleState {
  const rows: Draft = {};
  for (const [k, v] of Object.entries(s.rows)) rows[k] = { checked: v.checked, controls: v.controls.map((c) => (c.kind === "multicheck" ? { ...c, on: [...c.on] } : { ...c })) };
  return { ...s, rows, visibility: cloneVisibility(s.visibility) };
}

/** Stored (possibly partial / older) style merged over the factory style of
 *  `color`: unknown rows and values of another control kind are dropped. */
export function reviveCompareStyle(raw: unknown, color: string): CompareStyleState {
  const d = defaultCompareStyle(color);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<Record<keyof CompareStyleState, unknown>>;
  const style = COMPARE_STYLES.some((s) => s.id === r.style) ? (r.style as CompareStyleId) : d.style;
  const rows = d.rows;
  const stored = r.rows && typeof r.rows === "object" ? (r.rows as Record<string, { checked?: unknown; controls?: unknown }>) : {};
  for (const [k, def] of Object.entries(rows)) {
    const s = stored[k];
    if (!s) continue;
    const controls = Array.isArray(s.controls) ? s.controls : [];
    rows[k] = {
      checked: def.checked === null ? null : typeof s.checked === "boolean" ? s.checked : def.checked,
      controls: def.controls.map((c, i) => {
        const v = controls[i] as CtrlValue | undefined;
        return v && typeof v === "object" && v.kind === c.kind ? ({ ...c, ...v } as CtrlValue) : c;
      }),
    };
  }
  const vis = r.visibility && typeof r.visibility === "object" ? (r.visibility as Partial<IntervalVisibility>) : {};
  const unit = (k: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months") => {
    const u = vis[k] as Partial<IntervalVisibility["days"]> | undefined;
    const def = d.visibility[k];
    return u && typeof u === "object"
      ? { on: typeof u.on === "boolean" ? u.on : def.on, from: typeof u.from === "number" ? u.from : def.from, to: typeof u.to === "number" ? u.to : def.to }
      : def;
  };
  return {
    style,
    rows,
    priceLine: typeof r.priceLine === "boolean" ? r.priceLine : d.priceLine,
    minTick: typeof r.minTick === "string" && MIN_TICK_OPTIONS.includes(r.minTick) ? r.minTick : d.minTick,
    visibility: {
      ticks: typeof vis.ticks === "boolean" ? vis.ticks : d.visibility.ticks,
      seconds: unit("seconds"),
      minutes: unit("minutes"),
      hours: unit("hours"),
      days: unit("days"),
      weeks: unit("weeks"),
      months: unit("months"),
      ranges: typeof vis.ranges === "boolean" ? vis.ranges : d.visibility.ranges,
    },
  };
}

// ── Style → series ──────────────────────────────────────────────────────────
const SOURCE_IDS: Record<string, PriceSource> = {
  Open: "open", High: "high", Low: "low", Close: "close",
  "(H + L)/2": "hl2", "(H + L + C)/3": "hlc3", "(O + H + L + C)/4": "ohlc4",
};

/** Chart type the series of a compare style is built with. */
export function chartTypeOf(style: CompareStyleId): ChartTypeId {
  return style === "hlcBars" ? "bar" : style;
}

/** Series styles of a compared symbol: the main series' factory styles with
 *  the drawn style's entry replaced by the compare values. */
export function compareSeriesStyles(s: CompareStyleState): SeriesStyles {
  const g = s.style;
  const at = (id: string, i = 0) => s.rows[keyOf(g, id)]?.controls?.[i];
  const checked = (id: string) => !!s.rows[keyOf(g, id)]?.checked;
  const color = (id: string, i = 0) => { const c = at(id, i); return c?.kind === "color" ? c.color : "#2962FF"; };
  const spec = (id: string): LineSpec => { const c = at(id); return c?.kind === "color" ? { color: c.color, width: c.width ?? 1, style: c.style ?? 0 } : { color: "#2962FF", width: 2, style: 0 }; };
  const pair = (id: string) => { const c = at(id); return c?.kind === "colorPair" ? c : { kind: "colorPair" as const, up: UP, down: DOWN }; };
  const src = (): PriceSource => { const c = at("Price source"); return (c?.kind === "select" && SOURCE_IDS[c.value]) || "close"; };
  const num = (id: string, def: number) => { const c = at(id); const n = c?.kind === "input" ? parseFloat(c.value) : NaN; return Number.isFinite(n) ? n : def; };
  const candle = () => ({
    prevClose: g === "hollowCandle" ? false : checked("Color bars based on previous close"),
    body: checked("Body"), bodyUp: pair("Body").up, bodyDown: pair("Body").down,
    border: checked("Borders"), borderUp: pair("Borders").up, borderDown: pair("Borders").down,
    wick: checked("Wick"), wickUp: pair("Wick").up, wickDown: pair("Wick").down,
  });
  const st: SeriesStyles = { ...DEFAULT_SERIES_STYLES };
  switch (g) {
    case "bar":
      st.bar = { prevClose: checked("Color bars based on previous close"), hlc: checked("HLC bars"), up: color("Up color"), down: color("Down color"), thin: checked("Thin bars") };
      break;
    case "hlcBars": {
      const c = color("Bars");
      st.bar = { prevClose: false, hlc: true, up: c, down: c, thin: checked("Thin bars") };
      break;
    }
    case "candle":
    case "hollowCandle":
      st[g] = candle();
      break;
    case "column":
      st.column = { source: src(), prevClose: checked("Color bars based on previous close"), up: color("Up color"), down: color("Down color") };
      break;
    case "line":
    case "lineWithMarkers":
    case "stepline": {
      const l = spec("Line");
      st[g] = { source: src(), type: "Solid", color: l.color, start: l.color, end: l.color, width: l.width, style: l.style };
      break;
    }
    case "area":
      st.area = { source: src(), line: spec("Line"), top: pair("Fill").up, bottom: pair("Fill").down };
      break;
    case "hlcArea":
      st.hlcArea = {
        high: { ...spec("High line"), on: checked("High line") },
        low: { ...spec("Low line"), on: checked("Low line") },
        close: spec("Close line"),
        fillTop: pair("Fill").up,
        fillBottom: pair("Fill").down,
      };
      break;
    case "baseline":
      st.baseline = {
        source: src(), top: spec("Top line"), bottom: spec("Bottom line"),
        topFill1: pair("Fill top area").up, topFill2: pair("Fill top area").down,
        bottomFill1: pair("Fill bottom area").up, bottomFill2: pair("Fill bottom area").down,
        level: num("Base level", 50),
      };
      break;
    case "hilo":
      st.hilo = {
        body: checked("Body"), bodyColor: color("Body"),
        border: checked("Borders"), borderColor: color("Borders"),
        labels: checked("Labels"), labelColor: color("Labels"),
      };
      break;
  }
  return st;
}

/** Price source of the drawn style (the legend / percent base value). */
export function compareSource(s: CompareStyleState): PriceSource {
  const c = s.rows[keyOf(s.style, "Price source")]?.controls?.[0];
  return (c?.kind === "select" && SOURCE_IDS[c.value]) || "close";
}

/** Main colour of the drawn style: legend values and the price-scale label. */
export function compareColor(s: CompareStyleState): string {
  const at = (id: string, i = 0) => s.rows[keyOf(s.style, id)]?.controls?.[i];
  const first = (...ids: string[]) => {
    for (const id of ids) {
      const c = at(id);
      if (c?.kind === "color") return c.color;
      if (c?.kind === "colorPair") return c.up;
    }
    return "#2962FF";
  };
  switch (s.style) {
    case "bar":
    case "column": return first("Up color");
    case "candle":
    case "hollowCandle": return first("Body");
    case "hlcArea": return first("Close line");
    case "baseline": return first("Top line");
    case "hlcBars": return first("Bars");
    case "hilo": return first("Body");
    default: return first("Line");
  }
}
