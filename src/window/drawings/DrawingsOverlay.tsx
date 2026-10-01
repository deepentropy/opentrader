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
 * Solid + SVG namespace: Solid's JSX compiler picks element namespace from
 * the lexical JSX context, so all <line>/<rect>/<polygon>/<text>/... JSX
 * lives inline in this file (inside the outer <svg>). Per-kind hit-tests
 * and pure geometry helpers live in kinds/hit-tests.ts and _shared.ts.
 */
import { createContext, createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, useContext } from "solid-js";
import type { IPriceLine } from "lightweight-charts";
import type { Coords } from "./coords";
import { defaultStyleFor, findOverlaySpec } from "lightweight-charts-drawing/core/specs";
import { isVisibleOnInterval, type DataPoint, type Drawing, type DrawingKind } from "lightweight-charts-drawing/core/types";
import {
  HANDLE_RADIUS,
  HIT_TOLERANCE,
  formatPriceDelta,
  formatTimeDelta,
  timeToSec,
  type HitResult,
  type Pt,
} from "lightweight-charts-drawing/core/_shared";
import { suspendDrawingPersist, resumeDrawingPersist } from "./persistence";
import { hitTestKind } from "lightweight-charts-drawing/core/kinds/hit-tests";
import { positionAnchors } from "lightweight-charts-drawing/core/kinds/position";
import { parseColor, textOnColor } from "lightweight-charts-drawing/core/color";
import { sceneImage, sceneTable, sceneTextTool } from "lightweight-charts-drawing/core/scene/text-tools";
import { sceneSvg } from "./scene-svg";
import { sceneLockedAnchors, sceneOf } from "lightweight-charts-drawing/core/scene";
import { DRAG_THRESHOLD, FREEHAND_SAMPLE_PX, MIN_DISTANCE_BETWEEN_POINTS } from "lightweight-charts-drawing/core/interact/constants";
import { magnetSnap, projectAll, projectPoint, screenPoints, translateDrawing, unproject } from "lightweight-charts-drawing/core/interact/project";
import { lockAxisDelta, shiftPlacementPoint } from "lightweight-charts-drawing/core/interact/shift";
import { buildNewDrawing, finishPlacement, SEGMENT_PREVIEW_KINDS, snapGannSquare } from "lightweight-charts-drawing/core/interact/placement";
import { anchorCursor, applyDrag, type DragState } from "lightweight-charts-drawing/core/interact/drag";
import { isAnchorable, toggleAnchored as toggleAnchoredDrawing } from "lightweight-charts-drawing/core/interact/anchor";
import { measureTextFont } from "lightweight-charts-drawing/core/scene/text";
import { signpostPositionFor } from "lightweight-charts-drawing/core/kinds/signpost";
import { TEXT_PLACEHOLDER } from "lightweight-charts-drawing/core/kinds/text-tools";
import { tableAnchors, tableCanRemove, tableHitCell, tableInsert, tableLayout, tableNextCell, tableRemove, tableWithText, TABLE_BORDER, TABLE_LINE_HEIGHT, TABLE_PAD, type TableCellRef, type TableLayout } from "lightweight-charts-drawing/core/kinds/table";
import { setTableUi, tableUi } from "./table-ui";
import { drawingImageFailed, imageInitialSize, IMAGE_MAX_SIDE, IMAGE_TYPES } from "lightweight-charts-drawing/core/kinds/images";
import { imagesVersion, saveDrawingImage } from "./image-store";
import { ImageDialog } from "./ImageDialog";
import { barsBetween, vwapLastValue } from "lightweight-charts-drawing/core/kinds/data-series";
import { SelectedToolbar } from "./SelectedToolbar";
import { DrawingContextMenu } from "./DrawingContextMenu";
import { SettingsDialog } from "./SettingsDialog";
import { copyDrawing, DRAWING_CLIP_MARK, pasteAsNew } from "./clipboard";
import {
  cursorForMode,
  DEMO_CURSOR_BORDER_OPACITY,
  HIGHLIGHTER_COLOR,
  HIGHLIGHTER_FADE_MS,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH,
} from "./cursors";
import type { CursorMode } from "../../data/drawing-toolbar";
import { hintState, lineToolHint, PATH_HINT, POLYLINE_HINT, setLineToolHint } from "../../data/hints";

type Props = {
  coords: Coords | null;
  /** Bumped on time-scale changes; the overlay re-renders to re-project. */
  coordEpoch: number;
  drawings: Drawing[];
  armedTool: string | null;
  /** Cursor-group interaction mode. `eraser` removes drawings under the pointer
   *  (click + sweep); `demonstration` draws a circle cursor (+ Alt highlighter);
   *  the rest just set the pointer glyph (handled on the chart host). */
  cursorMode?: CursorMode;
  /** Staged glyph for the `font-icon` tool — a Unicode emoji char or raw
   *  `<svg>` markup; attached to the placed drawing. */
  armedGlyph?: string;
  /** Snap placement clicks + drags to the closest OHLC of the bar under the
   *  cursor. Driven by the Magnet toggle. */
  magnet: boolean;
  /** Chart background (solid or vertical gradient) — anchors are filled with
   *  the background at their height. */
  anchorBg?: { top: string; bottom: string; gradient: boolean };
  /** Magnet strength: "strong" always snaps to the nearest OHLC level; "weak"
   *  only engages within MAGNET_WEAK_RADIUS_PX of a level (else the raw cursor
   *  is kept). */
  magnetMode?: "weak" | "strong";
  /** Also snap to price-pane overlay-indicator values (the "Snap to
   *  indicator" magnet sub-option). */
  magnetSnapsToIndicators?: boolean;
  /** After placing a drawing, keep the same tool armed instead of clearing.
   *  Driven by the Keep-drawing toggle. */
  stayMode: boolean;
  /** Places a new drawing and returns its assigned id (so paste can select it). */
  onPlace: (d: import("lightweight-charts-drawing/core/types").NewDrawing) => string | void;
  onDisarm: () => void;
  selectedId: string | null;
  /** Full multi-selection (ordered, last = primary = selectedId). Absent →
   *  single-select behaviour only. */
  selectedIds?: string[];
  setSelectedId: (id: string | null) => void;
  /** Ctrl/Cmd+click membership toggle (multi-select). */
  onToggleSelect?: (id: string) => void;
  onUpdate: (d: Drawing) => void;
  /** Bulk replace for group body-drags / group nudges — one undo entry. */
  onUpdateMany?: (list: Drawing[]) => void;
  onClone: (id: string) => void;
  onReorder: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  onRemove: (id: string) => void;
  /** Bulk delete for multi-select Delete — one undo entry. */
  onRemoveMany?: (ids: string[]) => void;
  /** TRUE when this overlay's pane is focused. Arrow-key nudges (broadcast from
   *  App as `drawing-nudge`) only apply on the active pane, so panes sharing a
   *  symbol — which all render the selected drawing — don't each move it. */
  active?: boolean;
  /** False while the pane's tab is hidden (the tab stays mounted): the
   *  window-wide key / paste / nudge / click-outside / place-at-cursor
   *  handlers belong to the shown tab. */
  shown?: boolean;
  /** Chart interval ("5", "240", "1D"…) — drives the per-drawing Visibility
   *  matrix (Settings → Visibility). Absent = no interval filtering. */
  interval?: string;
  /** Bare ticker of this pane's symbol — used to prefill the alert dialog
   *  from the selected toolbar's Add-alert button. */
  symbol?: string;
};

/** Fallback stroke for the rubber-band placement preview (no drawing yet). */
const PREVIEW_STROKE = "#2962ff";


/** Last pointer position in viewport coords. The overlay SVG ignores the
 *  pointer while no tool is armed, so the place-at-cursor hotkeys read this
 *  instead of the overlay's own move events. */
let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
}

/** Window event sent by the drawing-toolbar hotkeys Alt+H / J / V / C. The pane
 *  under the pointer creates the drawing there and sets `handled`; when no pane
 *  claims it the toolbar arms the tool instead. */
export const PLACE_AT_CURSOR_EVENT = "drawing-place-at-cursor";
export type PlaceAtCursorDetail = { kind: DrawingKind; handled: boolean };

function eventPoint(el: SVGSVGElement, e: PointerEvent): Pt {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function DrawingsOverlay(props: Props) {
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
  /** True between the placement pointerdown that opened a create-mode editor
   *  and its pointerup (see onPlacementClick). */
  let holdTextFocus = false;
  let textInput: HTMLInputElement | undefined;
  /** Inline text editor for the text-annotation family. `mode: "create"` commits
   *  a brand-new drawing on Enter/blur; `mode: "edit"` rewrites an existing one's
   *  `text`. `pos` is the editor's screen anchor (relative to the SVG box). */
  const [textEdit, setTextEdit] = createSignal<{
    mode: "create" | "edit";
    id?: string;
    kind: import("lightweight-charts-drawing/core/types").DrawingKind;
    points: DataPoint[];
    pos: Pt;
    value: string;
  } | null>(null);
  /** Settings dialog open for the drawing with this id. */
  const [settingsId, setSettingsId] = createSignal<string | null>(null);
  /** Tab the dialog opens on ("Visibility on intervals…" routes there). */
  const [settingsTab, setSettingsTab] = createSignal<"Style" | "Text" | "Coordinates" | "Visibility">("Style");
  /** Resolve the current drawing the dialog is editing — reactive so updates
   *  flow through (e.g. lock toggle from inside the dialog). */
  const settingsDrawing = () => {
    const id = settingsId();
    if (!id) return null;
    return props.drawings.find((d) => d.id === id) ?? null;
  };
  function openSettings(id: string, tab?: "Style" | "Text" | "Coordinates" | "Visibility") {
    setSettingsTab(tab ?? "Style");
    setSettingsId(id);
  }

  // ── Table cell editing and cell operations ──────────────────────────────
  // The active cell resets when its table is no longer selected.
  createEffect(() => {
    const u = tableUi();
    if (u && !selIds().includes(u.id)) setTableUi(null);
  });
  /** Table actions: insert a column / row (right of / below the active
   *  cell, else at the end; the active cell is kept) or remove the active
   *  cell's row / column (never the last one). One undo entry each. */
  function tableOp(id: string, op: "insert-column" | "insert-row" | "remove-row" | "remove-column") {
    const d = props.drawings.find((x) => x.id === id);
    if (!d || d.kind !== "table") return;
    const u = tableUi();
    const cell = u && u.id === id ? u.cell : null;
    window.dispatchEvent(new CustomEvent("drawing-gesture-end"));
    if (op === "insert-column" || op === "insert-row") {
      props.onUpdate({ ...d, style: { ...d.style, ...tableInsert(d.style, op === "insert-row" ? "row" : "column", cell) } } as Drawing);
    } else {
      const kind = op === "remove-row" ? "row" : "column";
      if (!cell || !tableCanRemove(d.style, kind)) return;
      const r = tableRemove(d.style, kind, cell);
      props.onUpdate({ ...d, style: { ...d.style, ...r.patch } } as Drawing);
      setTableUi({ id, cell: r.cell, editing: u?.editing ?? false, edge: null });
    }
    window.dispatchEvent(new CustomEvent("drawing-gesture-end"));
  }
  /** "Anchor drawing" toggle (core interact/anchor: text, pin, table). */
  function toggleAnchored(id: string) {
    const d = props.drawings.find((x) => x.id === id);
    const c = props.coords;
    if (!d || !c) return;
    const next = toggleAnchoredDrawing(d, c, paneDims());
    if (next) props.onUpdate(next);
  }

  /** Key of the cell being edited (the editor re-mounts per cell). */
  const tableEditKey = createMemo(() => {
    const u = tableUi();
    return u?.editing && u.cell ? `${u.id}|${u.cell[0]}|${u.cell[1]}` : null;
  });
  /** Editor geometry: the cell's text box (text renderer box less padding). */
  const tableEditor = createMemo(() => {
    const u = tableUi();
    if (!u?.editing || !u.cell) return null;
    void props.coordEpoch;
    void size();
    const c = props.coords;
    const d = props.drawings.find((x) => x.id === u.id);
    if (!c || !d || d.kind !== "table" || notShown(d)) return null;
    const p = screenPoints(c, d, paneDims())?.[0];
    if (!p) return null;
    const l = tableLayout(d, p);
    const [r, col] = u.cell;
    if (r >= l.ys.length - 1 || col >= l.xs.length - 1) return null;
    return { d, l, r, col };
  });

  // ── Image ─────────────────────────────────────────────────────────────
  // Arming the tool opens the Image dialog at once (active pane only); Ok
  // places the image at the pane centre, sized to fit a quarter of the pane,
  // and selects it. Cancel / Ok both leave the tool.
  const [imageDialog, setImageDialog] = createSignal(false);
  createEffect(() => {
    if (props.armedTool === "image" && props.active !== false) setImageDialog(true);
  });
  function placeImage(r: { name: string; width: number; height: number; transparency: number }) {
    const c = props.coords;
    if (!c) return;
    const { w, h } = paneDims();
    const dp = unproject(c, { x: w / 2, y: h / 2 });
    if (!dp) return;
    const id = props.onPlace({
      kind: "image",
      points: [dp],
      image: { name: r.name, ...imageInitialSize(r.width, r.height, w, h) },
      style: { ...defaultStyleFor("image"), transparency: r.transparency },
    });
    if (id) props.setSelectedId(id);
  }
  /** Paste an image as a drawing: a pasted image file (type, 2 MB and 2000 x
   *  2000 checks as the Image dialog) is placed like a dialog image, with the
   *  factory transparency, and selected. */
  async function pasteImage(file: File) {
    try {
      const r = await saveDrawingImage(file);
      if (r.width > IMAGE_MAX_SIDE || r.height > IMAGE_MAX_SIDE) throw new Error("The image being pasted is way too large");
      placeImage({ ...r, transparency: defaultStyleFor("image").transparency ?? 0 });
    } catch (err) {
      console.warn("[image] paste failed:", err instanceof Error ? err.message : err);
    }
  }
  // An image drawing whose image fails to load is removed.
  createEffect(() => {
    void imagesVersion();
    if (props.active === false) return;
    for (const d of props.drawings) {
      if (d.kind === "image" && drawingImageFailed(d.image?.name)) props.onRemove(d.id);
    }
  });

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

  // Demonstration cursor (crosshair demonstration view): a circle under the
  // pointer on the pane it is over (screen px), or null.
  const [demoCursor, setDemoCursor] = createSignal<Pt | null>(null);
  // "Hold Alt for temporary drawing" (demonstration cursor, Alt-only mouse
  // down): a presentation highlighter — a brush stroke, 36 px, ripe-red-500
  // at 25 %, opaque while drawn, then fading linearly over 4000 ms after
  // release and removed. Data points, so it follows pan / zoom. Not a
  // drawing: never saved, no undo.
  type Highlighter = { id: number; points: DataPoint[]; finishedAt: number | null };
  const [highlighters, setHighlighters] = createSignal<Highlighter[]>([]);
  const [fadeClock, setFadeClock] = createSignal(0);
  let highlighterSeq = 0;
  // True while the eraser button is held — drives the erase-on-sweep in onMove.
  let erasing = false;

  /** Remove the topmost drawing under the pointer (eraser click + sweep).
   *  Locked drawings are left alone, matching the Delete-key guard. */
  function eraseAt(e: PointerEvent) {
    const sp = eventPoint(svg, e);
    const hit = hitTopmost(sp);
    if (hit && !hit.drawing.locked) props.onRemove(hit.drawing.id);
  }

  // ── Region tools (Measure / Zoom in) ──────────────────────────────────────
  // Zoom is a transient press-drag-release rectangle (applies a chart zoom on
  // release). Measure is a two-click gesture (click the first point, move,
  // click the second) that leaves an ephemeral price/bars/% ruler until Escape
  // or a tool switch — NOT a persisted drawing. `region` holds the live rect
  // (zoom drag, or the measure rubber-band between its two clicks).
  const [region, setRegion] = createSignal<{ start: Pt; end: Pt } | null>(null);
  const [measureResult, setMeasureResult] = createSignal<{ start: Pt; end: Pt } | null>(null);
  // First (committed) point of an in-progress two-click measure, as a SCREEN
  // point already magnet-snapped at click time. Null between measurements.
  const [measureStart, setMeasureStart] = createSignal<Pt | null>(null);
  const regionTool = (): "measure" | "zoom" | null => {
    const t = props.armedTool;
    return t === "measure" || t === "zoom" ? t : null;
  };
  // Clear the ephemeral ruler + any half-placed measure when leaving the Measure
  // tool; drop a stray live region whenever no region tool is armed.
  createEffect(() => {
    if (props.armedTool !== "measure") {
      setMeasureResult(null);
      setMeasureStart(null);
    }
    if (!regionTool()) setRegion(null);
  });

  /** Measure tool — two-click placement. First click commits the
   *  start point (magnet-snapped); the rubber-band follows the cursor; the
   *  second click commits the ruler. Each point runs through the magnet via
   *  `aimAt`, so it locks onto the nearest OHLC level just like a drawing. */
  function onMeasureClick(e: PointerEvent) {
    const pt = aimAt(eventPoint(svg, e)).pt;
    const start = measureStart();
    if (!start) {
      // First click: drop the previous ruler and arm the second click.
      setMeasureResult(null);
      setMeasureStart(pt);
      setRegion({ start: pt, end: pt });
      return;
    }
    // Second click: commit the ruler (ignore a zero-size double-tap) and reset
    // for the next measurement. The tool stays armed.
    if (Math.hypot(pt.x - start.x, pt.y - start.y) > 3) {
      setMeasureResult({ start, end: pt });
    }
    setMeasureStart(null);
    setRegion(null);
  }

  // Zoom press-drag-release (Measure no longer uses this — it's two-click).
  function startRegion(e: PointerEvent) {
    const sp = eventPoint(svg, e);
    setRegion({ start: sp, end: sp });
    const onDocMove = (ev: PointerEvent) => {
      setRegion((r) => (r ? { start: r.start, end: eventPoint(svg, ev) } : null));
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

  // Highlighter fade: an animation-frame clock runs while a finished stroke is
  // fading; strokes past the 4 s fade are dropped.
  createEffect(() => {
    if (!highlighters().some((h) => h.finishedAt !== null)) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      setFadeClock(now);
      const cur = highlighters();
      const kept = cur.filter((h) => h.finishedAt === null || now - h.finishedAt < HIGHLIGHTER_FADE_MS);
      if (kept.length !== cur.length) setHighlighters(kept);
      if (kept.some((h) => h.finishedAt !== null)) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  /** Alt + press in demonstration mode: draw a highlighter until release. */
  function startHighlighter(e: PointerEvent) {
    const c = props.coords;
    if (!c) return;
    const first = unproject(c, eventPoint(svg, e));
    if (!first) return;
    const id = ++highlighterSeq;
    setHighlighters((hs) => [...hs, { id, points: [first], finishedAt: null }]);
    const onDocMove = (ev: PointerEvent) => {
      const cc = props.coords;
      const dp = cc ? unproject(cc, eventPoint(svg, ev)) : null;
      if (!dp) return;
      setHighlighters((hs) => hs.map((h) => (h.id === id ? { ...h, points: [...h.points, dp] } : h)));
    };
    const onDocUp = () => {
      document.removeEventListener("pointermove", onDocMove);
      document.removeEventListener("pointerup", onDocUp);
      const t = performance.now();
      setHighlighters((hs) => hs.map((h) => (h.id === id ? { ...h, finishedAt: t } : h)));
    };
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("pointerup", onDocUp);
  }

  // Demonstration mode: the pane keeps its crosshair, pan and selection (the
  // overlay does not capture it); the circle follows the pointer and an
  // Alt-only left press draws a highlighter instead (handled on the pane mouse
  // down, before hit tests / scrolling). Listened on the pane
  // root in the capture phase so the press never reaches the chart.
  createEffect(() => {
    if (cmode() !== "demonstration" || props.armedTool) {
      setDemoCursor(null);
      return;
    }
    const root = svg?.parentElement;
    if (!root) return;
    const onMovePt = (e: PointerEvent) => {
      const p = eventPoint(svg, e);
      const { w, h } = paneDims();
      setDemoCursor(p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h ? p : null);
    };
    const onLeave = () => setDemoCursor(null);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      const p = eventPoint(svg, e);
      const { w, h } = paneDims();
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) return;
      e.preventDefault();
      e.stopPropagation();
      startHighlighter(e);
    };
    root.addEventListener("pointermove", onMovePt, true);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown, true);
    onCleanup(() => {
      root.removeEventListener("pointermove", onMovePt, true);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown, true);
    });
  });

  function refreshSize() {
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
  }

  /** The chart pane inside the overlay (the SVG also spans the price and
   *  time axes): width = the time scale width, height = overlay height less
   *  the time axis. Every drawing is drawn in the pane (its media size) and
   *  clipped there; renderers, hit tests and placement use this size. */
  function paneDims(): { w: number; h: number } {
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

  function dataAt(p: Pt): DataPoint | null {
    const c = props.coords;
    if (!c) return null;
    const dp = unproject(c, p);
    if (!dp) return null;
    const m = effectiveMagnet();
    return m.enabled
      ? magnetSnap(dp, c, m.mode, !!props.magnetSnapsToIndicators) ?? dp
      : dp;
  }

  /** Screen point the placement preview/crosshair should track: the raw cursor,
   *  or — when the magnet engages — the snapped OHLC point projected back to
   *  screen (so the rubber-band locks onto the candle, x and y). Reads
   *  the modifier signals so it updates live when Shift/Ctrl change with a
   *  stationary cursor. Returns null alongside `engaged=false` when the magnet
   *  doesn't catch, so the caller keeps the free cursor. */
  function aimAt(cur: Pt): { pt: Pt; engaged: boolean } {
    const c = props.coords;
    if (!c) return { pt: cur, engaged: false };
    const m = effectiveMagnet();
    if (!m.enabled) return { pt: cur, engaged: false };
    const dp = unproject(c, cur);
    if (!dp) return { pt: cur, engaged: false };
    const snapped = magnetSnap(dp, c, m.mode, !!props.magnetSnapsToIndicators);
    if (!snapped) return { pt: cur, engaged: false };
    const sp = projectPoint(c, snapped);
    return sp ? { pt: sp, engaged: true } : { pt: cur, engaged: false };
  }

  function onPlacementClick(e: PointerEvent) {
    const spec = armedSpec();
    if (!spec) return;
    // Image: placed from its dialog (opened when the tool is armed), not by a
    // click.
    if (spec.kind === "image") return;
    const sp = eventPoint(svg, e);
    const pend = pending();
    // Variable-length finish gesture (polyline / path): a click within the
    // vertex tolerance of the LAST placed point commits the drawing instead of
    // appending; polyline ALSO commits on the FIRST point (closing the shape,
    // `filled` is set there). Path only finishes on the last point.
    // Double-click keeps working (on:dblclick). The tolerance is the minimum
    // distance between points = 5px with a mouse (10px on touch).
    if (spec.variableLength && pend.length >= 1 && props.coords) {
      const nearVertex = (v: DataPoint) => {
        const p = projectPoint(props.coords!, v);
        return !!p && Math.hypot(p.x - sp.x, p.y - sp.y) < MIN_DISTANCE_BETWEEN_POINTS;
      };
      // Last point first (checked first): finishing on the last point
      // leaves the polyline open; on the first point it closes it (filled).
      if (nearVertex(pend[pend.length - 1])) {
        // <2 points can't commit (a 1-point polyline is degenerate here) — the
        // click is swallowed so it doesn't stack a duplicate vertex.
        if (pend.length >= 2) finalizeVariableLength();
        return;
      }
      if (spec.kind === "polyline" && pend.length >= 2 && nearVertex(pend[0])) {
        finalizeVariableLength(true);
        return;
      }
    }
    const dp0 = dataAt(sp);
    if (!dp0) return;
    // Shift: the per-tool placement rule (lib interact/shift: 45° against
    // the previous point, square, Gann fixed increments; the ellipse ends as a
    // circle on its 2nd click).
    const sh = shiftDown() && props.coords ? shiftPlacementPoint(spec.kind, pend, dp0, props.coords) : { point: dp0 };
    const dp = sh.point;
    const next = sh.extra ? [...pending(), dp, sh.extra] : [...pending(), dp];
    // Variable-length tools (path/polyline/brush/highlighter) keep appending on
    // every click; the user finishes by double-clicking or re-clicking the
    // first/last vertex (above). Escape mid-placement CANCELS the in-progress
    // drawing — tools with pointsCount ≤ 0 (the variable-length set) are
    // removed, never committed.
    if (spec.variableLength || next.length < spec.pointCount) {
      setPending(next);
      // First point of a path / polyline: the "Double-click to finish" event
      // hint on every chart, until dismissed once.
      if (next.length === 1 && (spec.kind === "path" || spec.kind === "polyline")) {
        const key = spec.kind === "path" ? PATH_HINT : POLYLINE_HINT;
        if (!hintState(key).dismissed()) setLineToolHint({ key, text: `Double-click to finish ${spec.kind}` });
      }
      return;
    }
    // Text-family: open the inline editor at the anchor (last click = the text
    // position / callout balloon centre); committing creates the drawing.
    if (spec.textEditable) {
      // Placement runs on pointerdown; the browser's mousedown focus change
      // that follows would blur the new editor (and commit it empty). Ignore
      // blurs until the button is released, then focus the editor (the text
      // editor opens focused after the click).
      holdTextFocus = true;
      window.addEventListener("pointerup", () => {
        setTimeout(() => {
          holdTextFocus = false;
          textInput?.focus();
          textInput?.select();
        }, 0);
      }, { once: true, capture: true });
      setTextEdit({ mode: "create", kind: spec.kind, points: next, pos: sp, value: "" });
      setPending([]);
      setCursor(null);
      return;
    }
    // Finalize (fixed-length): the core adds the data computed at
    // placement; font-icon placements carry the staged glyph.
    const placed = finishPlacement(spec.kind, next, props.coords, paneDims(), { glyph: props.armedGlyph });
    if (placed) placeNew(placed);
    setPending([]);
    setCursor(null);
    // Stay-in-drawing-mode keeps the same tool armed for back-to-back
    // placements without round-tripping the toolbar.
    if (!props.stayMode) props.onDisarm();
  }

  /** Freehand placement (brush/highlighter): press-drag-release. The press seeds
   *  the path, every pointer-move past the sample threshold appends a vertex, and
   *  the release commits the stroke (≥2 points). Magnet is bypassed — a freehand
   *  line follows the raw cursor, it doesn't snap each sample to an OHLC
   *  level. */
  function startFreehand(e: PointerEvent) {
    const spec = armedSpec();
    if (!spec?.freehand) return;
    const c = props.coords;
    if (!c) return;
    e.stopPropagation();
    const sp0 = eventPoint(svg, e);
    const dp0 = unproject(c, sp0);
    if (!dp0) return;
    setPending([dp0]);
    setCursor(sp0);
    let last = sp0;
    const onDocMove = (ev: PointerEvent) => {
      const cc = props.coords;
      if (!cc) return;
      const cur = eventPoint(svg, ev);
      setCursor(cur);
      if (Math.hypot(cur.x - last.x, cur.y - last.y) < FREEHAND_SAMPLE_PX) return;
      const dp = unproject(cc, cur);
      if (!dp) return;
      last = cur;
      setPending((prev) => [...prev, dp]);
    };
    const onDocUp = () => {
      document.removeEventListener("pointermove", onDocMove);
      document.removeEventListener("pointerup", onDocUp);
      const pts = pending();
      setPending([]);
      setCursor(null);
      if (pts.length >= 2) {
        const placed = buildNewDrawing(spec.kind, pts);
        if (placed) placeNew(placed);
      }
      if (!props.stayMode) props.onDisarm();
    };
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("pointerup", onDocUp);
  }

  /** Commit a variable-length freehand drawing from the points placed so far
   *  (needs ≥2). Fired by the double-click handler; returns whether it placed. */
  function finalizeVariableLength(closed = false): boolean {
    const spec = armedSpec();
    if (!spec?.variableLength) return false;
    const pts = pending();
    if (pts.length < 2) return false;
    // The core stores polyline `closed` and freezes the ghost-feed seed.
    const placed = finishPlacement(spec.kind, pts, props.coords, paneDims(), { closed });
    if (placed) placeNew(placed);
    // Drawing finished: the shown path / polyline hint is dismissed for good.
    const hint = lineToolHint();
    if (hint) {
      hintState(hint.key).dismiss();
      setLineToolHint(null);
    }
    setPending([]);
    setCursor(null);
    if (!props.stayMode) props.onDisarm();
    return true;
  }

  /** Place a freshly drawn drawing. Every new drawing is selected (anchors +
   *  floating toolbar) once placement finishes. Keep-drawing mode is left as
   *  before (the tool stays armed for the next placement). */
  function placeNew(nd: import("lightweight-charts-drawing/core/types").NewDrawing) {
    const id = props.onPlace(nd);
    if (id && !props.stayMode) props.setSelectedId(id);
  }

  /** Commit the inline text editor — create a new text drawing (with the typed
   *  string) or rewrite an existing one's text. */
  function commitTextEdit() {
    const te = textEdit();
    if (!te) return;
    setTextEdit(null);
    const text = te.value;
    if (te.mode === "create") {
      let placed = buildNewDrawing(te.kind, te.points);
      // Signpost: the click height sets the label position.
      if (placed && te.kind === "signpost" && props.coords) {
        placed = { ...placed, style: { ...defaultStyleFor("signpost"), signpostPosition: signpostPositionFor(props.coords, te.points[0], paneDims().h) } };
      }
      if (placed) placeNew({ ...placed, text });
      if (!props.stayMode) props.onDisarm();
    } else if (te.id) {
      const d = props.drawings.find((x) => x.id === te.id);
      if (d) props.onUpdate({ ...d, text });
    }
  }

  /** Dismiss the editor without committing — in create mode this drops the
   *  half-placed drawing and disarms. */
  function cancelTextEdit() {
    const te = textEdit();
    if (!te) return;
    // Escape closes a NEW text's editor but keeps the drawing (selected).
    if (te.mode === "create") { commitTextEdit(); return; }
    setTextEdit(null);
  }

  /** Screen anchor for a text drawing's editor: the click point for 1-point
   *  kinds, the balloon centre (2nd point) for callout. */
  function textAnchorScreen(d: Drawing, pts: Pt[]): Pt {
    if ((d.kind === "callout" || d.kind === "note") && pts[1]) return pts[1];
    if (d.kind === "price-note" && pts[1]) {
      return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }
    return pts[0];
  }

  /** Topmost-first hit test across every drawing on the chart. Skips
   *  hidden drawings entirely so the cursor passes through to whatever is
   *  underneath (incl. the chart for pan). */
  function hitTopmost(sp: Pt): { drawing: Drawing; mode: HitResult; pts: Pt[] } | null {
    const c = props.coords;
    if (!c) return null;
    const { w, h } = paneDims();
    // Drawings are clipped to the pane: nothing hits over the axes.
    if (sp.x < 0 || sp.x > w || sp.y < 0 || sp.y > h) return null;
    for (let i = props.drawings.length - 1; i >= 0; i--) {
      const d = props.drawings[i];
      if (notShown(d)) continue;
      const pts = screenPoints(c, d, { w, h });
      if (!pts) continue;
      const r = hitTestKind(d, pts, sp, w, h, c, selIds().includes(d.id));
      if (r) return { drawing: d, mode: r, pts };
    }
    return null;
  }

  /** Current selection as an id list (multi-aware; falls back to the single id). */
  function selIds(): string[] {
    return props.selectedIds ?? (props.selectedId ? [props.selectedId] : []);
  }

  /** Delete / Backspace and middle click (remove selected sources): remove the
   *  deletable members in one shot (one undo entry). Locked drawings and
   *  drawings the Visibility matrix filtered off this interval are skipped
   *  (their toolbar is gone — don't delete blind). TRUE when any was removed. */
  function removeDrawings(ids: string[]): boolean {
    const deletable = ids
      .map((id) => props.drawings.find((d) => d.id === id))
      .filter((d): d is Drawing => !!d && !d.locked && !intervalHidden(d));
    if (deletable.length === 0) return false;
    if (deletable.length > 1 && props.onRemoveMany) {
      props.onRemoveMany(deletable.map((d) => d.id));
    } else {
      deletable.forEach((d) => props.onRemove(d.id));
    }
    return true;
  }

  function onSelectionPointerDown(e: PointerEvent) {
    if (armedSpec()) return;
    const c = props.coords;
    if (!c) return;
    const sp = eventPoint(svg, e);
    const hit = hitTopmost(sp);
    // Middle (wheel) click on a drawing removes it: an
    // unselected drawing becomes the selection first, then the selection is
    // removed like Delete. OT hit tests do not tell a shape's fill from its
    // outline, so a click on a fill also removes (by design fill hits are
    // ignored).
    if (e.button === 1) {
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const ids = selIds();
      if (ids.includes(hit.drawing.id)) {
        removeDrawings(ids);
      } else {
        props.setSelectedId(hit.drawing.id);
        removeDrawings([hit.drawing.id]);
      }
      return;
    }
    const multiKey = (e.ctrlKey || e.metaKey) && !!props.onToggleSelect;
    if (!hit) {
      // Ctrl+click on empty space keeps the selection; plain click clears.
      if (!multiKey) props.setSelectedId(null);
      return;
    }
    const ids = selIds();
    const wasSelected = ids.includes(hit.drawing.id);
    const inGroup = wasSelected && ids.length > 1;
    if (!multiKey && !wasSelected) props.setSelectedId(hit.drawing.id);
    e.stopPropagation();
    // Locked drawings can join/leave the selection but never drag. A plain
    // click on a locked member of a multi-selection still collapses the
    // selection to it (parity with unlocked members — selection only, no
    // drag arming, so it happens right here instead of on release).
    if (hit.drawing.locked) {
      if (multiKey) props.onToggleSelect?.(hit.drawing.id);
      else if (inGroup) props.setSelectedId(hit.drawing.id);
      return;
    }
    // Group body drag: every selected, draggable member translates together.
    // Locked / interval-hidden members stay selected but don't move.
    const group =
      inGroup && hit.mode.hit === "body"
        ? ids
            .map((id) => props.drawings.find((d) => d.id === id))
            .filter((d): d is Drawing => !!d && !d.locked && !intervalHidden(d))
            .map((d) => ({ start: d, startScreen: screenPoints(c, d, paneDims()) }))
            .filter((m): m is { start: Drawing; startScreen: Pt[] } => !!m.startScreen)
        : undefined;
    // Body-drags are gated on selection: clicking an unselected drawing's body
    // only selects it — the same gesture can't move it (a fresh grab needs a
    // second press). Anchor drags engage regardless of selection state. With
    // Ctrl held the press may still resolve to a toggle on release, so the
    // drag is armed either way but only activates when draggable.
    const canDrag = hit.mode.hit === "handle" || wasSelected;
    setDrag({
      id: hit.drawing.id,
      start: hit.drawing,
      startCursor: sp,
      startScreen: hit.pts,
      mode: hit.mode,
      active: false,
      group,
      pendingToggle: multiKey,
      pendingCollapse: !multiKey && inGroup,
      pane: paneDims(),
    });
    // Defer drawing writes for the duration of the drag: the reactive store
    // still updates every frame (panes mirror the move live), but the JSON
    // serialize + persist happens once on release (see persistence.ts).
    suspendDrawingPersist();
    const onDocMove = (ev: PointerEvent) => {
      const state = drag();
      if (!state) return;
      const cur = eventPoint(svg, ev);
      if (!state.active) {
        if (!canDrag) return;
        if (Math.hypot(cur.x - state.startCursor.x, cur.y - state.startCursor.y) < DRAG_THRESHOLD) {
          return;
        }
        // Close any open undo-coalescing window BEFORE the drag's first
        // update: a toolbar style edit within the last 800ms shares the
        // drag's coalesceId and would otherwise merge into one undo entry.
        window.dispatchEvent(new CustomEvent("drawing-gesture-end"));
        // Ctrl/Cmd + body drag on a single selected drawing → clone: drop
        // a duplicate in place and keep the drag on the original. Deferred to
        // drag activation so a bare Ctrl+click still toggles selection. Group
        // drags never clone — Ctrl just rides along.
        if (state.pendingToggle && state.mode.hit === "body" && !state.group) {
          props.onClone(state.id);
          props.setSelectedId(state.id);
        }
        setDrag({ ...state, active: true, pendingToggle: false, pendingCollapse: false });
      }
      const cc = props.coords;
      if (!cc) return;
      // Group body drag: translate every member by the cursor delta. No
      // per-point snapping — snapping members individually would tear the
      // group apart (same rule as the single body drag).
      const st = drag();
      if (st?.group) {
        // Shift: H/V lock of the move (lib lockAxisDelta).
        const d0 = { dx: cur.x - st.startCursor.x, dy: cur.y - st.startCursor.y };
        const { dx, dy } = shiftDown() ? lockAxisDelta(d0.dx, d0.dy) : d0;
        const moved: Drawing[] = [];
        for (const m of st.group) {
          const nd = translateDrawing(cc, m.start, m.startScreen, dx, dy, paneDims());
          if (nd) moved.push(nd);
        }
        if (moved.length) {
          if (props.onUpdateMany) props.onUpdateMany(moved);
          else moved.forEach((d) => props.onUpdate(d));
        }
        return;
      }
      const m = effectiveMagnet();
      const snap = m.enabled
        ? (p: DataPoint) => magnetSnap(p, cc, m.mode, !!props.magnetSnapsToIndicators) ?? p
        : (p: DataPoint) => p;
      const updated = applyDrag(state, cur, cc, snap, shiftDown());
      if (updated) props.onUpdate(updated);
    };
    const onDocUp = () => {
      const state = drag();
      // Bare click (never crossed the drag threshold): resolve the deferred
      // selection change — Ctrl toggles membership, a plain click on a group
      // member collapses the selection to it.
      if (state && !state.active) {
        if (state.pendingToggle) props.onToggleSelect?.(state.id);
        else if (state.pendingCollapse) props.setSelectedId(state.id);
        // Table: a click on a cell of the already selected table makes it the
        // active cell and opens its editor; a click on a corner anchor clears
        // it.
        if (hit.drawing.kind === "table" && !multiKey && e.button === 0) {
          if (hit.mode.hit === "body" && hit.mode.cell && wasSelected) {
            setTableUi({ id: hit.drawing.id, cell: hit.mode.cell, editing: true, edge: null });
          } else if (hit.mode.hit === "handle" && hit.mode.handleIndex < 4) {
            setTableUi((u) => (u && u.id === hit.drawing.id ? { ...u, cell: null, editing: false } : u));
          }
        }
      }
      // Image drag end: the centre goes back to its bar (the drag's
      // exact-centre offset is dropped).
      if (state?.active && state.start.kind === "image") {
        const cur = props.drawings.find((x) => x.id === state.id);
        if (cur?.image?.dx != null) {
          const { dx: _dx, ...im } = cur.image;
          props.onUpdate({ ...cur, image: im } as Drawing);
        }
      }
      document.removeEventListener("pointermove", onDocMove);
      document.removeEventListener("pointerup", onDocUp);
      setDrag(null);
      resumeDrawingPersist(); // flush the final position once
      // Pointer-up closes App's undo-coalescing window, so two quick drags of
      // the same drawing stay two undo entries.
      window.dispatchEvent(new CustomEvent("drawing-gesture-end"));
    };
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("pointerup", onDocUp);
  }

  function onMove(e: PointerEvent) {
    const mode = cmode();
    // Eraser sweep — while the button is held, erase whatever the pointer crosses.
    if (mode === "eraser") {
      if (erasing) eraseAt(e);
      return;
    }
    // Measure (two-click): once the first point is down, the rubber-band rect
    // tracks the cursor (magnet-snapped) until the second click commits it.
    if (props.armedTool === "measure" && measureStart()) {
      const end = aimAt(eventPoint(svg, e)).pt;
      setRegion((r) => (r ? { start: r.start, end } : null));
      return;
    }
    // Track the cursor for the whole armed session (even before the first
    // click) so the placement crosshair follows from the moment the tool is
    // armed, not just once an anchor exists.
    if (!armedSpec()) return;
    setCursor(eventPoint(svg, e));
  }

  function onContextMenu(e: MouseEvent) {
    // Only intervene if the right-click landed on a drawing — otherwise
    // we'd swallow the native menu for the rest of the chart.
    const sp = eventPoint(svg, e as unknown as PointerEvent);
    const hit = hitTopmost(sp);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    // Right-click on a member of a multi-selection keeps the group selected
    // (the menu's Remove then acts on the whole group); a drawing outside
    // the selection re-anchors it.
    if (!selIds().includes(hit.drawing.id)) props.setSelectedId(hit.drawing.id);
    setMenu({ drawing: hit.drawing, pos: { x: e.clientX, y: e.clientY } });
  }

  onMount(() => {
    refreshSize();
    const ro = new ResizeObserver(() => refreshSize());
    if (svg.parentElement) ro.observe(svg.parentElement);
    onCleanup(() => ro.disconnect());

    const onKey = (e: KeyboardEvent) => {
      if (props.shown === false) return;
      const t = e.target as HTMLElement | null;
      const inEditable =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // A modal dialog (drawing settings, indicators, …) owns the keyboard —
      // don't let Delete / copy / paste reach through it to the drawing layer.
      if (inEditable || document.querySelector('[role="dialog"]')) return;
      if (e.key === "Escape") {
        if (pending().length > 0) {
          setPending([]);
          setCursor(null);
        } else if (measureStart()) {
          // Cancel a half-placed two-click measure without disarming the tool.
          setMeasureStart(null);
          setRegion(null);
        } else if (props.armedTool) {
          props.onDisarm();
        } else if (props.selectedId) {
          props.setSelectedId(null);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (removeDrawings(selIds())) e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyC") {
        // Ctrl+C copies the selected drawing to the drawing clipboard. Match
        // the physical key (e.code) so non-Latin layouts work, and require a bare
        // Ctrl/Cmd so Ctrl+Shift+C etc. aren't hijacked. Without a selection, fall
        // through to the browser's text copy.
        if (props.selectedId) {
          const target = props.drawings.find((d) => d.id === props.selectedId);
          if (target) {
            e.preventDefault();
            copyDrawing(target);
          }
        }
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));

    // Ctrl+V: handled on the paste event, which carries the system clipboard.
    // A drawing copied here (marker in the HTML) pastes at the same data
    // coords; an image file becomes an Image drawing at the pane centre;
    // otherwise the in-app drawing clipboard is used. Only the focused pane
    // pastes.
    const onPaste = (e: ClipboardEvent) => {
      if (props.shown === false) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]') || props.active === false) return;
      const dt = e.clipboardData;
      const fromHere = !!dt && dt.getData("text/html").includes(DRAWING_CLIP_MARK);
      const file = !fromHere && dt ? Array.from(dt.files).find((f) => IMAGE_TYPES[f.type]) : undefined;
      if (file) {
        e.preventDefault();
        void pasteImage(file);
        return;
      }
      const nd = pasteAsNew();
      if (nd) {
        e.preventDefault();
        const id = props.onPlace(nd);
        if (id) props.setSelectedId(id); // select the paste so it's grab-ready
      }
    };
    document.addEventListener("paste", onPaste);
    onCleanup(() => document.removeEventListener("paste", onPaste));

    // Arrow-key nudge of the selected drawing (←↑→↓ move it 1px). App owns
    // the selection + arrow keys and broadcasts the screen delta; only the
    // focused pane applies it (props.active), so a drawing shown on several
    // panes moves exactly once. Mirrors the body-drag translate: project every
    // point, shift by (dx, dy) px, unproject. Skips locked drawings.
    const onNudge = (e: Event) => {
      if (props.shown === false || !props.active || selIds().length === 0) return;
      const c = props.coords;
      if (!c) return;
      const { dx, dy } = (e as CustomEvent<{ dx: number; dy: number }>).detail;
      // Every movable selected drawing nudges together (multi-select).
      const moved: Drawing[] = [];
      for (const id of selIds()) {
        const target = props.drawings.find((d) => d.id === id);
        if (!target || target.locked || intervalHidden(target)) continue;
        const screen = screenPoints(c, target, paneDims());
        if (!screen) continue;
        const nd = translateDrawing(c, target, screen, dx, dy, paneDims());
        if (nd) moved.push(nd);
      }
      if (moved.length > 1 && props.onUpdateMany) props.onUpdateMany(moved);
      else moved.forEach((d) => props.onUpdate(d));
    };
    window.addEventListener("drawing-nudge", onNudge);
    onCleanup(() => window.removeEventListener("drawing-nudge", onNudge));

    // Click-outside deselect — clicking anything that isn't the selected drawing
    // (or a drawing-related surface: its floating toolbar, settings dialog,
    // context menu, style popovers, or the left drawing toolbar) clears the
    // selection. Needed because while only a drawing is selected the overlay is
    // pointer-events:none (so the chart stays pannable), so empty-area clicks
    // land on the chart canvas, never reaching the overlay's own deselect
    // branch — a window-level capture listener catches them wherever they land.
    const KEEP = [
      "[data-drawing-id]", // the drawing itself (or another drawing)
      ".selected-toolbar", // its floating toolbar (+ favorites bar shell)
      ".drawing-settings-backdrop", // settings dialog (backdrop + body)
      ".drawing-context-menu", // right-click menu
      ".dt-popover", // colour / width / style / template popovers
      ".dt-color-field-portal", // portalled colour field
      ".drawing-toolbar", // the left drawing toolbar
      ".ot-table-cell-input", // the table cell editor
      ".ot-dlg-layer", // name / confirm dialogs (template save, delete)
    ].join(",");
    const onOutsideDown = (e: PointerEvent) => {
      if (props.shown === false || selIds().length === 0) return;
      // Ctrl/Cmd+click never clears — it's the multi-select modifier.
      if (e.ctrlKey || e.metaKey) return;
      const target = e.target as Element | null;
      if (target && target.closest(KEEP)) return;
      props.setSelectedId(null);
    };
    window.addEventListener("pointerdown", onOutsideDown, true);
    onCleanup(() => window.removeEventListener("pointerdown", onOutsideDown, true));

    // Alt+H / J / V / C: create the line at once at the cursor, in the
    // pane under the pointer (same magnet snap as a click), then select it.
    const onPlaceAtCursor = (e: Event) => {
      const detail = (e as CustomEvent<PlaceAtCursorDetail>).detail;
      if (props.shown === false || !detail || detail.handled || !lastPointer) return;
      const r = svg.getBoundingClientRect();
      const x = lastPointer.x - r.left;
      const y = lastPointer.y - r.top;
      if (r.width <= 0 || x < 0 || y < 0 || x > r.width || y > r.height) return;
      const dp = dataAt({ x, y });
      if (!dp) return;
      const placed = buildNewDrawing(detail.kind, [dp]);
      if (!placed) return;
      detail.handled = true;
      setPending([]);
      setCursor(null);
      const id = props.onPlace(placed);
      if (id) props.setSelectedId(id);
    };
    window.addEventListener(PLACE_AT_CURSOR_EVENT, onPlaceAtCursor);
    onCleanup(() => window.removeEventListener(PLACE_AT_CURSOR_EVENT, onPlaceAtCursor));

    // Track Shift / Ctrl-Cmd for the magnet modifier overrides. Down AND up on
    // window so presses register over the canvas; blur clears a stuck key.
    const onMod = (e: KeyboardEvent) => {
      const down = e.type === "keydown";
      if (e.key === "Shift") setShiftDown(down);
      else if (e.key === "Control" || e.key === "Meta") setCtrlDown(down);
    };
    const onBlur = () => { setShiftDown(false); setCtrlDown(false); };
    window.addEventListener("keydown", onMod);
    window.addEventListener("keyup", onMod);
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      window.removeEventListener("keydown", onMod);
      window.removeEventListener("keyup", onMod);
      window.removeEventListener("blur", onBlur);
    });
  });

  /** Effective magnet given held modifiers — Shift forces off, Ctrl/Cmd inverts
   *  (off→strong, on→off), else the persisted enable + weak/strong mode. */
  function effectiveMagnet(): { enabled: boolean; mode: "weak" | "strong" } {
    const mode = props.magnetMode ?? "weak";
    const d = drag();
    const busy = pending().length > 0 || (!!d?.active && d.mode.hit === "handle");
    if (shiftDown() && busy) return { enabled: false, mode };
    if (ctrlDown()) return { enabled: !props.magnet, mode: "strong" };
    return { enabled: !!props.magnet, mode };
  }

  // A tool change hides the line-tool event hint (not dismissed).
  createEffect(on(() => [props.armedTool, cmode()], () => setLineToolHint(null), { defer: true }));

  // Reset rubber-band when armedTool clears (e.g. switching tools mid-place).
  createEffect(() => {
    if (!armedSpec()) {
      setPending([]);
      setCursor(null);
    }
  });

  // ── Right-axis price pills (showPriceLabels) ───────────────────────────
  // For each endpoint of every drawing with `showPriceLabels` we create a
  // lightweight-charts price line with the body hidden — only the axis pill
  // shows. Diffed against a keyed Map so the sync is O(changes). The lines live
  // on ChartView's series; when the series is rebuilt (symbol/type change) the
  // `coords` identity changes and the old handles are stale, so we drop the map
  // without touching them (LWC disposed them with the old series).
  let priceLines = new Map<string, IPriceLine>();
  let priceLineCoords: Coords | null = null;
  createEffect(() => {
    const coords = props.coords;
    const list = props.drawings;
    if (coords !== priceLineCoords) {
      priceLines = new Map();
      priceLineCoords = coords;
    }
    if (!coords) return;
    const desired = new Map<string, { price: number; color: string }>();
    for (const d of list) {
      // Anchored VWAP "Price label": the VWAP's last value on the price
      // scale (re-read when the bars change; vwapData is cached per bars).
      if (d.kind === "anchored-vwap") {
        void props.coordEpoch;
        if (d.style.vwapPriceLabel === false || notShown(d)) continue;
        const v = vwapLastValue(d, coords);
        if (v != null) desired.set(`${d.id}#vwap`, { price: v, color: parseColor(d.style.color).hex });
        continue;
      }
      if (!d.style.showPriceLabels || notShown(d) || d.kind === "vertical-line") continue;
      d.points.forEach((pt, i) => desired.set(`${d.id}#${i}`, { price: pt.price, color: d.style.color }));
    }
    for (const [key, line] of priceLines) {
      const want = desired.get(key);
      if (!want) {
        coords.removePriceLine(line);
        priceLines.delete(key);
        continue;
      }
      line.applyOptions({ price: want.price, color: want.color, axisLabelColor: want.color });
    }
    for (const [key, want] of desired) {
      if (priceLines.has(key)) continue;
      priceLines.set(key, coords.addPriceLine({
        price: want.price,
        color: want.color,
        lineWidth: 1,
        lineVisible: false,
        axisLabelVisible: true,
        axisLabelColor: want.color,
        axisLabelTextColor: "#ffffff",
        title: "",
      }));
    }
  });
  onCleanup(() => {
    if (priceLineCoords) {
      for (const line of priceLines.values()) {
        try { priceLineCoords.removePriceLine(line); } catch { /* series already disposed */ }
      }
    }
    priceLines.clear();
  });

  // Live preview while placing. The *real* tool is drawn as you aim, not a
  // placeholder rubber-band: the in-progress draw renders exactly like the
  // finished one — solid stroke, a ray already extends to the pane edge, a
  // rectangle shows its fill.
  function previewElement(): import("solid-js").JSX.Element {
    const p = pending();
    const rawCur = cursor();
    const spec = armedSpec();
    const coords = props.coords;
    if (!spec || p.length === 0 || !rawCur || !coords) return null;
    // Re-project the already-placed anchors on every pan/zoom (coordEpoch bumps),
    // so a committed first point tracks its price/time as the chart scrolls
    // instead of sticking to its old screen position.
    void props.coordEpoch;
    const { w, h } = paneDims();
    // Project every point placed so far.
    const placed: Pt[] = [];
    for (const dp of p) {
      const sp = projectPoint(coords, dp);
      if (sp) placed.push(sp);
    }
    if (placed.length === 0) return null;
    // Preview with the tool's own default style, so the in-progress draw looks
    // exactly like the finished one (e.g. a trendline at its 1px default).
    const baseStyle = defaultStyleFor(spec.kind);
    // Magnet-snapped aim point (locks onto the candle's OHLC point when the
    // magnet engages, else the free cursor); a dot marks the lock.
    const aim = aimAt(rawCur);
    const cur = aim.pt;
    const magnetDot = aim.engaged
      ? <circle class="drawing-crosshair-magnet" cx={cur.x} cy={cur.y} r={4} fill={PREVIEW_STROKE} pointer-events="none" />
      : null;
    // Anchor dots mark each committed point.
    const dots = placed.map((pt) => (
      <circle cx={pt.x} cy={pt.y} r={3} fill={baseStyle.color} pointer-events="none" />
    ));

    // Fixed-arity tool with at least one anchor down + a live cursor: render
    // the REAL shape via its kind renderer so a ray extends, a rectangle
    // fills, a pitchfork fans. The cursor stands in for EVERY unplaced point
    // (renderers degrade coincident points to the shorter shape), and the
    // placement constructor derives the same synthetic points (curve
    // controls, channel offset) the commit will. Pattern / Elliott /
    // variable-length kinds fall through to the segment rubber-band below.
    if (
      !spec.variableLength && !spec.freehand && !SEGMENT_PREVIEW_KINDS.has(spec.kind) &&
      placed.length === p.length && placed.length < spec.pointCount
    ) {
      // Shift: the same per-tool rule as the click (onPlacementClick), so the
      // preview shows what the click will commit.
      const cur0 = dataAt(cur);
      const sh = cur0 && shiftDown() ? shiftPlacementPoint(spec.kind, p, cur0, coords) : null;
      const curData = sh ? sh.point : cur0;
      if (curData) {
        const full = [...p, curData];
        if (sh?.extra) full.push(sh.extra);
        while (full.length < spec.pointCount) full.push(curData);
        const nd0 = buildNewDrawing(spec.kind, full);
        const nd = nd0 && spec.kind === "gann-square" ? snapGannSquare(nd0 as Drawing, coords) : nd0;
        const previewDrawing = nd ? ({ ...nd, id: "__preview__", style: baseStyle } as Drawing) : null;
        const screen = previewDrawing ? projectAll(coords, previewDrawing.points) : null;
        if (previewDrawing && screen) {
          return (
            <g pointer-events="none">
              {renderKind(previewDrawing, screen, false, w, h, coords)}
              {dots}
              {magnetDot}
            </g>
          );
        }
      }
    }

    // Freehand stroke mid-draw (brush/highlighter): render the REAL stroke so the
    // live preview matches the committed look (wide translucent highlighter, etc.).
    if (spec.freehand && placed.length >= 2) {
      const previewDrawing = { id: "__preview__", kind: spec.kind, points: p, style: baseStyle } as Drawing;
      return <g pointer-events="none">{renderKind(previewDrawing, placed, false, w, h, coords)}</g>;
    }

    // Multi-point tools mid-placement: connect the placed points so far + a SOLID
    // rubber-band to the cursor (the in-progress line is solid).
    const last = placed[placed.length - 1];
    return (
      <>
        <Show when={placed.length >= 2}>
          <polyline
            points={placed.map((q) => `${q.x},${q.y}`).join(" ")}
            fill="none"
            stroke={baseStyle.color}
            stroke-width={baseStyle.width}
            stroke-linecap="round"
            pointer-events="none"
          />
        </Show>
        <line
          x1={last.x}
          y1={last.y}
          x2={cur.x}
          y2={cur.y}
          stroke={baseStyle.color}
          stroke-width={baseStyle.width}
          stroke-linecap="round"
          pointer-events="none"
        />
        {dots}
        {magnetDot}
      </>
    );
  }

  /** Demonstration highlighters (Alt + draw): the brush renderer (smoothed
   *  the same way), faded by the time since release. */
  function highlighterElement(): import("solid-js").JSX.Element {
    const hs = highlighters();
    const c = props.coords;
    if (hs.length === 0 || !c) return null;
    void props.coordEpoch; // re-project on pan / zoom
    const now = fadeClock();
    const { w, h } = paneDims();
    const style = { ...defaultStyleFor("brush"), color: HIGHLIGHTER_COLOR, width: HIGHLIGHTER_WIDTH, fillBackground: false };
    return (
      <g pointer-events="none" clip-path={`url(#${paneClipId})`}>
        {hs.map((hl) => {
          const pts = projectAll(c, hl.points);
          if (!pts || pts.length < 2) return null;
          const progress = hl.finishedAt === null ? 0 : Math.min(1, Math.max(0, (now - hl.finishedAt) / HIGHLIGHTER_FADE_MS));
          const d = { id: `__highlighter_${hl.id}__`, kind: "brush", points: hl.points, style } as Drawing;
          return <g opacity={HIGHLIGHTER_OPACITY * (1 - progress)}>{renderKind(d, pts, false, w, h, c)}</g>;
        })}
      </g>
    );
  }

  /** Demonstration cursor: circle of radius LineWidth / 2 = 18 at
   *  the pointer, filled ripe-red-500 at 25 %, 1 px border at 3 %. */
  function demoCursorElement(): import("solid-js").JSX.Element {
    const p = demoCursor();
    if (!p) return null;
    return (
      <circle
        cx={p.x}
        cy={p.y}
        r={HIGHLIGHTER_WIDTH / 2}
        fill={HIGHLIGHTER_COLOR}
        fill-opacity={HIGHLIGHTER_OPACITY}
        stroke={HIGHLIGHTER_COLOR}
        stroke-opacity={DEMO_CURSOR_BORDER_OPACITY}
        stroke-width={1}
        pointer-events="none"
      />
    );
  }

  /** Placement crosshair — while a tool is armed the overlay captures the pane,
   *  so lightweight-charts' own crosshair can't track the cursor; we draw it
   *  here (full-pane dashed lines + a magnet dot when snapped). Mirrors the
   *  mock's `.drawing-crosshair-line` (stroke #9598a1, 1px, 6/6 dash). */
  function crosshairElement(): import("solid-js").JSX.Element {
    if (!armedSpec()) return null;
    const rawCur = cursor();
    if (!rawCur) return null;
    const { w, h } = paneDims();
    const aim = aimAt(rawCur);
    // Magnet pulls ONLY the horizontal (price) line to the nearest OHLC level.
    // The vertical (time) line stays on the raw cursor, and no snap dot is
    // drawn — the crosshair always reads as a full cross, never collapsing to
    // a point.
    const yLine = aim.engaged ? aim.pt.y : rawCur.y;
    return (
      <g pointer-events="none">
        <line x1={rawCur.x} y1={0} x2={rawCur.x} y2={h} stroke="#9598a1" stroke-width={1} stroke-dasharray="6 6" />
        <line x1={0} y1={yLine} x2={w} y2={yLine} stroke="#9598a1" stroke-width={1} stroke-dasharray="6 6" />
      </g>
    );
  }

  /** Measure ruler — a green/red box from start→end with a centered badge
   *  showing the price delta + %, bar count, and duration. Ephemeral (not a
   *  saved drawing); a transient measure tool. */
  function renderMeasure(start: Pt, end: Pt): import("solid-js").JSX.Element {
    const c = props.coords;
    if (!c) return null;
    const sd = unproject(c, start);
    const ed = unproject(c, end);
    if (!sd || !ed) return null;
    const up = ed.price >= sd.price;
    const color = up ? "#089981" : "#f23645";
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    const cx = x + w / 2;
    const priceLabel = formatPriceDelta(sd.price, ed.price);
    const sa = timeToSec(sd.time);
    const sb = timeToSec(ed.time);
    const barCount = sa != null && sb != null ? Math.max(0, barsBetween(c.bars(), sa, sb).length - 1) : 0;
    const timeLabel = formatTimeDelta(sd.time, ed.time);
    const subLabel = timeLabel ? `${barCount} bars, ${timeLabel}` : `${barCount} bars`;
    const bw = Math.max(120, priceLabel.length * 7.5, subLabel.length * 6.5);
    const bh = 34;
    const bx = cx - bw / 2;
    // Badge above the box, flipped below when it would clip the top edge.
    const by = y - bh - 8 < 0 ? y + h + 8 : y - bh - 8;
    return (
      <g pointer-events="none">
        <rect x={x} y={y} width={w} height={h} fill={color} fill-opacity={0.15} stroke={color} stroke-width={1} />
        {/* direction arrow from start price to end price */}
        <line x1={cx} y1={up ? y + h : y} x2={cx} y2={up ? y : y + h} stroke={color} stroke-width={1.5} />
        <rect x={bx} y={by} width={bw} height={bh} rx={4} fill={color} />
        <text x={cx} y={by + 14} text-anchor="middle" fill="#ffffff" font-size="12" font-weight="600">
          {priceLabel}
        </text>
        <text x={cx} y={by + 28} text-anchor="middle" fill="#ffffff" font-size="11">
          {subLabel}
        </text>
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
        />
      );
    }
    const m = tool === "measure" && live ? live : measureResult();
    return m ? renderMeasure(m.start, m.end) : null;
  }

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

  // Floating-toolbar anchor: bbox-top center of the selected drawing in
  // screen space. Reading `size` keeps it reactive on pan/zoom/resize.
  function selectedAnchor(): { drawing: Drawing; pos: Pt } | null {
    const id = props.selectedId;
    if (!id) return null;
    const c = props.coords;
    if (!c) return null;
    void size();
    void props.coordEpoch;
    const d = props.drawings.find((x) => x.id === id);
    if (!d) return null;
    // A drawing filtered off this interval by its Visibility matrix isn't
    // painted — anchor no toolbar over the empty chart.
    if (intervalHidden(d)) return null;
    const pts = screenPoints(c, d, paneDims());
    if (!pts) return null;
    let minY = Infinity;
    let sumX = 0;
    if (d.kind === "horizontal-line" || d.kind === "horizontal-ray" || d.kind === "vertical-line" || d.kind === "cross-line") {
      // Use the click point as the anchor — these kinds paint full-extent
      // but only have one meaningful position.
      return { drawing: d, pos: { x: pts[0].x, y: pts[0].y } };
    }
    let xCount = 0;
    for (const p of pts) {
      if (p.y < minY) minY = p.y;
      sumX += p.x;
      xCount++;
    }
    return { drawing: d, pos: { x: sumX / xCount, y: minY } };
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
        left: "0",
        width: "100%",
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
          if (hit && findOverlaySpec(hit.drawing.kind)?.textEditable && !hit.drawing.locked) {
            e.preventDefault();
            setTextEdit({
              mode: "edit",
              id: hit.drawing.id,
              kind: hit.drawing.kind,
              points: hit.drawing.points,
              pos: textAnchorScreen(hit.drawing, hit.pts),
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
        <clipPath id={paneClipId}>
          <rect x={0} y={0} width={paneDims().w} height={paneDims().h} />
        </clipPath>
      </defs>
      <g clip-path={`url(#${paneClipId})`}>
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
            const c = props.coords;
            if (notShown(d) || !c) return null;
            const pts = screenPoints(c, d, paneDims());
            return pts ? { c, pts } : null;
          });
          const selected = () => selIds().includes(d.id);
          // A drawing's anchors show on hover too (not just selection) —
          // locked drawings and armed-tool placement keep hover feedback off.
          const active = () =>
            selected() || (hoveredId() === d.id && !d.locked && !armedSpec());
          return (
            <Show when={view()}>
              {(v) => {
                const { w, h } = paneDims();
                // Locked drawings stay selectable (the pointerdown handler sets
                // the selection but never arms a drag), so show the normal arrow
                // rather than "not-allowed", which reads as non-interactive.
                const cursor = d.locked ? "default" : selected() ? "move" : "pointer";
                return (
                  <g
                    data-drawing-id={d.id}
                    style={{ "pointer-events": "visiblePainted", cursor }}
                    onPointerEnter={() => setHoveredId(d.id)}
                    onPointerLeave={() => setHoveredId((cur) => (cur === d.id ? null : cur))}
                  >
                    {/* Locked drawings never show the normal grab handles —
                        selection paints lock glyphs on the anchors instead. */}
                    <AnchorCtx.Provider value={{ fillAt: anchorFillAt, selected }}>
                      {renderKind(d, v().pts, active() && !d.locked, w, h, v().c, hoveredId() === d.id && !d.locked)}
                    </AnchorCtx.Provider>
                    <Show when={selected() && d.locked}>
                      {renderLockedAnchors(v().pts, d.style.color)}
                    </Show>
                  </g>
                );
              }}
            </Show>
          );
        }}
      </For>

      {crosshairElement()}
      {previewElement()}
      </g>
      {/* Axis parts of drawings (drawn in the axis panes, outside the pane
          clip): vertical / cross line time label, position price
          labels. */}
      <For each={props.drawings}>
        {(d) => {
          const view = createMemo(() => {
            if (!AXIS_PART_KINDS.has(d.kind)) return null;
            void props.coordEpoch;
            void size();
            const c = props.coords;
            if (notShown(d) || !c) return null;
            const pts = screenPoints(c, d, paneDims());
            return pts ? { c, pts } : null;
          });
          return <Show when={view()}>{(v) => renderAxisParts(d, v().pts, paneDims(), size().w, v().c)}</Show>;
        }}
      </For>
      {highlighterElement()}
      {demoCursorElement()}
      {regionElement()}
    </svg>
    <Show when={textEdit()}>
      {(te) => (
        <input
          ref={(el) => { textInput = el; queueMicrotask(() => { el.focus(); el.select(); }); }}
          class="ot-drawing-text-input"
          value={te().value}
          placeholder={TEXT_PLACEHOLDER[te().kind] ?? "Text"}
          style={{
            position: "absolute",
            left: `${te().pos.x}px`,
            top: `${te().pos.y - 12}px`,
            "z-index": 6,
          }}
          onInput={(e) => {
            const cur = textEdit();
            if (cur) setTextEdit({ ...cur, value: e.currentTarget.value });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitTextEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelTextEdit();
            }
          }}
          onBlur={() => { if (!holdTextFocus) commitTextEdit(); }}
        />
      )}
    </Show>
    {/* Table in-place cell editor (multi-line; Tab / Shift+Tab = next /
        previous cell, Escape closes it and clears the active cell). The text
        is written to the cell on every change. */}
    <Show when={props.active !== false && tableEditKey()} keyed>
      {(key) => {
        const [id, r0, c0] = key.split("|");
        const cell: TableCellRef = [Number(r0), Number(c0)];
        const geo = () => {
          const te = tableEditor();
          if (!te) return null;
          const { l, r, col } = te;
          return {
            left: l.xs[col] + TABLE_BORDER + TABLE_PAD,
            top: l.ys[r] + TABLE_BORDER + TABLE_PAD,
            width: Math.max(0, l.xs[col + 1] - l.xs[col] - 2 * (TABLE_BORDER + TABLE_PAD)),
            height: Math.max(0, l.ys[r + 1] - l.ys[r] - 2 * (TABLE_BORDER + TABLE_PAD)),
            fs: l.fs,
            color: te.d.style.textColor ?? "#dbdbdb",
            align: te.d.style.horzLabelsAlign ?? "left",
          };
        };
        const writeText = (text: string) => {
          const d = props.drawings.find((x) => x.id === id);
          if (d) props.onUpdate({ ...d, style: { ...d.style, ...tableWithText(d.style, cell, text) } } as Drawing);
        };
        return (
          <Show when={geo()}>
            {(g) => (
              <textarea
                ref={(el) => {
                  const d = props.drawings.find((x) => x.id === id);
                  el.value = d?.kind === "table" ? d.style.tableCells?.[cell[0]]?.[cell[1]] ?? "" : "";
                  queueMicrotask(() => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
                }}
                class="ot-table-cell-input"
                spellcheck={false}
                style={{
                  left: `${g().left}px`,
                  // The SVG line box is fs tall (centre at fs / 2 + 0.05 fs);
                  // the textarea line box is 1.3 fs with the text centred.
                  top: `${g().top - 0.1 * g().fs}px`,
                  width: `${g().width}px`,
                  height: `${g().height + 0.3 * g().fs}px`,
                  "font-size": `${g().fs}px`,
                  "line-height": String(TABLE_LINE_HEIGHT),
                  color: g().color,
                  "caret-color": g().color,
                  "text-align": g().align,
                }}
                onInput={(e) => writeText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const d = props.drawings.find((x) => x.id === id);
                    if (d) setTableUi({ id, cell: tableNextCell(d.style, cell, e.shiftKey), editing: true, edge: null });
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setTableUi((u) => (u && u.id === id ? { ...u, cell: null, editing: false } : u));
                  }
                }}
                onBlur={() => {
                  // Leaving the editor keeps the active cell (the blue border
                  // stays while the table is selected).
                  setTableUi((u) => (u && u.id === id && u.editing && u.cell && u.cell[0] === cell[0] && u.cell[1] === cell[1] ? { ...u, editing: false } : u));
                }}
              />
            )}
          </Show>
        );
      }}
    </Show>
    <Show when={imageDialog()}>
      <ImageDialog
        onConfirm={(r) => placeImage(r)}
        onClose={() => {
          setImageDialog(false);
          if (props.armedTool === "image") props.onDisarm();
        }}
      />
    </Show>
    {/* Only the active pane shows the selected-drawing toolbar — panes that
        share a symbol all render the selected drawing, so without this gate two
        (or more) toolbars would stack on a multi-layout. */}
    <Show when={props.active !== false && selectedAnchor()}>
      {(a) => (
        <SelectedToolbar
          drawing={a().drawing}
          group={selIds()
            .map((id) => props.drawings.find((d) => d.id === id))
            .filter((d): d is Drawing => !!d)}
          anchor={a().pos}
          onUpdate={props.onUpdate}
          onUpdateMany={props.onUpdateMany}
          onRemove={props.onRemove}
          onRemoveMany={props.onRemoveMany}
          onOpenSettings={openSettings}
          onClone={props.onClone}
          onCopy={copyDrawing}
          onReorder={props.onReorder}
          onTableOp={(op) => tableOp(a().drawing.id, op)}
          onToggleAnchor={isAnchorable(a().drawing.kind) ? () => toggleAnchored(a().drawing.id) : undefined}
          onAddAlert={(d) => {
            // Same event the chart context menu uses; prefill the drawing's
            // first-point price on this pane's symbol.
            window.dispatchEvent(new CustomEvent("chart-open-alert-dialog", {
              detail: { symbol: props.symbol, price: d.points[0]?.price },
            }));
          }}
        />
      )}
    </Show>
    <Show when={menu()}>
      {(m) => (
        <DrawingContextMenu
          drawing={m().drawing}
          // Locked members are excluded so the menu's bulk Remove matches the
          // Delete key (the clicked drawing itself falls to the single path).
          groupIds={selIds().filter((id) => {
            const dd = props.drawings.find((x) => x.id === id);
            return !!dd && (!dd.locked || id === m().drawing.id);
          })}
          anchor={m().pos}
          onClose={() => setMenu(null)}
          onUpdate={props.onUpdate}
          onClone={props.onClone}
          onCopy={copyDrawing}
          onReorder={props.onReorder}
          onRemove={props.onRemove}
          onRemoveMany={props.onRemoveMany}
          onOpenSettings={openSettings}
          tableCell={(() => { const u = tableUi(); return u && u.id === m().drawing.id ? u.cell : null; })()}
          onTableOp={(op) => tableOp(m().drawing.id, op)}
        />
      )}
    </Show>
    <Show when={settingsDrawing()}>
      {(d) => (
        <SettingsDialog
          drawing={d()}
          coords={props.coords}
          symbol={props.symbol}
          initialTab={settingsTab()}
          onClose={() => setSettingsId(null)}
          onUpdate={props.onUpdate}
        />
      )}
    </Show>
    </>
  );
}

/** ---------- render dispatch ---------- */

/** Kinds with parts on an axis (drawn outside the pane clip). */
const AXIS_PART_KINDS = new Set<string>(["vertical-line", "cross-line", "long-position", "short-position"]);

/** Axis parts of a drawing: the time label of a vertical / cross line on the
 *  time axis (show time) and the entry / target / stop price pills of a
 *  position on the price axis (axis labels for the three levels).
 *  `pane` = the pane size, `svgW` = the overlay width (pane + price axis). */
function renderAxisParts(d: Drawing, pts: Pt[], pane: { w: number; h: number }, svgW: number, coords: Coords | null) {
  const s = d.style;
  if (d.kind === "vertical-line" || d.kind === "cross-line") {
    const t0 = d.points[0];
    return (
      <Show when={!!s.showTime && !!t0}>
        <TimeAxisLabel x={pts[0].x} h={pane.h} time={t0.time} color={s.color} coords={coords} />
      </Show>
    );
  }
  if ((d.kind === "long-position" || d.kind === "short-position") && s.showPriceLabels !== false) {
    const pa = positionAnchors(d, pts, coords);
    if (!pa) return null;
    const entry = d.points[0].price;
    const sign = d.kind === "long-position" ? 1 : -1;
    const pill = (y: number, price: number, bg: string) => {
      const label = price.toFixed(2);
      const pw = label.length * 6.5 + 10;
      return (
        <g pointer-events="none">
          <rect x={svgW - pw - 2} y={y - 8} width={pw} height={16} rx={2} fill={bg} />
          <text x={svgW - pw / 2 - 2} y={y + 4} font-size="10" fill="#ffffff" text-anchor="middle">{label}</text>
        </g>
      );
    };
    return (
      <>
        {pill(pts[0].y, entry, "#787b86")}
        {pill(pa.yTarget, entry + sign * pa.profit, "#089981")}
        {pill(pa.yStop, entry - sign * pa.stop, "#f23645")}
      </>
    );
  }
  return null;
}

/** Draws one drawing: the core scene (lightweight-charts-drawing
 *  scene/index sceneOf) as SVG. Text, table and image stay components (they
 *  read OpenTrader signals: anchor context, table UI, image cache). Exported
 *  for the port's golden render check. */
export function renderKind(
  d: Drawing,
  pts: Pt[],
  selected: boolean,
  w: number,
  h: number,
  coords: Coords | null,
  hovered = false,
): import("solid-js").JSX.Element {
  switch (d.kind) {
    case "text":
      return <TextToolView d={d} p={pts[0]} hovered={hovered} />;
    case "table":
      return <TableView d={d} p={pts[0]} active={selected} />;
    case "image":
      return <ImageView d={d} p={pts[0]} active={selected} />;
  }
  return sceneSvg(sceneOf(d, pts, { w, h, coords, selected, hovered }), Handles, d.style.color);
}

/** Anchor colour (ot-blue-600), the same for every drawing whatever its line
 *  colour. */
const ANCHOR_COLOR = "#1e53e5";

/** Per-drawing anchor context: chart background at a y, and whether the owner
 *  drawing is selected (the ring is thicker for a selected drawing). */
const AnchorCtx = createContext<{ fillAt: (y: number) => string; selected: () => boolean }>({
  fillAt: () => "#0f0f0f",
  selected: () => true,
});

/** Linear mix of two #rrggbb colours (t = 0 → a, 1 → b). */
function mixHex(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  const ch = (sh: number) => Math.round(((na >> sh) & 255) + (((nb >> sh) & 255) - ((na >> sh) & 255)) * t);
  return "#" + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0");
}

/** Line anchors: radius 6, ring in ot-blue-600 drawn inside the radius with
 *  stroke 1 (+1 when the drawing is selected), filled with
 *  the chart background at the anchor's height. The hovered anchor adds a 3px
 *  ring (RegularSelectedStrokeWidth) at 20% alpha just outside. `color` (the
 *  drawing colour) is no longer used for anchors. */
function Handles(props: { pts: Pt[]; color: string; squares?: readonly number[] }) {
  const ctx = useContext(AnchorCtx);
  const sw = () => (ctx.selected() ? 2 : 1);
  return (
    <For each={props.pts}>
      {(p, i) => {
        // One-axis anchors (`square: true`) are rounded squares: side
        // 2·radius − stroke, corner radius 3; hover ring side 2·radius + 3.
        const square = () => !!props.squares?.includes(i());
        return (
          <g class="drawing-handle" style={{ cursor: anchorCursor(p, props.pts) }}>
            {/* hovered-anchor ring (20%-alpha halo) — shown via CSS :hover */}
            <Show
              when={square()}
              fallback={<circle class="drawing-handle-ring" cx={p.x} cy={p.y} r={HANDLE_RADIUS + 1.5} fill="none" stroke={ANCHOR_COLOR} stroke-opacity={0.2} stroke-width={3} pointer-events="none" />}
            >
              <rect class="drawing-handle-ring" x={p.x - HANDLE_RADIUS - 1.5} y={p.y - HANDLE_RADIUS - 1.5} width={2 * HANDLE_RADIUS + 3} height={2 * HANDLE_RADIUS + 3} rx={4.5} fill="none" stroke={ANCHOR_COLOR} stroke-opacity={0.2} stroke-width={3} pointer-events="none" />
            </Show>
            <Show
              when={square()}
              fallback={<circle cx={p.x} cy={p.y} r={HANDLE_RADIUS - sw() / 2} fill={ctx.fillAt(p.y)} stroke={ANCHOR_COLOR} stroke-width={sw()} />}
            >
              <rect x={p.x - HANDLE_RADIUS + sw() / 2} y={p.y - HANDLE_RADIUS + sw() / 2} width={2 * HANDLE_RADIUS - sw()} height={2 * HANDLE_RADIUS - sw()} rx={3} fill={ctx.fillAt(p.y)} stroke={ANCHOR_COLOR} stroke-width={sw()} />
            </Show>
          </g>
        );
      }}
    </For>
  );
}

/** Locked-selection anchors: padlocks on the anchor points in place of
 *  the grab handles (core sceneLockedAnchors); no resize cursors — the body
 *  keeps `default`. */
function renderLockedAnchors(pts: Pt[], color: string) {
  return sceneSvg(sceneLockedAnchors(pts, color), Handles, color);
}


/** Time-axis label of a vertical line / cross line (`showTime`): the
 *  crosshair label in the line colour. Time axis view renderer (the same as
 *  the lightweight-charts crosshair label): chart date-time text, axis font,
 *  padding 9·fs/12, height 1 + 5 + fs/4 + fs + fs/4 from the axis top, bottom
 *  corners radius 2, kept inside the axis width. */
function TimeAxisLabel(props: { x: number; h: number; time: import("lightweight-charts").Time; color: string; coords: Coords | null }) {
  const geo = () => {
    const c = props.coords;
    if (!c) return null;
    const ax = c.timeAxis();
    const text = c.formatTime(props.time);
    const fs = ax.fontSize;
    const padH = (9 * fs) / 12;
    const lw = Math.round(measureTextFont(text, fs, ax.fontFamily)) + 2 * padH;
    let cx = props.x;
    let x1 = Math.floor(cx - lw / 2) + 0.5;
    if (x1 < 0) {
      cx += -x1;
      x1 = Math.floor(cx - lw / 2) + 0.5;
    } else if (x1 + lw > ax.width) {
      cx -= x1 + lw - ax.width;
      x1 = Math.floor(cx - lw / 2) + 0.5;
    }
    const top = props.h; // pane height = the time axis top
    const y2 = top + Math.ceil(1 + 5 + fs / 4 + fs + fs / 4);
    const x2 = x1 + lw;
    const r = 2;
    const path = `M ${x1} ${top} V ${y2 - r} Q ${x1} ${y2} ${x1 + r} ${y2} H ${x2 - r} Q ${x2} ${y2} ${x2} ${y2 - r} V ${top} Z`;
    return { path, text, fs, font: ax.fontFamily, tx: x1 + padH, ty: top + 1 + 5 + fs / 4 + fs / 2 };
  };
  return (
    <Show when={geo()}>
      {(g) => (
        <g pointer-events="none">
          <path d={g().path} fill={props.color} />
          <text x={g().tx} y={g().ty} font-size={String(g().fs)} font-family={g().font} fill={textOnColor(props.color)} dominant-baseline="central" style={{ "white-space": "pre" }}>
            {g().text}
          </text>
        </g>
      )}
    </Show>
  );
}

// ── Per-level model helpers (fib/gann/pitchfork families) ───────────────────
// The level ladder lives on the style (`s.levels`); a kind's factory set from
// specs.ts is the fallback for drawings saved before the model existed.

/** The style's visible levels (or the kind's factory set), coeff-ascending. */

/** Fib time zone (line-tool-fib-timezone): one vertical line per
 *  visible level at p0 + coeff × the p0→p1 distance (11 Fibonacci-sequence
 *  coefficients), per-level colour/width/style, coeff labels at the foot,
 *  fills between adjacent lines (default off) and a dashed gray connector
 *  between the two anchors. */

/* ---------- fib-fan / cycle / curve family (ported from mock kinds/*) ----------
 * These mirror the reference mock's per-kind renderers (window/drawings/kinds/*.tsx);
 * geometry + level palette are lifted verbatim, adapted to our render-fn signature. */

/** Table (scene/text-tools sceneTable) with the host's interaction: the
 *  hovered resize edge (active edge from the last hit test, selected only)
 *  and its cursor. */
function TableView(props: { d: Drawing; p: Pt; active: boolean }) {
  const ctx = useContext(AnchorCtx);
  const l = (): TableLayout => tableLayout(props.d, props.p);
  const ui = () => {
    const u = tableUi();
    return u && u.id === props.d.id && ctx.selected() ? u : null;
  };
  const edgeCursor = () => {
    const e = ui()?.edge;
    if (!e) return undefined;
    return e.col != null && e.row != null ? "default" : e.col != null ? "ew-resize" : "ns-resize";
  };
  const onMove = (e: PointerEvent) => {
    const id = props.d.id;
    const svgEl = (e.currentTarget as SVGElement).ownerSVGElement;
    let edge = null as ReturnType<typeof edgeOf>;
    if (svgEl && ctx.selected()) {
      const r = svgEl.getBoundingClientRect();
      const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
      const onAnchor = tableAnchors(l()).some((q) => Math.hypot(q.x - cur.x, q.y - cur.y) <= HANDLE_RADIUS + HIT_TOLERANCE);
      edge = onAnchor ? null : edgeOf(tableHitCell(l(), cur, true));
    }
    setEdge(id, edge);
  };
  return (
    <g style={{ cursor: edgeCursor() }} onPointerMove={onMove} onPointerLeave={() => setEdge(props.d.id, null)}>
      {sceneSvg(sceneTable(props.d, props.p, props.active, ui()), Handles, props.d.style.color)}
    </g>
  );
}
function edgeOf(h: ReturnType<typeof tableHitCell>) {
  return h && "edge" in h ? h.edge : null;
}
function setEdge(id: string, edge: ReturnType<typeof edgeOf>) {
  const u = tableUi();
  const cur = u && u.id === id ? u.edge : null;
  if ((cur?.row ?? -1) === (edge?.row ?? -1) && (cur?.col ?? -1) === (edge?.col ?? -1)) return;
  setTableUi(u && u.id === id ? { ...u, edge } : { id, cell: null, editing: false, edge });
}

function ImageView(props: { d: Drawing; p: Pt; active: boolean }) {
  return (
    <>
      {(() => {
        void imagesVersion();
        return sceneSvg(sceneImage(props.d, props.p, props.active), Handles, props.d.style.color);
      })()}
    </>
  );
}

function TextToolView(props: { d: Drawing; p: Pt; hovered: boolean }) {
  const ctx = useContext(AnchorCtx);
  return <>{sceneSvg(sceneTextTool(props.d, props.p, ctx.selected(), props.hovered), Handles, props.d.style.color)}</>;
}

/** Andrews pitchfork: median line (handle → midpoint of the prongs) plus two
 *  parallel lines through each prong, all extended forward. */

