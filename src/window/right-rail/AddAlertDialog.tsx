/*
 * AddAlertDialog — the watchlist menu's "Add alert on the list…" action. A small
 * modal to set a local price-move alert for the active list: notify when any
 * symbol's absolute change% crosses the threshold. Evaluated against the live
 * tick stream in Watchlist.tsx. Local alerts (no server side).
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

type Props = {
  listName: string;
  /** Existing threshold for this list, or undefined when none is set yet. */
  initial: number | undefined;
  onSave: (threshold: number) => void;
  onRemove: () => void;
  onClose: () => void;
};

export function AddAlertDialog(props: Props) {
  const [value, setValue] = createSignal(props.initial != null ? String(props.initial) : "5");
  let input!: HTMLInputElement;

  const save = () => {
    const n = parseFloat(value());
    if (Number.isFinite(n) && n > 0) {
      props.onSave(n);
      props.onClose();
    }
  };

  onMount(() => {
    input.focus();
    input.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  return (
    <Portal mount={document.body}>
      <div class="wl-dialog-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div class="wl-dialog wl-dialog--narrow" role="dialog" aria-label="Add alert" onMouseDown={(e) => e.stopPropagation()}>
          <header class="wl-dialog-header">
            <span class="wl-dialog-title">Alert · {props.listName}</span>
            <button type="button" class="wl-dialog-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
                <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
              </svg>
            </button>
          </header>
          <div class="wl-dialog-body">
            <p class="wl-dialog-text">Notify me when any symbol in this list moves by at least:</p>
            <div class="wl-dialog-field">
              <input
                ref={input}
                class="wl-dialog-input"
                type="number"
                min="0"
                step="0.5"
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
              />
              <span class="wl-dialog-suffix">% (absolute change)</span>
            </div>
          </div>
          <footer class="wl-dialog-footer">
            <Show when={props.initial != null}>
              <button
                type="button"
                class="wl-dialog-btn wl-dialog-btn--danger"
                onClick={() => {
                  props.onRemove();
                  props.onClose();
                }}
              >
                Remove
              </button>
            </Show>
            <span class="wl-dialog-spacer" />
            <button type="button" class="wl-dialog-btn" onClick={() => props.onClose()}>Cancel</button>
            <button type="button" class="wl-dialog-btn wl-dialog-btn--primary" onClick={save}>Save</button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
