/*
 * Undo steps of the edits of one source of a chart (reference undo commands):
 * visual order, visibility on intervals, Move to, Pin to scale, the settings
 * dialog. The chart wraps such an edit in "chart-sources-edit" begin / end;
 * the sources of the focused chart (studies, their settings, compared
 * symbols, the orders) are read before and after, and one undo step holds
 * both, under the reference's text of the command.
 */
import { emitAppEvent, onAppEvent } from "../../data/app-events";
import type { AppTabs } from "./app-tabs";
import type { ChartSources, LayoutSourcesUndoEntry, UndoHistory } from "./undo-history";
import { chartSources } from "./layout-sources";

/** Run `edit` as one undo step named `label` (the chart's side). */
export function sourcesEdit(label: string, edit: () => void): void {
  emitAppEvent("chart-sources-edit", { phase: "begin", label });
  try {
    edit();
  } finally {
    emitAppEvent("chart-sources-edit", { phase: "end", label });
  }
}

export function installSourceEdits(t: Pick<AppTabs, "activeTab" | "tabOf">, undo: Pick<UndoHistory, "commit">): () => void {
  let open: { tabId: string; pane: number; before: ChartSources } | null = null;
  return onAppEvent("chart-sources-edit", (d) => {
    if (!d) return;
    if (d.phase === "begin") {
      const tab = t.activeTab();
      const p = tab.panes[tab.activePane];
      open = p ? { tabId: tab.id, pane: tab.activePane, before: chartSources(p) } : null;
      return;
    }
    const was = open;
    open = null;
    if (!was) return;
    // The chart saves its edits through the tab (some a moment later): read them once they are in.
    setTimeout(() => {
      const p = t.tabOf(was.tabId)?.panes[was.pane];
      if (!p) return;
      const after = chartSources(p);
      if (JSON.stringify(after) === JSON.stringify(was.before)) return;
      const entry: LayoutSourcesUndoEntry = { kind: "layout-sources", tabId: was.tabId, before: { [was.pane]: was.before }, after: { [was.pane]: after }, slices: [], label: d.label, at: Date.now() };
      undo.commit(entry);
    }, 0);
  });
}
