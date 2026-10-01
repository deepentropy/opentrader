/*
 * Favourite indicators — a global, persisted store (same model as
 * interval-favorites). Starring an indicator in the Indicators dialog adds it
 * to the header's "Favorite indicators" dropdown; the set is a single global
 * preference shared across charts/windows.
 * Keyed by the library registry id (see window/chart/indicators/registry.ts).
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import type { HeaderMenuDef } from "../window/header/header-menus/registry";

const STORAGE_KEY = "ot:favorite-indicators";

function load(): string[] {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw) {
      // Drop ids the registry no longer knows (library upgrade) so the menu
      // never lists rows that can't be added.
      return (JSON.parse(raw) as string[]).filter((id) => !!getIndicatorEntry(id));
    }
  } catch {
    /* malformed / unavailable — start empty */
  }
  return [];
}

const [favorites, setFavorites] = createSignal<string[]>(load());

// Live cross-window sync: re-seed from storage on another window's change.
kv.onExternalChange(STORAGE_KEY, () => setFavorites(load()));

/** Live list of favourited indicator registry ids (global + persisted),
 *  sorted by display name for the dropdown. */
export const favoriteIndicators = () =>
  [...favorites()].sort((a, b) =>
    (getIndicatorEntry(a)?.name ?? a).localeCompare(getIndicatorEntry(b)?.name ?? b),
  );

export function isFavoriteIndicator(id: string): boolean {
  return favorites().includes(id);
}

/** Toggle an indicator's favourited state; persists + notifies all readers. */
export function toggleFavoriteIndicator(id: string): void {
  const cur = favorites();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  setFavorites(next);
  try {
    kv.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** Live "Favorite indicators" dropdown. Rows are the favourited registry ids;
 *  a click adds one more instance, so no row is marked as on the chart. With
 *  no favourites yet, one disabled hint row explains where stars live. */
export function buildFavoriteIndicatorsMenu(): HeaderMenuDef {
  const favs = favoriteIndicators();
  const items =
    favs.length > 0
      ? favs.map((id) => ({
          id,
          label: getIndicatorEntry(id)?.name ?? id,
          favorited: true,
        }))
      : [
          {
            id: "no-favorite-indicators",
            label: "Star indicators in the Indicators dialog to list them here",
            disabled: true,
          },
        ];
  // Section title, shown only with favourites.
  return { width: 314, sections: [{ header: favs.length > 0 ? "Favorite Indicators" : null, items }] };
}
