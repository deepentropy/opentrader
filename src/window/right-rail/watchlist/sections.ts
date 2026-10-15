/*
 * Watchlist sections: the collapsed sections (saved with the list), the items
 * on screen, and the inline rename of a section header.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import { watchlistStore, isSectionId, sectionId, sectionNameOf, shownItems } from "../../../data/watchlist-store";
import { type WatchlistCx } from "./context";
import type { Accessor, Setter } from "solid-js";

/** What createSections adds to the watchlist context. */
export interface SectionsApi {
  collapsed: Accessor<Set<string>>;
  commitRename: () => void;
  draft: Accessor<string>;
  inListOrder: (ids: string[]) => string[];
  isCollapsed: (name: string) => boolean;
  onTitleClick: (e: MouseEvent, name: string) => void;
  renaming: Accessor<string | null>;
  setCollapse: (names: string[], value: boolean) => void;
  setDraft: Setter<string>;
  setRenaming: Setter<string | null>;
  shown: Accessor<string[]>;
  startRename: (name: string) => void;
  toggleCollapse: (name: string) => void;
}

export function createSections(cx: WatchlistCx): SectionsApi {
  const { active, clickItem, isSectionSelected, selectOnly, selection, setRenamingList } = cx;
  // ── Section UI state ── the collapsed sections are saved with the list
  // (store); which one is being renamed is view state. A header click selects
  // the section; a second click on the already-selected title enters rename.
  // Switching lists ends a rename.
  const collapsed = createMemo(() => new Set(active()?.collapsed ?? []));
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  createEffect(() => {
    watchlistStore.activeId(); // track: reset interaction state on list switch
    setRenaming(null);
    setRenamingList(false);
  });

  const isCollapsed = (name: string) => collapsed().has(name);
  const setCollapse = (names: string[], value: boolean) => watchlistStore.setSectionsCollapsed(names, value);
  // The chevron of a selected header folds / unfolds every selected section.
  const toggleCollapse = (name: string) => {
    const picked = selection().filter(isSectionId).map(sectionNameOf);
    setCollapse(picked.includes(name) ? picked : [name], !isCollapsed(name));
  };

  // The items on screen, in order (rows of collapsed sections left out).
  const shown = createMemo(() => {
    const a = active();
    return a ? shownItems(a, collapsed()) : [];
  });
  const inListOrder = (ids: string[]) => {
    const set = new Set(ids);
    return shown().filter((id) => set.has(id));
  };
  const startRename = (name: string) => {
    setRenaming(name);
    setDraft(name);
  };
  const commitRename = () => {
    const cur = renaming();
    if (cur) selectOnly(sectionId(watchlistStore.renameSection(cur, draft())));
    setRenaming(null);
  };
  // Title click: select on the first click, edit on the second (when already
  // selected) — a select→edit model. A click with Ctrl or Shift only changes
  // the selection.
  const onTitleClick = (e: MouseEvent, name: string) => {
    if (renaming() === name) return; // already editing — clicks inside must not reset
    const wasSelected = isSectionSelected(name);
    if (clickItem(e, sectionId(name)) && wasSelected) startRename(name);
  };

  return {
    collapsed,
    commitRename,
    draft,
    inListOrder,
    isCollapsed,
    onTitleClick,
    renaming,
    setCollapse,
    setDraft,
    setRenaming,
    shown,
    startRename,
    toggleCollapse,
  };
}
