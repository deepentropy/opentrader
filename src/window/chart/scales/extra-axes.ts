/*
 * Price axes past the first one of a side (scale-layout.ts): the chart
 * library draws one axis per side, so its side axis is widened
 * (minimumWidth) and this primitive paints the other scales of the side next
 * to the library's own one, outwards (reference: index 0 next to the chart).
 *
 * Each extra scale is a library overlay scale "<side>#<index>" of its pane;
 * the axis shows what the reference axis shows: its border on the chart side,
 * its tick marks and labels, the last-value labels of its series (taken off
 * the library, which would draw them on the pane's first axis) and the
 * crosshair price label. Widths follow the library's rule (border + tick +
 * paddings + 5 + widest text, made even); each index is as wide as its widest
 * pane, the side's first index keeps the width the library gives it.
 */
import {
  PriceScaleMode,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Side } from "./scale-layout";

const EXTRA_RE = /^(left|right)#(\d+)$/;

/** A library scale id of an extra axis ("right#1"...). */
export function isExtraScaleId(id: unknown): id is string {
  return typeof id === "string" && EXTRA_RE.test(id);
}

/** Series on an extra axis wanting their last-value label (the axis draws it). */
const labelWish = new WeakMap<object, boolean>();

/** A series goes on scale `scaleId`: on an extra axis its last-value label is
 *  drawn by that axis (`wanted` = the label the series should show). */
export function setSeriesScale(s: ISeriesApi<SeriesType>, scaleId: string, wanted: boolean): void {
  const o = s.options() as { priceScaleId?: string; lastValueVisible?: boolean };
  const extra = isExtraScaleId(scaleId);
  labelWish.set(s, wanted);
  const patch: Record<string, unknown> = {};
  if (o.priceScaleId !== scaleId) patch.priceScaleId = scaleId;
  const shown = extra ? false : wanted;
  if (o.lastValueVisible !== shown) patch.lastValueVisible = shown;
  // The library draws a series' name tag next to the pane's first scale: off on an extra axis.
  if (extra && (o as { title?: string }).title) patch.title = "";
  if (Object.keys(patch).length) s.applyOptions(patch);
}

/** The last-value label a series asked for when it went on its scale. */
export function labelWanted(s: object): boolean {
  return labelWish.get(s) ?? false;
}

/** Width of the first axis of each side per chart (renderers on the side axis keep to it). */
const firstWidths = new WeakMap<IChartApi, { left: number; right: number }>();

/** Width a renderer on the `side` axis may use: the side's first scale (the
 *  whole axis without extra scales). */
export function firstAxisWidth(chart: IChartApi | null | undefined, side: string | undefined, full: number): number {
  const w = chart ? firstWidths.get(chart) : undefined;
  const v = w && (side === "left" || side === "right") ? w[side] : 0;
  return v > 0 ? Math.min(v, full) : full;
}

/** One extra scale of a pane as the axis paints it. */
export type ExtraScale = { pane: number; side: Side; index: number; libId: string };

export type AxisStyle = {
  font: string;
  fontSize: number;
  textColor: string;
  borderColor: string;
  borderVisible: boolean;
  crosshairBg: string;
  crosshairVisible: boolean;
};

type Label = { y: number; text: string; bg: string; fg: string };

/** What a scale draws now: tick marks and its labels. */
type ScalePaint = { ticks: { y: number; text: string }[]; labels: Label[]; texts: string[] };

const NICE = [1, 2, 2.5, 5, 10];

function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const n of NICE) if (n * p >= raw) return n * p;
  return 10 * p;
}

function contrast(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  const h = /^#([0-9a-f]{6})/i.exec(color.trim());
  const h3 = /^#([0-9a-f]{3})$/i.exec(color.trim());
  const [r, g, b] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : h
      ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)]
      : h3
        ? [parseInt(h3[1][0] + h3[1][0], 16), parseInt(h3[1][1] + h3[1][1], 16), parseInt(h3[1][2] + h3[1][2], 16)]
        : [0, 0, 0];
  return 0.199 * r + 0.687 * g + 0.114 * b < 150 ? "#ffffff" : "#000000";
}

/** Value and colour of a series' last point. */
function lastPoint(s: ISeriesApi<SeriesType>): { value: number; color: string } | null {
  const data = s.data();
  for (let i = data.length - 1; i >= 0; i--) {
    const d = data[i] as { value?: number; close?: number; open?: number; color?: string; lineColor?: string };
    const v = d.value ?? d.close;
    if (v == null || !Number.isFinite(v)) continue;
    const o = s.options() as { color?: string; lineColor?: string; upColor?: string; downColor?: string };
    let color = d.color ?? d.lineColor ?? o.color ?? o.lineColor;
    if (!color && d.close != null && d.open != null) color = d.close >= d.open ? o.upColor : o.downColor;
    return { value: v, color: color ?? "#2962FF" };
  }
  return null;
}

/** Value of the first visible bar (base of the percent / indexed modes). */
function baseValue(chart: IChartApi, s: ISeriesApi<SeriesType>): number | null {
  const r = chart.timeScale().getVisibleLogicalRange();
  if (!r) return null;
  const d = s.dataByIndex(Math.max(0, Math.ceil(r.from)), 1 /* nearest right */) as { value?: number; close?: number } | null;
  const v = d?.value ?? d?.close;
  return v != null && Number.isFinite(v) && v !== 0 ? v : null;
}

function fmtPercent(v: number): string {
  const s = Math.abs(v).toFixed(2);
  return `${v < 0 ? "−" : ""}${s}%`;
}

/** The axis maths of one extra scale. */
export class ExtraScaleModel {
  constructor(private chart: IChartApi, readonly scale: ExtraScale) {}

  /** Series of the scale, the first one leading (formatter, percent base). */
  series(): ISeriesApi<SeriesType>[] {
    const pane = this.chart.panes()[this.scale.pane];
    if (!pane) return [];
    return pane.getSeries().filter((s) => (s.options() as { priceScaleId?: string }).priceScaleId === this.scale.libId);
  }

  private mode(): PriceScaleMode {
    try {
      return this.chart.priceScale(this.scale.libId, this.scale.pane).options().mode;
    } catch {
      return PriceScaleMode.Normal;
    }
  }

  /** Text of price `p` on this scale. */
  formatter(): ((p: number) => string) | null {
    const lead = this.series().find((s) => s.options().visible !== false) ?? this.series()[0];
    if (!lead) return null;
    const mode = this.mode();
    if (mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100) {
      const base = baseValue(this.chart, lead);
      if (base === null) return null;
      return mode === PriceScaleMode.Percentage ? (p) => fmtPercent((p / base - 1) * 100) : (p) => ((p / base) * 100).toFixed(2);
    }
    const f = lead.priceFormatter();
    return (p) => f.format(p);
  }

  /** Ticks and labels at pane height `h` (spacing from the font size). */
  paint(h: number, fontSize: number): ScalePaint {
    const out: ScalePaint = { ticks: [], labels: [], texts: [] };
    const series = this.series();
    const lead = series.find((s) => s.options().visible !== false);
    const fmt = this.formatter();
    if (!lead || !fmt || !(h > 0)) return out;
    const top = lead.coordinateToPrice(0);
    const bottom = lead.coordinateToPrice(h);
    if (top == null || bottom == null) return out;
    const hi = Math.max(top as number, bottom as number);
    const lo = Math.min(top as number, bottom as number);
    // Edge texts (the library sizes its axis on them too).
    out.texts.push(fmt(hi), fmt(lo));
    const minGap = Math.ceil(fontSize * 2.5);
    const count = Math.max(1, Math.floor(h / minGap));
    const mode = this.mode();
    if (mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100) {
      const base = baseValue(this.chart, lead);
      if (base) {
        const toV = (p: number) => (mode === PriceScaleMode.Percentage ? (p / base - 1) * 100 : (p / base) * 100);
        const fromV = (v: number) => (mode === PriceScaleMode.Percentage ? base * (1 + v / 100) : (base * v) / 100);
        const step = niceStep((toV(hi) - toV(lo)) / count);
        for (let v = Math.ceil(toV(lo) / step) * step; v <= toV(hi); v += step) this.pushTick(out, lead, fromV(v), fmt, h);
      }
    } else {
      const step = niceStep((hi - lo) / count);
      let lastY = Number.POSITIVE_INFINITY;
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
        const y = lead.priceToCoordinate(p);
        if (y == null) continue;
        // Log mode: keep the spacing.
        if (Math.abs(lastY - (y as number)) < minGap * 0.8) continue;
        lastY = y as number;
        out.ticks.push({ y: y as number, text: fmt(p) });
      }
    }
    for (const t of out.ticks) out.texts.push(t.text);
    for (const s of series) {
      if (s.options().visible === false || !labelWish.get(s)) continue;
      const last = lastPoint(s);
      if (!last) continue;
      const y = s.priceToCoordinate(last.value);
      if (y == null) continue;
      const text = fmt(last.value);
      out.labels.push({ y: y as number, text, bg: last.color, fg: contrast(last.color) });
      out.texts.push(text);
    }
    return out;
  }

  private pushTick(out: ScalePaint, lead: ISeriesApi<SeriesType>, p: number, fmt: (p: number) => string, h: number): void {
    const y = lead.priceToCoordinate(p);
    if (y == null || (y as number) < 0 || (y as number) > h) return;
    out.ticks.push({ y: y as number, text: fmt(p) });
  }

  /** Price at pane y (crosshair label). */
  textAt(y: number): string | null {
    const lead = this.series().find((s) => s.options().visible !== false);
    const fmt = this.formatter();
    if (!lead || !fmt) return null;
    const p = lead.coordinateToPrice(y);
    return p == null ? null : fmt(p as number);
  }
}

/** Library axis width rule for a widest text `w` at font size `fs`. */
export function axisWidthFor(w: number, fs: number): number {
  const pad = (fs / 12) * 5;
  const res = Math.ceil(1 + 5 + pad + pad + 5 + (w || 34));
  return res + (res % 2);
}

/** Paints the extra axes of one pane side on the library's side axis. */
export class ExtraAxesPrimitive implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  scales: ExtraScaleModel[] = [];
  /** Width of each index of the side (index 0 = the library's own axis). */
  widths: number[] = [];
  crosshairY: number | null = null;
  /** Called on every chart update (texts may have changed width). */
  onUpdate: () => void = () => {};
  private views: IPrimitivePaneView[];

  constructor(readonly side: Side, public style: () => AxisStyle) {
    const self = this;
    this.views = [
      { zOrder: () => "normal" as const, renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => self.draw(t, false) }) as IPrimitivePaneRenderer },
      { zOrder: () => "top" as const, renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => self.draw(t, true) }) as IPrimitivePaneRenderer },
    ];
  }

  attached(p: { requestUpdate: () => void }): void {
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this.requestUpdate = null;
  }
  update(): void {
    this.requestUpdate?.();
  }
  updateAllViews(): void {
    this.onUpdate();
  }
  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Left edge (media x) of index `i` on an axis `W` wide. */
  private slotX(i: number, W: number): { x0: number; w: number } {
    let off = 0;
    for (let k = 0; k < i; k++) off += this.widths[k] ?? 0;
    const w = this.widths[i] ?? 0;
    return this.side === "right" ? { x0: off, w } : { x0: W - off - w, w };
  }

  private draw(target: CanvasRenderingTarget2D, top: boolean): void {
    if (!this.scales.length) return;
    const st = this.style();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      const h = mediaSize.height;
      const pad = (st.fontSize / 12) * 5;
      ctx.font = st.font;
      ctx.textBaseline = "middle";
      for (const m of this.scales) {
        const { x0, w } = this.slotX(m.scale.index, W);
        if (!(w > 0)) continue;
        // Inner edge: the chart side of this axis.
        const inner = this.side === "right" ? x0 : x0 + w;
        const dir = this.side === "right" ? 1 : -1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, w, h);
        ctx.clip();
        if (!top) {
          const p = m.paint(h, st.fontSize);
          if (st.borderVisible) {
            ctx.fillStyle = st.borderColor;
            ctx.fillRect(this.side === "right" ? x0 : x0 + w - 1, 0, 1, h);
            for (const t of p.ticks) ctx.fillRect(this.side === "right" ? inner : inner - 5, Math.round(t.y), 5, 1);
          }
          ctx.fillStyle = st.textColor;
          ctx.textAlign = this.side === "right" ? "left" : "right";
          for (const t of p.ticks) ctx.fillText(t.text, inner + dir * (5 + pad), t.y);
          for (const l of p.labels) this.label(ctx, l, inner, dir, st, pad);
        } else if (this.crosshairY !== null && st.crosshairVisible) {
          const text = m.textAt(this.crosshairY);
          if (text) this.label(ctx, { y: this.crosshairY, text, bg: st.crosshairBg, fg: contrast(st.crosshairBg) }, inner, dir, st, pad);
        }
        ctx.restore();
      }
    });
  }

  /** A label box on the axis (library geometry: tick, paddings, text). */
  private label(ctx: CanvasRenderingContext2D, l: Label, inner: number, dir: number, st: AxisStyle, pad: number): void {
    const tw = Math.ceil(ctx.measureText(l.text).width);
    const total = 1 + pad + pad + tw + 5;
    const hgt = st.fontSize + ((2.5 / 12) * st.fontSize) * 2;
    const yTop = Math.round(l.y - hgt / 2);
    ctx.fillStyle = l.bg;
    const x = dir > 0 ? inner : inner - total;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, yTop, total, hgt, dir > 0 ? [0, 2, 2, 0] : [2, 0, 0, 2]);
    else ctx.rect(x, yTop, total, hgt);
    ctx.fill();
    ctx.fillStyle = l.fg;
    ctx.textAlign = dir > 0 ? "left" : "right";
    ctx.fillText(l.text, inner + dir * (5 + pad), l.y);
  }
}

/** Remember the first-axis widths of a chart (firstAxisWidth). */
export function setFirstAxisWidths(chart: IChartApi, w: { left: number; right: number }): void {
  firstWidths.set(chart, w);
}
