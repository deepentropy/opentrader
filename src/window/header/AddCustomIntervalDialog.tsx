/*
 * "Add custom interval" dialog (the reference app's interval-menu dialog):
 * a Type select (minutes, hours, days, weeks, months) and a numeric
 * Interval field (digits only, 6 at most). Add is disabled while the value
 * is empty / 0 or wrong; the errors are "too big" (over the type's limit)
 * and "already exists" (a built-in or custom interval with that id). Enter
 * adds, Escape / backdrop / Cancel close.
 */
import { createSignal, onMount, Show } from "solid-js";
import { SelectControl } from "../../components/form";
import {
  CUSTOM_INTERVAL_TYPES,
  isValidCustomInterval,
  normalizeCustomInterval,
} from "../chart/custom-intervals";
import { Dialog } from "../../components/Dialog";

const ERRORS = {
  invalid: "Interval value is too big, please try again",
  already_exists: "Interval already exists, please use a different value",
} as const;

export function AddCustomIntervalDialog(props: {
  /** True when the id is already in the menu (built-in or custom). */
  exists: (id: string) => boolean;
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [suffix, setSuffix] = createSignal("");
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<keyof typeof ERRORS | null>(null);
  let input!: HTMLInputElement;

  /** Validate `v` for type `s`; sets the error and tells whether it can be added. */
  const check = (s: string, v: string): boolean => {
    if (!Number(v)) {
      setError(null);
      return true;
    }
    if (!isValidCustomInterval(v, s)) {
      setError("invalid");
      return false;
    }
    if (props.exists(normalizeCustomInterval(v, s))) {
      setError("already_exists");
      return false;
    }
    setError(null);
    return true;
  };

  const canSubmit = () => !!Number(value()) && error() === null;
  const submit = () => {
    if (!canSubmit() || !check(suffix(), value())) return;
    props.onAdd(normalizeCustomInterval(value(), suffix()));
    props.onClose();
  };

  onMount(() => input.focus());

  const labelOf = (s: string) => CUSTOM_INTERVAL_TYPES.find((t) => t.suffix === s)?.label ?? s;

  return (
    <Dialog
      look="form"
      layerClass="layout-name-backdrop custom-interval-backdrop"
      backdrop="close-self"
      class="ot-popover layout-name-dialog custom-interval-dialog"
      data-name="add-custom-interval-dialog"
      title="Add custom interval"
      onClose={props.onClose}
      onEnter={(e) => { e.preventDefault(); submit(); }}
    >
      <div class="custom-interval-content">
        <div class="custom-interval-row">
          <div class="custom-interval-title">Type</div>
          <SelectControl
            value={labelOf(suffix())}
            options={CUSTOM_INTERVAL_TYPES.map((t) => t.label)}
            width={180}
            onPick={(label) => {
              const s = CUSTOM_INTERVAL_TYPES.find((t) => t.label === label)?.suffix ?? "";
              setSuffix(s);
              check(s, value());
            }}
          />
        </div>
        <div class="custom-interval-row">
          <div class="custom-interval-title">Interval</div>
          <div class="custom-interval-input-wrap">
            <div class="cp3-number custom-interval-input" classList={{ "has-error": error() !== null }}>
              <input
                ref={input}
                type="text"
                inputmode="numeric"
                maxLength={6}
                value={value()}
                spellcheck={false}
                autocomplete="off"
                aria-invalid={error() !== null || undefined}
                onInput={(e) => {
                  const v = e.currentTarget.value;
                  if (/^[0-9]*$/.test(v)) {
                    setValue(v);
                    check(suffix(), v);
                  } else {
                    e.currentTarget.value = value();
                  }
                }}
              />
            </div>
            <Show when={error()}>
              {(err) => <div class="custom-interval-error" role="alert">{ERRORS[err()]}</div>}
            </Show>
          </div>
        </div>
      </div>
      <div class="layout-name-footer">
        <button type="button" class="layout-name-btn is-secondary" onClick={() => props.onClose()}>Cancel</button>
        <button
          type="button"
          class="layout-name-btn is-primary"
          data-name="submit-button"
          disabled={!canSubmit()}
          classList={{ "is-disabled": !canSubmit() }}
          onClick={submit}
        >
          Add
        </button>
      </div>
    </Dialog>
  );
}
