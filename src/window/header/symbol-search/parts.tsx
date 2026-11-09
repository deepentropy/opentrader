/*
 * Pieces of the symbol search: highlighted text, row flags, filter chips and the empty-list art.
 */
import { createSignal, For, Show, type JSX } from "solid-js";
import { createPopover } from "../../../components/popover";
import { countryOfExchange, flagUrl } from "../../../data/country-flags";

/** Flag of a row: its own flag, else its country's (search data, else the
 *  exchange). */
export function rowFlag(row: { flagSrc?: string; country?: string; exchange?: string }): string | undefined {
  return row.flagSrc ?? flagUrl(row.country ?? countryOfExchange(row.exchange));
}

/** Split `text` so the matched `[a, b)` range renders inside an <em>. */
export function renderHighlighted(text: string, range: [number, number] | null): JSX.Element {
  if (!range) return text;
  const [a, b] = range;
  return (
    <>
      {text.slice(0, a)}
      <em>{text.slice(a, b)}</em>
      {text.slice(b)}
    </>
  );
}

export const caretIcon = () => (
  <svg class="symbol-search-filter-caret" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12">
    <path fill="currentColor" d="M3 6l5 5 5-5z" />
  </svg>
);

/** A filter chip with its drop-down list (first option = no filter), or
 *  `onOpen` for a chip that opens its own panel. Set, it turns into a light
 *  pill with a reset button. */
export function FilterChip(props: {
  all: string;
  value: string | null;
  options: string[];
  onPick: (v: string | null) => void;
  label?: string;
  icon?: string;
  onOpen?: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  // The wrapper holds the button and its menu (capture phase: before the dialog stops the press).
  const wrap = createPopover(undefined, { onClose: () => setOpen(false), placement: false, active: open, press: "mousedown", escape: "none" });
  const pick = (v: string | null) => {
    props.onPick(v);
    setOpen(false);
  };
  const toggle = () => (props.onOpen ? props.onOpen() : setOpen((o) => !o));
  return (
    <div class="symbol-search-filter-wrap" ref={wrap}>
      <Show
        when={props.value}
        fallback={
          <button type="button" class="symbol-search-filter" aria-haspopup="listbox" aria-expanded={open()} onClick={toggle}>
            <span>{props.all}</span>
            {caretIcon()}
          </button>
        }
      >
        <div class="symbol-search-filter-pill">
          <button type="button" class="symbol-search-filter-pill-main" aria-haspopup="listbox" aria-expanded={open()} onClick={toggle}>
            <Show when={props.icon}>
              <span class="symbol-search-filter-flag" aria-hidden="true"><img src={props.icon} alt="" /></span>
            </Show>
            <span>{props.label ?? props.value}</span>
          </button>
          <button type="button" class="symbol-search-filter-reset" aria-label="Reset" onClick={() => pick(null)}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m3.5 3.5 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
      </Show>
      <Show when={open()}>
        <div class="symbol-search-type-menu symbol-search-filter-menu" role="listbox">
          <button type="button" role="option" aria-selected={!props.value} class={"symbol-search-type-option" + (!props.value ? " selected" : "")} onClick={() => pick(null)}>
            {props.all}
          </button>
          <For each={props.options}>
            {(o) => (
              <button type="button" role="option" aria-selected={o === props.value} class={"symbol-search-type-option" + (o === props.value ? " selected" : "")} onClick={() => pick(o)}>
                {o}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Illustration of "No symbols match your criteria": a magnifying glass over
 *  an empty list. */
export function NoSymbolsArt() {
  return (
    <svg class="symbol-search-none-icon" width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
      <rect x="22" y="26" width="64" height="70" rx="6" fill="var(--color-bg-primary-hover)" stroke="var(--color-text-secondary)" stroke-width="2" />
      <path d="M34 44h40M34 58h28M34 72h34" stroke="var(--color-text-secondary)" stroke-width="2" stroke-linecap="round" opacity="0.5" />
      <circle cx="78" cy="76" r="17" fill="var(--color-bg-primary)" stroke="var(--color-text-primary)" stroke-width="3" />
      <path d="M90.5 88.5l13 13" stroke="var(--color-text-primary)" stroke-width="5" stroke-linecap="round" />
      <path d="M72 70l12 12M84 70L72 82" stroke="var(--color-text-primary)" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  );
}
