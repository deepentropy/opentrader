/*
 * Drawing templates + tool defaults — TV LinetoolTemplatesList (module
 * 728838, store 216857) and DefaultProperty (667950), read 26/09/2026.
 *
 * Templates: one list PER TOOL (TV `/drawing-templates/<toolName>/`), sorted
 * by name (localeCompare, numeric). A template holds the drawing's style and,
 * for text tools, its text (TV templateKeys include "text").
 *
 * Tool default: TV saves a tool's default each time one of its drawings is
 * edited through the UI (property change -> saveDefaults), so the next drawing
 * of that tool starts with the last style. Text content is not part of the
 * default (TV defaults keys exclude "text"). "Apply defaults" restores the
 * factory style and clears the saved default (restoreFactoryDefaults).
 *
 * Persisted in the app key-value store, shared by all windows.
 */
import type { DrawingStyle } from "lightweight-charts-drawing/tv/types";
import { setDefaultStyleOverride } from "lightweight-charts-drawing/tv/specs";
import * as kv from "../../data/kv";

/** A saved drawing template: the style (+ the text of text tools). */
export type DrawingTemplate = { name: string; style: DrawingStyle; text?: string };

const KEY = "tv:drawing-templates-by-tool";

function loadAll(): Record<string, DrawingTemplate[]> {
  try {
    const raw = kv.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, DrawingTemplate[]>) : {};
  } catch {
    return {};
  }
}

const byName = (a: DrawingTemplate, b: DrawingTemplate) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Saved templates of one tool, sorted by name. */
export function loadTemplates(kind: string): DrawingTemplate[] {
  const list = loadAll()[kind];
  return Array.isArray(list) ? [...list].sort(byName) : [];
}

/** Save (or replace) a tool's template by name; returns the tool's new list. */
export function saveTemplate(kind: string, tpl: DrawingTemplate): DrawingTemplate[] {
  const all = loadAll();
  const list = (all[kind] ?? []).filter((t) => t.name !== tpl.name);
  list.push({ name: tpl.name, style: { ...tpl.style }, ...(tpl.text !== undefined ? { text: tpl.text } : {}) });
  all[kind] = list.sort(byName);
  kv.setItem(KEY, JSON.stringify(all));
  return all[kind];
}

export function deleteTemplate(kind: string, name: string): DrawingTemplate[] {
  const all = loadAll();
  all[kind] = (all[kind] ?? []).filter((t) => t.name !== name);
  if (all[kind].length === 0) delete all[kind];
  kv.setItem(KEY, JSON.stringify(all));
  return all[kind] ?? [];
}

/* ── Per-tool default ──────────────────────────────────────────────────────
 * The user's default style for a drawing KIND, over the spec's factory
 * defaults; every new drawing of that kind starts with it (`defaultStyleFor`).
 * Cached in-memory so the per-render preview reads don't hit the store each
 * frame. */
const KIND_DEFAULTS_KEY = "tv:drawing-kind-defaults";
let kindDefaultsCache: Record<string, DrawingStyle> | null = null;

// Live cross-window sync: drop the in-memory cache when another window saves a
// kind default, so the next read reflects it. (The templates list is read on
// demand each time the menu opens, so it needs no invalidation.)
kv.onExternalChange(KIND_DEFAULTS_KEY, () => { kindDefaultsCache = null; });

function loadKindDefaults(): Record<string, DrawingStyle> {
  if (kindDefaultsCache) return kindDefaultsCache;
  try {
    const raw = kv.getItem(KIND_DEFAULTS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    kindDefaultsCache = v && typeof v === "object" ? (v as Record<string, DrawingStyle>) : {};
  } catch {
    kindDefaultsCache = {};
  }
  return kindDefaultsCache;
}

/** The user-saved default style for a kind, or undefined if none. */
export function kindDefaultOverride(kind: string): DrawingStyle | undefined {
  return loadKindDefaults()[kind];
}

/** Remember `style` as the default of `kind` (TV saves a tool's defaults on
 *  every UI edit of one of its drawings). The text content is left out. */
export function saveKindDefault(kind: string, style: DrawingStyle): void {
  const { text: _text, ...rest } = style;
  const all = { ...loadKindDefaults(), [kind]: rest as DrawingStyle };
  kindDefaultsCache = all;
  kv.setItem(KIND_DEFAULTS_KEY, JSON.stringify(all));
}

/** Forget the saved default of `kind` (TV restoreFactoryDefaults). */
export function clearKindDefault(kind: string): void {
  const all = { ...loadKindDefaults() };
  if (!(kind in all)) return;
  delete all[kind];
  kindDefaultsCache = all;
  kv.setItem(KIND_DEFAULTS_KEY, JSON.stringify(all));
}

// The shared core merges the user's saved default over the factory style.
setDefaultStyleOverride(kindDefaultOverride);
