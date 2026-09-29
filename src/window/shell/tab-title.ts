/*
 * Tab-title parts — the configurable pieces of a tab's title.
 * The App-settings "Tabs" tab reorders / hides these; TabPanel renders them in
 * the configured order. Shared so AppSettingsDialog (the editor) and TabPanel
 * (the renderer) agree on the part set + default order/visibility.
 *
 * Persisted as a global preference (tab titles look the same across tabs).
 */
import * as kv from "../../data/kv";

export type TabTitlePartId =
  | "symbolLogo"
  | "ticker"
  | "priceChangeIcon"
  | "lastPrice"
  | "priceChange"
  | "layoutName";

export const TAB_TITLE_PARTS: { id: TabTitlePartId; label: string }[] = [
  { id: "symbolLogo", label: "Symbol logo" },
  { id: "ticker", label: "Ticker" },
  { id: "priceChangeIcon", label: "Price change icon" },
  { id: "lastPrice", label: "Last price" },
  { id: "priceChange", label: "Price change %" },
  { id: "layoutName", label: "Layout name" },
];

export const TAB_TITLE_LABEL: Record<TabTitlePartId, string> = Object.fromEntries(
  TAB_TITLE_PARTS.map((p) => [p.id, p.label]),
) as Record<TabTitlePartId, string>;

export type TabTitlePartState = { id: TabTitlePartId; visible: boolean };

/** Default = every part visible, in the listed order. */
export const DEFAULT_TAB_TITLE_PARTS: TabTitlePartState[] = TAB_TITLE_PARTS.map((p) => ({
  id: p.id,
  visible: true,
}));

const STORAGE_KEY = "ot:tab-title-parts";

export function loadTabTitleParts(): TabTitlePartState[] {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as TabTitlePartState[];
      // Validate against the known part ids; drop unknowns, append any missing
      // (forward-compat if the part set grows).
      if (Array.isArray(v)) {
        const known = new Set(TAB_TITLE_PARTS.map((p) => p.id));
        const seen = new Set<string>();
        const out: TabTitlePartState[] = [];
        for (const p of v) {
          if (p && known.has(p.id) && !seen.has(p.id)) {
            out.push({ id: p.id, visible: !!p.visible });
            seen.add(p.id);
          }
        }
        for (const p of TAB_TITLE_PARTS) if (!seen.has(p.id)) out.push({ id: p.id, visible: true });
        if (out.length) return out;
      }
    }
  } catch {
    /* malformed — fall through to defaults */
  }
  return DEFAULT_TAB_TITLE_PARTS.map((p) => ({ ...p }));
}

export function saveTabTitleParts(parts: TabTitlePartState[]): void {
  try {
    kv.setItem(STORAGE_KEY, JSON.stringify(parts));
  } catch {
    /* best-effort */
  }
}
