/*
 * Indicator templates — the header "Indicator templates" dropdown (a
 * study-template model; templates live in localStorage, not the cloud). A
 * template captures the active pane's indicator set plus each study's edited
 * inputs/styles, so applying one restores the exact studies.
 *
 * Favourited templates surface as round letter badges on the header strip
 * (20×20 template badges, e.g. "S" for Scalping) — one-click apply.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";
import type { HeaderMenuDef } from "../window/header/header-menus/registry";

const STORAGE_KEY = "ot:indicator-templates";

export type IndicatorTemplate = {
  id: string;
  name: string;
  /** Registry ids of the studies, in pane order. */
  indicators: string[];
  /** Per-study edited inputs/styles (PaneIndicatorSettings), keyed by id. */
  settings: Record<string, unknown>;
  /** Favourited templates render as header badges. */
  favorite: boolean;
  /** Last save/apply, ms — drives the recently-used ordering. */
  usedAt: number;
};

function load(): IndicatorTemplate[] {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as IndicatorTemplate[];
  } catch {
    /* malformed / unavailable — start empty */
  }
  return [];
}

const [templates, setTemplates] = createSignal<IndicatorTemplate[]>(load());

// Live cross-window sync.
kv.onExternalChange(STORAGE_KEY, () => setTemplates(load()));

function persist(next: IndicatorTemplate[]) {
  setTemplates(next);
  try {
    kv.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** All templates, most recently used first. */
export const savedIndicatorTemplates = () =>
  [...templates()].sort((a, b) => b.usedAt - a.usedAt);

/** Favourited templates (header badges), most recently used first. */
export const favoriteIndicatorTemplates = () =>
  savedIndicatorTemplates().filter((t) => t.favorite);

export function getIndicatorTemplate(id: string): IndicatorTemplate | undefined {
  return templates().find((t) => t.id === id);
}

/** Save the current studies under `name`. A template with the same name is
 *  overwritten in place. */
export function saveIndicatorTemplate(
  name: string,
  indicators: string[],
  settings: Record<string, unknown>,
): IndicatorTemplate {
  const now = Date.now();
  const existing = templates().find((t) => t.name === name);
  const tpl: IndicatorTemplate = {
    id: existing?.id ?? `it_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    indicators: [...indicators],
    settings: JSON.parse(JSON.stringify(settings)) as Record<string, unknown>,
    favorite: existing?.favorite ?? false,
    usedAt: now,
  };
  persist([...templates().filter((t) => t.id !== tpl.id), tpl]);
  return tpl;
}

export function removeIndicatorTemplate(id: string): void {
  persist(templates().filter((t) => t.id !== id));
}

export function toggleFavoriteIndicatorTemplate(id: string): void {
  persist(templates().map((t) => (t.id === id ? { ...t, favorite: !t.favorite } : t)));
}

/** Stamp a template as just-used (apply path) for the recency ordering. */
export function touchIndicatorTemplate(id: string): void {
  persist(templates().map((t) => (t.id === id ? { ...t, usedAt: Date.now() } : t)));
}

// ── Menu builder ───────────────────────────────────────────────────────────

export const SAVE_TEMPLATE_ROW_ID = "indicator-templates-save";
export const APPLY_TEMPLATE_PREFIX = "apply-indicator-template:";

/** Live "Indicator templates" dropdown: Save action + recently-used rows.
 *  Row ids carry the template id in the `apply-indicator-template:` prefix. */
export function buildIndicatorTemplatesMenu(): HeaderMenuDef {
  const rows = savedIndicatorTemplates().map((t) => ({
    id: `${APPLY_TEMPLATE_PREFIX}${t.id}`,
    label: t.name,
    iconName: null,
    hotkey: null,
    checked: false,
    favorited: t.favorite,
  }));
  return {
    width: 352,
    sections: [
      {
        header: null,
        items: [
          {
            id: SAVE_TEMPLATE_ROW_ID,
            label: "Save indicator template…",
            iconName: "menu-indicator-templates-save-indicator-template",
            hotkey: null,
            checked: false,
            favorited: false,
          },
        ],
      },
      ...(rows.length > 0 ? [{ header: "RECENTLY USED", items: rows }] : []),
    ],
  } as HeaderMenuDef;
}
