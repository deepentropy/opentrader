/*
 * Selects.
 *
 * `SelectControl`: the Settings dialogs' select — a 34 px transparent r8 button with the 18 px chevron and an r10
 * option menu flush under it, trigger-wide, flipped above without room below. `MultiCheckSelect` is the same button
 * over a check list that stays open while options are toggled, `MenuSelect` over the caller's own rows. `NativeSelect` is a plain <select> (drawing
 * Settings), styled by its class.
 */
import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { createPopover } from "../popover";
import { isRtl } from "../reading-direction";
import { CheckBox } from "./CheckBox";
import { Chevron } from "./glyphs";
import { translate } from "../../i18n/translator";
import { listText, lowerWord } from "../../i18n/format";

type Anchor = { left: number; right: number; top: number; bottom: number; width: number };
const anchorOf = (el: HTMLElement): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
};

/** The menu's start edge on the trigger's: its left, its right right to left (the menu may be wider). */
const startOf = (a: Anchor): JSX.CSSProperties =>
  isRtl() ? { right: `${document.documentElement.clientWidth - a.right}px` } : { left: `${a.left}px` };

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
      style={{ ...startOf(props.anchor), top: `${top()}px`, "min-width": `${props.anchor.width}px` }}
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
  /** The options are data, not interface words (date format samples): not translated. */
  data?: boolean;
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
        <span class="cp3-select-value" data-no-translate={props.data || undefined}>{props.display ?? props.labelOf?.(props.value) ?? props.value}</span>
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
                  <span class="cp3-menu-title" data-no-translate={props.data || undefined}>{props.labelOf?.(o) ?? o}</span>
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

/** The select button over a menu of the caller's own rows (options with tooltips or disabled states). */
export function MenuSelect(props: { display: string; width: number; role: "listbox" | "menu"; children: (close: () => void) => JSX.Element }) {
  let btn: HTMLButtonElement | undefined;
  const [anchor, setAnchor] = createSignal<Anchor | null>(null);
  const close = () => setAnchor(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${anchor() ? " is-open" : ""}`}
        style={{ width: `${props.width}px` }}
        aria-haspopup={props.role}
        aria-expanded={!!anchor()}
        onClick={() => (anchor() ? close() : setAnchor(anchorOf(btn!)))}
      >
        <span class="cp3-select-value">{props.display}</span>
        <span class="cp3-select-caret"><Chevron /></span>
      </button>
      <Show when={anchor()} keyed>
        {(a) => (
          <OptionsMenu anchor={a} trigger={() => btn} onClose={close} role={props.role}>
            {props.children(close)}
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
  if (picked.length === 0) return translate("Hidden");
  // Translated here, the words joined: the control shows the text as it is (data-no-translate).
  return listText(picked.map((o, i) => (i === 0 ? translate(o) : lowerWord(translate(o)))));
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
        <span class="cp3-select-value" data-no-translate>{multiSummary(props.options, props.on)}</span>
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
