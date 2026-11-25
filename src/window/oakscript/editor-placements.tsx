/*
 * Where a chart window shows the OakScript editor (#325): under the chart (the drawer, OakScriptPanel), in an editor
 * tab of the window, or in the editor's own window (detached-editor.ts). Created once by App: the More menu's "Open
 * editor" rows move the editor, an editor tab shows the editor in place of the chart layout, and the window's editor
 * window is answered here (its studies, Add to chart, Logs, In-place, the script runtime of this window).
 */
import { Show, createEffect, on, onCleanup } from "solid-js";
import type { AppTabs } from "../shell/app-tabs";
import type { createChartEdits } from "../shell/chart-edits";
import { DEFAULT_PANELS } from "../shell/tabs";
import { getOakEngine } from "./engine";
import * as scripts from "../../data/oakscript-store";
import { OakScriptPanel } from "./OakScriptPanel";
import { shownScriptName } from "./editor-state";
import { hostEditorWindow, openEditorWindow, showInEditorWindow, type DetachMode } from "./detached-editor";
import { openScriptLogs } from "./logs/script-logs";
import { dropUserScriptRuntime, notifyScriptCompiled, notifyScriptRenamed } from "../chart/indicators/user-scripts";
import { dropUserStrategy, notifyUserStrategyCompiled } from "../chart/indicators/strategy-entries";

type Deps = {
  tabs: Pick<AppTabs, "tabs" | "activeTabId" | "activeTab" | "tabOf" | "patchTab" | "activateTab" | "newEditorTab" | "closeEditorTab">;
  edits: Pick<ReturnType<typeof createChartEdits>, "toggleScriptOnTab" | "addStudyTo" | "removeScript">;
  editorOpen: () => boolean;
  setEditorOpen: (open: boolean) => void;
};

export function createEditorPlacements(d: Deps) {
  const { tabs } = d;
  const studiesOf = (tabId: string) => {
    const t = tabs.tabOf(tabId);
    return t && !t.editor ? (t.panes[t.activePane] ?? t.panes[0])?.indicators ?? [] : null;
  };

  /** The editor goes back under chart tab `tabId`, which is shown. */
  function inPlace(tabId: string): void {
    const t = tabs.tabOf(tabId);
    if (!t) return;
    if (tabs.activeTabId() === tabId) d.setEditorOpen(true);
    else {
      // The tab switch shows the tab's panels: its editor among them.
      tabs.patchTab(tabId, { panels: { ...(t.panels ?? DEFAULT_PANELS), editor: true } });
      tabs.activateTab(tabId);
    }
  }

  // The editor's own window, linked to one of this window's chart tabs.
  const windowTab = hostEditorWindow({
    studiesOf,
    toggle: (tab, typeId) => d.edits.toggleScriptOnTab(tab, typeId),
    add: (tab, typeId) => d.edits.addStudyTo(tab, typeId),
    logs: (tab, scriptId) => {
      if (tabs.tabOf(tab)) tabs.activateTab(tab);
      openScriptLogs({ scriptId });
    },
    inPlace: (tab, scriptId) => {
      if (scriptId) scripts.setCurrentScriptId(scriptId);
      inPlace(tabs.tabOf(tab) ? tab : tabs.activeTabId());
    },
    // This window runs the script's studies: it compiles the new source itself.
    compiled: (scriptId, source) => {
      void getOakEngine()
        .compile(scriptId, source)
        .then(
          (meta) => {
            notifyScriptCompiled(scriptId, meta);
            notifyUserStrategyCompiled(scriptId, meta);
          },
          () => {},
        );
    },
    renamed: (scriptId) => notifyScriptRenamed(scriptId),
  });

  // A script deleted in any window leaves this window's charts and script runtime.
  onCleanup(
    scripts.onScriptDeleted((scriptId) => {
      d.edits.removeScript(scriptId);
      dropUserScriptRuntime(scriptId);
      dropUserStrategy(scriptId);
    }),
  );

  // While the editor has a window of its own, opening it under the chart (the editor button, a study's "Source
  // code") brings that window to the front with the script instead.
  createEffect(
    on(d.editorOpen, (open) => {
      const tab = windowTab();
      if (!open || !tab) return;
      d.setEditorOpen(false);
      void showInEditorWindow(tab, scripts.currentScriptId());
    }),
  );

  /** More menu "Open editor" of the editor under the chart: in a new tab, or in its own window. */
  function openOut(where: DetachMode): void {
    const chartTab = tabs.activeTabId();
    if (where === "tab") {
      d.setEditorOpen(false);
      tabs.newEditorTab(chartTab);
      return;
    }
    void openEditorWindow(chartTab, shownScriptName()).then((opened) => {
      if (opened) d.setEditorOpen(false);
    });
  }

  /** The editor of the shown editor tab, in place of the chart layout. */
  function EditorTabView(props: { theme: "dark" | "light" }) {
    return (
      <Show when={tabs.activeTab().editor}>
        {(link) => (
          <div class="oak-editor-tab">
            <OakScriptPanel
              theme={props.theme}
              placement="tab"
              linked={studiesOf(link().chartTab) !== null}
              indicators={studiesOf(link().chartTab) ?? []}
              onToggleIndicator={(id) => d.edits.toggleScriptOnTab(link().chartTab, id)}
              onAddIndicator={(id) => d.edits.addStudyTo(link().chartTab, id)}
              onClose={() => {}}
              onOpenEditor={(where) => {
                if (where !== "in-place") return;
                const chartTab = link().chartTab;
                tabs.closeEditorTab(tabs.activeTabId());
                // Its chart tab closed: under the tab shown instead.
                inPlace(tabs.tabOf(chartTab) ? chartTab : tabs.activeTabId());
              }}
              onLogs={(scriptId) => {
                const chartTab = link().chartTab;
                if (!tabs.tabOf(chartTab)) return;
                tabs.activateTab(chartTab);
                openScriptLogs({ scriptId });
              }}
            />
          </div>
        )}
      </Show>
    );
  }

  return { openOut, EditorTabView };
}
