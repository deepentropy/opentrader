/*
 * Controls of the drawing Settings dialog that only it has: rows, the bold / italic toggles and the stats
 * multi-select. Check boxes, selects, value fields and colour buttons are the shared form kit (components/form).
 */
import { createSignal, For, Show } from "solid-js";
import { CheckMarkBox } from "../../../components/form";
import { Chevron } from "../../../components/form/glyphs";
import { createPopover } from "../../../components/popover";

export function DialogRow(props: { label?: string; children: import("solid-js").JSX.Element }) {
  return (
    <div class="drawing-settings-row">
      {props.label && <div class="drawing-settings-row-label">{props.label}</div>}
      <div class="drawing-settings-row-inputs">{props.children}</div>
    </div>
  );
}

/** Bold / italic toggle buttons (text style rows). */
export function FontStyleToggles(props: { bold: boolean; italic: boolean; onBold: (v: boolean) => void; onItalic: (v: boolean) => void }) {
  return (
    <>
      <button type="button" class={"drawing-settings-text-toggle" + (props.bold ? " active" : "")} aria-pressed={props.bold} title="Bold" onClick={() => props.onBold(!props.bold)}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M14 21h-3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3c2 0 4 1 4 3 0 1 0 2-1.5 3 1.5.5 2.5 2 2.5 4 0 2.75-2.638 4-5 4zM12 9l.004 3c.39.026.82 0 1.25 0C14.908 12 16 11.743 16 10.5c0-1.1-.996-1.5-2.5-1.5-.397 0-.927-.033-1.5 0zm0 5v5h1.5c1.5 0 3.5-.5 3.5-2.5S15 14 13.5 14c-.5 0-.895-.02-1.5 0z" /></svg>
      </button>
      <button type="button" class={"drawing-settings-text-toggle" + (props.italic ? " active" : "")} aria-pressed={props.italic} title="Italic" onClick={() => props.onItalic(!props.italic)}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12.143 20l1.714-12H12V7h5v1h-2.143l-1.714 12H15v1h-5v-1h2.143z" /></svg>
      </button>
    </>
  );
}

/** Stats multi-select: a select-look button whose label is the
 *  comma-joined enabled stats; opens a checklist of the 7 stat flags. */
export function StatsMultiSelect(props: {
  fields: ReadonlyArray<readonly [string, string]>;
  /** Summary when nothing is on ("Hidden"; extend lists "Don't extend"). */
  emptyLabel?: string;
  isOn: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0, width: 0 });
  let rootEl: HTMLDivElement | undefined;
  let btnEl: HTMLButtonElement | undefined;
  const summary = () => {
    const on = props.fields.filter(([key]) => props.isOn(key)).map(([, label]) => label);
    return on.length ? on.join(", ") : props.emptyLabel ?? "Hidden";
  };
  // The dialog body scrolls (overflow-y:auto), so an absolutely-positioned menu
  // clips at the body edge — open it fixed, anchored under the button and
  // clamped to the viewport (as the colour panel).
  const openMenu = () => {
    const r = btnEl!.getBoundingClientRect();
    setPos({ left: r.left, top: Math.min(r.bottom + 4, window.innerHeight - 8), width: r.width });
    setOpen(true);
  };
  // Escape closes just this menu; the dialog's own Escape defers while it's open.
  const menuRef = createPopover(() => rootEl, { onClose: () => setOpen(false), placement: false, active: open });
  return (
    <div class="drawing-settings-multiselect" ref={rootEl}>
      <button
        ref={btnEl}
        type="button"
        class="drawing-settings-multiselect-btn"
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : openMenu())}
      >
        <span class="drawing-settings-multiselect-label">{summary()}</span>
        <span class="drawing-settings-chevron"><Chevron /></span>
      </button>
      <Show when={open()}>
        <div
          ref={menuRef}
          class="drawing-settings-multiselect-menu"
          role="listbox"
          aria-multiselectable="true"
          style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "min-width": `${pos().width}px` }}
        >
          <For each={props.fields}>
            {([key, label]) => (
              <label class="drawing-settings-checkbox-row drawing-settings-multiselect-option" role="option" aria-selected={props.isOn(key)}>
                <CheckMarkBox checked={props.isOn(key)} variant="drawing">
                  <input type="checkbox" checked={props.isOn(key)} onChange={(e) => props.onToggle(key, e.currentTarget.checked)} />
                </CheckMarkBox>
                <span class="drawing-settings-checkbox-label">{label}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
