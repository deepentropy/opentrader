/*
 * AddAlertDialog — the watchlist menu's "Add alert on the list…" action. A small
 * modal to set a local price-move alert for the active list: notify when any
 * symbol's absolute change% crosses the threshold. Evaluated against the live
 * tick stream in Watchlist.tsx. Local alerts (no server side).
 */
import { createSignal, onMount, Show } from "solid-js";
import { Dialog } from "../../components/Dialog";

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
  });

  return (
    <Dialog
      look="watchlist"
      layerClass="wl-dialog-backdrop"
      backdrop="close"
      class="wl-dialog wl-dialog--narrow"
      label="Add alert"
      title={<>Alert · {props.listName}</>}
      onClose={props.onClose}
      keys={{ target: "document" }}
      onEnter={(e) => { e.preventDefault(); save(); }}
    >
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
    </Dialog>
  );
}
