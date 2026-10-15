/*
 * Watchlist table columns: the per-column widths (drag-resizable from the
 * header dividers, persisted), the shared grid template of the header and
 * the rows, and the guide line under a hovered or dragged divider.
 */
import { createSignal, onCleanup } from "solid-js";
import * as kv from "../../../data/kv";
import { COL_WIDTHS_KEY, DEFAULT_COL_W, DEFAULT_SYMBOL_W, MAX_COL_W, MIN_COL_W, SYMBOL_COL_KEY, loadColWidths } from "./prefs";
import { type WatchlistCx } from "./context";
import type { Accessor, JSX } from "solid-js";

/** What createColumns adds to the watchlist context. */
export interface ColumnsApi {
  asideEl: HTMLElement;
  colResizeHandle: (key: string) => JSX.Element;
  gridTemplate: () => string;
  guide: Accessor<{ x: number; top: number } | null>;
  headersEl: HTMLDivElement;
}

export function createColumns(cx: WatchlistCx): ColumnsApi {
  const { visibleCols } = cx;
  // Per-column widths (px), keyed by column key, drag-resizable from the column
  // dividers and persisted. Symbol flexes to fill the slack but has a resizable
  // minimum (so it hugs the left while the data columns hug the right).
  const [colWidths, setColWidths] = createSignal<Record<string, number>>(loadColWidths());
  onCleanup(kv.onExternalChange(COL_WIDTHS_KEY, () => setColWidths(loadColWidths())));
  const symbolW = () => colWidths()[SYMBOL_COL_KEY] ?? DEFAULT_SYMBOL_W;
  const gridTemplate = () =>
    `minmax(${symbolW()}px, 1fr) ${visibleCols().map((c) => `${colWidths()[c.key] ?? DEFAULT_COL_W}px`).join(" ")}`;

  // Root <aside> + column-header refs, and the guide line under a column
  // divider (x = divider centre, top = header bottom, both px from the aside).
  // It is drawn while a divider is hovered or dragged: 2px #132042 (#e3effd
  // light) from the header's bottom to the list's.
  let asideEl!: HTMLElement;
  let headersEl!: HTMLDivElement;
  const [guide, setGuide] = createSignal<{ x: number; top: number } | null>(null);
  let resizing = false;
  const showGuide = (handle: HTMLElement) => {
    const a = asideEl.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    // -1: the guide starts at the bottom of the header cells, over the
    // header's 1px border (separator top = 27 of the 28px strip).
    setGuide({ x: h.left + h.width / 2 - a.left, top: headersEl.getBoundingClientRect().bottom - 1 - a.top });
  };

  /** Drag a column's right-edge divider to resize that column (clamped);
   *  persists on release. The shared grid template repaints both header and
   *  rows; the guide line follows the divider while dragging. */
  function startColResize(e: PointerEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const isSymbol = key === SYMBOL_COL_KEY;
    const startW = colWidths()[key] ?? (isSymbol ? DEFAULT_SYMBOL_W : DEFAULT_COL_W);
    const min = isSymbol ? 60 : MIN_COL_W;
    const max = isSymbol ? MAX_COL_W : MAX_COL_W;
    resizing = true;
    showGuide(handle);
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(min, Math.min(max, startW + (ev.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [key]: w }));
      showGuide(handle);
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      resizing = false;
      // Released over the divider: it is still hovered, keep its guide.
      if (!handle.contains(document.elementFromPoint(ev.clientX, ev.clientY))) setGuide(null);
      try {
        kv.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths()));
      } catch {
        /* best-effort */
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }
  /** Column divider in the header: the resize grab area plus the hover line.
   *  Hidden (CSS) on the last column: there is no divider there, so the
   *  last column is not resizable. */
  const colResizeHandle = (key: string) => (
    <span
      class="watchlist-col-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => startColResize(e, key)}
      onPointerEnter={(e) => {
        if (!resizing) showGuide(e.currentTarget);
      }}
      onPointerLeave={() => {
        if (!resizing) setGuide(null);
      }}
    />
  );

  return {
    get asideEl() { return asideEl; }, set asideEl(v: HTMLElement) { asideEl = v; },
    colResizeHandle,
    gridTemplate,
    guide,
    get headersEl() { return headersEl; }, set headersEl(v: HTMLDivElement) { headersEl = v; },
  };
}
