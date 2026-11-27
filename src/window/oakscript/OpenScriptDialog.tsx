/*
 * "Open my script" dialog (script menu > Open script…, Ctrl+O in the editor, #419). Reference layout: 480 x 617,
 * the built-in picker's title and search row; a "Script name" header with a sort button (name A to Z / Z to A, date
 * modified oldest / newest first, newest first by default); one 52 px row per stored script: a favourite star
 * (filled when starred, outlined on hover only), the name 14/22 with the script-type glyph, the date modified 12/18
 * under it, and a remove button. Favourites come first. Picking a row opens the script; the current one is marked.
 *
 * Escape is heard on the document, after Remove's confirmation and the sort menu (on the window) took theirs.
 * The star is the Indicators dialog's favourite (the same id), so a starred script is in Favorite indicators too.
 * The reference's line under the name is "Version: n (date)": scripts here keep no versions, so it holds the date.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { createPopover } from "../../components/popover";
import * as scripts from "../../data/oakscript-store";
import { isFavoriteIndicator, toggleFavoriteIndicator } from "../../data/indicator-favorites";
import { userIndicatorId } from "../chart/indicators/user-scripts";
import { userStrategyId } from "../chart/indicators/strategy-entries";
import { dateText } from "../../i18n/format";
import { translateWith } from "../../i18n/translator";
import { OPEN_SCRIPT_SORTS, openScriptRows, readOpenScriptSort, writeOpenScriptSort, type OpenScriptSort } from "./open-script-list";

type Props = {
  /** The stored script the editor holds (marked in the list). */
  currentId: string;
  onPick: (id: string) => void;
  /** Remove: asks first, as the script menu's Delete script does. */
  onDelete: (id: string, name: string) => void;
  onClose: () => void;
};

/** The id the script is starred under: what the Indicators dialog adds it as. */
const favoriteId = (e: scripts.OakScriptEntry) => (e.strategy ? userStrategyId(e.id) : userIndicatorId(e.id));

// Own glyphs: an indicator line, a strategy's rising steps, a star, the sort arrow beside lines.
const ICON_INDICATOR = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" d="m1.5 11.5 4-4 4 4 4-5 3 3" />
  </svg>
);
const ICON_STRATEGY = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" d="M1.5 14.5h4v-4h4v-4h4v-4h3" />
  </svg>
);
const STAR = (filled: boolean) => (
  <svg viewBox="0 0 18 18" width="18" height="18" fill={filled ? "currentColor" : "none"} stroke="currentColor" stroke-width={filled ? 0 : 1} aria-hidden="true">
    <path d="M9 2.2l1.96 4.02 4.44.62-3.22 3.1.78 4.44L9 12.78 5.26 14.4l.78-4.44-3.22-3.1 4.44-.62z" />
  </svg>
);
const SORT_ICON = (up: boolean) => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" d={up ? "M5.5 15V3.5M2.5 6.5l3-3 3 3M10 5h6M10 9h5M10 13h4" : "M5.5 3v11.5M2.5 11.5l3 3 3-3M10 5h6M10 9h5M10 13h4"} />
  </svg>
);

export function OpenScriptDialog(props: Props) {
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<OpenScriptSort>(readOpenScriptSort());
  const [sortOpen, setSortOpen] = createSignal(false);
  // The stored scripts, read again when one is deleted (here or in another window).
  const [entries, setEntries] = createSignal(scripts.listScriptEntries());
  onCleanup(scripts.onScriptDeleted(() => setEntries(scripts.listScriptEntries())));
  const rows = createMemo(() => openScriptRows(entries(), sort(), query(), (e) => isFavoriteIndicator(favoriteId(e))));
  let input!: HTMLInputElement;
  let sortBtn!: HTMLButtonElement;
  onMount(() => input.focus());

  const pickSort = (s: OpenScriptSort) => {
    setSort(s);
    writeOpenScriptSort(s);
    setSortOpen(false);
  };
  const modified = (ms: number) =>
    translateWith("Modified: {0}", dateText(ms, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));

  return (
    <Dialog look="prompt" titleClass="oak-builtin-dlg__title" layerClass="ot-dlg-layer oak-open-dlg-layer" backdrop="block" class="oak-builtin-dlg oak-open-dlg" title="Open my script" onClose={props.onClose} keys={{ target: "document" }}>
      <label class="oak-builtin-dlg__search">
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" d="M12.4 12.4 16 16M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z" />
        </svg>
        <input
          ref={input}
          type="text"
          role="searchbox"
          placeholder="Search"
          spellcheck={false}
          autocomplete="off"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      <div class="oak-open-dlg__header">
        <span>Script name</span>
        <Tooltip text="Sort by script name, date changed" side="bottom">
          <button
            ref={sortBtn}
            type="button"
            class="oak-open-dlg__sort"
            classList={{ "is-open": sortOpen() }}
            aria-label="Sort by script name, date changed"
            aria-haspopup="menu"
            aria-expanded={sortOpen()}
            data-qa-id="open-script-sort"
            onClick={() => setSortOpen((o) => !o)}
          >
            {SORT_ICON(sort().endsWith("asc"))}
          </button>
        </Tooltip>
      </div>
      <div class="oak-builtin-dlg__list oak-open-dlg__list" role="listbox">
        <For each={rows()} fallback={<div class="oak-open-dlg__empty">{query().trim() ? "No scripts match your criteria" : "No saved scripts"}</div>}>
          {(e) => {
            const fav = () => isFavoriteIndicator(favoriteId(e));
            return (
              <div
                class="oak-open-dlg__row"
                classList={{ "is-current": e.id === props.currentId, "is-favorite": fav() }}
                role="option"
                aria-selected={e.id === props.currentId}
                data-script-id={e.id}
                onClick={() => props.onPick(e.id)}
              >
                <Tooltip text={fav() ? "Remove from favorites" : "Add to favorites"} side="bottom">
                  <span
                    class="oak-open-dlg__star"
                    role="button"
                    aria-label={fav() ? "Remove from favorites" : "Add to favorites"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleFavoriteIndicator(favoriteId(e));
                    }}
                  >
                    {STAR(fav())}
                  </span>
                </Tooltip>
                <span class="oak-open-dlg__info" title={e.name}>
                  <span class="oak-open-dlg__title">
                    <span class="oak-open-dlg__name" data-no-translate>{e.name}</span>
                    <span class="oak-builtin-dlg__type">{e.strategy ? ICON_STRATEGY() : ICON_INDICATOR()}</span>
                  </span>
                  <Show when={e.updatedAt > 0}>
                    <span class="oak-open-dlg__details">{modified(e.updatedAt)}</span>
                  </Show>
                </span>
                <Tooltip text="Remove" side="bottom">
                  <span
                    class="oak-open-dlg__remove"
                    role="button"
                    aria-label="Remove"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      props.onDelete(e.id, e.name);
                    }}
                  >
                    <Icon name="scr-trash" size={18} />
                  </span>
                </Tooltip>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={sortOpen()}>
        <SortMenu anchor={sortBtn} sort={sort()} onPick={pickSort} onClose={() => setSortOpen(false)} />
      </Show>
    </Dialog>
  );
}

function SortMenu(props: { anchor: HTMLElement; sort: OpenScriptSort; onPick: (s: OpenScriptSort) => void; onClose: () => void }) {
  const popover = createPopover(() => props.anchor, { onClose: () => props.onClose(), placement: { gap: 4 } });
  return (
    <Portal>
      <div ref={popover} class="ot-popover oak-open-dlg__sort-menu" role="menu" aria-label="Sort by script name, date changed">
        <For each={OPEN_SCRIPT_SORTS}>
          {(s) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={s.id === props.sort}
              class={`ot-menu-item${s.id === props.sort ? " ot-menu-item--current" : ""}`}
              onClick={() => props.onPick(s.id)}
            >
              <span class="ot-menu-item__icon">{SORT_ICON(s.id.endsWith("asc"))}</span>
              <span class="ot-menu-item__label">{s.label}</span>
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
}
