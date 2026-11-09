/*
 * The study Settings dialog of the chart (legend gear, double click, menus):
 * every change is drawn at once and saved as an undo step through the pane's
 * store (chart-edits editStudySettings); Cancel takes the dialog's steps back.
 */
import { Show, type JSX } from "solid-js";
import type { Bar } from "oakscriptjs";
import { IndicatorSettingsDialog } from "../IndicatorSettingsDialog";
import { getIndicatorEntry } from "../indicators/registry";
import { isStrategyId } from "../indicators/strategy-entries";
import { typeIdOf } from "../indicators/study-id";
import { settingsUndoText } from "../indicators/settings-undo-text";
import { outputValueRows, styleItems, type StyleEntry } from "../indicators/style-outputs";
import type { IndicatorStyleOverrides } from "../indicators/indicator-layer";
import type { IndicatorOptions } from "../indicators/indicator-options";
import { profileMetaOf } from "../profiles/vbp-studies";
import { isTpoEntry } from "../profiles/tpo";
import { autoTicksPerRow } from "../profiles/tpo-engine";
import { saveIndicatorDefault } from "../../../data/indicator-defaults";
import { cachedSymbolSessions } from "../../../data/session";
import { type ChartCx } from "./context";

/** What createStudySettings adds to the chart context. */
export interface StudySettingsApi {
  /** The open study's Settings dialog (nothing while none is open). */
  StudySettingsDialog: () => JSX.Element;
}

export function createStudySettings(cx: ChartCx): StudySettingsApi {
  const { paneId, props } = cx;
  const legendAtCrosshair = () => cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);

  function StudySettingsDialog() {
    return (
      <Show when={cx.settingsForId()}>
        {(id) => {
          const controller = cx.controller;
          const entry = getIndicatorEntry(id());
          const values = controller?.getInputs(id());
          const styles = controller?.getStyles(id());
          // Read once: the dialog's controls may call back while it closes.
          const strategy = values ? cx.strategyDialogConfig(id(), values) : undefined;
          const tab = cx.settingsTab();
          // The study as it was when the dialog opened: Cancel puts it back after a preview.
          const snapshot = controller?.settingsSnapshot(id());
          // Every change is drawn and saved as it is made, one undo step each (the reference app), the keystrokes of
          // one field as one step; Cancel takes the dialog's steps back. `shown`: the settings last drawn.
          const session = `${paneId}:${id()}:${Date.now()}`;
          let shown = JSON.stringify({ inputs: values ?? {}, styles: styles ?? {}, options: controller?.getOptions(id()) });
          const step = (next: { inputs: Record<string, unknown>; styles: IndicatorStyleOverrides; options: IndicatorOptions }) => {
            const was = JSON.parse(shown) as typeof next;
            const title = cx.indLegend().find((r) => r.id === id())?.title ?? entry!.name;
            const { key, label } = settingsUndoText(was, next, entry!.inputConfig ?? [], title);
            shown = JSON.stringify(next);
            cx.controller?.previewSettings(id(), next.inputs, next.styles, next.options);
            cx.edits.editStudySettings(id(), { inputs: next.inputs, styles: next.styles, options: next.options }, label, { coalesce: `${session}:${key}`, session });
          };
          const redrawn = () => {
            legendAtCrosshair();
            if (isStrategyId(id())) cx.applyStrategyMarkers();
          };
          return (
            <Show when={entry && values && styles}>
              <IndicatorSettingsDialog
                title={isStrategyId(id()) || profileMetaOf(entry) || isTpoEntry(entry) ? (entry!.shortName ?? entry!.name) : entry!.name}
                strategy={strategy}
                profile={profileMetaOf(entry) ?? undefined}
                tpo={isTpoEntry(entry) ? { autoTicksPerRow: autoTicksPerRow(cx.raw as unknown as Bar[], cachedSymbolSessions(props.symbol ?? "")?.mintick ?? 0.01) } : undefined}
                timeZone={cachedSymbolSessions(props.symbol ?? "")?.timeZone}
                initialTab={tab}
                inputConfig={entry!.inputConfig}
                sourceChoices={cx.sourceChoicesFor(id())}
                plotConfig={entry!.plotConfig}
                styleItems={styleItems(entry! as unknown as StyleEntry)}
                valueRows={outputValueRows(entry! as unknown as Parameters<typeof outputValueRows>[0])}
                onPreview={(next) => {
                  if (next) step(next);
                  else {
                    // Cancel (or back to the opening values): the study as it was, the dialog's steps taken back.
                    if (snapshot) cx.controller?.restoreSettings(id(), snapshot);
                    cx.edits.rollbackSources(session);
                  }
                  redrawn();
                }}
                inputs={values!}
                styles={styles!}
                options={controller!.getOptions(id())}
                onApply={(next) => {
                  // Ok: the changes are drawn and saved already; one not drawn yet is a step of its own.
                  if (JSON.stringify(next) !== shown) step(next);
                  redrawn();
                }}
                onSaveAsDefault={(next) => saveIndicatorDefault(typeIdOf(id()), next)}
                onClose={() => {
                  cx.setSettingsForId(null);
                  cx.setSettingsTab(undefined);
                }}
              />
            </Show>
          );
        }}
      </Show>
    );
  }

  return { StudySettingsDialog };
}
