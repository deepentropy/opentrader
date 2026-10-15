/*
 * Per-drawing layers of the overlay SVG: the drawings themselves (in their
 * pane, with anchors and lock glyphs), the alert marks under alerted
 * drawings, and the axis parts drawn outside the pane clip.
 */
import { createMemo, For, Show, type JSX } from "solid-js";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { drawingCanAlert, rulesOfDrawing } from "../../../data/alert-condition";
import { alertStore } from "../../../data/alert-store";
import { screenPoints } from "lightweight-charts-drawing/core/interact/project";
import { vwapScreenSeries } from "lightweight-charts-drawing/core/kinds/data-series";
import { AnchorCtx, renderKind, renderLockedAnchors } from "./render";
import { AXIS_PART_KINDS, renderAxisParts } from "./axis-labels";
import { type OverlayCx } from "./context";

/** What createLayers adds to the overlay context. */
export interface LayersApi {
  AlertMarks: () => JSX.Element;
  AxisParts: () => JSX.Element;
  DrawingLayer: () => JSX.Element;
}

export function createLayers(cx: OverlayCx): LayersApi {
  const { anchorFillAt, armedSpec, hoveredId, notShown, props, setHoveredId, size } = cx;

  /** Every drawing, drawn in its pane. */
  function DrawingLayer() {
    return (
      <For each={props.drawings}>
        {(d) => {
          // Re-project this drawing whenever the time/price scale changes
          // (coordEpoch bumps on every pan/zoom) or the pane resizes, so the
          // geometry stays pinned to its data coordinates and scrolls with the
          // chart. The <For> child is reference-keyed and won't re-run on its
          // own, so the reactive read must live in this memo.
          const view = createMemo(() => {
            void props.coordEpoch;
            void size();
            const f = cx.drawFrame(d);
            if (notShown(d) || !f) return null;
            const pts = screenPoints(f.coords, d, f.dims);
            return pts ? { c: f.coords, pts, f } : null;
          });
          const selected = () => cx.selIds().includes(d.id);
          // A drawing's anchors show on hover too (not just selection) —
          // locked drawings and armed-tool placement keep hover feedback off.
          const active = () =>
            selected() || (hoveredId() === d.id && !d.locked && !armedSpec());
          return (
            <Show when={view()}>
              {(v) => {
                // Locked drawings stay selectable (the pointerdown handler sets
                // the selection but never arms a drag), so show the normal arrow
                // rather than "not-allowed", which reads as non-interactive.
                const cursor = d.locked ? "default" : selected() ? "move" : "pointer";
                // Drawn in its pane: clipped there (overlay coordinates), in
                // the pane's own space (shifted down by the pane top).
                return (
                  <g clip-path={`url(#${v().f.clip})`}>
                    <g
                      data-drawing-id={d.id}
                      transform={v().f.top ? `translate(0 ${v().f.top})` : undefined}
                      style={{ "pointer-events": "visiblePainted", cursor }}
                      onPointerEnter={() => setHoveredId(d.id)}
                      onPointerLeave={() => setHoveredId((cur) => (cur === d.id ? null : cur))}
                    >
                      {/* Locked drawings never show the normal grab handles —
                          selection paints lock glyphs on the anchors instead. */}
                      <AnchorCtx.Provider value={{ fillAt: (y: number) => anchorFillAt(y + v().f.top), selected }}>
                        {renderKind(d, v().pts, active() && !d.locked, v().f.dims.w, v().f.dims.h, v().c, hoveredId() === d.id && !d.locked, cx.isSunk(d))}
                      </AnchorCtx.Provider>
                      <Show when={selected() && d.locked}>
                        {renderLockedAnchors(v().pts, d.style.color)}
                      </Show>
                    </g>
                  </g>
                );
              }}
            </Show>
          );
        }}
      </For>
    );
  }

  /** The alarm-clock mark under every alerted drawing. */
  function AlertMarks() {
    return (
      <For each={props.drawings}>
        {(d) => {
          const view = createMemo(() => {
            if (!drawingCanAlert(d.kind) || rulesOfDrawing(alertStore.rules(), d.id).length === 0) return null;
            void props.coordEpoch;
            void size();
            const f = cx.drawFrame(d);
            if (notShown(d) || !f) return null;
            const pts = screenPoints(f.coords, d, f.dims);
            const at = d.kind === "anchored-vwap" ? vwapMarkAnchor(vwapScreenSeries(d, f.coords).line, f.dims.w) : pts ? alertMarkAnchor(d.kind, pts, f.dims.w) : null;
            return at ? { at, f } : null;
          });
          return (
            <Show when={view()} keyed>
              {(v) => (
                <g clip-path={`url(#${v.f.clip})`} pointer-events="none">
                  <g transform={`translate(${Math.round(v.at.x)} ${Math.round(v.at.y + v.f.top + ALERT_MARK_GAP)})`}>
                    <circle r="6" fill={d.style.color} />
                    <path d="M-6.5 -5.5 -4 -8M6.5 -5.5 4 -8" stroke={d.style.color} stroke-width="1.5" stroke-linecap="round" fill="none" />
                    <path d="M0 -3V0.5H2.5" stroke="var(--color-bg-primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />
                  </g>
                </g>
              )}
            </Show>
          );
        }}
      </For>
    );
  }

  /** The axis parts of every drawing that has some. */
  function AxisParts() {
    return (
      <For each={props.drawings}>
        {(d) => {
          const view = createMemo(() => {
            if (!AXIS_PART_KINDS.has(d.kind)) return null;
            void props.coordEpoch;
            void size();
            const f = cx.drawFrame(d);
            if (notShown(d) || !f) return null;
            const pts = screenPoints(f.coords, d, f.dims);
            return pts ? { c: f.coords, pts, f } : null;
          });
          // Keyed: the parts are built from one projection, so each new one
          // (pan, zoom, resize) rebuilds them.
          return <Show when={view()} keyed>{(v) => renderAxisParts(d, v.pts, cx.chartDims(), size().w, v.c, v.f.top)}</Show>;
        }}
      </For>
    );
  }

  return { AlertMarks, AxisParts, DrawingLayer };
}

/** Distance from a drawing to the centre of its alert mark. */
const ALERT_MARK_GAP = 24;

/** Point of a drawing its alert mark hangs under (pane pixels). A
 *  horizontal line: the middle of the pane. The other kinds are placed by
 *  the same idea, the middle of what is drawn: a horizontal ray from its
 *  start to the right edge, an extended line at the middle of the pane, a
 *  rectangle under its bottom edge, the rest at the middle of their first
 *  two points. */
function alertMarkAnchor(kind: string, pts: Pt[], paneW: number): Pt | null {
  const [a, b] = pts;
  if (!a) return null;
  if (kind === "horizontal-line") return { x: paneW / 2, y: a.y };
  if (kind === "horizontal-ray") return { x: (Math.max(0, a.x) + paneW) / 2, y: a.y };
  if (!b) return a;
  if (kind === "extended-line" && b.x !== a.x) {
    const x = paneW / 2;
    return { x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) };
  }
  if (kind === "rectangle") return { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Anchored VWAP: the mark hangs under the middle of the part of its line
 *  that is in view. */
function vwapMarkAnchor(line: Pt[], paneW: number): Pt | null {
  const shown = line.filter((p) => p.x >= 0 && p.x <= paneW);
  return shown.length ? shown[shown.length >> 1] : null;
}
