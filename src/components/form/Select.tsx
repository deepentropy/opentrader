/*
 * Selects.
 *
 * `SelectControl`: the Settings dialogs' select — a 34 px transparent r8 button with the 18 px chevron and an r10
 * option menu flush under it, trigger-wide, flipped above without room below. `MultiCheckSelect` is the same button
 * over a check list that stays open while options are toggled. `NativeSelect` is a plain <select> (drawing
 * Settings), styled by its class.
 */
import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { createPopover } from "../popover";
import { CheckBox } from "./CheckBox";
import { Chevron } from "./glyphs";

type Anchor = { left: number; top: number; bottom: number; width: number };
const anchorOf = (el: HTMLElement): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
};

function OptionsMenu(props: {
  anchor: Anchor;
  trigger: () => HTMLElement | undefined;
  children: JSX.Element;
  onClose: () => void;
  role?: "listbox" | "menu";
}) {
  let ref: HTMLDivElement | undefined;
  const popover = createPopover(props.trigger, { onClose: props.onClose, placement: false });
  // Under the trigger; above it when there is no room below.
  const [top, setTop] = createSignal(props.anchor.bottom);
  onMount(() => {
    if (!ref) return;
    const h = ref.offsetHeight;
    if (props.anchor.bottom + h > window.innerHeight - 4) setTop(Math.max(4, props.anchor.top - h));
  });
  return (
    <div
      ref={(el) => { ref = el; popover(el); }}
      class="cp3-menu"
      role={props.role ?? "listbox"}
      style={{ left: `${props.anchor.left}px`, top: `${top()}px`, "min-width": `${props.anchor.width}px` }}
    >
      {props.children}
    </div>
  );
}

export function SelectControl(props: {
  value: string;
  options: string[];
  width: number;
  disabled?: boolean;
  /** Options shown but not selectable. */
  disabledOptions?: string[];
  /** Right-aligned tag of an option (e.g. the chart currency). */
  optionTag?: (o: string) => string | undefined;
  /** Closed-control text when it differs from the value. */
  display?: string;
  /** Option text when the options are ids (default: the option itself). */
  labelOf?: (o: string) => string;
  onPick: (v: string) => void;
}) {
  let btn: HTMLButtonElement | undefined;
  const [anchor, setAnchor] = createSignal<Anchor | null>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${props.disabled ? " is-disabled" : ""}${anchor() ? " is-open" : ""}`}
        style={{ width: `${props.width}px` }}
        aria-haspopup="listbox"
        aria-expanded={!!anchor()}
        disabled={props.disabled}
        onClick={() => (anchor() ? setAnchor(null) : setAnchor(anchorOf(btn!)))}
      >
        <span class="cp3-select-value">{props.display ?? props.labelOf?.(props.value) ?? props.value}</span>
        <span class="cp3-select-caret"><Chevron /></span>
      </button>
      <Show when={anchor()} keyed>
        {(a) => (
          <OptionsMenu anchor={a} trigger={() => btn} onClose={() => setAnchor(null)}>
            <For each={props.options}>
              {(o) => (
                <div
                  role="option"
                  aria-checked={o === props.value}
                  aria-disabled={props.disabledOptions?.includes(o) || undefined}
                  class={`cp3-menu-item${o === props.value ? " is-selected" : ""}${props.disabledOptions?.includes(o) ? " is-disabled" : ""}`}
                  onClick={() => { if (props.disabledOptions?.includes(o)) return; props.onPick(o); setAnchor(null); }}
                >
                  <span class="cp3-menu-title">{props.labelOf?.(o) ?? o}</span>
                  <Show when={props.optionTag?.(o)}>
                    {(tag) => <span class="cp3-menu-tag">{tag()}</span>}
                  </Show>
                </div>
              )}
            </For>
          </OptionsMenu>
        )}
      </Show>
    </>
  );
}

/** Closed-control text for a check list: checked options in catalog order,
 *  the first as is and the rest lower-cased ("Value, line"); none checked
 *  reads "Hidden". */
function multiSummary(options: string[], on: string[]): string {
  const picked = options.filter((o) => on.includes(o));
  if (picked.length === 0) return "Hidden";
  return picked.map((o, i) => (i === 0 ? o : o.toLowerCase())).join(", ");
}

/** Check-list select: toggling an option keeps the menu open. */
export function MultiCheckSelect(props: { options: string[]; on: string[]; width: number; onChange: (on: string[]) => void }) {
  let btn: HTMLButtonElement | undefined;
  const [anchor, setAnchor] = createSignal<Anchor | null>(null);
  const toggle = (o: string) =>
    props.onChange(props.on.includes(o) ? props.on.filter((x) => x !== o) : [...props.on, o]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${anchor() ? " is-open" : ""}`}
        style={{ width: `${props.width}px` }}
        aria-haspopup="menu"
        aria-expanded={!!anchor()}
        onClick={() => (anchor() ? setAnchor(null) : setAnchor(anchorOf(btn!)))}
      >
        <span class="cp3-select-value">{multiSummary(props.options, props.on)}</span>
        <span class="cp3-select-caret"><Chevron /></span>
      </button>
      <Show when={anchor()} keyed>
        {(a) => (
          <OptionsMenu anchor={a} trigger={() => btn} onClose={() => { setAnchor(null); btn?.focus(); }} role="menu">
            <For each={props.options}>
              {(o, i) => (
                <div
                  ref={(el) => { if (i() === 0) queueMicrotask(() => el.focus()); }}
                  role="menuitemcheckbox"
                  aria-checked={props.on.includes(o)}
                  tabIndex={0}
                  class="cp3-menu-item cp3-menu-check"
                  onClick={() => toggle(o)}
                  onKeyDown={(e) => {
                    // Space / Enter toggle the row, arrows move between rows.
                    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(o); }
                    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const next = (e.key === "ArrowDown" ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
                      next?.focus();
                    }
                  }}
                >
                  <CheckBox checked={props.on.includes(o)} onToggle={() => {}} tabIndex={-1} />
                  <span class="cp3-menu-title">{o}</span>
                </div>
              )}
            </For>
          </OptionsMenu>
        )}
      </Show>
    </>
  );
}

/** A plain <select> of string options. */
export function NativeSelect(props: { value: string; options: string[]; onChange: (v: string) => void; class: string }) {
  return (
    <select class={props.class} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
      <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
    </select>
  );
}
