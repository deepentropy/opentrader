/*
 * Human-readable label per DrawingKind. Sourced from the live TV
 * drawing-toolbar inventory (data/drawing-toolbar.ts) at module load
 * time, so a future toolbar re-capture flows through here automatically.
 */
import { GROUPS, groupTools } from "../../data/drawing-toolbar";
import type { TvIconName } from "../../components/TvIcon";
import type { DrawingKind } from "lightweight-charts-drawing/tv/types";

const LABEL_BY_ID: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const g of GROUPS) for (const t of groupTools(g)) out[t.id] = t.title;
  return out;
})();

const ICON_BY_ID: Record<string, TvIconName> = (() => {
  const out: Record<string, TvIconName> = {};
  for (const g of GROUPS) for (const t of groupTools(g)) out[t.id] = t.iconName ?? g.defaultIcon;
  return out;
})();

/** Toolbar title for a kind, with a fallback that prettifies the id. */
export function labelForKind(kind: DrawingKind): string {
  return (
    LABEL_BY_ID[kind] ??
    kind
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ")
  );
}

/** Toolbar glyph (`draw-*` icon name) for a kind — the same icon the drawing
 *  toolbar shows, used as the object-tree row icon. Falls back to the trendline. */
export function iconForKind(kind: DrawingKind): TvIconName {
  return ICON_BY_ID[kind] ?? "draw-trend-line";
}
