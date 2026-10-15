/*
 * Shared form controls of the drawing Settings dialog: rows, selects,
 * decimal fields, check boxes, the stats multi-select, and the colour /
 * colour-with-thickness buttons with their fixed colour panel.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { LineStyle } from "lightweight-charts-drawing/core/types";
import { ColorPanel } from "../ColorPanel";

export function DialogRow(props: { label?: string; children: import("solid-js").JSX.Element }) {
  return (
    <div class="drawing-settings-row">
      {props.label && <div class="drawing-settings-row-label">{props.label}</div>}
      <div class="drawing-settings-row-inputs">{props.children}</div>
    </div>
  );
}

/** Select: 100 px; `wide` = 180 px (Stats position), `mid` = 150 px
 *  (Elliott Degree). */
export function Dropdown(props: { value: string; options: string[]; onChange: (v: string) => void; wide?: boolean; mid?: boolean }) {
  return (
    <select
      class={"drawing-settings-select" + (props.wide ? " wide" : props.mid ? " mid" : "")}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    >
      <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
    </select>
  );
}

/** Decimal field written with a dot and fixed decimals (a
 *  type="number" input would follow the system locale, e.g. "25,00").
 *  `digits` unset = the plain number ("0.382"). Invalid text reverts on
 *  commit. Every value field is 100 x 34 (`narrow` kept for callers). */
export function DecimalInput(props: { value: number; digits?: number; narrow?: boolean; onCommit: (v: number) => void }) {
  const text = () => (props.digits == null ? String(props.value) : props.value.toFixed(props.digits));
  return (
    <input
      type="text"
      inputmode="decimal"
      class={"drawing-settings-level-coeff" + (props.narrow ? "" : " is-wide")}
      value={text()}
      onChange={(e) => {
        const v = parseFloat(e.currentTarget.value);
        if (Number.isFinite(v)) props.onCommit(v);
        else e.currentTarget.value = text();
      }}
    />
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

/** Check box without a title (level rows). */
export function CheckBox(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label class={"drawing-settings-checkbox-row" + (props.disabled ? " disabled" : "")}>
      <span class={"drawing-settings-checkbox-box" + (props.checked ? " checked" : "")}>
        <Show when={props.checked}>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
          </svg>
        </Show>
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      </span>
    </label>
  );
}

export function CheckboxRow(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="drawing-settings-checkbox-row">
      <span class={"drawing-settings-checkbox-box" + (props.checked ? " checked" : "")}>
        <Show when={props.checked}>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
          </svg>
        </Show>
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
      </span>
      <span class="drawing-settings-checkbox-label">{props.label}</span>
    </label>
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
  let menuEl: HTMLDivElement | undefined;
  const summary = () => {
    const on = props.fields.filter(([key]) => props.isOn(key)).map(([, label]) => label);
    return on.length ? on.join(", ") : props.emptyLabel ?? "Hidden";
  };
  // The dialog body scrolls (overflow-y:auto), so an absolutely-positioned menu
  // clips at the body edge — open it fixed, anchored under the button and
  // clamped to the viewport (mirrors FixedColorPanel).
  const openMenu = () => {
    const r = btnEl!.getBoundingClientRect();
    setPos({ left: r.left, top: Math.min(r.bottom + 4, window.innerHeight - 8), width: r.width });
    setOpen(true);
  };
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!open()) return;
      const t = e.target as Node;
      if (rootEl?.contains(t) || menuEl?.contains(t)) return;
      setOpen(false);
    };
    // Escape closes just this menu; the dialog's own Escape defers while it's open.
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
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
        <span class="drawing-settings-chevron"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg></span>
      </button>
      <Show when={open()}>
        <div
          ref={menuEl}
          class="drawing-settings-multiselect-menu"
          role="listbox"
          aria-multiselectable="true"
          style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "min-width": `${pos().width}px` }}
        >
          <For each={props.fields}>
            {([key, label]) => (
              <label class="drawing-settings-checkbox-row drawing-settings-multiselect-option" role="option" aria-selected={props.isOn(key)}>
                <span class={"drawing-settings-checkbox-box" + (props.isOn(key) ? " checked" : "")}>
                  <Show when={props.isOn(key)}>
                    <svg viewBox="0 0 16 16" width="12" height="12">
                      <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
                    </svg>
                  </Show>
                  <input
                    type="checkbox"
                    checked={props.isOn(key)}
                    onChange={(e) => props.onToggle(key, e.currentTarget.checked)}
                  />
                </span>
                <span class="drawing-settings-checkbox-label">{label}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Fixed-position ColorPanel host: opens under an anchor button, clamped to
 *  the viewport, scrolls internally (the panel extends past the dialog). */
function FixedColorPanel(props: {
  anchor: () => HTMLElement | undefined;
  onDismiss: () => void;
  children: import("solid-js").JSX.Element;
}) {
  let panelEl: HTMLDivElement | undefined;
  const rect = props.anchor()?.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect?.left ?? 0, window.innerWidth - 258));
  const top = Math.min((rect?.bottom ?? 0) + 4, window.innerHeight - 120);
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelEl?.contains(t) || props.anchor()?.contains(t)) return;
      props.onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onDismiss(); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  return (
    <div
      ref={panelEl}
      class="dt-popover dlg-color-panel"
      style={{ position: "fixed", left: `${left}px`, top: `${top}px`, "max-height": `${window.innerHeight - top - 8}px` }}
    >
      {props.children}
    </div>
  );
}

/** Plain color swatch button (text color / fill color) opening the panel. */
export function DialogColorButton(props: { color: string; onColor: (c: string) => void; mixed?: boolean }) {
  const [open, setOpen] = createSignal(false);
  let btnEl: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        class="drawing-settings-color-swatch"
        aria-label="Color"
        aria-haspopup="dialog"
        aria-expanded={open()}
        ref={btnEl}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          class="drawing-settings-color-swatch-fill"
          // Mixed-colour placeholder: red / teal split along the diagonal.
          style={props.mixed ? { background: "linear-gradient(to top right, #f7525f 50%, #22ab94 50%)" } : { "--swatch-color": props.color }}
        />
      </button>
      <Show when={open()}>
        <FixedColorPanel anchor={() => btnEl} onDismiss={() => setOpen(false)}>
          <ColorPanel value={props.color} onChange={props.onColor} onPicked={() => setOpen(false)} />
        </FixedColorPanel>
      </Show>
    </>
  );
}

/** Composite `color-with-thickness-select` (75×34: swatch + current-width
 *  line preview) — opens ONE panel carrying swatches + opacity + Thickness +
 *  Line style sections (250×436). */
export function ColorThicknessPicker(props: {
  color: string;
  width: number;
  lineStyle?: LineStyle;
  onColor: (c: string) => void;
  onWidth: (w: number) => void;
  /** Omitted → no "Line style" section (polyline). */
  onLineStyle?: (s: LineStyle) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let btnEl: HTMLButtonElement | undefined;
  const lineCss = () =>
    `${Math.max(props.width, 1)}px ${props.lineStyle === "dashed" ? "dashed" : props.lineStyle === "dotted" ? "dotted" : "solid"} ${props.color}`;
  return (
    <span class="drawing-settings-color-thickness">
      <button
        type="button"
        class="dlg-color-thickness-btn"
        data-name="color-with-thickness-select"
        aria-haspopup="dialog"
        aria-expanded={open()}
        ref={btnEl}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="dlg-ct-swatch" style={{ "--swatch-color": props.color }} />
        <span class="dlg-ct-line" style={{ "border-top": lineCss() }} />
      </button>
      <Show when={open()}>
        <FixedColorPanel anchor={() => btnEl} onDismiss={() => setOpen(false)}>
          <ColorPanel
            value={props.color}
            onChange={props.onColor}
            onPicked={() => setOpen(false)}
            thickness={props.width}
            onThickness={(w) => { props.onWidth(w); setOpen(false); }}
            lineStyle={props.lineStyle}
            onLineStyle={props.onLineStyle ? (s) => { props.onLineStyle!(s); setOpen(false); } : undefined}
          />
        </FixedColorPanel>
      </Show>
    </span>
  );
}
