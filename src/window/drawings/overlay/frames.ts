/*
 * Panes of the drawings overlay: the overlay size, the drawing area (time
 * scale width, panes height), one frame per chart pane (top, size, coords,
 * clip) and the overlay <-> frame point conversions.
 */
import { createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { offsetCoords } from "../pane-coords";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { type Frame, type OverlayCx } from "./context";

/** What createFrames adds to the overlay context. */
export interface FramesApi {
  axisWidth: Accessor<number>;
  chartDims: () => { w: number; h: number };
  drawFrame: (d: Drawing) => Frame | null;
  frameAt: (p: Pt) => Frame | null;
  frameByKey: (key: string | null | undefined) => Frame | null;
  frameOf: (d: Drawing) => Frame | null;
  frames: Accessor<Frame[]>;
  mainFrame: () => Frame | null;
  paneClipId: string;
  refreshSize: () => void;
  toLocal: (p: Pt, f: Frame) => Pt;
  toLocalClamped: (p: Pt, f: Frame) => Pt;
}

export function createFrames(cx: OverlayCx): FramesApi {
  const { props, setSize, size } = cx;
  function refreshSize() {
    if (!cx.svg) return;
    const r = cx.svg.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
  }

  /** The drawing area inside the overlay (the SVG also spans the price and
   *  time axes): width = the time scale width, height = overlay height less
   *  the time axis, i.e. every pane. The region tools (measure, zoom) and
   *  the demonstration highlighter use it. */
  function chartDims(): { w: number; h: number } {
    const sz = size();
    const ax = props.coords?.timeAxis();
    const aw = axisWidth();
    return { w: aw > 0 ? aw : ax && ax.width > 0 ? ax.width : sz.w, h: ax ? Math.max(0, sz.h - ax.height) : sz.h };
  }
  // The time scale width as a signal: lightweight-charts resizes its panes on
  // its own ResizeObserver, so when the overlay size changes the chart may
  // not have its new width yet. Re-read it on the next frame and on every
  // pan / zoom (coordEpoch), else the pane clip keeps the old width and cuts
  // drawings (a layout change left a 1008 px pane clipped at 448 px).
  const [axisWidth, setAxisWidth] = createSignal(0);
  createEffect(() => {
    size();
    void props.coordEpoch;
    const c = props.coords;
    const read = () => setAxisWidth(c?.timeAxis().width ?? 0);
    read();
    const raf = requestAnimationFrame(read);
    onCleanup(() => cancelAnimationFrame(raf));
  });
  const paneClipId = `pane-clip-${createUniqueId()}`;

  // Drawing panes: see Frame (context.ts).
  const frames = createMemo<Frame[]>(() => {
    const all = chartDims();
    const list = props.panes;
    const c = props.coords;
    if (!list || list.length === 0) return c ? [{ key: null, top: 0, dims: all, coords: c, clip: `${paneClipId}-0` }] : [];
    return list.map((p, i) => ({ key: p.key, top: p.top, dims: { w: all.w, h: p.height }, coords: p.coords, clip: `${paneClipId}-${i}` }));
  });
  const frameByKey = (key: string | null | undefined): Frame | null => frames().find((f) => f.key === (key ?? null)) ?? null;
  const mainFrame = () => frameByKey(null);
  /** Pane of a drawing (its owner); null when the owner is not on the chart. */
  const frameOf = (d: Drawing): Frame | null => frameByKey(d.owner);
  /** Frame a drawing is drawn and hit in: its pane, or every pane for a
   *  vertical line with "Extend" on (its price still maps in its pane). */
  function drawFrame(d: Drawing): Frame | null {
    const f = frameOf(d);
    if (!f) return null;
    if (d.kind === "vertical-line" && d.style.extendLine !== false) {
      return { key: f.key, top: 0, dims: chartDims(), coords: offsetCoords(f.coords, f.top), clip: `${paneClipId}-all` };
    }
    return f;
  }
  /** Pane under an overlay point, or null (axes, separators). */
  const frameAt = (p: Pt): Frame | null =>
    frames().find((f) => p.x >= 0 && p.x <= f.dims.w && p.y >= f.top && p.y < f.top + f.dims.h) ?? null;
  /** Overlay point -> frame-local point. */
  const toLocal = (p: Pt, f: Frame): Pt => ({ x: p.x, y: p.y - f.top });
  /** Overlay point -> frame-local point kept inside the frame. */
  const toLocalClamped = (p: Pt, f: Frame): Pt => ({
    x: Math.max(0, Math.min(f.dims.w, p.x)),
    y: Math.max(0, Math.min(f.dims.h, p.y - f.top)),
  });

  return { axisWidth, chartDims, drawFrame, frameAt, frameByKey, frameOf, frames, mainFrame, paneClipId, refreshSize, toLocal, toLocalClamped };
}
