/*
 * Pointer interaction with placed drawings: the topmost hit test, the
 * selection (click, Ctrl / Cmd toggle, middle-click removal), body / anchor /
 * group drags, the eraser, the pointer move of the armed overlay and the
 * drawing context menu.
 */
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import type { HitResult, Pt } from "lightweight-charts-drawing/core/_shared";
import { suspendDrawingPersist, resumeDrawingPersist } from "../persistence";
import { emitAppEvent } from "../../../data/app-events";
import { hitTestKind } from "lightweight-charts-drawing/core/kinds/hit-tests";
import { DRAG_THRESHOLD } from "lightweight-charts-drawing/core/interact/constants";
import { screenPoints, translateDrawing } from "lightweight-charts-drawing/core/interact/project";
import { lockAxisDelta } from "lightweight-charts-drawing/core/interact/shift";
import { applyDrag } from "lightweight-charts-drawing/core/interact/drag";
import { setTableUi } from "../table-ui";
import { eventPoint } from "./helpers";
import { type Frame, type OverlayCx } from "./context";

/** What createSelection adds to the overlay context. */
export interface SelectionApi {
  eraseAt: (e: PointerEvent) => void;
  hitTopmost: (spG: Pt) => { drawing: Drawing; mode: HitResult; pts: Pt[]; frame: Frame } | null;
  onContextMenu: (e: MouseEvent) => void;
  onMove: (e: PointerEvent) => void;
  onSelectionPointerDown: (e: PointerEvent) => void;
  removeDrawings: (ids: string[]) => boolean;
  selIds: () => string[];
}

export function createSelection(cx: OverlayCx): SelectionApi {
  const { armedSpec, cmode, drag, intervalHidden, notShown, props, setCursor, setDrag, setMenu, shiftDown } = cx;

  /** Remove the topmost drawing under the pointer (eraser click + sweep).
   *  Locked drawings are left alone, matching the Delete-key guard. */
  function eraseAt(e: PointerEvent) {
    const sp = eventPoint(cx.svg, e);
    const hit = hitTopmost(sp);
    if (hit && !hit.drawing.locked) props.onRemove(hit.drawing.id);
  }

  /** Topmost-first hit test across every drawing on the chart. Skips
   *  hidden drawings entirely so the cursor passes through to whatever is
   *  underneath (incl. the chart for pan). */
  function hitTopmost(spG: Pt): { drawing: Drawing; mode: HitResult; pts: Pt[]; frame: Frame } | null {
    for (let i = props.drawings.length - 1; i >= 0; i--) {
      const d = props.drawings[i];
      if (notShown(d)) continue;
      // Drawings are clipped to their pane: nothing hits outside it.
      const f = cx.drawFrame(d);
      if (!f) continue;
      const { w, h } = f.dims;
      const sp = cx.toLocal(spG, f);
      if (sp.x < 0 || sp.x > w || sp.y < 0 || sp.y > h) continue;
      const pts = screenPoints(f.coords, d, f.dims);
      if (!pts) continue;
      const r = hitTestKind(d, pts, sp, w, h, f.coords, selIds().includes(d.id));
      if (r) return { drawing: d, mode: r, pts, frame: f };
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
    const spG = eventPoint(cx.svg, e);
    const hit = hitTopmost(spG);
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
    // A right press on a drawing selects it when it is outside the selection and keeps a selection it belongs to
    // (its menu then acts on the whole selection); it never drags.
    if (e.button === 2 && hit) {
      e.stopPropagation();
      if (!selIds().includes(hit.drawing.id)) props.setSelectedId(hit.drawing.id);
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
    // The drag runs in the hit drawing's pane (frame-local points).
    const hf = hit.frame;
    const sp = cx.toLocal(spG, hf);
    /** Pane of each group member (members may sit in different panes). */
    const memberFrames = new Map<string, Frame>();
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
            .map((d) => {
              const mf = cx.drawFrame(d);
              if (mf) memberFrames.set(d.id, mf);
              return { start: d, startScreen: mf ? screenPoints(mf.coords, d, mf.dims) : null };
            })
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
      pane: hf.dims,
    });
    // Defer drawing writes for the duration of the drag: the reactive store
    // still updates every frame (panes mirror the move live), but the JSON
    // serialize + persist happens once on release (see persistence.ts).
    suspendDrawingPersist();
    const onDocMove = (ev: PointerEvent) => {
      const state = drag();
      if (!state) return;
      const cur = cx.toLocal(eventPoint(cx.svg, ev), hf);
      if (!state.active) {
        if (!canDrag) return;
        if (Math.hypot(cur.x - state.startCursor.x, cur.y - state.startCursor.y) < DRAG_THRESHOLD) {
          return;
        }
        // Close any open undo-coalescing window BEFORE the drag's first
        // update: a toolbar style edit within the last 800ms shares the
        // drag's coalesceId and would otherwise merge into one undo entry.
        emitAppEvent("drawing-gesture-end");
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
      const cc = hf.coords;
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
          const mf = memberFrames.get(m.start.id);
          const nd = mf ? translateDrawing(mf.coords, m.start, m.startScreen, dx, dy, mf.dims) : null;
          if (nd) moved.push(nd);
        }
        if (moved.length) {
          if (props.onUpdateMany) props.onUpdateMany(moved);
          else moved.forEach((d) => props.onUpdate(d));
        }
        return;
      }
      const m = cx.effectiveMagnet();
      const snap = m.enabled
        ? (p: DataPoint) => cx.snapIn(hf, p, m.mode) ?? p
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
      emitAppEvent("drawing-gesture-end");
    };
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("pointerup", onDocUp);
  }

  function onMove(e: PointerEvent) {
    const mode = cmode();
    // Eraser sweep — while the button is held, erase whatever the pointer crosses.
    if (mode === "eraser") {
      if (cx.erasing) eraseAt(e);
      return;
    }
    // Measure (two-click): once the first point is down, the rubber-band rect
    // tracks the cursor (magnet-snapped) until the second click commits it.
    if (props.armedTool === "measure" && cx.measureStart()) {
      const f = cx.frameByKey(cx.measureKey());
      if (!f) return;
      const end = cx.measurePoint(e, f);
      cx.setRegion((r) => (r ? { start: r.start, end } : null));
      return;
    }
    // Track the cursor for the whole armed session (even before the first
    // click) so the placement crosshair follows from the moment the tool is
    // armed, not just once an anchor exists.
    if (!armedSpec()) return;
    setCursor(eventPoint(cx.svg, e));
  }

  function onContextMenu(e: MouseEvent) {
    // Only intervene if the right-click landed on a drawing — otherwise
    // we'd swallow the native menu for the rest of the chart.
    const sp = eventPoint(cx.svg, e as unknown as PointerEvent);
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

  return { eraseAt, hitTopmost, onContextMenu, onMove, onSelectionPointerDown, removeDrawings, selIds };
}
