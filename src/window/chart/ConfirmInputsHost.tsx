/*
 * The "Confirm Inputs" dialog of a study being added (confirm-inputs.ts): its confirm inputs with Apply; Cancel, the
 * close button, Escape and a click outside add nothing. Rendered once by App.
 */
import { Show, type JSX } from "solid-js";
import { IndicatorSettingsDialog } from "./IndicatorSettingsDialog";
import { defaultIndicatorOptions } from "./indicators/indicator-options";
import { closeConfirmDialog, confirmDialog } from "./confirm-inputs";

export function ConfirmInputsHost(): JSX.Element {
  return (
    <Show when={confirmDialog()} keyed>
      {(req) => {
        let applied: Record<string, unknown> | null = null;
        let done = false;
        const finish = (v: Record<string, unknown> | null) => {
          if (done) return;
          done = true;
          closeConfirmDialog(req, v);
        };
        return (
          <IndicatorSettingsDialog
            title={req.title}
            inputConfig={req.inputConfig}
            plotConfig={[]}
            inputs={req.inputs}
            styles={{}}
            options={defaultIndicatorOptions()}
            inputsOnly
            timeZone={req.timeZone}
            confirmInputs={{ onCancel: () => finish(null) }}
            onApply={(next) => (applied = next.inputs)}
            onOk={() => (applied ??= {})}
            onSaveAsDefault={() => {}}
            onClose={() => finish(applied ? { ...req.inputs, ...applied } : null)}
          />
        );
      }}
    </Show>
  );
}
