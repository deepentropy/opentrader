/*
 * Stacking order of a chart's panes: the price pane (`_series`, the main
 * series' own pane) and the stacked panes of the studies and compared
 * symbols, top to bottom. The price pane can sit at any position (pane
 * controls, chart drag of the series).
 */
import { MAIN_SOURCE_ID } from "../object-tree-sources";

/** Pane ids in stacking order: the saved order first, then the ids it does
 *  not list in their given order; the price pane (`_series`) stays on top
 *  when the saved order does not place it (charts saved before it could
 *  move). */
export function paneRanks(ids: string[], saved: string[]): string[] {
  const rank = (id: string) => {
    const k = saved.indexOf(id);
    if (k >= 0) return k;
    if (id === MAIN_SOURCE_ID) return -1;
    return saved.length + ids.indexOf(id);
  };
  return ids.slice().sort((a, b) => rank(a) - rank(b));
}

/** The saved order after the price pane is moved to the bottom (chart drag of
 *  the series onto the time axis): `current` = the pane ids top to bottom. */
export function seriesPaneLast(current: string[]): string[] {
  return [...current.filter((id) => id !== MAIN_SOURCE_ID), MAIN_SOURCE_ID];
}
