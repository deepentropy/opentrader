/*
 * Draws the volume profile studies (vbp-studies.ts) on the price pane, as the
 * reference HHist / horizontal line views do:
 *
 * - Box and lines from the left edge of the profile's first bar to the right
 *   edge of its last bar; the Visible range profile is placed against the
 *   pane's edge (its width % of the pane) and its lines cross the pane.
 * - Histogram box over the rows' extent; rows 1 px apart when they are at
 *   least 1 px high; row length = width % of the box minus one px per part,
 *   scaled by the largest row total. Up/Down: up then down from the edge;
 *   Total: one part; Delta: the difference in the dominant side's colour,
 *   then twice the smaller side at half and quarter opacity.
 * - Values ("up × down") at 3 px from the edge, 70 % down the row, font
 *   min(1.7 x box width / text length, 0.6 x row height), all at the smallest
 *   size and only from 7.5 px; a sum row under the histogram.
 * - POC / VAH / VAL lines; extended lines stop at the bar that crosses them.
 * - Price scale labels (study "Labels on price scale"): per line kind, the
 *   line of the profile in view that ends last.
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { textOnColor } from "lightweight-charts-drawing/core/color";
import type { VbpDraw, VbpDrawProfile } from "./vbp-studies";
import type { VbpLine } from "./vbp-style";

/** Smallest font the values are written with. */
const MIN_VALUE_FONT = 7.5;

/** rgba() / #hex colour with its alpha multiplied by `k`. */
function scaleAlpha(color: string, k: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const a = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a * k})`;
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(c);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${(m[4] !== undefined ? +m[4] : 1) * k})`;
  return c;
}

/** Colour without its transparency (axis label background). */
function opaque(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  const hex = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(color.trim());
  return hex ? `#${hex[1]}` : color;
}

/** Volume as "74.89K", "1.07M". */
function volumeText(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return String(Math.round(v));
}

const dashOf = (style: number) => (style === 1 ? [6, 6] : style === 2 ? [2, 2] : []);

type Label = { y: number; text: string; color: string };

export class VbpPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPrimitivePaneView[];
  private labels: { poc: Label | null; vah: Label | null; val: Label | null } = { poc: null, vah: null, val: null };
  private readonly axisViews: ISeriesPrimitiveAxisView[];

  /** `times`: chart bar times by index (the profiles' i0 / i1); `labelsOnScale`: price scale labels allowed. */
  constructor(private readonly draw: VbpDraw, private readonly times: number[], private readonly labelsOnScale: boolean) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.paint(target) };
    this.views = [{ zOrder: () => "normal", renderer: () => renderer }];
    const axis = (k: "poc" | "vah" | "val"): ISeriesPrimitiveAxisView => ({
      coordinate: () => this.labels[k]?.y ?? -1,
      text: () => this.labels[k]?.text ?? "",
      textColor: () => textOnColor(this.labels[k]?.color ?? "#000000"),
      backColor: () => this.labels[k]?.color ?? "transparent",
      visible: () => this.labels[k] !== null,
      tickVisible: () => this.labels[k] !== null,
    });
    this.axisViews = [axis("val"), axis("vah"), axis("poc")];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<SeriesType, Time>;
    this.requestUpdate = param.requestUpdate;
    this.requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews(): void {
    this.updateLabels();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  /** x of the centre of chart bar `i` and the bar spacing. */
  private barX(i: number): number | null {
    const t = this.times[i];
    if (t === undefined || !this.chart) return null;
    return this.chart.timeScale().timeToCoordinate(t as unknown as Time);
  }

  private spacing(): number {
    const ts = this.chart!.timeScale();
    const a = ts.logicalToCoordinate(0 as never);
    const b = ts.logicalToCoordinate(1 as never);
    return a != null && b != null ? Math.abs(b - a) : 6;
  }

  /** Left / right x of a profile's box. */
  private xRange(p: VbpDrawProfile, half: number): { min: number; max: number } | null {
    const a = this.barX(p.i0);
    const b = this.barX(p.i1);
    if (a == null || b == null) return null;
    return this.draw.toBarEdges ? { min: a - half, max: b + half } : { min: a, max: b };
  }

  private updateLabels(): void {
    this.labels = { poc: null, vah: null, val: null };
    const { chart, series } = this;
    if (!chart || !series || !this.draw.showPrice || !this.labelsOnScale) return;
    const st = this.draw.style;
    const width = chart.timeScale().width();
    for (const k of ["poc", "vah", "val"] as const) {
      const line: VbpLine = st[k];
      if (!line.visible) continue;
      let best: { end: number; level: number } | null = null;
      for (const p of this.draw.profiles) {
        const a = this.barX(p.i0);
        const b = this.barX(p.i1);
        if (a == null || b == null) continue;
        // Lines of the visible range profile cross the pane; the others need an end in view or to span it.
        if (!this.draw.relative && (b < 0 || a > width)) continue;
        if (!best || p.i1 > best.end) best = { end: p.i1, level: p[k] };
      }
      if (!best) continue;
      const y = series.priceToCoordinate(best.level);
      if (y == null) continue;
      this.labels[k] = { y, text: series.priceFormatter().format(best.level), color: opaque(line.color) };
    }
  }

  private paint(target: CanvasRenderingTarget2D): void {
    const { chart, series } = this;
    if (!chart || !series) return;
    const d = this.draw;
    const st = d.style;
    const half = this.spacing() / 2;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, mediaSize }) => {
      const paneW = mediaSize.width;
      const fromRight = st.placement === "Right";
      for (const p of d.profiles) {
        const xr = d.relative ? { min: 0, max: paneW } : this.xRange(p, half);
        if (!xr || xr.max < 0 || xr.min > paneW) continue;
        const n = p.up.length;
        const yTop = series.priceToCoordinate(p.lo + n * p.step);
        const yBot = series.priceToCoordinate(p.lo);
        if (yTop == null || yBot == null) continue;
        if (Math.max(yTop, yBot) < 0 || Math.min(yTop, yBot) > mediaSize.height) continue;
        // Histogram box over the rows.
        if (!d.relative && st.boxColor) {
          ctx.fillStyle = st.boxColor;
          const x = Math.round(xr.min * hr);
          const y = Math.round(Math.min(yTop, yBot) * vr);
          ctx.fillRect(x, y, Math.round(xr.max * hr) - x, Math.round(Math.max(yTop, yBot) * vr) - y);
        }
        if (st.visible) this.paintRows(ctx, p, xr, fromRight, hr, vr, mediaSize.height);
      }
      // POC / VAH / VAL lines.
      for (const p of d.profiles) {
        const xr = d.relative ? { min: 0, max: paneW } : this.xRange(p, half);
        if (!xr) continue;
        for (const k of ["val", "vah", "poc"] as const) {
          const line = st[k];
          if (!line.visible) continue;
          const end = k === "poc" ? p.pocEnd : k === "vah" ? p.vahEnd : p.valEnd;
          let right = xr.max;
          if (end === -1) right = paneW;
          else if (end !== null) {
            const x = this.barX(end);
            if (x != null) right = d.toBarEdges ? x + half : x;
          }
          if (right < 0 || xr.min > paneW) continue;
          const y = series.priceToCoordinate(p[k]);
          if (y == null) continue;
          const lw = Math.max(1, Math.round(line.width * vr));
          const yy = Math.round(y * vr) + (lw % 2 ? 0.5 : 0);
          ctx.strokeStyle = line.color;
          ctx.lineWidth = lw;
          ctx.setLineDash(dashOf(line.style).map((v) => v * hr));
          ctx.beginPath();
          ctx.moveTo(Math.round(xr.min * hr), yy);
          ctx.lineTo(Math.round(right * hr), yy);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    });
  }

  private paintRows(ctx: CanvasRenderingContext2D, p: VbpDrawProfile, xr: { min: number; max: number }, fromRight: boolean, hr: number, vr: number, paneH: number): void {
    const series = this.series!;
    const d = this.draw;
    const st = d.style;
    const n = p.up.length;
    const delta = d.volume === "Delta";
    const total = d.volume === "Total";
    // Parts of each row and the largest row total.
    const parts: { values: number[]; colors: string[]; shown: number[] }[] = [];
    let max = 0;
    for (let r = 0; r < n; r++) {
      const va = r >= p.vaLo && r <= p.vaHi;
      const upC = va ? st.vaUpColor : st.upColor;
      const downC = va ? st.vaDownColor : st.downColor;
      const u = p.up[r];
      const dn = p.down[r];
      let values: number[];
      let colors: string[];
      let shown: number[];
      if (delta) {
        const hi = Math.max(u, dn);
        const lo = Math.min(u, dn);
        const base = u > dn ? upC : downC;
        values = [hi - lo, lo, lo];
        colors = [base, scaleAlpha(base, 0.5), scaleAlpha(base, 0.25)];
        shown = [hi - lo];
      } else if (total) {
        values = [u + dn];
        colors = [upC];
        shown = values;
      } else {
        values = [u, dn];
        colors = [upC, downC];
        shown = values;
      }
      parts.push({ values, colors, shown });
      max = Math.max(max, values.reduce((a, b) => a + b, 0));
    }
    if (!(max > 0)) return;
    const xRangeW = xr.max - xr.min;
    const base = fromRight ? xr.max : xr.min;
    const sign = fromRight ? -1 : 1;
    const rowH = Math.abs((series.priceToCoordinate(p.lo) ?? 0) - (series.priceToCoordinate(p.lo + p.step) ?? 0));
    const gap = Math.floor(rowH * vr) >= vr ? Math.floor(vr) : 0;
    const texts: { text: string; x: number; y: number; h: number }[] = [];
    const sums: number[] = [];
    for (let r = 0; r < n; r++) {
      const yHi = series.priceToCoordinate(p.lo + (r + 1) * p.step);
      const yLo = series.priceToCoordinate(p.lo + r * p.step);
      if (yHi == null || yLo == null) continue;
      const top = Math.min(yHi, yLo);
      const bottom = Math.max(yHi, yLo);
      const { values, colors, shown } = parts[r];
      if (st.showValues) shown.forEach((v, i) => (sums[i] = (sums[i] ?? 0) + v));
      if (bottom < 0 || top > paneH) continue;
      const avail = Math.max((st.percentWidth * xRangeW) / 100 - values.length, 0);
      let x = base;
      for (let i = 0; i < values.length; i++) {
        const x2 = x + sign * ((avail * values[i]) / max);
        if (Math.abs(x2 - x) < 0.5) continue;
        const px = Math.round(Math.min(x, x2) * hr);
        const pw = Math.round(Math.max(x, x2) * hr) - px;
        const py = Math.round(top * vr);
        const ph = Math.max(Math.round(bottom * vr) - py - gap, 1);
        ctx.fillStyle = colors[i];
        ctx.fillRect(px, py, pw, ph);
        x = x2;
      }
      if (st.showValues) texts.push({ text: (fromRight ? [...shown].reverse() : shown).map(volumeText).join(" × "), x: base + 3 * sign, y: top, h: bottom - top });
    }
    if (!st.showValues || texts.length === 0) return;
    // The sums under the lowest row.
    const last = texts.reduce((a, t) => (t.y > a.y ? t : a), texts[0]);
    const avgH = texts.reduce((a, t) => a + t.h, 0) / texts.length;
    texts.push({ text: (fromRight ? [...sums].reverse() : sums).map(volumeText).join(" × "), x: base + 3 * sign, y: last.y + last.h, h: avgH });
    const font = Math.min(...texts.map((t) => Math.min(Math.round((1.7 * xRangeW) / t.text.length), Math.round(0.6 * t.h))));
    if (font < MIN_VALUE_FONT) return;
    ctx.save();
    ctx.scale(hr, vr);
    ctx.font = `${font}px ${this.chart?.options().layout.fontFamily ?? "sans-serif"}`;
    ctx.textAlign = fromRight ? "right" : "left";
    ctx.fillStyle = st.valuesColor;
    for (const t of texts) ctx.fillText(t.text, t.x, t.y + 0.7 * t.h);
    ctx.restore();
  }
}
