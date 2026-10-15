/*
 * Shared context of the watchlist panel's parts (watchlist/*.ts). Watchlist
 * owns the active list's accessors, the view prefs and the dialogs; each part
 * is created with this context and adds its own functions to it (attach), so
 * the parts reach each other through it without a creation order. The
 * mutable fields are live accessors of the panel's state.
 */
import type { Accessor, Setter } from "solid-js";
import type { Group, Row, SortKey, WlColumnKey, WlSettings } from "../../../data/watchlist";
import type { AddAnchor, WatchList } from "../../../data/watchlist-store";

import type { ColumnsApi } from "./columns";
import type { CellsApi } from "./cells";
import type { SortApi } from "./sort";
import type { SelectionApi } from "./selection";
import type { SectionsApi } from "./sections";
import type { DragApi } from "./drag";
import type { AddSymbolsApi } from "./add-symbols";
import type { ListActionsApi } from "./list-actions";
import type { KeyboardApi } from "./keyboard";
import type { RowMenusApi } from "./row-menus";
import type { RowsApi } from "./rows";
import type { HeadersApi } from "./headers";

export type WatchlistProps = {
  /** Active chart symbol in full form (e.g. "NASDAQ:TSLA"). May be undefined
   *  for tickers absent from the symbol-search dataset (e.g. watchlist-only
   *  names), which is why `activeTicker` exists for selection. */
  activeSymbol?: string;
  /** Active chart symbol in BARE form (e.g. "TSLA"). The chart symbol after a
   *  row click is always the bare ticker, so this is what reliably matches a
   *  row's `short` for the selection highlight. */
  activeTicker?: string;
  /** Fires with the full ticker ("NASDAQ:INTC") on row click. */
  onSymbolSelect?: (ticker: string) => void;
  /** Row menu "Add … to compare": the symbols join the focused chart as
   *  compared symbols, in this order. */
  onAddCompare?: (tickers: string[]) => void;
  /** Active chart interval (currently unused here; kept for future per-symbol
   *  actions that need it). */
  interval?: string;
};

/** State and functions Watchlist itself owns. */
export interface WatchlistCore {
  props: WatchlistProps;
  active: () => WatchList | undefined;
  addAnchor: Accessor<AddAnchor>;
  allRows: () => Row[];
  extras: () => Row[];
  groups: () => Group[];
  inDeleted: () => boolean;
  listDraft: Accessor<string>;
  listName: () => string;
  setAddAnchor: Setter<AddAnchor>;
  setAlertOpen: Setter<boolean>;
  setListDraft: Setter<string>;
  setOpenListOpen: Setter<boolean>;
  setRenamingList: Setter<boolean>;
  setSortBy: (next: SortKey | ((cur: SortKey) => SortKey)) => void;
  setSortMenuOpen: Setter<boolean>;
  settings: Accessor<WlSettings>;
  showToast: (msg: string) => void;
  sortBy: () => SortKey;
  sortMenuOpen: Accessor<boolean>;
  sortWrapEl: HTMLDivElement | undefined;
  uploadInput: HTMLInputElement | undefined;
  visibleCols: () => { key: WlColumnKey; menuLabel: string; header: string }[];
}

export type WatchlistCx = WatchlistCore &
  ColumnsApi &
  CellsApi &
  SortApi &
  SelectionApi &
  SectionsApi &
  DragApi &
  AddSymbolsApi &
  ListActionsApi &
  KeyboardApi &
  RowMenusApi &
  RowsApi &
  HeadersApi;

/** Add a part's functions (and its state accessors) to the context. */
export function attach<T extends object>(cx: WatchlistCx, api: T): T {
  Object.defineProperties(cx, Object.getOwnPropertyDescriptors(api));
  return api;
}
