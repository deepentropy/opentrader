/*
 * Watchlist menu actions on the open list: rename, add section, clear,
 * create / copy / upload / open a list, and the list alert.
 */
import { createEffect } from "solid-js";
import { watchlistStore, consumeOpenListRequest, clearFiredForList, sectionId } from "../../../data/watchlist-store";
import { showConfirm, showNotice } from "../../../components/Dialogs";
import { formatted, translatePlural, translateWith } from "../../../i18n/translator";
import { numberText } from "../../../i18n/format";
import { promptCopyWatchlist, promptNewWatchlist } from "../watchlist-prompts";
import { type ListFileError, MAX_LIST_FILE_KB, listFileTooBig, parseWatchlistFile } from "./list-file";
import { warnListFull } from "./list-full";
import { type WatchlistCx } from "./context";

/** What createListActions adds to the watchlist context. */
export interface ListActionsApi {
  addAlert: () => void;
  addSection: (before: string | null) => void;
  clearList: () => void;
  commitListRename: () => void;
  copyList: () => void;
  createList: () => void;
  onUploadFiles: (files: File[]) => Promise<void>;
  openList: () => void;
  removeAlert: () => void;
  renameList: () => void;
  saveAlert: (threshold: number) => void;
  uploadList: () => void;
}

/** Why an uploaded file made no list. */
function refuseListFile(error: ListFileError): void {
  if (error === "size") {
    showNotice({ title: "File too big", text: formatted(translateWith("The file is larger than {0} KB.", numberText(MAX_LIST_FILE_KB))) });
  } else if (error === "count") {
    warnListFull();
  } else {
    showNotice({
      title: "Invalid file",
      text: 'The file holds no list of symbols. Separate them with commas or put one per line, for example "NASDAQ:AAPL,NYSE:F" or "AAPL,F,MSFT".',
    });
  }
}

/** Make a list of a file, named after it; else why it makes none ("empty": a file that parses to no rows, which
 *  never made a list nor a message; "warned": the store refused it and said why). */
async function importListFile(file: File): Promise<ListFileError | "empty" | "warned" | null> {
  if (listFileTooBig(file.size)) return "size";
  const parsed = parseWatchlistFile(await file.text());
  if ("error" in parsed) return parsed.error;
  const { groups, extras } = parsed;
  if (!groups.length && !extras.length) return "empty";
  // Imported lists start in "default" (file) order — see importList — so
  // rows keep the file's order and don't reshuffle as live quotes arrive.
  return watchlistStore.importList(file.name.replace(/\.[^.]+$/, ""), groups, extras) ? null : "warned";
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
    if (inDeleted()) return;
    // No name: the list is full (the store showed its warning).
    const name = watchlistStore.addSection(before);
    if (name) highlightRows([sectionId(name)]);
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
  // "Upload list…": open the hidden file picker (several files at once); read in onUploadFiles.
  const uploadList = () => cx.uploadInput?.click();
  // One list per file, in the picked order; the last one made is opened. A
  // single file that makes no list says why; for several files, one notice
  // names the files left out and a toast counts the lists made.
  const onUploadFiles = async (files: File[]) => {
    const refused: string[] = [];
    let made = 0;
    for (const file of files) {
      const error = await importListFile(file);
      if (error === null) made++;
      else if (error === "empty") continue;
      else if (files.length > 1) refused.push(file.name);
      else if (error !== "warned") refuseListFile(error);
    }
    if (files.length < 2) return;
    if (made) showToast(formatted(translatePlural(made, { one: "{0} list uploaded", other: "{0} lists uploaded" })));
    if (refused.length) {
      showNotice({
        title: "Some files made no list",
        text: formatted(
          translateWith(
            "Not uploaded: {0}. A file holds symbols separated by commas or one per line, and is at most {1} KB.",
            refused.join(", "),
            numberText(MAX_LIST_FILE_KB),
          ),
        ),
      });
    }
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
    onUploadFiles,
    openList,
    removeAlert,
    renameList,
    saveAlert,
    uploadList,
  };
}
