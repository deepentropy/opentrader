/*
 * Region tools of the drawings overlay: the Zoom in rectangle (press, drag,
 * release) and the two-click Measure ruler, with their live and finished
 * views.
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { projectPoint, unproject } from "lightweight-charts-drawing/core/interact/project";
import { measureText } from "lightweight-charts-drawing/core/scene/text";
import { rangeLabelLines } from "lightweight-charts-drawing/core/scene/ranges";
import { rangeArrowPath } from "lightweight-charts-drawing/core/scene/lines";
import { eventPoint } from "./helpers";
import { type Frame, type OverlayCx } from "./context";

// Measure ruler: label fill (the box is the same colour at 20 %) and line
// colour per direction; fill of the measured range on the scales.
const MEASURE_UP = { label: "#2962ff", line: "#1e53e5" };
const MEASURE_DOWN = { label: "#f7525f", line: "#f7525f" };

/** What createRegionTools adds to the overlay context. */
export interface RegionToolsApi {
  finishRegion: () => void;
  measureKey: Accessor<string | null>;
  measurePoint: (e: PointerEvent, f: Frame) => Pt;
  measureResult: Accessor<{ key: string | null; a: DataPoint; b: DataPoint } | null>;
  measureStart: Accessor<Pt | null>;
  onMeasureClick: (e: PointerEvent) => void;
  plotPoint: (e: PointerEvent) => Pt;
  region: Accessor<{ start: Pt; end: Pt } | null>;
  regionElement: () => import("solid-js").JSX.Element;
  regionTool: () => "measure" | "zoom" | null;
  renderMeasure: (f: Frame, start: Pt, end: Pt) => import("solid-js").JSX.Element;
  setMeasureResult: Setter<{ key: string | null; a: DataPoint; b: DataPoint } | null>;
  setMeasureStart: Setter<Pt | null>;
  setRegion: Setter<{ start: Pt; end: Pt } | null>;
  startRegion: (e: PointerEvent) => void;
}

export function createRegionTools(cx: OverlayCx): RegionToolsApi {
  const { props, size } = cx;
  // renderMeasure's own `cx` (the ruler's centre x) shadows the context.
  const overlay = cx;
  // ── Region tools (Measure / Zoom in) ──────────────────────────────────────
  // Zoom is a transient press-drag-release rectangle (applies a chart zoom on
  // release). Measure is a two-click gesture (click the first point, move,
  // click the second) that leaves an ephemeral price/bars/% ruler until the
  // next press on the chart, Escape or another tool — NOT a persisted drawing.
  // The second click also returns to the cursor. `region` holds the live rect
  // (zoom drag, or the measure rubber-band between its two clicks).
  const [region, setRegion] = createSignal<{ start: Pt; end: Pt } | null>(null);
  // A finished ruler: its pane and its two points as data, so it follows pan
  // and zoom like a drawing.
  const [measureResult, setMeasureResult] = createSignal<{ key: string | null; a: DataPoint; b: DataPoint } | null>(null);
  // Pane of the measure in progress (the pane of its first click).
  const [measureKey, setMeasureKey] = createSignal<string | null>(null);
  // First (committed) point of an in-progress two-click measure, as a SCREEN
  // point already magnet-snapped at click time. Null between measurements.
  const [measureStart, setMeasureStart] = createSignal<Pt | null>(null);
  const regionTool = (): "measure" | "zoom" | null => {
    const t = props.armedTool;
    return t === "measure" || t === "zoom" ? t : null;
  };
  // Drop any half-placed measure when leaving the Measure tool, and the ruler
  // when another tool is armed (a finished ruler outlives the tool, which
  // returns to the cursor); drop a stray live region whenever no region tool
  // is armed.
  createEffect(() => {
    if (props.armedTool !== "measure") {
      if (props.armedTool) setMeasureResult(null);
      setMeasureStart(null);
    }
    if (!regionTool()) setRegion(null);
  });
  // The next press on the chart removes a finished ruler.
  onMount(() => {
    const onPress = (e: PointerEvent) => {
      if (!measureResult() || props.armedTool === "measure") return;
      const root = cx.svg?.parentElement;
      if (root && e.target instanceof Node && root.contains(e.target)) setMeasureResult(null);
    };
    window.addEventListener("pointerdown", onPress, true);
    onCleanup(() => window.removeEventListener("pointerdown", onPress, true));
  });

  /** A pointer position kept inside the drawing area: while a region tool is
   *  armed the overlay also takes the pointer over the price and time scales,
   *  and a ruler or zoom box must not reach them. */
  function plotPoint(e: PointerEvent): Pt {
    const p = eventPoint(cx.svg, e);
    const { w, h } = cx.chartDims();
    return { x: Math.min(Math.max(p.x, 0), w), y: Math.min(Math.max(p.y, 0), h) };
  }

  /** Measure tool — two-click placement. First click commits the
   *  start point (magnet-snapped); the rubber-band follows the cursor; the
   *  second click commits the ruler. Each point runs through the magnet via
   *  `aimAt`, so it locks onto the nearest OHLC level just like a drawing. */
  /** Pointer position of a measure in pane `f`: kept inside the pane,
   *  magnet-snapped, in overlay coordinates. */
  function measurePoint(e: PointerEvent, f: Frame): Pt {
    const q = cx.aimAt(cx.toLocalClamped(eventPoint(cx.svg, e), f), f).pt;
    return { x: q.x, y: q.y + f.top };
  }

  function onMeasureClick(e: PointerEvent) {
    const start = measureStart();
    if (!start) {
      // First click: drop the previous ruler and arm the second click. The
      // ruler lives in the pane of this click.
      const f = cx.frameAt(plotPoint(e)) ?? cx.mainFrame();
      if (!f) return;
      const pt = measurePoint(e, f);
      setMeasureResult(null);
      setMeasureKey(f.key);
      setMeasureStart(pt);
      setRegion({ start: pt, end: pt });
      return;
    }
    // Second click: commit the ruler (ignore a zero-size double-tap) and
    // return to the cursor.
    const f = cx.frameByKey(measureKey());
    const pt = f ? measurePoint(e, f) : start;
    if (f && Math.hypot(pt.x - start.x, pt.y - start.y) > 3) {
      const a = unproject(f.coords, cx.toLocal(start, f));
      const b = unproject(f.coords, cx.toLocal(pt, f));
      if (a && b) setMeasureResult({ key: f.key, a, b });
    }
    setMeasureStart(null);
    setRegion(null);
    props.onDisarm();
  }

  // Zoom press-drag-release (Measure no longer uses this — it's two-click).
  function startRegion(e: PointerEvent) {
    const sp = plotPoint(e);
    setRegion({ start: sp, end: sp });
    const onDocMove = (ev: PointerEvent) => {
      setRegion((r) => (r ? { start: r.start, end: plotPoint(ev) } : null));
    };
    const onDocUp = () => {
      document.removeEventListener("pointermove", onDocMove);
      document.removeEventListener("pointerup", onDocUp);
      finishRegion();
    };
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("pointerup", onDocUp);
  }

  // Zoom-only finalize (Measure is two-click, handled in onMeasureClick).
  function finishRegion() {
    const r = region();
    setRegion(null);
    if (!r) return;
    const dx = Math.abs(r.end.x - r.start.x);
    const dy = Math.abs(r.end.y - r.start.y);
    if ((dx > 3 || dy > 3) && props.coords) {
      props.coords.zoomToScreenRect(r.start.x, r.end.x, r.start.y, r.end.y);
    }
    // Zoom is one-shot unless keep-drawing is on.
    if (!props.stayMode) props.onDisarm();
  }

  /** Measure ruler (not a saved drawing): a filled box between the two points,
   *  blue when the price goes up and red when it goes down, a horizontal and a
   *  vertical line through its middle (arrow at the end point when at least
   *  50 px long), and a label: price change (percent) pips / bars, time span /
   *  volume (main pane only). Drawn in its pane `f` (points in the pane's own
   *  space); the measured range is highlighted on the price and time scales. */
  function renderMeasure(f: Frame, start: Pt, end: Pt): import("solid-js").JSX.Element {
    const c = f.coords;
    const sd = unproject(c, start);
    const ed = unproject(c, end);
    if (!sd || !ed) return null;
    const up = ed.price >= sd.price;
    const tone = up ? MEASURE_UP : MEASURE_DOWN;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    const cx = (start.x + end.x) / 2;
    const midX = Math.round(cx);
    const midY = Math.round((start.y + end.y) / 2);
    // First line: change (percent) pips, the change and the pips with
    // thousands separators and the U+2212 minus sign; then the bars, time
    // span and volume lines of the range tools.
    const pip = c.pipSize() || 0.01;
    const digits = Math.max(0, Math.min(8, Math.round(-Math.log10(pip))));
    const grouped = (v: number, dg: number) =>
      `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dg, maximumFractionDigits: dg })}`;
    const change = ed.price - sd.price;
    const pct = sd.price !== 0 ? Math.round(((100 * change) / Math.abs(sd.price)) * 100) / 100 : 0;
    const lines = [
      `${grouped(change, digits)} (${pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%) ${grouped(Math.round(change / pip), 0)}`,
      ...rangeLabelLines({ points: [sd, ed] } as Drawing, { showVolume: f.key === null } as Drawing["style"], c, false, true),
    ];
    const fs = 12;
    const pad = 9;
    const bw = Math.max(0, ...lines.map((l) => measureText(l, fs))) + pad * 2;
    const bh = fs * lines.length + 8 * Math.max(0, lines.length - 1) + pad * 2;
    // Label centred on the box, 10 px past the end point (above when the ruler
    // goes up, below when it goes down); moved to the other side when it
    // would leave the pane and fits there, else held at the edge.
    const paneH = f.dims.h;
    const half = bh / 2;
    const off = 10 + half;
    let cy: number;
    if (start.y > end.y) {
      cy = y - off;
      const over = half - cy;
      if (over > 0) cy = y + h + off + half <= paneH ? y + h + off : cy + over;
    } else {
      cy = y + h + off;
      const over = cy + half - paneH;
      if (over > 0) cy = y - off - half >= 0 ? y - off : cy - over;
    }
    const by = cy - half;
    return (
      <g pointer-events="none">
        {/* Measured range and its two points on the time and price scales. */}
        {overlay.renderScaleMarks([{ f, marks: [{ ...start, time: sd.time, price: sd.price }, { ...end, time: ed.time, price: ed.price }] }], false)}
        <g clip-path={`url(#${f.clip})`}>
          <g transform={f.top ? `translate(0 ${f.top})` : undefined}>
          <rect x={x} y={y} width={w} height={h} fill={tone.label} fill-opacity={0.2} />
          <line x1={start.x} y1={midY} x2={end.x} y2={midY} stroke={tone.line} stroke-width={1} />
          <line x1={midX} y1={start.y} x2={midX} y2={end.y} stroke={tone.line} stroke-width={1} />
          <Show when={w >= 50}>
            <path d={rangeArrowPath({ x: start.x, y: midY }, { x: end.x, y: midY }, 1)} fill="none" stroke={tone.line} stroke-width={1} />
          </Show>
          <Show when={h >= 50}>
            <path d={rangeArrowPath({ x: midX, y: start.y }, { x: midX, y: end.y }, 1)} fill="none" stroke={tone.line} stroke-width={1} />
          </Show>
          <Show when={lines.length > 0}>
            <rect x={cx - bw / 2} y={by} width={bw} height={bh} rx={4} fill={tone.label} />
            <For each={lines}>
              {(line, i) => (
                <text x={cx} y={by + pad + i() * (fs + 8) + fs / 2} text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size={String(fs)}>
                  {line}
                </text>
              )}
            </For>
          </Show>
          </g>
        </g>
      </g>
    );
  }
  /** Live zoom rectangle (while dragging) or the measure ruler (live + the
   *  committed ephemeral result). */
  function regionElement(): import("solid-js").JSX.Element {
    const tool = props.armedTool;
    const live = region();
    if (tool === "zoom") {
      if (!live) return null;
      const x = Math.min(live.start.x, live.end.x);
      const y = Math.min(live.start.y, live.end.y);
      const w = Math.abs(live.end.x - live.start.x);
      const h = Math.abs(live.end.y - live.start.y);
      return (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill="rgba(41,98,255,0.12)"
          stroke="#2962ff"
          stroke-width={1}
          stroke-dasharray="4 4"
          pointer-events="none"
          clip-path={`url(#${cx.paneClipId}-all)`}
        />
      );
    }
    if (tool === "measure" && live) {
      const f = cx.frameByKey(measureKey());
      return f ? renderMeasure(f, cx.toLocal(live.start, f), cx.toLocal(live.end, f)) : null;
    }
    const m = measureResult();
    const f = m ? cx.frameByKey(m.key) : null;
    if (!m || !f) return null;
    void props.coordEpoch; // re-project on pan / zoom
    void size();
    const a = projectPoint(f.coords, m.a);
    const b = projectPoint(f.coords, m.b);
    return a && b ? renderMeasure(f, a, b) : null;
  }

  return {
    finishRegion,
    measureKey,
    measurePoint,
    measureResult,
    measureStart,
    onMeasureClick,
    plotPoint,
    region,
    regionElement,
    regionTool,
    renderMeasure,
    setMeasureResult,
    setMeasureStart,
    setRegion,
    startRegion,
  };
}
