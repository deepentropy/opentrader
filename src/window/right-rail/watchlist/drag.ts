/*
 * Watchlist drag and drop: rows and section headers (the selection, or the
 * dragged item alone) moved inside the list, the insertion line, and the drag
 * image that follows the pointer.
 */
import { createSignal, onCleanup } from "solid-js";
import { watchlistStore, canMoveItems, isSectionId, sectionNameOf } from "../../../data/watchlist-store";
import { type WatchlistCx } from "./context";
import type { Accessor } from "solid-js";

/** What createDrag adds to the watchlist context. */
export interface DragApi {
  dragAt: Accessor<{ x: number; y: number } | null>;
  dragIds: Accessor<string[]>;
  dropAfter: (id: string) => boolean;
  dropBefore: (id: string) => boolean;
  isDragging: (id: string) => boolean;
  onItemDragStart: (e: DragEvent, id: string) => void;
  onRowsDragEnd: () => void;
  onRowsDragOver: (e: DragEvent) => void;
  onRowsDrop: (e: DragEvent) => void;
}

export function createDrag(cx: WatchlistCx): DragApi {
  const { collapsed, inListOrder, selectOnly, selectedIds, selection, shown } = cx;
  // ── Drag-and-drop reorder ── rows and section headers are dragged. A drag
  // that starts on a selected item moves the whole selection, in its order on
  // screen; on any other item it moves that item alone (and selects it). A
  // section header moves alone, so the rows around it change section; a
  // collapsed section moves with its rows and only lands on a section
  // boundary (`canMoveItems`). A sorted list is dragged like any other: the
  // move ends the sort and the order on screen is the list's order. `dragIds`
  // are the items in flight; `dropTarget` is the item the insertion line sits
  // on, before or after it.
  const [dragIds, setDragIds] = createSignal<string[]>([]);
  const [dropTarget, setDropTarget] = createSignal<{ id: string; after: boolean } | null>(null);
  // The drag image: one line per item in flight, its top-left corner at the
  // pointer. It replaces the browser's own image (the row under the pointer).
  const [dragAt, setDragAt] = createSignal<{ x: number; y: number } | null>(null);
  const noDragImage = new Image();
  noDragImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const trackDrag = (e: DragEvent) => setDragAt({ x: e.clientX, y: e.clientY });
  const endDrag = () => {
    document.removeEventListener("dragover", trackDrag);
    setDragIds([]);
    setDropTarget(null);
    setDragAt(null);
  };
  onCleanup(() => document.removeEventListener("dragover", trackDrag));

  const onItemDragStart = (e: DragEvent, id: string) => {
    if (!selectedIds().has(id)) selectOnly(id);
    setDragIds(inListOrder(selection()));
    setDragAt({ x: e.clientX, y: e.clientY });
    document.addEventListener("dragover", trackDrag);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", isSectionId(id) ? sectionNameOf(id) : id);
      e.dataTransfer.setDragImage(noDragImage, 0, 0);
    }
  };
  // Container-level drag-over: the WHOLE list is a drop zone, so the no-drop
  // cursor never shows over gaps/padding. The target is the item under the
  // pointer (the closest one over a gap), before it in its top half, after it
  // in its bottom half. No line over a dragged item; a place the dragged items
  // cannot take keeps the last valid line.
  const onRowsDragOver = (e: DragEvent) => {
    const ids = dragIds();
    if (!ids.length) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const container = e.currentTarget as HTMLElement;
    let el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-item-id]") ?? null;
    if (!el) {
      let bestDist = Infinity;
      for (const c of container.querySelectorAll<HTMLElement>("[data-item-id]")) {
        const rect = c.getBoundingClientRect();
        const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
        if (dist >= bestDist) continue;
        bestDist = dist;
        el = c;
      }
    }
    const id = el?.dataset.itemId;
    if (!el || !id) return;
    if (ids.includes(id)) {
      setDropTarget(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const after = e.clientY >= rect.top + rect.height / 2;
    if (canMoveItems(shown(), collapsed(), ids, id, after)) setDropTarget({ id, after });
  };
  const onRowsDrop = (e: DragEvent) => {
    const ids = dragIds();
    const t = dropTarget();
    if (ids.length && t) {
      e.preventDefault();
      watchlistStore.moveItems(ids, t.id, t.after, collapsed());
    }
    endDrag();
  };
  const onRowsDragEnd = () => endDrag();
  const isDragging = (id: string) => dragIds().includes(id);
  // Insertion line above (`drop-before`) or below (`drop-after`) an item.
  const dropBefore = (id: string) => {
    const t = dropTarget();
    return !!t && t.id === id && !t.after;
  };
  const dropAfter = (id: string) => {
    const t = dropTarget();
    return !!t && t.id === id && t.after;
  };

  return { dragAt, dragIds, dropAfter, dropBefore, isDragging, onItemDragStart, onRowsDragEnd, onRowsDragOver, onRowsDrop };
}
