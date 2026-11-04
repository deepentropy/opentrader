/*
 * Undo steps of the edits of one source of a chart (reference undo commands):
 * visual order, visibility on intervals, Move to, Pin to scale, the settings
 * dialog. The chart wraps such an edit in "chart-sources-edit" begin / end;
 * the sources of the focused chart (studies, their settings, compared
 * symbols, the orders) are read before and after, and one undo step holds
 * both, under the reference's text of the command. The Settings dialog
 * records each change as it is made (the reference app), the keystrokes of
 * one field as one step; its Cancel takes them back.
 */
import { emitAppEvent, onAppEvent } from "../../data/app-events";
import type { AppTabs } from "./app-tabs";
import type { ChartSources, LayoutSourcesUndoEntry, UndoHistory } from "./undo-history";
import { chartSources } from "./layout-sources";

/** A study on its defaults has no saved settings: the edit gives it some. Its `before` then takes the settings it
 *  was drawn with (`drawn`, from the chart), so undo puts them back on the chart (no saved settings would leave
 *  the edited ones drawn). */
export function withDrawnBefore(before: ChartSources, after: ChartSources, drawn: Record<string, unknown>): ChartSources {
  const missing = Object.keys(after.indicatorSettings ?? {}).filter((id) => before.indicators.includes(id) && !before.indicatorSettings?.[id] && drawn[id]);
  if (!missing.length) return before;
  const indicatorSettings = { ...before.indicatorSettings };
  for (const id of missing) indicatorSettings[id] = JSON.parse(JSON.stringify(drawn[id]));
  return { ...before, indicatorSettings };
}

/** Run `edit` as one undo step named `label` (the chart's side). `coalesce`: one step with the previous one of the
 *  same key; `session`: the dialog it is made in (see "chart-sources-rollback"). */
export function sourcesEdit(label: string, edit: () => void, opts: { coalesce?: string; session?: string } = {}): void {
  emitAppEvent("chart-sources-edit", { phase: "begin", label, ...opts });
  try {
    edit();
  } finally {
    emitAppEvent("chart-sources-edit", { phase: "end", label, ...opts });
  }
}

export function installSourceEdits(t: Pick<AppTabs, "activeTab" | "tabOf">, undo: Pick<UndoHistory, "commit" | "rollback">): () => void {
  let open: { tabId: string; pane: number; before: ChartSources; drawn: Record<string, unknown> } | null = null;
  // After the steps still being read (they are read on the next turn).
  const offRollback = onAppEvent("chart-sources-rollback", (d) => {
    if (d) setTimeout(() => undo.rollback(d.session), 0);
  });
  const offEdit = onAppEvent("chart-sources-edit", (d) => {
    if (!d) return;
    if (d.phase === "begin") {
      const tab = t.activeTab();
      const p = tab.panes[tab.activePane];
      let drawn: Record<string, unknown> = {};
      emitAppEvent("chart-sources-snapshot", { fill: (m) => (drawn = m) });
      open = p ? { tabId: tab.id, pane: tab.activePane, before: chartSources(p), drawn } : null;
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
      const entry: LayoutSourcesUndoEntry = {
        kind: "layout-sources",
        tabId: was.tabId,
        before: { [was.pane]: withDrawnBefore(was.before, after, was.drawn) },
        after: { [was.pane]: after },
        slices: [],
        label: d.label,
        at: Date.now(),
        coalesce: d.coalesce,
        session: d.session,
      };
      undo.commit(entry);
    }, 0);
  });
  return () => {
    offRollback();
    offEdit();
  };
}
