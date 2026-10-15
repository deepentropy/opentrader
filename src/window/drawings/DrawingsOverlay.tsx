/*
 * DrawingsOverlay — SVG layer above the lightweight-charts canvas.
 *
 * Feature 5b: 2-click placement (trend-line, rectangle), click-to-select,
 * Escape-to-cancel cascade, Delete-to-remove.
 * Feature 5c: drag-to-edit (body translates all points; handle moves one
 *   point for line/triangle kinds, or remaps a bbox corner for rectangle/
 *   circle/date-and-price-range), per-symbol persistence, and 12 new
 *   drawing kinds.
 *
 * Pointer-events strategy:
 *   • Outer <svg> is pointer-events: none by default so chart pan/zoom
 *     continues to work untouched. While armed for a tool the SVG flips
 *     to pointer-events: auto so it captures placement clicks.
 *   • Per-drawing <g>s opt back in via pointer-events: visiblePainted
 *     (SVG default), so clicks on painted areas (incl. transparent-but-
 *     stroked hit lines and translucent fills) select / start-drag the
 *     drawing even when not armed.
 *
 * Parts: this file owns the pointer state and the outer <svg>; the rest
 * lives in overlay/* (panes, placement, selection and drags, text editor,
 * tables, images, region tools, demonstration cursor, price pills, scale
 * marks, popups, render dispatch), each created with the shared context
 * (overlay/context.ts) where its code sat in this component, so effects,
 * listeners and cleanups keep their order. Per-kind hit-tests
 * and pure geometry helpers live in kinds/hit-tests.ts and _shared.ts.
 */
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { FIB_LEVEL_DEFAULTS, findOverlaySpec } from "lightweight-charts-drawing/core/specs";
import { fibLevelAt } from "lightweight-charts-drawing/core/scene/fib";
import { isVisibleOnInterval, type DataPoint, type Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import type { PlaceAtCursorDetail } from "../../data/app-events";
import type { DragState } from "lightweight-charts-drawing/core/interact/drag";
import { cursorForMode } from "./cursors";
import type { CursorMode } from "../../data/drawing-toolbar";
import { setLineToolHint } from "../../data/hints";
import { eventPoint, mixHex } from "./overlay/helpers";
import { attach, type OverlayCore, type OverlayCx, type OverlayProps } from "./overlay/context";
import { createTables } from "./overlay/table";
import { createImages } from "./overlay/image";
import { createRegionTools } from "./overlay/region-tools";
import { createDemonstration } from "./overlay/demonstration";
import { createFrames } from "./overlay/frames";
import { createSunk } from "./overlay/sunk";
import { createPlacement } from "./overlay/placement";
import { createTextEdit } from "./overlay/text-edit";
import { createSelection } from "./overlay/selection";
import { createWindowEvents } from "./overlay/window-events";
import { createPriceLines } from "./overlay/price-lines";
import { createScaleMarks } from "./overlay/scale-marks";
import { createPopups } from "./overlay/popups";
import { createLayers } from "./overlay/layers";

/** Paints drawing `id` on the canvas of the pane `paneKey` (context in CSS
 *  px, origin at the pane's top-left). `onAsyncLoad`: an image of the
 *  drawing finished loading (paint again). */
export type SunkPainter = (ctx: CanvasRenderingContext2D, id: string, paneKey: string | null, onAsyncLoad?: () => void) => void;

/** Kinds drawn by components (not a plain scene): they stay in the overlay,
 *  in front of every series. */
export const NEVER_SUNK_KINDS: ReadonlySet<string> = new Set(["table", "image"]);

export { PLACE_AT_CURSOR_EVENT } from "./overlay/window-events";
export type { PlaceAtCursorDetail };
export { renderKind } from "./overlay/render";

export function DrawingsOverlay(props: OverlayProps) {
  let svg!: SVGSVGElement;
  const [pending, setPending] = createSignal<DataPoint[]>([]);
  const [cursor, setCursor] = createSignal<Pt | null>(null);
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [size, setSize] = createSignal<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Chart background at pane y (gradient-aware) for the anchor fill. */
  const anchorFillAt = (y: number): string => {
    const bg = props.anchorBg;
    if (!bg) return "#0f0f0f";
    if (!bg.gradient) return bg.top;
    const h = size().h;
    return mixHex(bg.top, bg.bottom, h > 0 ? Math.max(0, Math.min(1, y / h)) : 0);
  };
  // Held modifiers that temporarily override the persisted magnet:
  //   Shift    → magnet off once a tool is being created (after its first
  //              point) or an anchor is dragged; it
  //              also drives the per-tool Shift constraints (lib interact/shift).
  //   Ctrl/Cmd → invert magnet: off→Strong, on→off.
  // Window-level so a press registers even when the pointer is over the canvas;
  // a window blur resets both so a missed key-up can't stick.
  const [shiftDown, setShiftDown] = createSignal(false);
  const [ctrlDown, setCtrlDown] = createSignal(false);
  /** Open context menu state — viewport coords + the drawing it targets. */
  const [menu, setMenu] = createSignal<{ drawing: Drawing; pos: { x: number; y: number } } | null>(null);

  const armedSpec = () => findOverlaySpec(props.armedTool);
  const cmode = (): CursorMode => props.cursorMode ?? "cross";
  // Drawing under the pointer (a hovered drawing shows its anchors before any
  // click). Driven by per-<g> pointer enter/leave — no extra hit-test pass.
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);
  /** Hidden flag OR filtered out by the per-interval Visibility matrix. */
  const notShown = (d: Drawing) =>
    !!d.hidden || !isVisibleOnInterval(d.visibility, props.interval);
  // Hidden specifically by the per-interval Visibility matrix (not the Hide
  // toggle). The selection path uses this so a drawing filtered off the current
  // interval drops its floating toolbar and can't be Delete'd / nudged blind —
  // while a Hide-toggled drawing keeps its toolbar so it can still be un-hidden.
  const intervalHidden = (d: Drawing) =>
    !isVisibleOnInterval(d.visibility, props.interval);
  // True while the eraser button is held — drives the erase-on-sweep in onMove.
  let erasing = false;

  // Shared context of this overlay's parts (overlay/*.ts): live accessors of
  // the state above; each part adds its functions when it is created.
  const cx = {
    props,
    get anchorFillAt() { return anchorFillAt; },
    get armedSpec() { return armedSpec; },
    get cmode() { return cmode; },
    get ctrlDown() { return ctrlDown; },
    get cursor() { return cursor; },
    get drag() { return drag; },
    get erasing() { return erasing; }, set erasing(v: OverlayCore["erasing"]) { erasing = v; },
    get hoveredId() { return hoveredId; },
    get intervalHidden() { return intervalHidden; },
    get menu() { return menu; },
    get notShown() { return notShown; },
    get pending() { return pending; },
    get setCtrlDown() { return setCtrlDown; },
    get setCursor() { return setCursor; },
    get setDrag() { return setDrag; },
    get setHoveredId() { return setHoveredId; },
    get setMenu() { return setMenu; },
    get setPending() { return setPending; },
    get setShiftDown() { return setShiftDown; },
    get setSize() { return setSize; },
    get shiftDown() { return shiftDown; },
    get size() { return size; },
    get svg() { return svg; },
  } as OverlayCx;

  // Table cell editing and cell operations (overlay/table.tsx).
  const { TableCellEditor } = attach(cx, createTables(cx));
  // Image tool dialog, image paste, failed images (overlay/image.tsx).
  const { ImageDialogHost } = attach(cx, createImages(cx));
  // Region tools: Measure / Zoom in (overlay/region-tools.tsx).
  const { onMeasureClick, regionElement, regionTool, startRegion } = attach(cx, createRegionTools(cx));
  // Demonstration cursor + Alt highlighter (overlay/demonstration.tsx).
  const { demoCursorElement, highlighterElement } = attach(cx, createDemonstration(cx));
  // Overlay size, drawing area and drawing panes (overlay/frames.ts).
  const { chartDims, frameByKey, frames, paneClipId } = attach(cx, createFrames(cx));
  // Drawings painted on the chart canvas (overlay/sunk.ts).
  attach(cx, createSunk(cx));
  // Placement, magnet, preview and crosshair (overlay/placement.tsx).
  const { crosshairElement, finalizeVariableLength, onPlacementClick, placeKey, previewElement, setPlaceKey, startFreehand } = attach(cx, createPlacement(cx));
  // Inline text editor (overlay/text-edit.tsx).
  const { TextEditor, setTextEdit, textAnchorScreen, textEdit } = attach(cx, createTextEdit(cx));
  // Hit test, selection, drags, eraser, context menu (overlay/selection.ts).
  const { eraseAt, hitTopmost, onContextMenu, onMove, onSelectionPointerDown } = attach(cx, createSelection(cx));
  // Window-wide keys, paste, nudge, click-outside, place-at-cursor and the
  // held modifiers, on mount (overlay/window-events.ts).
  attach(cx, createWindowEvents(cx));

  // A tool change hides the line-tool event hint (not dismissed).
  createEffect(on(() => [props.armedTool, cmode()], () => setLineToolHint(null), { defer: true }));

  // Reset rubber-band when armedTool clears (e.g. switching tools mid-place).
  createEffect(() => {
    if (!armedSpec()) {
      setPending([]);
      setCursor(null);
    }
  });
  createEffect(() => {
    if (pending().length === 0) setPlaceKey(null);
  });

  // Right-axis price pills (overlay/price-lines.ts).
  attach(cx, createPriceLines(cx));
  // Points on the price / time scales (overlay/scale-marks.tsx).
  const { scaleMarksElement } = attach(cx, createScaleMarks(cx));
  // Floating toolbar, context menu, Settings dialog (overlay/popups.tsx).
  const { DrawingPopups, openSettings } = attach(cx, createPopups(cx));
  // Drawings, alert marks and axis parts of the SVG (overlay/layers.tsx).
  const { AlertMarks, AxisParts, DrawingLayer } = attach(cx, createLayers(cx));

  function svgCursor(): string | undefined {
    // While armed we draw full-pane dashed guide lines (above); the OS crosshair
    // (+) stays visible at the pointer so there's always a cross marker where the
    // mouse is — even when magnet pulls the horizontal guide line off to the
    // nearest OHLC level (the guide line sticks to the bar, the + tracks the
    // cursor).
    if (armedSpec()) return "crosshair";
    // Region tools (measure / zoom) keep the OS crosshair while dragging a box.
    if (regionTool()) return "crosshair";
    const d = drag();
    if (d && d.active) {
      return d.mode.hit === "handle" ? "grabbing" : "move";
    }
    // Capturing cursor mode (the only one where the overlay's own cursor
    // shows): the eraser glyph.
    const mode = cmode();
    if (mode === "eraser") return cursorForMode(mode, false);
    return undefined;
  }

  // While a tool is armed the overlay captures the whole pane (to receive
  // placement clicks), which otherwise swallows wheel scroll/zoom. Forward the
  // wheel to the chart element beneath so it stays scrollable/zoomable while
  // armed — clicks still place points. No-op when not armed (the
  // overlay is pointer-events:none then and the chart gets the wheel directly).
  function forwardWheel(e: WheelEvent) {
    if (!armedSpec()) return;
    const beneath = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== svg && !svg.contains(el));
    if (!beneath) return;
    e.preventDefault();
    beneath.dispatchEvent(new WheelEvent("wheel", {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      // The chart's wheel reads Shift (horizontal move) and Ctrl (focused zoom).
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      bubbles: true,
      cancelable: true,
    }));
  }

  return (
    <>
    <svg
      ref={svg}
      width="100%"
      height="100%"
      style={{
        position: "absolute",
        top: "0",
        left: `${props.leftInset ?? 0}px`,
        width: `calc(100% - ${props.leftInset ?? 0}px)`,
        height: "100%",
        "pointer-events":
          armedSpec() || regionTool() || cmode() === "eraser"
            ? "auto"
            : "none",
        "z-index": 5,
        cursor: svgCursor(),
      }}
      on:wheel={{ handleEvent: forwardWheel, passive: false }}
      onPointerMove={onMove}
      onPointerDown={(e) => {
        // While the inline text editor is open, a click outside it should just
        // commit (via the input's blur) — not start a new placement/selection.
        if (textEdit()) return;
        const mode = cmode();
        // Eraser — click removes the drawing under the pointer; never places /
        // selects. The held button drives the sweep in onMove.
        if (mode === "eraser") {
          e.stopPropagation();
          erasing = true;
          eraseAt(e);
          return;
        }
        // Zoom — press-drag-release a rectangle (transient, not a placed
        // drawing). Measure — two-click placement (each click handled here).
        if (regionTool()) {
          e.stopPropagation();
          if (props.armedTool === "measure") onMeasureClick(e);
          else startRegion(e);
          return;
        }
        if (armedSpec()?.freehand) {
          startFreehand(e);
        } else if (armedSpec()) {
          onPlacementClick(e);
        } else {
          onSelectionPointerDown(e);
        }
      }}
      onPointerUp={() => { erasing = false; }}
      onPointerLeave={() => { erasing = false; setCursor(null); }}
      // Native listener (not Solid-delegated): while idle the svg is
      // pointer-events:none with per-<g> visiblePainted children, and the
      // delegated dblclick doesn't fire through that combination.
      on:dblclick={(e) => {
        // Freehand finalize: the two single-clicks that precede a double-click
        // have already appended their points, so finalize uses pending as-is.
        if (armedSpec()?.variableLength) {
          e.preventDefault();
          finalizeVariableLength();
          return;
        }
        // Re-edit an existing text annotation (double-click while not placing);
        // any other drawing opens its settings dialog (the two single-clicks
        // that preceded the dblclick already selected it).
        if (!armedSpec()) {
          const sp = eventPoint(svg, e as unknown as PointerEvent);
          const hit = hitTopmost(sp);
          // Fib retracement / trend-based extension: a double-click on a
          // level line edits that level's text on the chart.
          const fibLevel = hit && !hit.drawing.locked && (hit.drawing.kind === "fib-retracement" || hit.drawing.kind === "trend-based-fib-extension")
            ? fibLevelAt(hit.drawing, hit.pts, { x: sp.x, y: sp.y - hit.frame.top }, hit.frame.dims.w, hit.frame.coords)
            : null;
          if (hit && fibLevel) {
            e.preventDefault();
            const lvls = hit.drawing.style.levels ?? FIB_LEVEL_DEFAULTS;
            setTextEdit({
              mode: "edit",
              id: hit.drawing.id,
              kind: hit.drawing.kind,
              points: hit.drawing.points,
              pos: { x: fibLevel.textX, y: fibLevel.y + hit.frame.top },
              value: lvls[fibLevel.index]?.text ?? "",
              level: fibLevel.index,
            });
          } else if (hit && findOverlaySpec(hit.drawing.kind)?.textEditable && !hit.drawing.locked) {
            e.preventDefault();
            setTextEdit({
              mode: "edit",
              id: hit.drawing.id,
              kind: hit.drawing.kind,
              points: hit.drawing.points,
              pos: (() => { const a = textAnchorScreen(hit.drawing, hit.pts); return { x: a.x, y: a.y + hit.frame.top }; })(),
              value: hit.drawing.text ?? "",
            });
          } else if (hit) {
            e.preventDefault();
            openSettings(hit.drawing.id);
          }
        }
      }}
      onContextMenu={onContextMenu}
    >
      <defs>
        {/* One clip per pane (overlay coordinates) + the whole drawing area. */}
        <For each={frames()}>
          {(f) => (
            <clipPath id={f.clip}>
              <rect x={0} y={f.top} width={f.dims.w} height={f.dims.h} />
            </clipPath>
          )}
        </For>
        <clipPath id={`${paneClipId}-all`}>
          <rect x={0} y={0} width={chartDims().w} height={chartDims().h} />
        </clipPath>
      </defs>
      <DrawingLayer />

      {crosshairElement()}
      <Show when={frameByKey(placeKey())}>
        {(f) => (
          <g clip-path={`url(#${f().clip})`}>
            <g transform={f().top ? `translate(0 ${f().top})` : undefined}>{previewElement()}</g>
          </g>
        )}
      </Show>
      {/* Alert mark: a small alarm clock in the colour of the drawing, 24 px
          under it, on every drawing an alert reads. */}
      <AlertMarks />
      {/* Axis parts of drawings (drawn in the axis panes, outside the pane
          clip): vertical / cross line time label, position price
          labels. */}
      <AxisParts />
      {scaleMarksElement()}
      {highlighterElement()}
      {demoCursorElement()}
      {regionElement()}
    </svg>
    <TextEditor />
    {/* Table in-place cell editor (multi-line; Tab / Shift+Tab = next /
        previous cell, Escape closes it and clears the active cell). The text
        is written to the cell on every change. */}
    <TableCellEditor />
    <ImageDialogHost />
    <DrawingPopups />
    </>
  );
}
