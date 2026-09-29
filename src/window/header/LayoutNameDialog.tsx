/*
 * LayoutNameDialog — a small centred modal for naming a chart layout. Backs
 * the header "Manage layouts" actions that need a name: Save (when the active
 * chart is still untitled), Rename, and Make a copy.
 *
 * A name-prompt dialog with the shared dialog tokens (same look as
 * GoToDateDialog): titlebar + close, a single labelled text input, and a
 * Cancel / <submit> footer. Enter submits, Escape / backdrop click cancels.
 */
import { createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

type Props = {
  title: string;
  /** Footer primary-button text (e.g. "Save", "Rename"). */
  submitLabel: string;
  /** Pre-filled value; the input is focused + selected on mount. */
  initialValue?: string;
  /** Label above the input. */
  fieldLabel?: string;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <Portal mount={document.body}>
      <div class="layout-name-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
        <div
          ref={root}
          class="ot-popover layout-name-dialog"
          role="dialog"
          aria-label={props.title}
          data-name="layout-name-dialog"
        >
          <div class="layout-name-titlebar">
            <div class="layout-name-title">{props.title}</div>
            <button type="button" class="layout-name-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg viewBox="0 0 28 28" width="24" height="24">
                <path fill="currentColor" d="M19.78 8.22 14 14l5.78 5.78-1.06 1.06L13 15.06l-5.78 5.78-1.06-1.06L11.94 14 6.16 8.22l1.06-1.06L13 12.94l5.72-5.78 1.06 1.06Z" />
              </svg>
            </button>
          </div>
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
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          </div>
          <div class="layout-name-footer">
            <button type="button" class="layout-name-btn is-secondary" onClick={() => props.onClose()}>Cancel</button>
            <button type="button" class="layout-name-btn is-primary" data-name="submit-button" onClick={submit}>
              {props.submitLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
