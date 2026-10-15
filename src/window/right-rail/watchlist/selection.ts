/*
 * Watchlist selection: one selection of symbol rows and section headers
 * (click, Ctrl / Shift click, Shift + Up / Down), put back on the charted
 * symbol's row when the chart or the list changes, and the removal of the
 * selected items.
 */
import { createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { type Row } from "../../../data/watchlist";
import { watchlistStore, isSectionId, listItems, sectionId } from "../../../data/watchlist-store";
import { showConfirm } from "../../../components/Dialogs";
import { type WatchlistCx } from "./context";
import type { Accessor, Setter } from "solid-js";

/** What createSelection adds to the watchlist context. */
export interface SelectionApi {
  chartRow: Accessor<string | null>;
  clickItem: (e: MouseEvent, id: string) => boolean;
  extendSelection: (dir: 1 | -1) => void;
  isSectionSelected: (name: string) => boolean;
  isSelected: (r: Row) => boolean;
  removeFromButton: (id: string) => void;
  removeSelection: () => void;
  scrollToItem: (id: string) => void;
  selectOnly: (id: string | null) => void;
  selectedIds: Accessor<Set<string>>;
  selection: Accessor<string[]>;
  setSelection: Setter<string[]>;
}

export function createSelection(cx: WatchlistCx): SelectionApi {
  const { active, allRows, props } = cx;
  // ── Selection ── one selection for the whole list: symbol rows and section
  // headers, by item id (a row's ticker, `sectionId(name)` for a header). A
  // plain click selects one item; Ctrl/Cmd + click toggles an item, Shift +
  // click adds the range from the last touched item (`focusId`), Shift +
  // Up/Down extends it, Ctrl/Cmd + A takes every item. It is not derived from
  // the charted symbol, so the clicked row stays lit even for watchlist-only
  // symbols; a change of the charted symbol or of the list puts it back on
  // the charted symbol's row (none when the list does not hold it).
  const [selection, setSelection] = createSignal<string[]>([]);
  const [focusId, setFocusId] = createSignal<string | null>(null);
  const selectedIds = createMemo(() => new Set(selection()));
  const selectOnly = (id: string | null) => {
    setSelection(id ? [id] : []);
    setFocusId(id);
  };
  // The row of the charted listing; a row still holding a bare ticker
  // matches by ticker.
  const chartRow = createMemo((): string | null => {
    const full = props.activeSymbol;
    const bare = props.activeTicker;
    const match =
      allRows().find((r) => r.ticker === full) ??
      allRows().find((r) => !r.ticker.includes(":") && !!bare && r.ticker === bare);
    return match ? match.ticker : null;
  });
  // The charted symbol as one value: the props are read through the pane's
  // state, which also changes for other reasons (a load that ends), and such
  // a change must not put the selection back.
  const chartKey = createMemo(() => `${props.activeSymbol ?? ""}|${props.activeTicker ?? ""}`);
  createEffect(on([chartKey, watchlistStore.activeId, chartRow], () => selectOnly(chartRow())));
  // An item that left the list leaves the selection.
  createEffect(() => {
    const a = active();
    const ids = new Set(a ? listItems(a) : []);
    const cur = untrack(selection);
    if (cur.some((id) => !ids.has(id))) setSelection(cur.filter((id) => ids.has(id)));
  });
  const isSelected = (r: Row) => selectedIds().has(r.ticker);
  const isSectionSelected = (name: string) => selectedIds().has(sectionId(name));

  /** A click on a row or a section header updates the selection. Returns
   *  true for a click with no modifier key (the one that also acts: loads the
   *  symbol, renames the section). */
  const clickItem = (e: MouseEvent, id: string): boolean => {
    const mod = e.ctrlKey || e.metaKey;
    const cur = selection();
    let next: string[];
    if (mod && !e.shiftKey && !e.altKey) {
      next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    } else if (e.shiftKey && !mod && !e.altKey && cur.length > 0) {
      const items = cx.shown();
      let from = items.indexOf(focusId() ?? "");
      if (from < 0) from = items.reduce((acc, x, i) => (cur.includes(x) ? i : acc), -1);
      const to = items.indexOf(id);
      next = [...cur];
      if (from >= 0 && to >= 0) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (!next.includes(items[i])) next.push(items[i]);
      }
    } else {
      next = [id];
    }
    setSelection(cx.inListOrder(next));
    setFocusId(id);
    cx.rowsEl?.focus();
    return !mod && !e.shiftKey && !e.altKey;
  };
  const scrollToItem = (id: string) =>
    queueMicrotask(() => {
      const el = [...(cx.rowsEl?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])].find((e) => e.dataset.itemId === id);
      el?.scrollIntoView({ block: "nearest" });
    });
  /** Shift + Up / Down: the selection grows by the next item, or gives back
   *  the last touched one when the step goes back into it. */
  const extendSelection = (dir: 1 | -1) => {
    const items = cx.shown();
    const n = items.length;
    if (!n) return;
    const cur = selection();
    const focus = focusId();
    let at = items.indexOf(cur.length === 1 && cur[0] !== focus ? cur[0] : (focus ?? ""));
    if ((dir === -1 && at === 0) || (dir === 1 && at === n - 1)) return;
    if (at < 0 && dir === -1) at = n;
    const id = items[at + dir];
    if (cur.includes(id) && focus) setSelection(cur.filter((x) => x !== focus));
    else setSelection(cx.inListOrder([...cur, id]));
    setFocusId(id);
    scrollToItem(id);
  };
  // ── Removal ── Delete / Backspace removes the selected items; the remove
  // button of a selected item removes all of them, of any other item that
  // item alone. More than one item asks first. A removed section header
  // leaves its rows in the list.
  const removeItems = (ids: string[], after?: () => void) => {
    if (!ids.length) return;
    const run = () => {
      watchlistStore.removeItems(ids);
      after?.();
      cx.rowsEl?.focus();
    };
    if (ids.length === 1) {
      run();
      return;
    }
    showConfirm({
      title: "Remove selected symbols?",
      text: `Doing this will remove ${ids.length} selected symbols from your watchlist.`,
      mainText: "Remove",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: run,
      onCancel: () => cx.rowsEl?.focus(),
    });
  };
  const removeFromButton = (id: string) => removeItems(selectedIds().has(id) ? selection() : [id]);
  // By key: the selection then goes to the row after the last removed item
  // (the first row when there is none after it; nothing when that item ended
  // the list). The charted symbol stays.
  const removeSelection = () => {
    const ids = selection();
    const a = active();
    if (!ids.length || !a) return;
    const last = ids[ids.length - 1];
    const all = listItems(a);
    let next: string | null = null;
    if (last !== all[all.length - 1]) {
      const items = cx.shown();
      const at = items.indexOf(last);
      const isRow = (id: string) => !isSectionId(id) && id !== last;
      next = items.slice(at + 1).find(isRow) ?? items.slice(0, Math.max(at, 0)).find(isRow) ?? null;
    }
    removeItems(ids, () => selectOnly(next && !ids.includes(next) ? next : null));
  };

  return {
    chartRow,
    clickItem,
    extendSelection,
    isSectionSelected,
    isSelected,
    removeFromButton,
    removeSelection,
    scrollToItem,
    selectOnly,
    selectedIds,
    selection,
    setSelection,
  };
}
