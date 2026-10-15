/*
 * Watchlist right-click menus: the row menu (one row or a selection of
 * several items) and the section menu, and their actions (flags, add to /
 * remove from a list, new list with the items, note).
 */
import { createSignal } from "solid-js";
import { type Row } from "../../../data/watchlist";
import {
  watchlistStore,
  isSectionId,
  isDeletedList,
  listItems,
  sectionId,
  sectionNameOf,
  type WatchList,
} from "../../../data/watchlist-store";
import { flagOf, lastFlagColor } from "../../../data/symbol-flags";
import { showConfirm } from "../../../components/Dialogs";
import { promptNewWatchlist } from "../watchlist-prompts";
import { emitAppEvent } from "../../../data/app-events";
import { type WatchlistCx } from "./context";
import type { Accessor, Setter } from "solid-js";

/** An open row menu: the clicked row (null for a header of a selection),
 *  the rows of the selection, the section and the position. */
type RowMenuState = { row: Row | null; selected: Row[] | null; section: string | null; x: number; y: number };

/** What createRowMenus adds to the watchlist context. */
export interface RowMenusApi {
  createListWithItems: (ids: string[]) => void;
  ctxIds: (m: { row: Row | null; selected: Row[] | null }) => string[];
  ctxLists: () => WatchList[];
  ctxMenu: Accessor<RowMenuState | null>;
  openContext: (e: MouseEvent, row: Row, section: string | null) => void;
  openNoteFor: (row: Row) => void;
  openSectionContext: (e: MouseEvent, name: string) => void;
  sectionCtx: Accessor<{ name: string; x: number; y: number } | null>;
  selectedRows: () => Row[];
  setCtxMenu: Setter<RowMenuState | null>;
  setSectionCtx: Setter<{ name: string; x: number; y: number } | null>;
  toggleFlags: (rows: Row[], ask?: boolean) => void;
  toggleItemsInList: (listId: string, ids: string[]) => void;
}

export function createRowMenus(cx: WatchlistCx): RowMenusApi {
  const { active, allRows, isSectionSelected, isSelected, renaming, selectOnly, selectRow, selectedIds, selection, showToast } = cx;
  // ── Context menus (right-click) ── one open menu at a time. The symbol-row
  // menu has this item set (flag toggle + colour row + add-to-list submenu +
  // note); rows are removed via the hover ×, not the menu. Section headers get
  // a Rename / Remove section / Add symbol menu.
  // `selected` = the rows the menu acts on when the clicked item is part of a
  // selection of several items (null = the clicked row alone). A header of
  // such a selection opens this same menu (`row` null, `section` = its name).
  const [ctxMenu, setCtxMenu] = createSignal<{ row: Row | null; selected: Row[] | null; section: string | null; x: number; y: number } | null>(null);
  const [sectionCtx, setSectionCtx] = createSignal<{ name: string; x: number; y: number } | null>(null);
  const openContext = (e: MouseEvent, row: Row, section: string | null) => {
    e.preventDefault();
    if (!isSelected(row)) selectOnly(row.ticker); // right-click selects the row
    setCtxMenu({ row, selected: selection().length > 1 ? selectedRows() : null, section, x: e.clientX, y: e.clientY });
  };
  const openSectionContext = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (renaming() === name) return; // no menu while its name is edited
    if (isSectionSelected(name) && selection().length > 1) {
      setCtxMenu({ row: null, selected: selectedRows(), section: name, x: e.clientX, y: e.clientY });
      return;
    }
    if (!isSectionSelected(name)) selectOnly(sectionId(name));
    setSectionCtx({ name, x: e.clientX, y: e.clientY });
  };
  // The items the open row menu acts on, in list order: the selection
  // (symbols and section headers) or the clicked row.
  const ctxIds = (m: { row: Row | null; selected: Row[] | null }): string[] => {
    if (m.selected == null) return m.row ? [m.row.ticker] : [];
    const a = active();
    return a ? listItems(a).filter((id) => selectedIds().has(id)) : [];
  };
  // The selected symbols, in list order (section headers left out).
  const selectedRows = () => allRows().filter((r) => selectedIds().has(r.ticker));
  // "Flag/Unflag" (same as Alt+↵): symbols that all carry a flag lose it;
  // otherwise they all take the last used colour. Unflagging several symbols
  // asks first.
  const toggleFlags = (rows: Row[], ask = rows.length > 1) => {
    if (!rows.length) return;
    const color = rows.every((r) => flagOf(r.ticker)) ? null : lastFlagColor();
    const run = () => rows.forEach((r) => watchlistStore.setRowFlag(r.ticker, color));
    if (!ask || color) {
      run();
      return;
    }
    showConfirm({
      title: "Unflag selected symbols?",
      text: "Doing this will unflag selected symbols from your watchlist.",
      mainText: "Unflag",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => {
        run();
        cx.rowsEl?.focus();
      },
      onCancel: () => cx.rowsEl?.focus(),
    });
  };
  // "Add … to" submenu: the lists it offers (the open list first, then the
  // others by name; no colour list, "Deleted symbols" only when it is the
  // open list) and a click on one of them.
  // A list holding every symbol loses them; any other list gets the ones it
  // misses.
  const ctxLists = () => {
    const id = watchlistStore.activeId();
    const all = watchlistStore.lists().filter((l) => !l.id.startsWith("color-") && (l.id === id || !isDeletedList(l.id)));
    return [
      ...all.filter((l) => l.id === id),
      ...all.filter((l) => l.id !== id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
  };
  // A section header among the items is added / removed like a symbol: added
  // at the end of the list (the symbols after it are its rows); removed, its
  // rows stay.
  const toggleItemsInList = (listId: string, ids: string[]) => {
    const missing = ids.filter((id) => !watchlistStore.listHas(listId, id));
    if (!missing.length) {
      for (const id of ids) {
        if (isSectionId(id)) watchlistStore.removeSectionFrom(listId, sectionNameOf(id));
        else watchlistStore.removeRowFrom(listId, id);
      }
      return;
    }
    for (const id of missing) {
      const r = allRows().find((x) => x.ticker === id);
      if (isSectionId(id)) watchlistStore.addSectionTo(listId, sectionNameOf(id));
      else if (r) watchlistStore.addRowTo(listId, r);
    }
  };
  const createListWithItems = (ids: string[]) => {
    const items = ids.flatMap((id): (Row | string)[] => {
      if (isSectionId(id)) return [sectionNameOf(id)];
      const r = allRows().find((x) => x.ticker === id);
      return r ? [r] : [];
    });
    const rows = items.filter((it): it is Row => typeof it !== "string");
    promptNewWatchlist((name) => {
      const nm = watchlistStore.createListWith(items, name);
      showToast(`Added ${rows.length === 1 ? rows[0].short : `${rows.length} symbols`} to ${nm}`);
    });
  };
  // "Add note": the editor lives in the details pane and shows the SELECTED
  // symbol's note — select the row, then ask the pane to open its note editor.
  const openNoteFor = (row: Row) => {
    selectRow(row.ticker);
    emitAppEvent("wl-open-note");
  };

  return {
    createListWithItems,
    ctxIds,
    ctxLists,
    ctxMenu,
    openContext,
    openNoteFor,
    openSectionContext,
    sectionCtx,
    selectedRows,
    setCtxMenu,
    setSectionCtx,
    toggleFlags,
    toggleItemsInList,
  };
}
