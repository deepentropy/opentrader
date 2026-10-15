/*
 * Window-wide events of the drawings overlay (set up on mount): the overlay
 * size, Escape / Delete / Ctrl+C, paste, the arrow-key nudge, click-outside
 * deselect, the place-at-cursor hotkeys and the held magnet modifiers.
 */
import { onCleanup, onMount } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { emitAppEvent, onAppEvent, type PlaceAtCursorDetail } from "../../../data/app-events";
import { screenPoints, translateDrawing } from "lightweight-charts-drawing/core/interact/project";
import { buildNewDrawing } from "lightweight-charts-drawing/core/interact/placement";
import { IMAGE_TYPES } from "lightweight-charts-drawing/core/kinds/images";
import { clipboardSource, copyDrawing, DRAWING_CLIP_MARK, pasteAsNew, SOURCE_CLIP_MARK } from "../clipboard";
import { lastPointer } from "./helpers";
import { type OverlayCx } from "./context";
import { contextMenuOpen } from "../../chart/menu-escape";

/** Window event sent by the drawing-toolbar hotkeys Alt+H / J / V / C. The pane
 *  under the pointer creates the drawing there and sets `handled`; when no pane
 *  claims it the toolbar arms the tool instead. */
export const PLACE_AT_CURSOR_EVENT = "drawing-place-at-cursor" as const;

/** What createWindowEvents adds to the overlay context (nothing: it only
 *  listens). */
export type WindowEventsApi = Record<never, never>;

export function createWindowEvents(cx: OverlayCx): WindowEventsApi {
  const { intervalHidden, pending, props, setCtrlDown, setCursor, setPending, setShiftDown } = cx;
  onMount(() => {
    cx.refreshSize();
    const ro = new ResizeObserver(() => cx.refreshSize());
    if (cx.svg.parentElement) ro.observe(cx.svg.parentElement);
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
        } else if (cx.measureStart()) {
          // Cancel a half-placed two-click measure without disarming the tool.
          cx.setMeasureStart(null);
          cx.setRegion(null);
        } else if (props.armedTool) {
          props.onDisarm();
        } else if (cx.measureResult()) {
          cx.setMeasureResult(null);
        } else if (props.selectedId && !contextMenuOpen()) {
          // The Escape that closes the drawing's menu keeps it selected.
          props.setSelectedId(null);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (cx.removeDrawings(cx.selIds())) e.preventDefault();
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
    // otherwise the in-app clipboard is used (a copied study / compared
    // symbol is added to the chart). Only the focused pane pastes.
    const onPaste = (e: ClipboardEvent) => {
      if (props.shown === false) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]') || props.active === false) return;
      const dt = e.clipboardData;
      const html = dt ? dt.getData("text/html") : "";
      const fromHere = html.includes(DRAWING_CLIP_MARK) || html.includes(SOURCE_CLIP_MARK);
      const file = !fromHere && dt ? Array.from(dt.files).find((f) => IMAGE_TYPES[f.type]) : undefined;
      if (file) {
        e.preventDefault();
        void cx.pasteImage(file);
        return;
      }
      const nd = pasteAsNew();
      if (nd) {
        e.preventDefault();
        const id = props.onPlace(nd);
        if (id) props.setSelectedId(id); // select the paste so it's grab-ready
      } else if (clipboardSource()) {
        e.preventDefault();
        emitAppEvent("chart-paste-source");
      }
    };
    document.addEventListener("paste", onPaste);
    onCleanup(() => document.removeEventListener("paste", onPaste));

    // Arrow-key nudge of the selected drawing (←↑→↓ move it 1px). App owns
    // the selection + arrow keys and broadcasts the screen delta; only the
    // focused pane applies it (props.active), so a drawing shown on several
    // panes moves exactly once. Mirrors the body-drag translate: project every
    // point, shift by (dx, dy) px, unproject. Skips locked drawings.
    const onNudge = (d: { dx: number; dy: number }) => {
      if (props.shown === false || !props.active || cx.selIds().length === 0) return;
      const { dx, dy } = d;
      // Every movable selected drawing nudges together (multi-select).
      const moved: Drawing[] = [];
      for (const id of cx.selIds()) {
        const target = props.drawings.find((d) => d.id === id);
        if (!target || target.locked || intervalHidden(target)) continue;
        const f = cx.drawFrame(target);
        if (!f) continue;
        const screen = screenPoints(f.coords, target, f.dims);
        if (!screen) continue;
        const nd = translateDrawing(f.coords, target, screen, dx, dy, f.dims);
        if (nd) moved.push(nd);
      }
      if (moved.length > 1 && props.onUpdateMany) props.onUpdateMany(moved);
      else moved.forEach((d) => props.onUpdate(d));
    };
    onCleanup(onAppEvent("drawing-nudge", onNudge));

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
      ".dt-popover", // colour / width / style / template popovers
      ".dt-color-field-portal", // portalled colour field
      ".drawing-toolbar", // the left drawing toolbar
      ".ot-table-cell-input", // the table cell editor
      ".ot-dlg-layer", // name / confirm dialogs (template save, delete)
      ".object-tree-panel", // the Object tree (shares the selection)
      ".ot-chart-ctx-menu", // its right-click / More menus
    ].join(",");
    const onOutsideDown = (e: PointerEvent) => {
      if (props.shown === false || cx.selIds().length === 0) return;
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
    const onPlaceAtCursor = (detail: PlaceAtCursorDetail) => {
      if (props.shown === false || !detail || detail.handled || !lastPointer) return;
      const r = cx.svg.getBoundingClientRect();
      const x = lastPointer.x - r.left;
      const y = lastPointer.y - r.top;
      if (r.width <= 0 || x < 0 || y < 0 || x > r.width || y > r.height) return;
      const f = cx.frameAt({ x, y });
      if (!f) return;
      const dp = cx.dataAt(cx.toLocal({ x, y }, f), f);
      if (!dp) return;
      const placed = buildNewDrawing(detail.kind, [dp]);
      if (!placed) return;
      detail.handled = true;
      setPending([]);
      setCursor(null);
      const id = props.onPlace({ ...placed, ...cx.ownerOf(f) });
      if (id) props.setSelectedId(id);
    };
    onCleanup(onAppEvent(PLACE_AT_CURSOR_EVENT, onPlaceAtCursor));

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

  return {};
}
