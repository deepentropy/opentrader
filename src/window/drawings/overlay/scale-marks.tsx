/*
 * The scales' part of the drawings overlay: the points of the selected
 * drawings, of the drawing being placed and of the measure ruler, as bands
 * and labels on the price and time scales.
 */
import { findOverlaySpec } from "lightweight-charts-drawing/core/specs";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { positionAnchors } from "lightweight-charts-drawing/core/kinds/position";
import { screenPoints } from "lightweight-charts-drawing/core/interact/project";
import { PriceAxisLabel, TimeAxisLabel } from "./axis-labels";
import { type Frame, type OverlayCx } from "./context";

// Fill of the measured range on the scales.
const MEASURE_AXIS_HIGHLIGHT = "rgba(41, 98, 255, 0.25)";
/** Scale labels of a drawing's points (selected, being placed, measure
 *  ruler); the darker one is the point being moved. */
const SCALE_LABEL_COLOR = "#2962ff";
const SCALE_LABEL_ACTIVE_COLOR = "#143eb2";
/** One point shown on the scales: frame-local x / y (null = not on that
 *  scale) with its time and price. `noPriceLabel`: band only (the tool draws
 *  its own price labels). */
export type ScaleMark = { x: number | null; y: number | null; time?: import("lightweight-charts").Time; price?: number; active?: boolean; noPriceLabel?: boolean };

/** What createScaleMarks adds to the overlay context. */
export interface ScaleMarksApi {
  drawingScaleMarks: (d: Drawing, f: Frame, activeIndex: number | null) => ScaleMark[];
  renderScaleMarks: (groups: { f: Frame; marks: ScaleMark[] }[], minMaxOnly: boolean) => import("solid-js").JSX.Element;
  scaleMarksElement: () => import("solid-js").JSX.Element;
  scalePriceText: (f: Frame, price: number) => string;
}

export function createScaleMarks(cx: OverlayCx): ScaleMarksApi {
  const { armedSpec, cursor, drag, notShown, pending, props, size } = cx;
  /** Price text on the price scale of frame `f`: the chart's price format in
   *  the main pane, else decimals from the pane's price step. */
  function scalePriceText(f: Frame, price: number): string {
    if (f.key === null && props.formatPrice) return props.formatPrice(price);
    const pip = f.coords.pipSize() || 0.01;
    const digits = Math.max(0, Math.min(8, Math.round(-Math.log10(pip))));
    return price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  /** Points on the scales: a band between the lowest and highest point on the
   *  time scale (all groups together) and on each pane's price scale, and a
   *  label per point (a repeated price text is shown once). `minMaxOnly`
   *  (several drawings selected): only the two outer labels on each scale. */
  function renderScaleMarks(groups: { f: Frame; marks: ScaleMark[] }[], minMaxOnly: boolean): import("solid-js").JSX.Element {
    const area = cx.chartDims();
    const sz = size();
    const out: import("solid-js").JSX.Element[] = [];
    const outer = <T,>(list: T[], v: (m: T) => number): T[] => {
      if (!minMaxOnly || list.length <= 2) return list;
      let lo = list[0];
      let hi = list[0];
      for (const m of list) {
        if (v(m) <= v(lo)) lo = m;
        if (v(m) >= v(hi)) hi = m;
      }
      return lo === hi ? [lo] : [lo, hi];
    };
    // Price scale (right of the plot), per pane.
    if (sz.w > area.w) {
      for (const { f, marks } of groups) {
        const ys = marks.filter((m): m is ScaleMark & { y: number } => m.y != null);
        if (ys.length === 0) continue;
        const y0 = Math.max(0, Math.min(...ys.map((m) => m.y)));
        const y1 = Math.min(f.dims.h, Math.max(...ys.map((m) => m.y)));
        if (y1 > y0) out.push(<rect x={area.w} y={f.top + y0} width={sz.w - area.w} height={y1 - y0} fill={MEASURE_AXIS_HIGHLIGHT} />);
        const ax = f.coords.timeAxis();
        const seen = new Set<string>();
        const labelled = ys.filter((m) => !m.noPriceLabel && m.price != null && m.y >= 0 && m.y <= f.dims.h);
        // The moved point's label is drawn last (over the others).
        for (const m of outer(labelled, (k) => k.y).sort((a, b) => Number(!!a.active) - Number(!!b.active))) {
          const text = scalePriceText(f, m.price!);
          if (seen.has(text)) continue;
          seen.add(text);
          out.push(<PriceAxisLabel x={area.w} w={sz.w - area.w} y={f.top + m.y} text={text} color={m.active ? SCALE_LABEL_ACTIVE_COLOR : SCALE_LABEL_COLOR} fontSize={ax.fontSize} fontFamily={ax.fontFamily} />);
        }
      }
    }
    // Time scale (under the panes), one for the whole chart.
    if (sz.h > area.h) {
      const xs = groups.flatMap((g) => g.marks.filter((m): m is ScaleMark & { x: number } => m.x != null).map((m) => ({ m, c: g.f.coords })));
      if (xs.length > 0) {
        const x0 = Math.max(0, Math.min(...xs.map((k) => k.m.x)));
        const x1 = Math.min(area.w, Math.max(...xs.map((k) => k.m.x)));
        if (x1 > x0) out.push(<rect x={x0} y={area.h} width={x1 - x0} height={sz.h - area.h} fill={MEASURE_AXIS_HIGHLIGHT} />);
        const labelled = xs.filter((k) => k.m.time != null && k.m.x >= 0 && k.m.x <= area.w);
        for (const k of outer(labelled, (q) => q.m.x).sort((a, b) => Number(!!a.m.active) - Number(!!b.m.active))) {
          out.push(<TimeAxisLabel x={k.m.x} h={area.h} time={k.m.time!} color={k.m.active ? SCALE_LABEL_ACTIVE_COLOR : SCALE_LABEL_COLOR} coords={k.c} />);
        }
      }
    }
    return <g pointer-events="none">{out}</g>;
  }

  /** Scale points of a drawing in its pane `f`: every point with its time and
   *  price; a horizontal line has no time, a vertical line no price, a
   *  position its stop / entry / target levels (it draws its own price
   *  labels). */
  function drawingScaleMarks(d: Drawing, f: Frame, activeIndex: number | null): ScaleMark[] {
    const c = f.coords;
    if (d.kind === "long-position" || d.kind === "short-position") {
      const pts = screenPoints(c, d, f.dims);
      const pa = pts ? positionAnchors(d, pts, c) : null;
      const marks: ScaleMark[] = d.points.map((p) => ({ x: c.timeToX(p.time), y: null, time: p.time }));
      if (pts && pa) for (const y of [pts[0].y, pa.yTarget, pa.yStop]) marks.push({ x: null, y, noPriceLabel: true });
      return marks;
    }
    const noTime = d.kind === "horizontal-line";
    const noPrice = d.kind === "vertical-line";
    return d.points.map((p, i) => ({
      x: noTime ? null : c.timeToX(p.time),
      y: noPrice ? null : c.priceToY(p.price),
      time: p.time,
      price: p.price,
      active: i === activeIndex,
    }));
  }

  /** The scales' part of the drawings: the points of the selected drawings
   *  and of the drawing being placed (the pointer as its next point). */
  function scaleMarksElement(): import("solid-js").JSX.Element {
    void props.coordEpoch;
    void size();
    const spec = armedSpec();
    const p = pending();
    if (spec && p.length > 0) {
      const f = cx.frameByKey(cx.placeKey());
      const rawG = cursor();
      if (!f || spec.freehand) return null;
      const marks: ScaleMark[] = p.map((dp) => ({ x: f.coords.timeToX(dp.time), y: f.coords.priceToY(dp.price), time: dp.time, price: dp.price }));
      if (rawG) {
        const cur = cx.aimAt(cx.toLocalClamped(rawG, f), f).pt;
        const dp = cx.dataAt(cur, f);
        if (dp) marks.push({ x: cur.x, y: cur.y, time: dp.time, price: dp.price, active: true });
      }
      return renderScaleMarks([{ f, marks }], false);
    }
    const ids = cx.selIds();
    if (ids.length === 0) return null;
    const dr = drag();
    const groups: { f: Frame; marks: ScaleMark[] }[] = [];
    let count = 0;
    for (const d of props.drawings) {
      // A drawing pinned to the pane (anchored) has no point on the scales.
      if (!ids.includes(d.id) || notShown(d) || d.anchored) continue;
      const f = cx.frameOf(d);
      if (!f) continue;
      const moved = dr && dr.active && dr.id === d.id && dr.mode.hit === "handle" && dr.mode.handleIndex < d.points.length ? dr.mode.handleIndex : null;
      const marks = drawingScaleMarks(d, f, moved);
      // A freehand stroke: its extent only.
      const freehand = !!findOverlaySpec(d.kind)?.freehand;
      const g = groups.find((k) => k.f.key === f.key);
      const list = freehand ? marks.map((m) => ({ ...m, time: undefined, price: undefined })) : marks;
      if (g) g.marks.push(...list);
      else groups.push({ f, marks: list });
      count++;
    }
    return count > 0 ? renderScaleMarks(groups, count > 1) : null;
  }

  return { drawingScaleMarks, renderScaleMarks, scaleMarksElement, scalePriceText };
}
