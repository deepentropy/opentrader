/*
 * Dialogs of the saved chart layouts (saved-layouts.ts): the naming dialog
 * (save as / rename / copy / create), and the "Save layout before
 * switching?" / "Download chart data" / "Open layout" dialogs. Two
 * components so App keeps them at their places among the other dialogs.
 */
import { Show } from "solid-js";
import { LayoutNameDialog } from "../header/LayoutNameDialog";
import { UnsavedLayoutDialog } from "../header/UnsavedLayoutDialog";
import { DownloadChartDataDialog } from "../header/DownloadChartDataDialog";
import { LayoutBrowserDialog } from "../header/LayoutBrowserDialog";
import { savedLayouts, toggleFavoriteLayout } from "../../data/layout-store";
import type { SavedLayouts } from "./saved-layouts";

/** Naming dialog of a saved layout. */
export function LayoutNamingDialog(props: { layouts: SavedLayouts }) {
  const l = props.layouts;
  return (
    <Show when={l.layoutNameDialog()}>
      {(dlg) => (
        <LayoutNameDialog
          title={
            dlg().mode === "rename"
              ? "Rename chart layout"
              : dlg().mode === "copy"
                ? "Copy chart layout"
                : dlg().mode === "create"
                  ? "Create layout"
                  : "Save new chart layout"
          }
          submitLabel={dlg().mode === "rename" ? "Rename" : dlg().mode === "create" ? "Create" : "Save"}
          initialValue={dlg().initial}
          {...(dlg().mode === "create"
            ? {
                fieldLabel: "New layout name",
                placeholder: "My layout",
                maxLength: 64,
                checkbox: { label: "Open in new tab", checked: l.createInNewTab(), onChange: l.setCreateInNewTab },
              }
            : {})}
          onSubmit={l.submitLayoutName}
          onClose={l.closeLayoutNameDialog}
        />
      )}
    </Show>
  );
}

/** Unsaved-changes question, chart data download and the layout browser. */
export function SavedLayoutDialogs(props: { layouts: SavedLayouts; activeId: string | undefined }) {
  const l = props.layouts;
  return (
    <>
      <Show when={l.pendingOpenId()}>
        <UnsavedLayoutDialog
          onSave={() => l.resolvePendingOpen("save")}
          onDontSave={() => l.resolvePendingOpen("dontSave")}
          onCancel={() => l.resolvePendingOpen("cancel")}
        />
      </Show>
      <Show when={l.downloadDataOpen()}>
        <DownloadChartDataDialog onClose={() => l.setDownloadDataOpen(false)} />
      </Show>
      <Show when={l.layoutBrowserOpen()}>
        <LayoutBrowserDialog
          layouts={savedLayouts()}
          activeId={props.activeId}
          summaryOf={l.summaryOfLayout}
          onOpen={l.requestOpenLayout}
          onDelete={l.deleteSavedLayout}
          onToggleFavorite={toggleFavoriteLayout}
          onClose={() => l.setLayoutBrowserOpen(false)}
        />
      </Show>
    </>
  );
}
