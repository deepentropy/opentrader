/*
 * Watchlist keyboard: the focusable list (its element), symbol navigation
 * (arrows, Space, the app's "watchlist-navigate" event), the selection keys
 * and the row click that loads a symbol.
 */
import { onCleanup, onMount } from "solid-js";
import { listItems } from "../../../data/watchlist-store";
import { onAppEvent } from "../../../data/app-events";
import { type WatchlistCx } from "./context";

/** What createKeyboard adds to the watchlist context. */
export interface KeyboardApi {
  onListKeyDown: (e: KeyboardEvent) => void;
  rowsEl: HTMLDivElement | undefined;
  selectRow: (ticker: string) => void;
}

export function createKeyboard(cx: WatchlistCx): KeyboardApi {
  const { active, chartRow, extendSelection, extras, groups, isCollapsed, isSelected, props, removeSelection, selectOnly, setSelection } = cx;
  // ── Keyboard navigation (ported from the reference mock) ──
  // When the list is focused: ↓ / Space load the next symbol, ↑ / Shift+Space
  // the previous one. Navigation is relative to the currently-loaded symbol and
  // runs over the *visible* rows (collapsed sections skipped) in display order.
  // The list container is made focusable (tabIndex=0) and a row click focuses
  // it so Space is delivered here next.
  let rowsEl: HTMLDivElement | undefined;
  // Nav order = rows of expanded sections, flattened in display order.
  const orderedRows = () =>
    extras().concat(
      groups()
        .filter((g) => !isCollapsed(g.name))
        .flatMap((g) => g.rows),
    );
  const navigate = (dir: 1 | -1) => {
    const rows = orderedRows();
    if (!props.onSymbolSelect || rows.length === 0) return;
    let cur = rows.findIndex((r) => isSelected(r));
    // No row selected (a section header is): go from the charted symbol.
    if (cur < 0) cur = rows.findIndex((r) => r.ticker === chartRow());
    // No current selection in the list → enter at the appropriate end.
    const next =
      cur < 0
        ? dir === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, cur + dir));
    if (next !== cur) props.onSymbolSelect(rows[next].ticker);
  };
  // App dispatches this when Space / Shift+Space is pressed while focus is on the
  // chart (not the list), so the watchlist still flips to the next/prev symbol.
  onMount(() => {
    onCleanup(onAppEvent("watchlist-navigate", (d) => navigate(d?.dir === -1 ? -1 : 1)));
  });
  const onListKeyDown = (e: KeyboardEvent) => {
    // While renaming a section (its input sits inside the keydown-bearing
    // `.watchlist-rows` grid) the nav keys must yield to the field — otherwise
    // Space / arrows scrub symbols mid-rename instead of editing the text.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const isSpace = e.code === "Space" || e.key === " ";
    if (e.shiftKey && (e.code === "ArrowDown" || e.code === "ArrowUp")) {
      e.preventDefault();
      extendSelection(e.code === "ArrowDown" ? 1 : -1);
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyA") {
      e.preventDefault();
      const a = active();
      if (a) setSelection(listItems(a));
    } else if (e.key === "Escape") {
      // Back to the charted symbol's row.
      e.preventDefault();
      selectOnly(chartRow());
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      removeSelection();
    } else if (e.code === "ArrowDown" || (isSpace && !e.shiftKey)) {
      e.preventDefault();
      navigate(1);
    } else if (e.code === "ArrowUp" || (isSpace && e.shiftKey)) {
      e.preventDefault();
      navigate(-1);
    } else if (e.altKey && e.key === "Enter") {
      // Alt+↵ flags/unflags the selected symbols. The bottom bar's maximize
      // (also Alt+↵) defers to the list whenever `.watchlist-rows` holds focus —
      // a Solid-delegated handler here can't cancel its sibling document
      // listener, so the deferral lives there, not in a useless stopPropagation.
      const rows = cx.selectedRows();
      if (rows.length) {
        e.preventDefault();
        cx.toggleFlags(rows);
      }
    }
  };
  // Select a row's symbol AND focus the list so Space / arrows flip next.
  const selectRow = (ticker: string) => {
    selectOnly(ticker); // optimistic: highlight immediately, even for
                        // watchlist-only symbols absent from the chart set
    props.onSymbolSelect?.(ticker);
    rowsEl?.focus();
  };

  return {
    onListKeyDown,
    get rowsEl() { return rowsEl; }, set rowsEl(v: HTMLDivElement | undefined) { rowsEl = v; },
    selectRow,
  };
}
