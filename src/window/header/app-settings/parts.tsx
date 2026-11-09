/*
 * Pieces shared by the Settings tabs.
 */
import { createSignal, onCleanup, type JSX } from "solid-js";

export function Section(props: { label: string; children: JSX.Element }) {
  return (
    <section class="app-settings-section">
      <label class="app-settings-section-label">{props.label}</label>
      <div class="app-settings-section-content">{props.children}</div>
    </section>
  );
}

/** Two-click confirm: the first click arms the button (label swaps to
 *  `confirmLabel`) and a timeout disarms it; the second click runs `action`. */
export function ConfirmButton(props: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = createSignal(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  return (
    <button
      type="button"
      class={`app-settings-btn${armed() ? " is-armed" : ""}`}
      onClick={() => {
        if (!armed()) {
          setArmed(true);
          timer = window.setTimeout(() => setArmed(false), 4000);
          return;
        }
        window.clearTimeout(timer);
        setArmed(false);
        props.onConfirm();
      }}
    >
      {armed() ? props.confirmLabel : props.label}
    </button>
  );
}
