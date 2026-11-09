/*
 * What opens the symbol search: the plain search, the watchlist "Add symbol" mode or the "Compare symbols" mode.
 */
import type { ComparePlacement } from "../../shell/tabs";

export type SymbolSearchProps = {
  /** Full symbol-name (e.g. "NASDAQ:INTC") of the currently-active chart. */
  activeSymbol?: string;
  /** When the dialog is opened by typing a character with no field focused,
   *  the query is seeded with that character instead of the active ticker. */
  seedQuery?: string | null;
  onSelect: (symbolName: string) => void;
  onClose: () => void;
  /** Watchlist "Add symbol" mode. The query starts empty; a click or
   *  Enter adds the row (or removes it when it is already in the list) and
   *  keeps the dialog open; with Shift it also closes. Each row gets the
   *  action buttons: + (add), or trash (remove) + target (go to symbol). */
  watchlist?: {
    has: (symbolName: string) => boolean;
    add: (symbolName: string) => void;
    /** Comma mode: add every typed name at once (bare or "EXCHANGE:TICKER"). */
    addMany: (names: string[]) => void;
    remove: (symbolName: string) => void;
    goTo: (symbolName: string) => void;
  };
  /** "Compare symbols" mode. Empty query: ADDED SYMBOLS (check box
   *  removes) then RECENT SYMBOLS; a query shows the category tabs and the
   *  results. A row click adds the symbol on the same % scale; the row's
   *  hover buttons pick the placement. The dialog stays open and the query
   *  clears after an add. */
  compare?: {
    added: () => { id: string; symbol: string; description?: string }[];
    /** Recently used symbols, most recent first. */
    recent: () => { symbol: string; description?: string }[];
    add: (symbolName: string, placement: ComparePlacement) => void;
    remove: (id: string) => void;
  };
};
