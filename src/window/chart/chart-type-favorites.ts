/*
 * Favourite chart types: a global, persisted store. Drives the filled stars of the chart type menu and the quick-access
 * buttons on the header strip (in the order they were added), one preference shared across charts.
 */
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";
import { HEADER_MENUS } from "../header/header-menus/registry";
import { CHART_TYPE_IDS, type ChartTypeId } from "./chart-types";

const STORAGE_KEY = "ot:favorite-chart-types";

function load(): ChartTypeId[] {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw) return [...new Set(JSON.parse(raw) as ChartTypeId[])].filter((id) => CHART_TYPE_IDS.has(id));
  } catch {
    /* malformed / unavailable: no favourites */
  }
  return [];
}

const [favorites, setFavorites] = createSignal<ChartTypeId[]>(load());

// Live cross-window sync: re-seed from storage on another window's change.
kv.onExternalChange(STORAGE_KEY, () => setFavorites(load()));

/** Live list of favourited chart types, oldest first. */
export const favoriteChartTypes = favorites;

/** Toggle a chart type's favourited state; persists + notifies all readers. */
export function toggleFavoriteChartType(id: ChartTypeId): void {
  const cur = favorites();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  setFavorites(next);
  try {
    kv.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** Buttons of the header strip: the favourites, then the current type when it isn't one. */
export function chartTypeButtons(favs: readonly ChartTypeId[], current: ChartTypeId): ChartTypeId[] {
  return favs.includes(current) ? [...favs] : [...favs, current];
}

/** Name of a chart type, as in the chart type menu. */
export function chartTypeLabel(id: ChartTypeId): string {
  for (const section of HEADER_MENUS.candles.sections) {
    const row = section.items.find((r) => r.id === id);
    if (row) return row.label;
  }
  return id;
}
