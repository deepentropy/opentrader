/*
 * Order of the right toolbar buttons: a group stuck to the top and one stuck
 * to the bottom, rearranged by dragging (RightRailTabs) and kv persisted.
 * Buttons added in a later version join their default group at its end.
 * Buttons hidden with the toolbar's context menu (#306) keep their place, so
 * showing one again puts it back where it was.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

export type RailLayout = { top: string[]; bottom: string[]; hidden?: string[] };
export type RailGroup = "top" | "bottom";

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
  const out: RailLayout = { top: keep(saved?.top), bottom: keep(saved?.bottom) };
  const def = defaultLayout(ids);
  for (const g of ["top", "bottom"] as const) for (const id of def[g]) if (!seen.has(id)) out[g].push(id);
  const hidden = Array.isArray(saved?.hidden) ? [...new Set(saved.hidden.filter((id) => known.has(id)))] : [];
  // One button at least stays on the toolbar (the place of its context menu).
  if (hidden.length > 0 && hidden.length < ids.length) out.hidden = hidden;
  return out;
}

/** `layout` with the button `id` hidden or shown again; the last shown button stays. */
export function setHiddenInLayout(layout: RailLayout, id: string, hide: boolean): RailLayout {
  const hidden = new Set(layout.hidden ?? []);
  if (hide) hidden.add(id);
  else hidden.delete(id);
  const all = layout.top.length + layout.bottom.length;
  if (hidden.size >= all) return layout;
  const { hidden: _old, ...rest } = layout;
  void _old;
  return hidden.size ? { ...rest, hidden: [...hidden] } : rest;
}

/** `layout` with `id` moved to `index` of `group` (index counted without `id`). */
export function moveInLayout(layout: RailLayout, id: string, group: RailGroup, index: number): RailLayout {
  const out: RailLayout = { top: layout.top.filter((x) => x !== id), bottom: layout.bottom.filter((x) => x !== id) };
  if (layout.hidden) out.hidden = layout.hidden;
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

/** The default order, every button shown ("Reset to default"). */
export function resetRailLayout(): void {
  setSaved(null);
  kv.removeItem(KEY);
}

export function setRailLayout(layout: RailLayout): void {
  setSaved(layout);
  kv.setItem(KEY, JSON.stringify(layout));
}
