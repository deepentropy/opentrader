/*
 * Watchlist menu actions on the open list: rename, add section, clear,
 * create / copy / upload / open a list, and the list alert.
 */
import { createEffect } from "solid-js";
import { watchlistStore, consumeOpenListRequest, clearFiredForList, sectionId } from "../../../data/watchlist-store";
import { showConfirm } from "../../../components/Dialogs";
import { promptCopyWatchlist, promptNewWatchlist } from "../watchlist-prompts";
import { parseWatchlistFile } from "./list-file";
import { type WatchlistCx } from "./context";

/** What createListActions adds to the watchlist context. */
export interface ListActionsApi {
  addAlert: () => void;
  addSection: (before: string | null) => void;
  clearList: () => void;
  commitListRename: () => void;
  copyList: () => void;
  createList: () => void;
  onUploadFile: (file: File) => void;
  openList: () => void;
  removeAlert: () => void;
  renameList: () => void;
  saveAlert: (threshold: number) => void;
  uploadList: () => void;
}

export function createListActions(cx: WatchlistCx): ListActionsApi {
  const { active, highlightRows, inDeleted, listDraft, listName, setAlertOpen, setListDraft, setOpenListOpen, setRenamingList, showToast } = cx;
  // ── Watchlist-menu actions (wired to the multi-list store) ──
  // "Rename": inline-edit the active list's name in the header.
  const renameList = () => {
    if (inDeleted()) return;
    setListDraft(listName());
    setRenamingList(true);
  };
  const commitListRename = () => {
    watchlistStore.renameActive(listDraft());
    setRenamingList(false);
  };
  // "Add section": the new header goes before `before` (the row whose menu
  // asked for it; from the list menu, the charted symbol's row), at the end
  // of the list when there is no such row. It is highlighted and scrolled to.
  const addSection = (before: string | null) => {
    if (!inDeleted()) highlightRows([sectionId(watchlistStore.addSection(before))]);
  };
  // "Clear list": remove every symbol from the active list (they join
  // "Deleted symbols").
  const clearList = () =>
    showConfirm({
      title: "Clear all symbols?",
      text: "Doing this will remove all symbols from your watchlist.",
      mainText: "Clear",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => watchlistStore.clearActive(),
    });
  // "Create new list…": asks the name, then a new empty list, switched-to.
  const createList = () => promptNewWatchlist((name) => watchlistStore.createList(name));
  // "Make a copy…": asks the name, then duplicates the active list (sections + extras).
  const copyList = () => {
    const a = watchlistStore.active();
    if (a) promptCopyWatchlist(`${a.name} copy`, (name) => watchlistStore.copyActive(name));
  };
  // "Upload list…": open the hidden file picker; parsed in onUploadFile.
  const uploadList = () => cx.uploadInput?.click();
  const onUploadFile = (file: File) => {
    void file.text().then((text) => {
      const { groups, extras } = parseWatchlistFile(text);
      if (groups.length || extras.length) {
        // Imported lists start in "default" (file) order — see importList — so
        // rows keep the file's order and don't reshuffle as live quotes arrive.
        watchlistStore.importList(file.name.replace(/\.[^.]+$/, ""), groups, extras);
      }
    });
  };
  // "Open list…": the search-and-switch picker.
  const openList = () => setOpenListOpen(true);
  // Shift+W (global, handled in App) routes here: App switches the rail to the
  // watchlist tab and flags a request, which this effect consumes once we're
  // mounted — opening the picker whether we were already showing or just mounted.
  createEffect(() => {
    if (consumeOpenListRequest()) setOpenListOpen(true);
  });
  // "Add alert on the list…": the threshold dialog.
  const addAlert = () => setAlertOpen(true);
  const saveAlert = (threshold: number) => {
    const listId = watchlistStore.activeId();
    watchlistStore.setAlert(listId, threshold);
    // Re-arm: clear any previously-fired entries for this list.
    clearFiredForList(listId);
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
    showToast(`Alert set: ±${threshold}% on ${active()?.name ?? "list"}`);
  };
  const removeAlert = () => {
    watchlistStore.clearAlert(watchlistStore.activeId());
    showToast("Alert removed");
  };

  return {
    addAlert,
    addSection,
    clearList,
    commitListRename,
    copyList,
    createList,
    onUploadFile,
    openList,
    removeAlert,
    renameList,
    saveAlert,
    uploadList,
  };
}
