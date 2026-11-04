/*
 * Order of the right toolbar buttons: a group stuck to the top and one stuck
 * to the bottom, rearranged by dragging (RightRailTabs) and kv persisted.
 * Buttons added in a later version join their default group at its end.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

export type RailLayout = { top: string[]; bottom: string[] };
export type RailGroup = keyof RailLayout;

const KEY = "ot:right-rail:layout";

/** Buttons that start in the bottom group. */
const BOTTOM_DEFAULT = new Set(["assistant-button", "pine-dialog-button"]);

/** Default layout of `ids` (toolbar order). */
export function defaultLayout(ids: string[]): RailLayout {
  return { top: ids.filter((id) => !BOTTOM_DEFAULT.has(id)), bottom: ids.filter((id) => BOTTOM_DEFAULT.has(id)) };
}

/** A saved layout fitted to the buttons `ids` of this version: unknown ids
 *  dropped, duplicates kept once, missing ones added to their default group. */
export function normalizeLayout(saved: Partial<RailLayout> | null | undefined, ids: string[]): RailLayout {
  const known = new Set(ids);
  const seen = new Set<string>();
  const keep = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter((id): id is string => typeof id === "string" && known.has(id) && !seen.has(id) && !!seen.add(id));
  const out = { top: keep(saved?.top), bottom: keep(saved?.bottom) };
  const def = defaultLayout(ids);
  for (const g of ["top", "bottom"] as const) for (const id of def[g]) if (!seen.has(id)) out[g].push(id);
  return out;
}

/** `layout` with `id` moved to `index` of `group` (index counted without `id`). */
export function moveInLayout(layout: RailLayout, id: string, group: RailGroup, index: number): RailLayout {
  const out = { top: layout.top.filter((x) => x !== id), bottom: layout.bottom.filter((x) => x !== id) };
  const list = out[group];
  list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
  return out;
}

function read(): Partial<RailLayout> | null {
  try {
    return JSON.parse(kv.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

const [saved, setSaved] = createSignal<Partial<RailLayout> | null>(read());
kv.onExternalChange(KEY, () => setSaved(read()));

/** The layout of the buttons `ids`. */
export const railLayout = (ids: string[]): RailLayout => normalizeLayout(saved(), ids);

export function setRailLayout(layout: RailLayout): void {
  setSaved(layout);
  kv.setItem(KEY, JSON.stringify(layout));
}
