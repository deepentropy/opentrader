/*
 * The outputs of a study a user can style (Settings > Style), and their overrides applied to a result.
 *
 * Reference rules (its study property page): one row group per output in the study's declaration order — line plots
 * (colour, width, plot type), shapes (colour, shape, location), characters (colour, character, location), arrows
 * ("Up" / "Down" colours), background / bar colours (a "Color n" row per palette colour), candles ("Body", "Wick",
 * "Border" colours) — then the hlines (colour, line style, value), the fills (one colour, a palette or the two colours
 * of a gradient) and one show / hide row per kind of drawing ("GRAPHIC OBJECTS"). Outputs declared not editable are
 * not listed; they are still drawn.
 *
 * Overrides are stored with the plot overrides of the study (IndicatorStyleOverrides): a line plot under its plot id,
 * the other outputs under `<kind>:<id>` (styleKey).
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { PlotConfig } from "oakscriptjs";
import type { PlotStyleOverride, IndicatorStyleOverrides } from "./indicator-layer";

export type ShapeStyle = "xcross" | "cross" | "triangleup" | "triangledown" | "flag" | "circle" | "arrowup" | "arrowdown" | "labelup" | "labeldown" | "square" | "diamond";
export type ShapeLocation = "abovebar" | "belowbar" | "top" | "bottom" | "absolute";
export type DrawingKind = "label" | "line" | "box" | "linefill" | "polyline" | "table";
type LineStyleName = "solid" | "dashed" | "dotted";

/** Shape / character declaration (oakscriptjs ShapeConfig). */
export type ShapeDecl = {
  id: string;
  kind: "shape" | "char";
  title?: string;
  style?: ShapeStyle;
  char?: string;
  location: ShapeLocation;
  color?: string;
  palette?: string[];
  offset?: number;
  editable?: boolean;
  /** 'none': hidden by default (unchecked in the Style tab until the user shows it) */
  display?: string;
};
type ArrowDecl = { id: string; title?: string; colorup: string; colordown: string; editable?: boolean };
type ColorsDecl = { id: string; kind: "bgcolor" | "barcolor"; title?: string; palette?: string[]; outputIndex?: number; editable?: boolean };
type CandleDecl = {
  id: string;
  kind?: "candle" | "bar";
  title?: string;
  color?: string;
  wickColor?: string;
  borderColor?: string;
  palettes?: { color?: string[]; wickColor?: string[]; borderColor?: string[] };
  editable?: boolean;
};
type HLineDecl = { id: string; price: number; title?: string; color?: string; linestyle?: LineStyleName; linewidth?: number; display?: string; editable?: boolean };
type FillDecl = { id: string; plot1: string; plot2: string; title?: string; color?: string; palette?: string[]; topColor?: string; bottomColor?: string; editable?: boolean };
type OutputDecl = { kind: "plot" | "shape" | "char" | "arrow" | "candle" | "bar"; id: string; title?: string };

/** The declarations of an entry beyond its line plots (library entries and scripts give the same fields). */
export type StyleEntry = Pick<IndicatorRegistryEntry, "plotConfig"> & {
  shapeConfig?: ShapeDecl[];
  arrowConfig?: ArrowDecl[];
  barColorConfig?: ColorsDecl[];
  plotCandleConfig?: CandleDecl[];
  hlineConfig?: HLineDecl[];
  /** Declarations of the hlines a built-in gives in its result (no hlineConfig): `hline<k>` for the k-th */
  resultHlineConfig?: HLineDecl[];
  fillConfig?: FillDecl[];
  outputs?: OutputDecl[];
  /** Order of the Style rows (declaration order of the original) for an entry without `outputs` */
  styleOrder?: OutputDecl[];
  markerDrawing?: DrawingKind;
  drawingKinds?: DrawingKind[];
};

/** One output listed in the Style tab. `key`: its key in the study's style overrides. */
export type StyleItem =
  | { kind: "plot"; key: string; def: PlotConfig }
  | { kind: "shape"; key: string; decl: ShapeDecl }
  | { kind: "arrow"; key: string; decl: ArrowDecl }
  | { kind: "colors"; key: string; decl: ColorsDecl }
  | { kind: "candle"; key: string; decl: CandleDecl }
  | { kind: "hline"; key: string; decl: HLineDecl }
  | { kind: "fill"; key: string; decl: FillDecl }
  | { kind: "drawing"; key: string; drawing: DrawingKind; title: string };

export const styleKey = (kind: Exclude<StyleItem["kind"], "plot">, id: string): string => `${kind}:${id}`;

/** Drawing groups in the reference order (its graphics keys sorted) and titles. */
const DRAWINGS: [DrawingKind, string][] = [
  ["box", "Boxes"],
  ["label", "Pane labels"],
  ["linefill", "Line fills"],
  ["line", "Lines"],
  ["polyline", "Polylines"],
  ["table", "Tables"],
];

const editable = (d: { editable?: boolean }) => d.editable !== false;

/** The outputs of an entry listed in its Style tab, in the reference order. */
export function styleItems(entry: StyleEntry): StyleItem[] {
  // a plot hidden by default (display none) is listed, unchecked (reference: every plot not isHidden)
  const plots = (entry.plotConfig ?? []).filter((p) => editable(p as { editable?: boolean }));
  const shapes = (entry.shapeConfig ?? []).filter(editable);
  const arrows = (entry.arrowConfig ?? []).filter(editable);
  const candles = (entry.plotCandleConfig ?? []).filter(editable);
  const colors = (entry.barColorConfig ?? []).filter(editable);
  const outputs: StyleItem[] = [];
  // The plot-like outputs in declaration order (entry.outputs), the ones it does not name after them.
  const seen = new Set<string>();
  const push = (item: StyleItem | undefined) => {
    if (item && !seen.has(item.key)) { seen.add(item.key); outputs.push(item); }
  };
  const plotItem = (id: string): StyleItem | undefined => {
    const def = plots.find((p) => p.id === id);
    return def && { kind: "plot", key: def.id, def };
  };
  const shapeItem = (id: string): StyleItem | undefined => {
    const decl = shapes.find((s) => s.id === id);
    return decl && { kind: "shape", key: styleKey("shape", id), decl };
  };
  const arrowItem = (id: string): StyleItem | undefined => {
    const decl = arrows.find((s) => s.id === id);
    return decl && { kind: "arrow", key: styleKey("arrow", id), decl };
  };
  const candleItem = (id: string): StyleItem | undefined => {
    const decl = candles.find((s) => s.id === id);
    return decl && { kind: "candle", key: styleKey("candle", id), decl };
  };
  // Background / bar colours sit after the first `outputIndex` declared outputs (all of them when unset).
  const colorsAt = (n: number) => {
    for (const decl of colors) if (decl.outputIndex === n) push({ kind: "colors", key: styleKey("colors", decl.id), decl });
  };
  (entry.outputs ?? entry.styleOrder ?? []).forEach((o, n) => {
    colorsAt(n);
    if (o.kind === "plot") push(plotItem(o.id));
    else if (o.kind === "shape" || o.kind === "char") push(shapeItem(o.id));
    else if (o.kind === "arrow") push(arrowItem(o.id));
    else push(candleItem(o.id));
  });
  for (const p of plots) push(plotItem(p.id));
  for (const s of shapes) push(shapeItem(s.id));
  for (const a of arrows) push(arrowItem(a.id));
  for (const c of candles) push(candleItem(c.id));
  for (const decl of colors) push({ kind: "colors", key: styleKey("colors", decl.id), decl });

  const hlineDecls = entry.hlineConfig?.length ? entry.hlineConfig : entry.resultHlineConfig ?? [];
  const hlines: StyleItem[] = hlineDecls.filter(editable).map((decl) => ({ kind: "hline", key: styleKey("hline", decl.id), decl }));
  // An untitled fill: "Hlines Background" between two hlines, else "Plots Background" (reference compiler names).
  const hlineIds = new Set((entry.hlineConfig ?? []).map((h) => h.id));
  const fills: StyleItem[] = (entry.fillConfig ?? []).filter(editable).map((decl) => ({
    kind: "fill",
    key: styleKey("fill", decl.id),
    decl: decl.title ? decl : { ...decl, title: hlineIds.has(decl.plot1) && hlineIds.has(decl.plot2) ? "Hlines Background" : "Plots Background" },
  }));
  const kinds = new Set(entry.drawingKinds ?? []);
  const drawings: StyleItem[] = DRAWINGS.filter(([k]) => kinds.has(k)).map(([drawing, title]) => ({ kind: "drawing", key: styleKey("drawing", drawing), drawing, title }));
  return [...outputs, ...hlines, ...fills, ...drawings];
}

/**
 * The "Output values" rows of an entry's Style tab (reference rules): "Precision" when it has outputs, "Labels on
 * price scale" and "Values in status line" when one of them has values of its own (a line plot, shape, character,
 * arrow or candle, not only colours or alert conditions). "Input values" when it has inputs.
 */
export function outputValueRows(entry: StyleEntry & { alertConditions?: unknown[]; inputConfig?: { hidden?: boolean }[] }): { precision: boolean; values: boolean; inputs: boolean } {
  const values = (entry.plotConfig?.length ?? 0) + (entry.shapeConfig?.length ?? 0) + (entry.arrowConfig?.length ?? 0) + (entry.plotCandleConfig?.length ?? 0) > 0;
  const precision = values || (entry.barColorConfig?.length ?? 0) > 0 || (entry.alertConditions?.length ?? 0) > 0;
  const inputs = (entry.inputConfig ?? []).some((i) => !i.hidden);
  return { precision, values, inputs };
}

// ── applying the overrides ─────────────────────────────────────────────────────

/** Colour as [r, g, b, a] (hex, rgb(a)); null when not parsed. */
function rgba(c: string | undefined | null): number[] | null {
  if (!c) return null;
  const s = c.trim();
  if (s === "transparent") return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(s);
  if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16), m[4] ? parseInt(m[4] + m[4], 16) / 255 : 1];
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
    return [v[0], v[1], v[2], v[3] ?? 1];
  }
  return null;
}

/** Same colour (string or value). */
export function sameColor(a: string | undefined | null, b: string | undefined | null): boolean {
  if (a === b) return true;
  const x = rgba(a);
  const y = rgba(b);
  return !!x && !!y && x.every((v, i) => Math.abs(v - y[i]) < (i === 3 ? 0.01 : 0.6));
}

/** The palette colour `color` is drawn with, replaced by its override. */
function paletteColor(color: string, palette: string[] | undefined, override: (string | undefined)[] | undefined): string {
  if (!palette || !override) return color;
  const i = palette.findIndex((c) => sameColor(c, color));
  return i >= 0 && override[i] ? override[i]! : color;
}

const MARKER_SHAPES: Record<ShapeStyle, string> = {
  xcross: "xcross",
  cross: "cross",
  triangleup: "triangleUp",
  triangledown: "triangleDown",
  flag: "flag",
  circle: "circle",
  arrowup: "arrowUp",
  arrowdown: "arrowDown",
  labelup: "labelUp",
  labeldown: "labelDown",
  square: "square",
  diamond: "diamond",
};
const SHAPE_OF_MARKER = Object.fromEntries(Object.entries(MARKER_SHAPES).map(([k, v]) => [v, k])) as Record<string, ShapeStyle>;

/** Marker position of a PineScript location (oakscriptjs rule): on the price, a label pointing down above it, a
 *  label pointing up below it, the other shapes and the characters centred on it. */
function markerPosition(location: ShapeLocation, shape: ShapeStyle | undefined): string {
  switch (location) {
    case "abovebar": return "aboveBar";
    case "belowbar": return "belowBar";
    case "top": return "top";
    case "bottom": return "bottom";
    case "absolute": return shape === "labeldown" ? "atPriceTop" : shape === "labelup" ? "atPriceBottom" : "atPriceMiddle";
  }
}

const DRAWING_FIELDS: Record<DrawingKind, string> = { label: "labels", line: "lines", box: "boxes", linefill: "linefills", polyline: "polylines", table: "tables" };

type Marker = { time: number; position: string; price?: number; shape: string; color: string; char?: string; id?: string; [k: string]: unknown };

/** Values of a shape / character series by bar time (outputValues), for a marker moved to "Absolute". */
function absolutePrice(result: any, decl: ShapeDecl, time: number, bars: { time: unknown }[]): number | undefined {
  const values: { time: number; value: number }[] | undefined = result?.outputValues?.[decl.id];
  if (!values?.length) return undefined;
  let t = time;
  // the marker is drawn `offset` bars from the bar it was computed on
  if (decl.offset) {
    const i = bars.findIndex((b) => (b.time as number) === time);
    const j = i - decl.offset;
    if (i < 0 || j < 0 || j >= bars.length) return undefined;
    t = bars[j].time as number;
  }
  return values.find((v) => v.time === t)?.value;
}

function applyMarkers(entry: StyleEntry, result: any, styles: IndicatorStyleOverrides, bars: { time: unknown }[]): Marker[] | undefined {
  const markers: Marker[] | undefined = result?.markers;
  if (!markers?.length) return markers;
  const decls = new Map((entry.shapeConfig ?? []).map((d) => [d.id, d]));
  const drawingHidden = entry.markerDrawing && styles[styleKey("drawing", entry.markerDrawing)]?.visible === false;
  let changed = false;
  const out: Marker[] = [];
  for (const m of markers) {
    const decl = m.id ? decls.get(m.id) : undefined;
    // markers the reference draws as labels go with the labels
    if (!decl || decl.editable === false) {
      if (drawingHidden && (!decl || entry.markerDrawing)) { changed = true; continue; }
      out.push(m);
      continue;
    }
    const ov = styles[styleKey("shape", decl.id)];
    // hidden by default until its Style row is checked
    if (decl.display === "none" && ov?.visible !== true) { changed = true; continue; }
    if (!ov) { out.push(m); continue; }
    if (ov.visible === false) { changed = true; continue; }
    const next: Marker = { ...m };
    if (ov.color !== undefined && decl.color !== undefined) next.color = ov.color;
    if (decl.palette) next.color = paletteColor(m.color, decl.palette, ov.palette);
    if (decl.kind === "char" && ov.char !== undefined) next.char = ov.char;
    const style = decl.kind === "shape" ? ((ov.shape as ShapeStyle | undefined) ?? decl.style ?? SHAPE_OF_MARKER[m.shape]) : undefined;
    if (style) next.shape = MARKER_SHAPES[style];
    if (ov.location !== undefined || ov.shape !== undefined) {
      const location = (ov.location as ShapeLocation | undefined) ?? decl.location;
      next.position = markerPosition(location, style);
      if (location === "absolute") {
        const price = m.price ?? absolutePrice(result, decl, m.time, bars);
        if (price === undefined || !Number.isFinite(price)) { changed = true; continue; }
        next.price = price;
      } else delete next.price;
    }
    changed = true;
    out.push(next);
  }
  return changed ? out : markers;
}

function applyArrows(entry: StyleEntry, arrows: any[] | undefined, styles: IndicatorStyleOverrides): any[] | undefined {
  if (!arrows?.length) return arrows;
  const ids = new Set((entry.arrowConfig ?? []).filter(editable).map((a) => a.id));
  return arrows.flatMap((a) => {
    const ov = ids.has(a.id) ? styles[styleKey("arrow", a.id)] : undefined;
    if (!ov) return [a];
    if (ov.visible === false) return [];
    const color = a.value > 0 ? ov.colorUp : ov.colorDown;
    return [color !== undefined ? { ...a, color } : a];
  });
}

/** Background / bar colours: the declaration id on each entry (a single declaration of the kind owns the entries
 *  without one), hidden ones dropped, palette colours replaced. */
function applyColors(entry: StyleEntry, list: any[] | undefined, kind: "bgcolor" | "barcolor", styles: IndicatorStyleOverrides): any[] | undefined {
  if (!list?.length) return list;
  const decls = (entry.barColorConfig ?? []).filter((d) => d.kind === kind);
  const only = decls.length === 1 ? decls[0] : undefined;
  return list.flatMap((x) => {
    const decl = decls.find((d) => d.id === x.id) ?? (x.id ? undefined : only);
    if (!decl || decl.editable === false) return [x];
    const ov = styles[styleKey("colors", decl.id)];
    if (!ov) return [x];
    if (ov.visible === false) return [];
    const color = paletteColor(x.color, decl.palette, ov.palette);
    return [color !== x.color ? { ...x, color } : x];
  });
}

const CANDLE_FIELDS = ["color", "wickColor", "borderColor"] as const;

function applyCandles(entry: StyleEntry, map: Record<string, any[]> | undefined, styles: IndicatorStyleOverrides): Record<string, any[]> | undefined {
  if (!map) return map;
  const decls = new Map((entry.plotCandleConfig ?? []).map((d) => [d.id, d]));
  let out = map;
  for (const [id, list] of Object.entries(map)) {
    const decl = decls.get(id);
    const ov = decl && decl.editable !== false ? styles[styleKey("candle", id)] : undefined;
    if (!ov) continue;
    if (out === map) out = { ...map };
    if (ov.visible === false) { delete out[id]; continue; }
    const fixed: Partial<Record<(typeof CANDLE_FIELDS)[number], string>> = {};
    const pals: Partial<Record<(typeof CANDLE_FIELDS)[number], (string | undefined)[]>> = {};
    for (const f of CANDLE_FIELDS) {
      const v = ov[f === "color" ? "color" : f];
      if (decl!.palettes?.[f]) pals[f] = (f === "color" ? ov.palette : f === "wickColor" ? ov.wickPalette : ov.borderPalette);
      else if (v !== undefined && decl![f] !== undefined) fixed[f] = v as string;
    }
    out[id] = list.map((c) => {
      const next = { ...c, ...fixed };
      for (const f of CANDLE_FIELDS) if (pals[f] && c[f]) next[f] = paletteColor(c[f], decl!.palettes![f], pals[f]);
      return next;
    });
  }
  return out;
}

/** A fill with its override: colour, palette colours, gradient colours. */
function fillWith<T extends { color?: string; colors?: (string | null)[]; gradient?: any; options?: any }>(f: T, decl: FillDecl, ov: PlotStyleOverride, inResult: boolean): T {
  const next: any = { ...f };
  if (ov.color !== undefined && decl.color !== undefined) {
    if (inResult) next.options = { ...f.options, color: ov.color, transp: undefined };
    else next.color = ov.color;
    delete next.colors;
  }
  if (decl.palette && ov.palette && f.colors) next.colors = f.colors.map((c) => (c ? paletteColor(c, decl.palette, ov.palette) : c));
  if (f.gradient && (ov.topColor !== undefined || ov.bottomColor !== undefined)) {
    const g = f.gradient;
    next.gradient = {
      ...g,
      topColor: ov.topColor !== undefined && decl.topColor !== undefined ? g.topColor.map((c: string | null) => (c == null ? c : ov.topColor)) : g.topColor,
      bottomColor: ov.bottomColor !== undefined && decl.bottomColor !== undefined ? g.bottomColor.map((c: string | null) => (c == null ? c : ov.bottomColor)) : g.bottomColor,
    };
  }
  return next;
}

/**
 * The result, hlines and fills to draw with the study's Style overrides (the entry's other outputs than its line
 * plots, which the renderer takes as plot overrides). Unchanged objects are returned as they are.
 */
export function applyStyleOverrides(
  entry: StyleEntry,
  result: any,
  styles: IndicatorStyleOverrides,
  bars: { time: unknown }[],
): { result: any; hlineConfig: HLineDecl[] | undefined; fillConfig: FillDecl[] | undefined } {
  if (!result) return { result, hlineConfig: entry.hlineConfig, fillConfig: entry.fillConfig };
  const r = { ...result };
  r.markers = applyMarkers(entry, result, styles, bars);
  r.arrows = applyArrows(entry, result.arrows, styles);
  r.bgColors = applyColors(entry, result.bgColors, "bgcolor", styles);
  r.barColors = applyColors(entry, result.barColors, "barcolor", styles);
  r.plotCandles = applyCandles(entry, result.plotCandles, styles);
  r.plotBars = applyCandles(entry, result.plotBars, styles);
  // drawings
  for (const [kind, field] of Object.entries(DRAWING_FIELDS) as [DrawingKind, string][]) {
    if (styles[styleKey("drawing", kind)]?.visible === false && result[field]) r[field] = [];
  }
  // hlines (the entry's declarations, drawn by the renderer)
  const hlineConfig = entry.hlineConfig?.map((h) => {
    const ov = h.editable !== false ? styles[styleKey("hline", h.id)] : undefined;
    if (!ov) return h;
    return {
      ...h,
      ...(ov.visible === false ? { display: "none" } : {}),
      ...(ov.color !== undefined ? { color: ov.color } : {}),
      ...(ov.lineWidth !== undefined ? { linewidth: ov.lineWidth } : {}),
      ...(ov.lineStyle !== undefined ? { linestyle: ov.lineStyle as LineStyleName } : {}),
      ...(ov.price !== undefined ? { price: ov.price } : {}),
    };
  });
  // hlines of the result (declared in resultHlineConfig): matched by their id
  if (result.hlines?.length && entry.resultHlineConfig?.length) {
    const decls = new Map(entry.resultHlineConfig.map((d) => [d.id, d]));
    r.hlines = result.hlines.flatMap((h: any) => {
      const d = h.id ? decls.get(h.id) : undefined;
      const ov = d && d.editable !== false ? styles[styleKey("hline", d.id)] : undefined;
      if (!ov) return [h];
      if (ov.visible === false) return [];
      return [{
        ...h,
        ...(ov.price !== undefined ? { value: ov.price } : {}),
        options: {
          ...h.options,
          ...(ov.color !== undefined ? { color: ov.color } : {}),
          ...(ov.lineWidth !== undefined ? { linewidth: ov.lineWidth } : {}),
          ...(ov.lineStyle !== undefined ? { linestyle: ov.lineStyle } : {}),
        },
      }];
    });
  }
  // fills: between hlines in the entry, between plots in the result (matched to their declaration by id or plots)
  const fillDecls = entry.fillConfig ?? [];
  const fillOv = (d: FillDecl | undefined) => (d && d.editable !== false ? styles[styleKey("fill", d.id)] : undefined);
  const fillConfig = entry.fillConfig?.flatMap((f) => {
    const ov = fillOv(f);
    if (!ov) return [f];
    if (ov.visible === false) return [];
    return [fillWith(f as FillDecl & { colors?: (string | null)[]; gradient?: unknown }, f, ov, false)];
  });
  if (result.fills?.length) {
    const used = new Set<string>();
    r.fills = result.fills.flatMap((f: any) => {
      const same = (d: FillDecl) => !used.has(d.id) && d.plot1 === f.plot1 && d.plot2 === f.plot2;
      const decl = fillDecls.find((d) => d.id === f.id) ?? (f.id ? undefined : fillDecls.find((d) => same(d) && (d.title ?? "") === (f.options?.title ?? "")) ?? fillDecls.find(same));
      if (decl) used.add(decl.id);
      const ov = fillOv(decl);
      if (!ov) return [f];
      if (ov.visible === false) return [];
      return [fillWith(f, decl!, ov, true)];
    });
  }
  return { result: r, hlineConfig, fillConfig };
}
