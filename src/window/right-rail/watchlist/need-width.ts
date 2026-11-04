/*
 * The width the watchlist's table needs to show every column it has on (the Symbol column's minimum, each data
 * column, the gaps, the paddings and the list's scrollbar). The right panel opens at least that wide while it
 * shows the watchlist, so the table never scrolls sideways; 0 in the tile view.
 */
import { createRoot, createSignal } from "solid-js";

/** Row grid: 4 px between cells, 12 px right of the header's last cell (the rows: 8 px). */
const GAP = 4;
const RIGHT_PAD = 12;
/** The list's vertical scrollbar when it shows. */
const SCROLLBAR = 5;

/** Width of the table for these column widths (Symbol minimum first). */
export function tableWidth(symbolW: number, columnWidths: number[]): number {
  return symbolW + columnWidths.reduce((s, w) => s + w, 0) + GAP * columnWidths.length + RIGHT_PAD + SCROLLBAR;
}

const state = createRoot(() => {
  const [need, setNeed] = createSignal(0);
  return { need, setNeed };
});

/** What the watchlist table needs (0: nothing asked). */
export const watchlistNeed = state.need;
export const setWatchlistNeed = state.setNeed;
