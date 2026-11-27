/*
 * The Open script dialog's list (#419): the user's stored scripts, favourites first, then the others, each group in
 * the chosen order (reference rule). The order is kept between openings.
 */
import * as kv from "../../data/kv";
import type { OakScriptEntry } from "../../data/oakscript-store";

export type OpenScriptSort = "name-asc" | "name-desc" | "date-asc" | "date-desc";

export const OPEN_SCRIPT_SORTS: readonly { id: OpenScriptSort; label: string }[] = [
  { id: "name-asc", label: "Script name (A to Z)" },
  { id: "name-desc", label: "Script name (Z to A)" },
  { id: "date-asc", label: "Date modified (oldest first)" },
  { id: "date-desc", label: "Date modified (newest first)" },
];

const SORT_KEY = "ot:oakscript:openSort";
/** The reference opens the list newest first. */
const DEFAULT_SORT: OpenScriptSort = "date-desc";

export function readOpenScriptSort(): OpenScriptSort {
  const v = kv.getItem(SORT_KEY);
  return OPEN_SCRIPT_SORTS.some((s) => s.id === v) ? (v as OpenScriptSort) : DEFAULT_SORT;
}

export function writeOpenScriptSort(sort: OpenScriptSort): void {
  kv.setItem(SORT_KEY, sort);
}

/** The rows to show: `query` matched in the name (any case), favourites first, each group sorted by `sort`. */
export function openScriptRows(
  entries: readonly OakScriptEntry[],
  sort: OpenScriptSort,
  query: string,
  isFavorite: (e: OakScriptEntry) => boolean,
): OakScriptEntry[] {
  const q = query.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : [...entries];
  const byName = (a: OakScriptEntry, b: OakScriptEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const compare = (a: OakScriptEntry, b: OakScriptEntry): number => {
    switch (sort) {
      case "name-asc":
        return byName(a, b);
      case "name-desc":
        return byName(b, a);
      case "date-asc":
        return a.updatedAt - b.updatedAt || byName(a, b);
      case "date-desc":
        return b.updatedAt - a.updatedAt || byName(a, b);
    }
  };
  return shown.sort((a, b) => Number(isFavorite(b)) - Number(isFavorite(a)) || compare(a, b));
}
