/*
 * Drawings painted on the chart canvas (behind a series): the painter handed
 * to the chart, which paints a drawing's scene in its pane's canvas.
 */
import { onCleanup } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { sceneImage, sceneTable, sceneTextTool } from "lightweight-charts-drawing/core/scene/text-tools";
import { sceneOf } from "lightweight-charts-drawing/core/scene";
import { drawScene } from "lightweight-charts-drawing/runtime/scene-canvas";
import { screenPoints } from "lightweight-charts-drawing/core/interact/project";
import type { SunkPainter } from "../DrawingsOverlay";
import { type OverlayCx } from "./context";

/** What createSunk adds to the overlay context. */
export interface SunkApi {
  isSunk: (d: Drawing) => boolean;
  paintSunk: SunkPainter;
}

export function createSunk(cx: OverlayCx): SunkApi {
  const { anchorFillAt, notShown, props } = cx;
  // ── Drawings painted on the chart canvas ────────────────────────────────
  // A drawing behind a series (props.sunk) is painted by the chart in its
  // pane's canvas, at its place in the drawing order: same scene, without the
  // anchors (they stay in the overlay, in front).
  let sunkFont = "";
  const paintSunk: SunkPainter = (ctx, id, paneKey, onAsyncLoad) => {
    const d = props.drawings.find((x) => x.id === id);
    const pane = cx.frameByKey(paneKey);
    const f = d ? cx.drawFrame(d) : null;
    if (!d || !pane || !f || notShown(d)) return;
    const pts = screenPoints(f.coords, d, f.dims);
    if (!pts) return;
    // Table and image: their plain scene (the snapshot image paints them).
    const scene = d.kind === "text"
      ? sceneTextTool(d, pts[0], false, false)
      : d.kind === "table"
        ? sceneTable(d, pts[0], false, null)
        : d.kind === "image"
          ? sceneImage(d, pts[0], false)
          : sceneOf(d, pts, { w: f.dims.w, h: f.dims.h, coords: f.coords, selected: false, hovered: false });
    if (!sunkFont && cx.svg) sunkFont = getComputedStyle(cx.svg).fontFamily;
    ctx.save();
    // The drawing's frame inside this pane's canvas (an extended vertical
    // line is laid out over the whole chart).
    ctx.translate(0, f.top - pane.top);
    drawScene(ctx, scene, {
      fontFamily: sunkFont || "sans-serif",
      anchors: { fillAt: (y) => anchorFillAt(y + f.top), selected: false },
      onAsyncLoad,
    });
    ctx.restore();
  };
  props.onPainter?.(paintSunk);
  onCleanup(() => props.onPainter?.(null));
  const isSunk = (d: Drawing) => !!props.sunk?.has(d.id);

  return { isSunk, paintSunk };
}
