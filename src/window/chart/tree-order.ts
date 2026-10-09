/*
 * Order of the objects of one chart pane: its sources (main series, studies,
 * compared symbols) and its drawings in one list, front object first. The
 * Object tree shows this list and the chart draws in it.
 *
 * Saved as: the pane's source order (PaneChart.sourceOrder), the order of
 * the drawings among themselves (their array), and per drawing the source it
 * sits right in front of (`over`; absent = behind every source of its pane).
 */
import type { Drawing } from "lightweight-charts-drawing/core/types";

export type TreeItem = { kind: "source" | "drawing"; id: string };

/** A drawing with its place among the sources (a persisted field the
 *  drawing type does not declare). */
export type PlacedDrawing = Drawing & { over?: string };
export const overOf = (d: Drawing): string | undefined => (d as PlacedDrawing).over;

/** Items of one pane, front first. `sources`: the pane's source ids, front
 *  first. `drawings`: the pane's drawings, front first, with the source each
 *  one sits in front of (an unknown source = behind them all). */
export function paneItems(sources: string[], drawings: { id: string; over?: string }[]): TreeItem[] {
  const out: TreeItem[] = [];
  for (const s of sources) {
    for (const d of drawings) if (d.over === s) out.push({ kind: "drawing", id: d.id });
    out.push({ kind: "source", id: s });
  }
  for (const d of drawings) if (!d.over || !sources.includes(d.over)) out.push({ kind: "drawing", id: d.id });
  return out;
}

/** `items` with `id` moved right above / below `target`; null when either is
 *  missing or nothing moves. */
export function moveItem(items: TreeItem[], id: string, target: string, below: boolean): TreeItem[] | null {
  const from = items.findIndex((x) => x.id === id);
  if (from < 0 || id === target || !items.some((x) => x.id === target)) return null;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(next.findIndex((x) => x.id === target) + (below ? 1 : 0), 0, it);
  return next.every((x, i) => x.id === items[i].id) ? null : next;
}

/** What `items` saves: the sources and the drawings in order, and for every
 *  drawing the source right behind it (null = none). */
export function splitItems(items: TreeItem[]): { sources: string[]; drawings: string[]; over: Record<string, string | null> } {
  const sources: string[] = [];
  const drawings: string[] = [];
  const over: Record<string, string | null> = {};
  let behind: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "source") {
      behind = it.id;
      sources.unshift(it.id);
    } else {
      over[it.id] = behind;
      drawings.unshift(it.id);
    }
  }
  return { sources, drawings, over };
}
