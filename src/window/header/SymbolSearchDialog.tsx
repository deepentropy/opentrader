/*
 * SymbolSearchDialog — modal opened from the header's symbol pill.
 *
 * Feature 4 + 4-extras: backdrop + dialog frame, search input, category
 * tabs, results list with click-to-select, AND keyboard navigation
 * (↑/↓ move, Enter commit, Esc close), match-range `<em>` highlights,
 * the All-tab filter-chip strip, the active-symbol blue corner marker,
 * and recent-symbol pinning (handled in `filterSymbols`).
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { CATEGORIES, TYPE_FILTERS, type FilteredRow } from "../../data/symbol-search";
import { ECONOMIC_CATEGORIES } from "../../data/datafeed";
import { deleteLocalSeries, localSymbol, renameLocalSeries } from "../../data/local-series";
import { ImportSeriesHost, pickSeriesFiles, pickSeriesFolder } from "./ImportSeriesDialog";
import { showConfirm, showNotice, showRename } from "../../components/Dialogs";
import { flagUrl } from "../../data/country-flags";
import { ECONOMIC_DATA_NOTICE } from "../../data/economic-notice";
import { Tooltip } from "../../components/Tooltip";
import { CheckBox } from "../../components/form";
import type { ComparePlacement } from "../shell/tabs";
import { createPopover } from "../../components/popover";
import { CountryPanel } from "./symbol-search/CountryPanel";
import { FilterChip, NoSymbolsArt, rowFlag } from "./symbol-search/parts";
import { ResultRow, compareInfo, compareRow, type RowContext } from "./symbol-search/ResultRows";
import {
  TOKEN_ESCAPE_RE,
  createSymbolSearch,
  econCategory,
  econCountry,
  econCountryName,
  econSource,
  persistTypeCode,
  setEconCategory,
  setEconCountry,
  setEconSource,
  tokenAt,
} from "./symbol-search/search-model";
import type { SymbolSearchProps } from "./symbol-search/types";

type Props = SymbolSearchProps;

export function SymbolSearchDialog(props: Props) {
  const s = createSymbolSearch(props);
  const { category, setCategory, query, setQuery, setCaret, multiMode, searchText, highlightIdx, setHighlightIdx } = s;
  const { typeCode, setTypeCode, typeMenuOpen, setTypeMenuOpen, typeLabel, searching, economy, sources, setCountryPanel, setCountryQuery } = s;
  const { rows, otherCount, categoryLabel, dialogTitle, compareHome, listRows } = s;

  let input!: HTMLInputElement;
  let listEl: HTMLDivElement | undefined;

  // Close the type dropdown on an outside click (capture phase so it runs
  // before the dialog's mousedown-stopPropagation).
  const typeWrap = createPopover(undefined, { onClose: () => setTypeMenuOpen(false), placement: false, active: typeMenuOpen, press: "mousedown", escape: "none" });

  // Scroll the highlighted row into view as the selection moves.
  createEffect(() => {
    const i = highlightIdx();
    const el = listEl?.children[i] as HTMLElement | undefined;
    // Rows of the main list are display: contents (no box): scroll a cell.
    ((el?.firstElementChild as HTMLElement | null) ?? el)?.scrollIntoView({ block: "nearest" });
  });

  // Watchlist mode: a row just added flashes for 500 ms.
  const [flashed, setFlashed] = createSignal<string | null>(null);
  let flashTimer: number | undefined;
  onCleanup(() => window.clearTimeout(flashTimer));
  /** The rows share one grid, so the actions column is two buttons wide
   *  as soon as one visible row is already in the list. */
  const anyInList = () => !!props.watchlist && !multiMode() && rows().some((r) => props.watchlist!.has(r.symbolName));

  function addRow(row: FilteredRow) {
    props.watchlist!.add(row.symbolName);
    setFlashed(row.symbolName);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => setFlashed(null), 500);
  }
  /** Watchlist mode: Shift closes the dialog, else the query is reselected so
   *  the next symbol can be typed at once. */
  function afterAction(shift: boolean) {
    if (shift) props.onClose();
    else input.select();
  }

  /** Comma mode, row click: the row's full name replaces the token under the
   *  caret (appended when there is none); nothing is added yet. */
  function insertToken(row: FilteredRow) {
    const text = input.value;
    const pos = input.selectionStart ?? text.length;
    const tok = tokenAt(text, pos);
    const at = tok ? tok.offset : text.length;
    const name = TOKEN_ESCAPE_RE.test(row.symbolName) ? `'${row.symbolName}'` : row.symbolName;
    const next = text.slice(0, at) + name + text.slice(at + (tok ? tok.value.length : 0));
    setQuery(next);
    input.value = next;
    input.setSelectionRange(at + name.length, at + name.length);
    setCaret(at + name.length);
    input.focus();
  }
  /** Comma mode, Enter (with or without Shift): add every token, then close
   *  (split on commas, trim, drop empties, upper-case). */
  function submitMany() {
    const names = query()
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .map((t) => t.toUpperCase());
    if (names.length) props.watchlist!.addMany(names);
    props.onClose();
  }

  /** Compare mode: add with a placement, clear the query, keep the dialog. */
  function addCompare(symbolName: string, placement: ComparePlacement) {
    props.compare!.add(symbolName, placement);
    setQuery("");
    input.value = "";
    input.focus();
  }

  /** Local tab: rename an imported series (its charts keep the old symbol). */
  function renameSeries(name: string) {
    showRename({
      title: "Rename series",
      label: "Symbol name",
      maxLength: 42,
      // No list of names: a taken name is refused (renameLocalSeries), not replaced.
      names: [],
      replaceText: (n) => n,
      initialValue: name,
      onSave: (to) => {
        renameLocalSeries(name, to).catch((e) => showNotice({ title: "Rename series", text: e instanceof Error ? e.message : String(e) }));
      },
    });
  }

  function removeSeries(name: string) {
    showConfirm({
      title: "Remove series",
      text: `Do you really want to remove ${localSymbol(name)}? Its bars are deleted.`,
      mainText: "Remove",
      intent: "danger",
      onConfirm: () => {
        deleteLocalSeries(name).catch((e) => showNotice({ title: "Remove series", text: e instanceof Error ? e.message : String(e) }));
      },
    });
  }

  function commit(row: FilteredRow | undefined, shift = false) {
    if (props.compare) {
      if (row) addCompare(row.symbolName, "percent");
      return;
    }
    const wl = props.watchlist;
    if (wl && multiMode()) {
      if (row) insertToken(row);
      return;
    }
    if (!row) return;
    if (wl) {
      if (wl.has(row.symbolName)) wl.remove(row.symbolName);
      else addRow(row);
      afterAction(shift);
      return;
    }
    props.onSelect(row.symbolName);
    props.onClose();
  }


  onMount(() => {
    input.focus();
    // Seeded by a typed character → place the caret at the end so the next
    // keystroke appends; otherwise select the pre-filled ticker for replacement.
    if (props.seedQuery != null) {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } else {
      input.select();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (s.countryPanel()) {
        // The countries panel covers the list: its keys stay in its search.
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(listRows().length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (multiMode()) submitMany();
        else commit(listRows()[highlightIdx()], e.shiftKey);
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const ctx: RowContext = { s, props, flashed, commit, addRow, afterAction, addCompare, renameSeries, removeSeries };

  return (
    <>
      <Dialog
        look="symbol-search"
        layerClass="symbol-search-backdrop"
        backdrop="close"
        // The reference app's symbol search has no title bar to drag.
        draggable={false}
        class="symbol-search-dialog"
        classList={{ "is-compare": !!props.compare }}
        data-name={props.compare ? "compare-dialog" : props.watchlist ? "watchlist-symbol-search-dialog" : "symbol-search-items-dialog"}
        title={dialogTitle()}
        onClose={props.onClose}
        // Escape is one of the list's keys (above).
        onEscape={false}
      >
        {/* Search input — wrapped in a rounded box whose border lights up on
            focus; a clear disc appears once the field is non-empty. */}
        <div class="symbol-search-input-wrap">
          <div class="symbol-search-input-box">
            <span class="symbol-search-input-icon" aria-hidden="true">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 28 28"
                width="28"
                height="28"
                fill="none"
              >
                <path
                  stroke="currentColor"
                  stroke-width="1.4"
                  d="M19.5 19.5 24 24M21 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"
                />
              </svg>
            </span>
            <input
              ref={input}
              type="search"
              role="searchbox"
              class="symbol-search-input"
              placeholder="Symbol, ISIN, or CUSIP"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
              }}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              autocomplete="off"
              spellcheck={false}
            />
            <Show when={query()}>
              <Tooltip text="Clear" side="bottom">
                <button
                  type="button"
                  aria-label="Clear"
                  class="symbol-search-clear"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    input.focus();
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                    <mask id="symbol-search-clear-knockout">
                      <rect width="16" height="16" fill="#fff" />
                      <path d="M5 5l6 6M11 5l-6 6" stroke="#000" stroke-width="1.5" stroke-linecap="round" />
                    </mask>
                    <circle cx="8" cy="8" r="8" fill="currentColor" mask="url(#symbol-search-clear-knockout)" />
                  </svg>
                </button>
              </Tooltip>
            </Show>
          </div>
        </div>

        {/* Category tabs (compare mode: only while searching) */}
        <Show when={!compareHome()}>
        <div class="symbol-search-tabs" role="tablist">
          <For each={CATEGORIES}>
            {(c) => (
              <button
                type="button"
                role="tab"
                aria-selected={category() === c.id}
                class={
                  "symbol-search-tab" +
                  (category() === c.id ? " selected" : "")
                }
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            )}
          </For>
          {/* No "More" overflow tab: all ten tabs fit at this dialog
              width. */}
        </div>
        </Show>

        {/* Filter chips — Stocks tab. No Country and Sector chips:
            both are plan-dependent: this feed is US-only and the
            provider's reference search has no sector filter, so they are
            omitted rather than rendered dead. Only the working Type chip
            (provider `type` filter) remains. */}
        <Show when={!props.compare && category() === "stocks"}>
          <div class="symbol-search-filters">
            {/* Type — functional dropdown (the search `type` filter). */}
            <div class="symbol-search-filter-wrap" ref={typeWrap}>
              <button
                type="button"
                class={"symbol-search-filter" + (typeCode() ? " is-active" : "")}
                aria-haspopup="listbox"
                aria-expanded={typeMenuOpen()}
                onClick={() => setTypeMenuOpen((o) => !o)}
              >
                <span>{typeLabel()}</span>
                <svg class="symbol-search-filter-caret" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12">
                  <path fill="currentColor" d="M3 6l5 5 5-5z" />
                </svg>
              </button>
              <Show when={typeMenuOpen()}>
                <div class="symbol-search-type-menu" role="listbox">
                  <For each={TYPE_FILTERS()}>
                    {(t) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={t.code === typeCode()}
                        class={"symbol-search-type-option" + (t.code === typeCode() ? " selected" : "")}
                        onClick={() => {
                          setTypeCode(t.code);
                          persistTypeCode(t.code);
                          setTypeMenuOpen(false);
                        }}
                      >
                        {t.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* Local tab: import CSV files of bars. */}
        <Show when={!props.compare && category() === "local"}>
          <div class="symbol-search-filters symbol-search-local-bar">
            <button type="button" class="symbol-search-import" data-name="import-csv" onClick={pickSeriesFiles}>
              Import CSV…
            </button>
            <button type="button" class="symbol-search-import" data-name="import-folder" onClick={() => void pickSeriesFolder()}>
              Import folder…
            </button>
          </div>
        </Show>

        {/* Economy tab: Countries (its own panel), Sources and Categories filters. */}
        <Show when={economy()}>
          <div class="symbol-search-filters">
            <FilterChip
              all="All countries"
              value={econCountry()}
              label={econCountry() ? econCountryName(econCountry()!) : undefined}
              icon={flagUrl(econCountry() ?? undefined)}
              options={[]}
              onPick={setEconCountry}
              onOpen={() => {
                setCountryQuery("");
                setCountryPanel(true);
              }}
            />
            <FilterChip all="All sources" value={econSource()} options={sources()} onPick={setEconSource} />
            <FilterChip all="All categories" value={econCategory()} options={ECONOMIC_CATEGORIES} onPick={setEconCategory} />
          </div>
        </Show>

        {/* Results list */}
        <div class="symbol-search-results">
          <Show when={props.compare && compareHome()}>
            <div class="symbol-search-list is-compare" role="listbox" ref={listEl}>
              <Show when={props.compare!.added().length > 0}>
                <div class="cmp-search-section">Added symbols</div>
                <For each={props.compare!.added()}>
                  {(a) => {
                    const cat = () => rows().find((r) => r.symbolName === a.symbol);
                    const colon = a.symbol.indexOf(":");
                    const exchange = colon >= 0 ? a.symbol.slice(0, colon) : "";
                    const ticker = colon >= 0 ? a.symbol.slice(colon + 1) : a.symbol;
                    return (
                      <div class="symbol-search-row cmp-search-row is-added" data-role="added-symbol-item" data-symbol-name={a.symbol} role="option">
                        {compareInfo(ticker, a.description || cat()?.description || "", cat()?.logoSrc)}
                        <div class="symbol-search-cell symbol-search-exchange-cell cmp-search-exchange">
                          <div class="symbol-search-market-type">{cat()?.marketType ?? ""}</div>
                          <div class="symbol-search-exchange-source"><span class="symbol-search-exchange">{exchange}</span></div>
                          <Show when={rowFlag({ exchange })}>
                            {(src) => <span class="symbol-search-flag" aria-hidden="true"><img src={src()} alt="" /></span>}
                          </Show>
                        </div>
                        <span class="cmp-search-check">
                          <CheckBox checked={true} onToggle={() => props.compare!.remove(a.id)} />
                        </span>
                      </div>
                    );
                  }}
                </For>
              </Show>
              <Show when={listRows().length > 0}>
                <div class="cmp-search-section">Recent symbols</div>
              </Show>
              <For each={listRows()}>{(row, i) => compareRow(ctx, row, i)}</For>
            </div>
          </Show>
          <Show when={props.compare && !compareHome()}>
            <Show when={rows().length > 0} fallback={<Show when={!searching()}><div class="ot-empty-state symbol-search-empty">No matches</div></Show>}>
              <div class="symbol-search-list is-compare" role="listbox" ref={listEl}>
                <For each={rows()}>{(row, i) => compareRow(ctx, row, i)}</For>
              </div>
            </Show>
          </Show>
          <Show
            when={!props.compare && rows().length > 0}
            fallback={
              <Show when={!props.compare && !searching()}>
                <Show
                  when={otherCount() > 0}
                  fallback={
                    <div class="symbol-search-none">
                      <NoSymbolsArt />
                      <div class="symbol-search-none-text">No symbols match your criteria</div>
                    </div>
                  }
                >
                  <div class="symbol-search-none">
                    <div class="symbol-search-other">
                      <span class="symbol-search-other-token">{searchText().trim()}</span> not found in <b>{categoryLabel()}</b> with such criteria
                    </div>
                    <div class="symbol-search-other-count">
                      There are also {otherCount()} symbols in other markets
                    </div>
                    <button type="button" class="symbol-search-show-me" onClick={() => setCategory("all")}>
                      Show me
                    </button>
                  </div>
                </Show>
              </Show>
            }
          >
            <div
              class="symbol-search-list"
              classList={{
                "is-watchlist": !!props.watchlist && !multiMode(),
                "has-list-actions": anyInList(),
                "is-local": category() === "local" && !props.watchlist && !multiMode(),
              }}
              role="listbox"
              ref={listEl}
            >
              <For each={rows()}>{(row, i) => <ResultRow ctx={ctx} row={row} i={i} />}</For>
            </div>
          </Show>
        </div>

        {/* Footer hint (watchlist mode: keyboard-hint footer; the
            Compare dialog has none). */}
        <Show
          when={props.watchlist}
          fallback={
            <Show when={!props.compare}>
              <div class="symbol-search-footer">
                {/* Economy: the notice the economic data source's terms require. */}
                {category() === "economy"
                  ? ECONOMIC_DATA_NOTICE
                  : category() === "local"
                    ? import.meta.env.MODE === "web"
                      ? "Imported series are kept in this browser tab until it closes"
                      : "Imported series are kept on this computer"
                    : "Search using ISIN and CUSIP codes"}
              </div>
            </Show>
          }
        >
          <div class="symbol-search-footer symbol-search-footer--keys">
            <div class="symbol-search-shortcuts">
              <Show
                when={!multiMode()}
                fallback={
                  <div class="symbol-search-kbd-group">
                    <kbd class="symbol-search-kbd">Enter</kbd>
                  </div>
                }
              >
                <div class="symbol-search-kbd-group">
                  <kbd class="symbol-search-kbd">Shift</kbd>+<kbd class="symbol-search-kbd">Click</kbd>
                </div>
                or
                <div class="symbol-search-kbd-group">
                  <kbd class="symbol-search-kbd">Shift</kbd>+<kbd class="symbol-search-kbd">Enter</kbd>
                </div>
              </Show>
            </div>
            <div>to add symbol and close dialog</div>
          </div>
        </Show>

        {/* Economy tab: the countries panel over the dialog (Back returns to the list). */}
        <CountryPanel s={s} onClose={props.onClose} onPicked={() => input.focus()} />
      </Dialog>
      {/* Local tab: the Import CSV dialog of the picked files. */}
      <ImportSeriesHost />
    </>
  );
}
