/*
 * Placement of a new drawing in the overlay: the pane of the placement, the
 * magnet (with its Shift / Ctrl overrides), click / freehand / variable-length
 * placement, and the live preview with its crosshair.
 */
import { createSignal, Show } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { FREEHAND_SAMPLE_PX, MIN_DISTANCE_BETWEEN_POINTS } from "lightweight-charts-drawing/core/interact/constants";
import { magnetSnap, projectAll, projectPoint, unproject } from "lightweight-charts-drawing/core/interact/project";
import { shiftPlacementPoint } from "lightweight-charts-drawing/core/interact/shift";
import { buildNewDrawing, finishPlacement, SEGMENT_PREVIEW_KINDS, snapGannSquare } from "lightweight-charts-drawing/core/interact/placement";
import { hintState, lineToolHint, PATH_HINT, POLYLINE_HINT, setLineToolHint } from "../../../data/hints";
import { eventPoint } from "./helpers";
import { renderKind } from "./render";
import { type Frame, type OverlayCx } from "./context";

/** Fallback stroke for the rubber-band placement preview (no drawing yet). */
const PREVIEW_STROKE = "#2962ff";

/** What createPlacement adds to the overlay context. */
export interface PlacementApi {
  aimAt: (cur: Pt, f?: Frame | null) => { pt: Pt; engaged: boolean };
  crosshairElement: () => import("solid-js").JSX.Element;
  dataAt: (p: Pt, f: Frame) => DataPoint | null;
  effectiveMagnet: () => { enabled: boolean; mode: "weak" | "strong" };
  finalizeVariableLength: (closed?: boolean) => boolean;
  onPlacementClick: (e: PointerEvent) => void;
  ownerOf: (f: Frame) => { owner?: string };
  placeFrame: (p: Pt | null) => Frame | null;
  placeKey: Accessor<string | null>;
  placeNew: (nd: import("lightweight-charts-drawing/core/types").NewDrawing, f: Frame) => void;
  previewElement: () => import("solid-js").JSX.Element;
  setPlaceKey: Setter<string | null>;
  snapIn: (f: Frame, dp: DataPoint, mode: "weak" | "strong") => DataPoint | null;
  startFreehand: (e: PointerEvent) => void;
}

export function createPlacement(cx: OverlayCx): PlacementApi {
  const { armedSpec, ctrlDown, cursor, drag, pending, props, setCursor, setPending, shiftDown } = cx;
  /** Owner of the placement in progress (the pane of its first point). */
  const [placeKey, setPlaceKey] = createSignal<string | null>(null);
  /** Pane of a placement: the locked pane once a point is down, else the
   *  pane under the pointer. */
  const placeFrame = (p: Pt | null): Frame | null =>
    pending().length > 0 ? cx.frameByKey(placeKey()) : p ? cx.frameAt(p) : null;
  /** Owner field of a new drawing placed in `f`. */
  const ownerOf = (f: Frame): { owner?: string } => (f.key ? { owner: f.key } : {});

  /** Magnet snap in frame `f`: OHLC in the main pane; in a study pane only
   *  the pane's study values, with "Snap to indicator" on. */
  function snapIn(f: Frame, dp: DataPoint, mode: "weak" | "strong"): DataPoint | null {
    return magnetSnap(dp, f.coords, mode, !!props.magnetSnapsToIndicators, f.key === null);
  }

  /** Data point at frame-local point `p` of frame `f` (magnet applied). */
  function dataAt(p: Pt, f: Frame): DataPoint | null {
    const dp = unproject(f.coords, p);
    if (!dp) return null;
    const m = effectiveMagnet();
    return m.enabled ? snapIn(f, dp, m.mode) ?? dp : dp;
  }

  /** Screen point the placement preview/crosshair should track: the raw cursor,
   *  or — when the magnet engages — the snapped OHLC point projected back to
   *  screen (so the rubber-band locks onto the candle, x and y). Reads
   *  the modifier signals so it updates live when Shift/Ctrl change with a
   *  stationary cursor. Returns null alongside `engaged=false` when the magnet
   *  doesn't catch, so the caller keeps the free cursor. */
  function aimAt(cur: Pt, f: Frame | null = cx.mainFrame()): { pt: Pt; engaged: boolean } {
    if (!f) return { pt: cur, engaged: false };
    const c = f.coords;
    const m = effectiveMagnet();
    if (!m.enabled) return { pt: cur, engaged: false };
    const dp = unproject(c, cur);
    if (!dp) return { pt: cur, engaged: false };
    const snapped = snapIn(f, dp, m.mode);
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
    const spG = eventPoint(cx.svg, e);
    const pend = pending();
    // The placement stays in the pane of its first click; later clicks are
    // kept inside that pane.
    const f = placeFrame(spG);
    if (!f) return;
    if (pend.length === 0) setPlaceKey(f.key);
    const sp = cx.toLocalClamped(spG, f);
    // Variable-length finish gesture (polyline / path): a click within the
    // vertex tolerance of the LAST placed point commits the drawing instead of
    // appending; polyline ALSO commits on the FIRST point (closing the shape,
    // `filled` is set there). Path only finishes on the last point.
    // Double-click keeps working (on:dblclick). The tolerance is the minimum
    // distance between points = 5px with a mouse (10px on touch).
    if (spec.variableLength && pend.length >= 1) {
      const nearVertex = (v: DataPoint) => {
        const p = projectPoint(f.coords, v);
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
    const dp0 = dataAt(sp, f);
    if (!dp0) return;
    // Shift: the per-tool placement rule (lib interact/shift: 45° against
    // the previous point, square, Gann fixed increments; the ellipse ends as a
    // circle on its 2nd click).
    const sh = shiftDown() ? shiftPlacementPoint(spec.kind, pend, dp0, f.coords) : { point: dp0 };
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
      cx.holdTextFocus = true;
      window.addEventListener("pointerup", () => {
        setTimeout(() => {
          cx.holdTextFocus = false;
          cx.textInput?.focus();
          cx.textInput?.select();
        }, 0);
      }, { once: true, capture: true });
      cx.setTextEdit({ mode: "create", kind: spec.kind, points: next, pos: spG, value: "", frameKey: f.key });
      setPending([]);
      setCursor(null);
      return;
    }
    // Finalize (fixed-length): the core adds the data computed at
    // placement; font-icon placements carry the staged glyph.
    const placed = finishPlacement(spec.kind, next, f.coords, f.dims, { glyph: props.armedGlyph });
    if (placed) placeNew(placed, f);
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
    const spG = eventPoint(cx.svg, e);
    const f = cx.frameAt(spG);
    if (!f) return;
    e.stopPropagation();
    const sp0 = cx.toLocal(spG, f);
    const dp0 = unproject(f.coords, sp0);
    if (!dp0) return;
    setPlaceKey(f.key);
    setPending([dp0]);
    setCursor(spG);
    let last = sp0;
    const onDocMove = (ev: PointerEvent) => {
      const curG = eventPoint(cx.svg, ev);
      setCursor(curG);
      const cur = cx.toLocalClamped(curG, f);
      if (Math.hypot(cur.x - last.x, cur.y - last.y) < FREEHAND_SAMPLE_PX) return;
      const dp = unproject(f.coords, cur);
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
        if (placed) placeNew(placed, f);
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
    const f = cx.frameByKey(placeKey());
    if (pts.length < 2 || !f) return false;
    // The core stores polyline `closed` and freezes the ghost-feed seed.
    const placed = finishPlacement(spec.kind, pts, f.coords, f.dims, { closed });
    if (placed) placeNew(placed, f);
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
  function placeNew(nd: import("lightweight-charts-drawing/core/types").NewDrawing, f: Frame) {
    const id = props.onPlace({ ...nd, ...ownerOf(f) });
    if (id && !props.stayMode) props.setSelectedId(id);
  }

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

  // Live preview while placing. The *real* tool is drawn as you aim, not a
  // placeholder rubber-band: the in-progress draw renders exactly like the
  // finished one — solid stroke, a ray already extends to the pane edge, a
  // rectangle shows its fill.
  function previewElement(): import("solid-js").JSX.Element {
    const p = pending();
    const rawG = cursor();
    const spec = armedSpec();
    const f = cx.frameByKey(placeKey());
    if (!spec || p.length === 0 || !rawG || !f) return null;
    const coords = f.coords;
    // In the pane of the first point, the cursor kept inside it.
    const rawCur = cx.toLocalClamped(rawG, f);
    // Re-project the already-placed anchors on every pan/zoom (coordEpoch bumps),
    // so a committed first point tracks its price/time as the chart scrolls
    // instead of sticking to its old screen position.
    void props.coordEpoch;
    const { w, h } = f.dims;
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
    const aim = aimAt(rawCur, f);
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
      const cur0 = dataAt(cur, f);
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

  /** Placement crosshair — while a tool is armed the overlay captures the pane,
   *  so lightweight-charts' own crosshair can't track the cursor; we draw it
   *  here (full-pane dashed lines + a magnet dot when snapped). Mirrors the
   *  mock's `.drawing-crosshair-line` (stroke #9598a1, 1px, 6/6 dash). */
  function crosshairElement(): import("solid-js").JSX.Element {
    if (!armedSpec()) return null;
    const rawG = cursor();
    if (!rawG) return null;
    // The vertical line runs through every pane; the horizontal one stays in
    // the placement pane (the cursor kept inside it once a point is down).
    const f = placeFrame(rawG);
    if (!f) return null;
    const { w, h } = cx.chartDims();
    const rawCur = cx.toLocalClamped(rawG, f);
    const aim = aimAt(rawCur, f);
    // Magnet pulls ONLY the horizontal (price) line to the nearest OHLC level.
    // The vertical (time) line stays on the raw cursor, and no snap dot is
    // drawn — the crosshair always reads as a full cross, never collapsing to
    // a point.
    const yLine = f.top + (aim.engaged ? aim.pt.y : rawCur.y);
    return (
      <g pointer-events="none">
        <line x1={rawCur.x} y1={0} x2={rawCur.x} y2={h} stroke="#9598a1" stroke-width={1} stroke-dasharray="6 6" />
        <line x1={0} y1={yLine} x2={w} y2={yLine} stroke="#9598a1" stroke-width={1} stroke-dasharray="6 6" />
      </g>
    );
  }

  return {
    aimAt,
    crosshairElement,
    dataAt,
    effectiveMagnet,
    finalizeVariableLength,
    onPlacementClick,
    ownerOf,
    placeFrame,
    placeKey,
    placeNew,
    previewElement,
    setPlaceKey,
    snapIn,
    startFreehand,
  };
}
