/*
 * LayoutNameDialog — a small centred modal for naming a chart layout. Backs
 * the header "Manage layouts" actions that need a name: Save (when the active
 * chart is still untitled), Rename, and Make a copy.
 *
 * A name-prompt dialog with the shared dialog tokens (same look as
 * GoToDateDialog): titlebar + close, a single labelled text input, and a
 * Cancel / <submit> footer. Enter submits, Escape / backdrop click cancels.
 */
import { createSignal, onMount } from "solid-js";
import { Show } from "solid-js";
import { CheckBox } from "../../components/form";
import { Dialog } from "../../components/Dialog";

type Props = {
  title: string;
  /** Footer primary-button text (e.g. "Save", "Rename"). */
  submitLabel: string;
  /** Pre-filled value; the input is focused + selected on mount. */
  initialValue?: string;
  /** Label above the input. */
  fieldLabel?: string;
  placeholder?: string;
  maxLength?: number;
  /** A check box under the field (Create layout: "Open in new tab"). */
  checkbox?: { label: string; checked: boolean; onChange: (v: boolean) => void };
  onSubmit: (name: string) => void;
  onClose: () => void;
};

export function LayoutNameDialog(props: Props) {
  const [value, setValue] = createSignal(props.initialValue ?? "");
  let input!: HTMLInputElement;
  let root!: HTMLDivElement;

  const submit = () => {
    const name = value().trim();
    if (!name) {
      input.focus();
      return;
    }
    props.onSubmit(name);
    props.onClose();
  };

  onMount(() => {
    input.focus();
    input.select();
  });

  return (
    <Dialog
      look="form"
      layerClass="layout-name-backdrop"
      backdrop="close-self"
      class="ot-popover layout-name-dialog"
      ref={root}
      data-name="layout-name-dialog"
      title={props.title}
      onClose={props.onClose}
      onEnter={submit}
    >
      <div class="layout-name-body">
        <label class="layout-name-field-label" for="layout-name-input">
          {props.fieldLabel ?? "Layout name"}
        </label>
        <input
          ref={input}
          id="layout-name-input"
          class="layout-name-input"
          type="text"
          value={value()}
          placeholder={props.placeholder}
          maxLength={props.maxLength}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <Show when={props.checkbox}>
          {(cb) => (
            <label class="layout-name-check" onClick={(e) => { e.preventDefault(); if (!(e.target as HTMLElement).closest(".cp3-checkbox")) cb().onChange(!cb().checked); }}>
              <CheckBox checked={cb().checked} onToggle={() => cb().onChange(!cb().checked)} />
              <span>{cb().label}</span>
            </label>
          )}
        </Show>
      </div>
      <div class="layout-name-footer">
        <button type="button" class="layout-name-btn is-secondary" onClick={() => props.onClose()}>Cancel</button>
        <button type="button" class="layout-name-btn is-primary" data-name="submit-button" aria-disabled={!value().trim()} disabled={!value().trim()} onClick={submit}>
          {props.submitLabel}
        </button>
      </div>
    </Dialog>
  );
}
