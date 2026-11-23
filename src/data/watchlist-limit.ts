/*
 * The size limit of a watchlist (#358): at most 1,000 symbols and section headers, as in the reference. A change
 * that would take a list past it (Add symbol, "Add to watchlist", a new section, a new or copied list, a flag that
 * fills a colour list) is refused whole: nothing is added, and the window shows its warning. Data plugins' lists are
 * cut to the same size when they arrive (plugins/data.rs).
 */
import type { Group, Row } from "./watchlist";

/** Most symbols and section headers a list holds. */
export const MAX_LIST_ITEMS = 1000;

/** Symbols and section headers of a list. */
export const listItemCount = (l: { groups: readonly Group[]; extras: readonly Row[] }): number =>
  l.extras.length + l.groups.reduce((n, g) => n + 1 + g.rows.length, 0);

/** What was refused: rows or sections of a list, or flags of one colour. */
export type ListFullKind = "list" | "flags";

let warn: (kind: ListFullKind) => void = () => {};

/** The window's warning for a refused change (set once at start-up; the stores stay free of dialogs). */
export function onListFull(fn: (kind: ListFullKind) => void): void {
  warn = fn;
}

/** A change was refused: the list would hold more than MAX_LIST_ITEMS items. */
export function listFull(kind: ListFullKind = "list"): void {
  warn(kind);
}
