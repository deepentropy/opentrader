/*
 * "Open built-in script" dialog (script menu > Built-in…). Reference layout:
 * 420 x 610, #1F1F1F, r6; title 20/28 600 with a close button; a search row
 * (40 px, magnifier, "Search"); the "SCRIPT NAME" header (11/16 uppercase);
 * one 32 px row per built-in: its name then the script-type glyph, a hover
 * fill and the name as tooltip. Picking a row gives a new script with that
 * source (the reference opens it as a new "Untitled script").
 */
import { For, createMemo, createSignal, onMount } from "solid-js";
import { builtinScriptRows } from "./builtin-sources";
import { Dialog } from "../../components/Dialog";

type Props = {
  onPick: (typeId: string) => void;
  onClose: () => void;
};

// Indicator script glyph (own drawing): a rising, falling line.
const ICON_INDICATOR = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" d="m1.5 11.5 4-4 4 4 4-5 3 3" />
  </svg>
);

export function BuiltinScriptDialog(props: Props) {
  const [query, setQuery] = createSignal("");
  const rows = builtinScriptRows();
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  });
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <Dialog look="prompt" titleClass="oak-builtin-dlg__title" layerClass="ot-dlg-layer" backdrop="block" class="oak-builtin-dlg" title="Open built-in script" onClose={props.onClose}>
      <label class="oak-builtin-dlg__search">
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" d="M12.4 12.4 16 16M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z" />
        </svg>
        <input
          ref={input}
          type="text"
          placeholder="Search"
          spellcheck={false}
          autocomplete="off"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      <div class="oak-builtin-dlg__header">Script name</div>
      <div class="oak-builtin-dlg__list" role="listbox">
        <For each={shown()}>
          {(r) => (
            <div class="oak-builtin-dlg__row" role="option" title={r.name} data-type-id={r.typeId} onClick={() => props.onPick(r.typeId)}>
              <span class="oak-builtin-dlg__name">{r.name}</span>
              <span class="oak-builtin-dlg__type">{ICON_INDICATOR()}</span>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  );
}
