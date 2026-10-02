/*
 * Name dialogs of the watchlist "…" rows: Create new list…, Make a copy…
 * (title, "New watchlist name" field, 128 characters). Names may repeat: the
 * store makes them unique, so there is no "replace?" check.
 */
import { showRename } from "../../components/Dialogs";

const LABEL = "New watchlist name";
const MAX = 128;

/** "Create new list…": asks the new list's name. */
export function promptNewWatchlist(onName: (name: string) => void): void {
  showRename({ title: "Create new watchlist", label: LABEL, maxLength: MAX, names: [], replaceText: () => "", onSave: onName });
}

/** "Make a copy…": asks the copy's name (starts with `initial`). */
export function promptCopyWatchlist(initial: string, onName: (name: string) => void): void {
  showRename({ title: "Make copy of watchlist", label: LABEL, maxLength: MAX, names: [], replaceText: () => "", initialValue: initial, saveText: "Make copy", onSave: onName });
}
