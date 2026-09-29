/*
 * Favourite drawing tools — a global, persisted store (ported from the
 * reference mock's DrawingsContext favorites slice, adapted to SolidJS
 * module-level signals, mirroring interval-favorites.ts).
 *
 * The favourited set drives BOTH the filled stars in the left drawing
 * toolbar's submenu rows and the membership of the floating
 * `FavoritesToolbar` strip. It's a single global preference, persisted to
 * localStorage, keyed by canonical tool id (the same ids the toolbar arms and
 * the drawing specs match on). Toolbar visibility is persisted alongside it.
 */
import { createSignal } from "solid-js";
import type { IconName } from "../../components/Icon";
import { GROUPS, groupTools, type Group, type Tool } from "../../data/drawing-toolbar";
import * as kv from "../../data/kv";

const FAV_KEY = "ot:favorite-tools";
const VISIBLE_KEY = "ot:favorite-tools-visible";
const POS_KEY = "ot:favorite-tools-pos";

/** Free offset of the favorites toolbar from its default dock, in
 *  offsetParent-relative coords. null = still at the CSS dock (never dragged). */
export type FavoritesToolbarPos = { x: number; y: number };

/** Initial favourites (Ray, Trendline, Horizontal ray, Arrow mark down/up,
 *  Text, Anchored VWAP, Vertical line), used as a populated-by-default seed. */
export const DEFAULT_FAVORITE_TOOL_IDS = [
  "ray", "trend-line", "horizontal-ray", "arrow-mark-down",
  "arrow-mark-up", "text", "anchored-vwap", "vertical-line",
];

/** id → { tool, group } across every tool in every group. Built once at
 *  module load; lets the favorites toolbar resolve a favourited id back to its
 *  title + icon. */
const TOOL_INDEX: Record<string, { tool: Tool; group: Group }> = (() => {
  const out: Record<string, { tool: Tool; group: Group }> = {};
  for (const group of GROUPS) for (const tool of groupTools(group)) out[tool.id] = { tool, group };
  return out;
})();

/** Resolve a tool id to its display title + best icon (per-tool, else the
 *  group default), or null if the id isn't a known drawing tool. */
export function findToolMeta(
  id: string,
): { title: string; iconName: IconName; hotkey?: string } | null {
  const hit = TOOL_INDEX[id];
  if (!hit) return null;
  return {
    title: hit.tool.title,
    iconName: hit.tool.iconName ?? hit.group.defaultIcon,
    hotkey: hit.tool.hotkey,
  };
}

function loadFavorites(): string[] {
  try {
    const raw = kv.getItem(FAV_KEY);
    if (raw) return (JSON.parse(raw) as string[]).filter((id) => TOOL_INDEX[id]);
  } catch {
    /* malformed / unavailable — fall back to defaults */
  }
  return [...DEFAULT_FAVORITE_TOOL_IDS];
}

function loadVisible(): boolean {
  try {
    const raw = kv.getItem(VISIBLE_KEY);
    if (raw !== null) return raw === "true";
  } catch {
    /* best-effort */
  }
  return true;
}

function loadPos(): FavoritesToolbarPos | null {
  try {
    const raw = kv.getItem(POS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as FavoritesToolbarPos;
      if (typeof v?.x === "number" && typeof v?.y === "number") return v;
    }
  } catch {
    /* malformed / unavailable — fall back to the default dock */
  }
  return null;
}

const [favorites, setFavorites] = createSignal<string[]>(loadFavorites());
const [visible, setVisible] = createSignal<boolean>(loadVisible());
const [pos, setPos] = createSignal<FavoritesToolbarPos | null>(loadPos());

// Live cross-window sync: re-seed from storage when another window changes it
// (raw setters, so no re-persist / echo).
kv.onExternalChange(FAV_KEY, () => setFavorites(loadFavorites()));
kv.onExternalChange(VISIBLE_KEY, () => setVisible(loadVisible()));
kv.onExternalChange(POS_KEY, () => setPos(loadPos()));

/** Live, ordered list of favourited tool ids (global + persisted). New
 *  favourites append at the end (favouriting order). */
export const favoriteToolIds = favorites;

/** Whether the favorite drawing tools toolbar is shown. The bar only renders
 *  when this is true AND there is ≥1 favourite. */
export const favoritesToolbarVisible = visible;

export function isFavoriteTool(id: string): boolean {
  return favorites().includes(id);
}

/** Toggle a tool's favourited state; persists + notifies all readers. */
export function toggleFavoriteTool(id: string): void {
  const cur = favorites();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  setFavorites(next);
  try {
    kv.setItem(FAV_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

export function setFavoritesToolbarVisible(v: boolean): void {
  setVisible(v);
  try {
    kv.setItem(VISIBLE_KEY, String(v));
  } catch {
    /* best-effort */
  }
}

/** Live, persisted free offset of the favorites toolbar (null = default dock). */
export const favoritesToolbarPos = pos;

/** Persist the favorites toolbar position; notifies all readers + windows. */
export function setFavoritesToolbarPos(p: FavoritesToolbarPos): void {
  setPos(p);
  try {
    kv.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    /* best-effort */
  }
}
