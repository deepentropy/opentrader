/*
 * SymbolSearchDialog — modal opened from the header's symbol pill.
 *
 * Feature 4 + 4-extras: backdrop + dialog frame, search input, category
 * tabs, results list with click-to-select, AND keyboard navigation
 * (↑/↓ move, Enter commit, Esc close), match-range `<em>` highlights,
 * the All-tab filter-chip strip, the active-symbol blue corner marker,
 * and recent-symbol pinning (handled in `filterSymbols`).
 */
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import {
  CATEGORIES,
  TYPE_FILTERS,
  SYMBOLS,
  filterSymbols,
  liveResultsToRows,
  type FilteredRow,
  type SymbolRow,
  type SymbolCategoryId,
} from "../../data/symbol-search";
import { getTickerInfo, searchSymbols } from "../../data/datafeed";
import { recentSymbols } from "../../data/recent-symbols";
import { countryOfExchange, flagUrl } from "../../data/country-flags";
import type { SymbolSearchResult } from "../../bindings";
import * as kv from "../../data/kv";
import { Tooltip } from "../../components/Tooltip";
import { CheckBox } from "./ChartPropertiesDialog";
import type { ComparePlacement } from "../shell/tabs";

/** Durable key for the Type filter chip, so the chosen filter survives both a
 *  query change (already independent state) and closing/reopening the modal or
 *  an app reload. Stores the Massive `type` code; absent = "All types" (null). */
const TYPE_FILTER_KEY = "ot:symbol-search:type-filter";
/** The symbol search opens on the category tab used last (All at first). */
const CATEGORY_KEY = "ot:symbol-search:category";
function loadCategory(): SymbolCategoryId {
  const raw = kv.getItem(CATEGORY_KEY);
  return raw && CATEGORIES.some((c) => c.id === raw) ? (raw as SymbolCategoryId) : "all";
}

/** Read the persisted Type filter, ignoring anything not in the current catalog. */
function loadTypeCode(): string | null {
  const raw = kv.getItem(TYPE_FILTER_KEY);
  return raw != null && TYPE_FILTERS().some((t) => t.code === raw) ? raw : null;
}

/** Persist the Type filter — remove the key for "All types" (null = no filter). */
function persistTypeCode(code: string | null): void {
  if (code == null) kv.removeItem(TYPE_FILTER_KEY);
  else kv.setItem(TYPE_FILTER_KEY, code);
}

/** Live search runs only inside the Tauri shell (the Rust command hits
 *  Massive); elsewhere (browser / offline) we fall back to the static list. */
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Props = {
  /** Full symbol-name (e.g. "NASDAQ:INTC") of the currently-active chart. */
  activeSymbol?: string;
  /** When the dialog is opened by typing a character with no field focused,
   *  the query is seeded with that character instead of the active ticker. */
  seedQuery?: string | null;
  onSelect: (symbolName: string) => void;
  onClose: () => void;
  /** Watchlist "Add symbol" mode. The query starts empty; a click or
   *  Enter adds the row (or removes it when it is already in the list) and
   *  keeps the dialog open; with Shift it also closes. Each row gets the
   *  action buttons: + (add), or trash (remove) + target (go to symbol). */
  watchlist?: {
    has: (symbolName: string) => boolean;
    add: (symbolName: string) => void;
    /** Comma mode: add every typed name at once (bare or "EXCHANGE:TICKER"). */
    addMany: (names: string[]) => void;
    remove: (symbolName: string) => void;
    goTo: (symbolName: string) => void;
  };
  /** "Compare symbols" mode. Empty query: ADDED SYMBOLS (check box
   *  removes) then RECENT SYMBOLS; a query shows the category tabs and the
   *  results. A row click adds the symbol on the same % scale; the row's
   *  hover buttons pick the placement. The dialog stays open and the query
   *  clears after an add. */
  compare?: {
    added: () => { id: string; symbol: string; description?: string }[];
    /** Recently used symbols, most recent first. */
    recent: () => { symbol: string; description?: string }[];
    add: (symbolName: string, placement: ComparePlacement) => void;
    remove: (id: string) => void;
  };
};

/** Compare dialog row buttons. */
const COMPARE_BUTTONS: { placement: ComparePlacement; label: string }[] = [
  { placement: "percent", label: "Same % scale" },
  { placement: "scale", label: "New price scale" },
  { placement: "pane", label: "New pane" },
];

// Row action icons of the watchlist search dialog.
const ICON_ADD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M13.9 14.1V22h1.2v-7.9H23v-1.2h-7.9V5h-1.2v7.9H6v1.2h7.9z"></path></svg>';
const ICON_REMOVE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M18 7h5v1h-2.01l-1.33 14.64a1.5 1.5 0 0 1-1.5 1.36H9.84a1.5 1.5 0 0 1-1.49-1.36L7.01 8H5V7h5V6c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v1Zm-6-2a1 1 0 0 0-1 1v1h6V6a1 1 0 0 0-1-1h-4ZM8.02 8l1.32 14.54a.5.5 0 0 0 .5.46h8.33a.5.5 0 0 0 .5-.46L19.99 8H8.02Z"></path></svg>';
const ICON_GOTO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M14 9.5a.5.5 0 0 0 1 0V7.02A6.5 6.5 0 0 1 20.98 13H18.5a.5.5 0 0 0 0 1h2.48A6.5 6.5 0 0 1 15 19.98V17.5a.5.5 0 0 0-1 0v2.48A6.5 6.5 0 0 1 8.02 14h2.48a.5.5 0 0 0 0-1H8.02A6.5 6.5 0 0 1 14 7.02V9.5zm1-3.48V4.5a.5.5 0 0 0-1 0v1.52A7.5 7.5 0 0 0 7.02 13H5.5a.5.5 0 0 0 0 1h1.52A7.5 7.5 0 0 0 14 20.98v1.52a.5.5 0 0 0 1 0v-1.52A7.5 7.5 0 0 0 21.98 14h1.52a.5.5 0 0 0 0-1h-1.52A7.5 7.5 0 0 0 15 6.02z"></path></svg>';

/** Symbol tokens of a comma list (tokenizer subset): a
 *  token runs from its first non-space character to the next comma, so it
 *  keeps trailing spaces ("MSFT " in "AAPL,MSFT , KO"). */
function symbolTokens(text: string): { value: string; offset: number }[] {
  const out: { value: string; offset: number }[] = [];
  let start = 0;
  for (const part of text.split(",")) {
    const lead = part.length - part.trimStart().length;
    if (part.length > lead) out.push({ value: part.slice(lead), offset: start + lead });
    start += part.length + 1;
  }
  return out;
}
/** Token under the caret, ends inclusive. */
function tokenAt(text: string, pos: number): { value: string; offset: number } | null {
  return symbolTokens(text).find((t) => t.offset <= pos && pos <= t.offset + t.value.length) ?? null;
}
/** Names that contain a spread operator are quoted. */
const TOKEN_ESCAPE_RE = /[+\-/*]/;

/** Flag of a row: its own flag, else its country's (search data, else the
 *  exchange). */
function rowFlag(row: { flagSrc?: string; country?: string; exchange?: string }): string | undefined {
  return row.flagSrc ?? flagUrl(row.country ?? countryOfExchange(row.exchange));
}

/** Split `text` so the matched `[a, b)` range renders inside an <em>. */
function renderHighlighted(text: string, range: [number, number] | null): JSX.Element {
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

export function SymbolSearchDialog(props: Props) {
  const [category, setCategoryRaw] = createSignal<SymbolCategoryId>(props.compare ? "all" : props.watchlist ? "stocks" : loadCategory());
  const setCategory = (c: SymbolCategoryId) => {
    setCategoryRaw(c);
    if (!props.compare && !props.watchlist) kv.setItem(CATEGORY_KEY, c);
  };
  const initialQuery = (() => {
    // A typed character (seedQuery) takes precedence over the active ticker —
    // the user started typing a new lookup, so don't pre-fill the old symbol.
    if (props.seedQuery != null) return props.seedQuery;
    if (props.watchlist || props.compare) return ""; // the Add-symbol / Compare dialogs open empty
    const a = props.activeSymbol;
    if (!a) return "";
    const colon = a.indexOf(":");
    return colon >= 0 ? a.slice(colon + 1) : a;
  })();
  const [query, setQuery] = createSignal(initialQuery);
  // Watchlist comma mode: the search runs on the token under the caret,
  // upper-cased, and follows the caret as it moves.
  const [caret, setCaret] = createSignal(initialQuery.length);
  const multiMode = () => !!props.watchlist && query().includes(",");
  const searchText = () =>
    multiMode() ? (tokenAt(query(), caret())?.value.trim().toUpperCase() ?? "") : query();
  const [highlightIdx, setHighlightIdx] = createSignal(0);
  // Active "All types" filter — null = no type filter (Massive `type` param).
  // Seeded from the persisted value so it survives reopen / reload.
  const [typeCode, setTypeCode] = createSignal<string | null>(loadTypeCode());
  const [typeMenuOpen, setTypeMenuOpen] = createSignal(false);
  const typeLabel = () =>
    TYPE_FILTERS().find((t) => t.code === typeCode())?.label ?? "All types";

  let input!: HTMLInputElement;
  let listEl: HTMLDivElement | undefined;
  let typeWrap: HTMLDivElement | undefined;

  // Results: live Massive typeahead inside Tauri (debounced per keystroke),
  // else the static local filter. `searching` suppresses the empty state while
  // a request is in flight; the previous rows stay visible (no flicker).
  const [searching, setSearching] = createSignal(false);
  // Raw live results for the CURRENT (query, type). Null → use the static
  // catalogue (no Tauri, empty query, or a failed request). Kept separate from
  // the category so a tab switch re-filters instantly via the memo below,
  // instead of firing a fresh debounced request that leaves the previous tab's
  // rows on screen for ~half a second.
  const [liveRaw, setLiveRaw] = createSignal<SymbolSearchResult[] | null>(null);
  let reqSeq = 0;
  // Network fetch — depends on query + type only, NOT category.
  createEffect(() => {
    const q = searchText().trim();
    const type = typeCode();
    if (!HAS_TAURI || q.length < 1) {
      reqSeq++; // cancel any in-flight request
      setLiveRaw(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const my = ++reqSeq;
    const handle = window.setTimeout(async () => {
      try {
        const data = await searchSymbols(q, type);
        if (reqSeq !== my) return; // a newer keystroke superseded this
        setLiveRaw(data);
      } catch {
        // command errored / offline / no key → fall back to the static catalogue.
        if (reqSeq === my) setLiveRaw(null);
      } finally {
        if (reqSeq === my) setSearching(false);
      }
    }, 250);
    onCleanup(() => window.clearTimeout(handle));
  });
  // Displayed rows — derived synchronously from the live results (or the static
  // catalogue) and the active category, so switching tabs updates immediately
  // without a refetch. With an explicit type filter, Massive already constrains
  // the results, so the tab/category client filter is skipped (an ETF type would
  // otherwise be dropped by the Stocks tab, since ETF→funds category).
  // Empty query, All tab (symbol search only): the symbols picked before
  // come first, then the usual list (duplicates kept, as in the reference).
  const [historyNames, setHistoryNames] = createSignal<Record<string, string>>({});
  const historyRows = createMemo<FilteredRow[]>(() => {
    if (props.watchlist || props.compare) return [];
    return recentSymbols("search").map((sym) => {
      const cat = SYMBOLS.find((x) => x.symbolName === sym);
      if (cat) return { ...cat, titleHighlight: null, descriptionHighlight: null };
      const colon = sym.indexOf(":");
      const ticker = colon >= 0 ? sym.slice(colon + 1) : sym;
      const exchange = colon >= 0 ? sym.slice(0, colon) : "";
      return { symbolName: sym, ticker, description: historyNames()[sym] ?? "", marketType: "", exchange, category: "all" as SymbolCategoryId, titleHighlight: null, descriptionHighlight: null };
    });
  });
  createEffect(() => {
    for (const r of historyRows()) {
      if (r.description || r.symbolName in untrack(historyNames)) continue;
      setHistoryNames((m) => ({ ...m, [r.symbolName]: "" }));
      getTickerInfo(r.symbolName).then((info) => setHistoryNames((m) => ({ ...m, [r.symbolName]: info?.name ?? "" }))).catch(() => {});
    }
  });
  const rows = createMemo<FilteredRow[]>(() => {
    const q = searchText().trim();
    const cat = category();
    const type = typeCode();
    const raw = liveRaw();
    if (!HAS_TAURI || q.length < 1 || raw == null) {
      const base = filterSymbols(cat, q);
      return q.length < 1 && cat === "all" ? [...historyRows(), ...base] : base;
    }
    return liveResultsToRows(raw, type ? "all" : cat, q);
  });

  // Close the type dropdown on an outside click (capture phase so it runs
  // before the dialog's mousedown-stopPropagation).
  createEffect(() => {
    if (!typeMenuOpen()) return;
    const onDown = (e: MouseEvent) => {
      if (typeWrap && !typeWrap.contains(e.target as Node)) setTypeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });

  // Pre-select the row matching the active symbol when the result set
  // changes (incl. on query / tab change); fall back to the first row.
  createEffect(() => {
    const list = rows();
    const idx = list.findIndex((r) => r.symbolName === props.activeSymbol);
    setHighlightIdx(idx >= 0 ? idx : 0);
  });

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

  const dialogTitle = () => (props.compare ? "Compare symbols" : props.watchlist ? "Add symbol" : "Symbol search");
  /** Compare mode with an empty query: the ADDED / RECENT sections. */
  const compareHome = () => !!props.compare && !query().trim();
  /** Compare home: the recently used symbols (catalogue row when known). */
  const recentRows = createMemo<FilteredRow[]>(() => {
    if (!props.compare) return [];
    return props.compare.recent().map((r) => {
      const cat = SYMBOLS.find((s) => s.symbolName === r.symbol);
      const colon = r.symbol.indexOf(":");
      const ticker = colon >= 0 ? r.symbol.slice(colon + 1) : r.symbol;
      const exchange = colon >= 0 ? r.symbol.slice(0, colon) : "";
      const base: SymbolRow = cat ?? { symbolName: r.symbol, ticker, description: "", marketType: "", exchange, category: "all" as SymbolCategoryId };
      return { ...base, description: r.description || base.description, titleHighlight: null, descriptionHighlight: null };
    });
  });
  /** Rows of the list (compare home: the recent symbols). */
  const listRows = () => (compareHome() ? recentRows() : rows());

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

  /** Compare row: logo, ticker over description. */
  function compareInfo(ticker: string, description: string, logo?: string | null, tr?: [number, number] | null, dr?: [number, number] | null) {
    return (
      <div class="symbol-search-cell cmp-search-info">
        <span class="symbol-search-logo" aria-hidden="true">
          <Show when={logo} fallback={<span class="symbol-search-logo-letter">{ticker[0]}</span>}>
            <img src={logo!} alt="" crossOrigin="anonymous" decoding="async" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />
          </Show>
        </span>
        <div class="cmp-search-titles">
          <div class="cmp-search-ticker" data-name="list-item-title">{renderHighlighted(ticker, tr ?? null)}</div>
          <div class="cmp-search-desc">{renderHighlighted(description, dr ?? null)}</div>
        </div>
      </div>
    );
  }
  /** Compare result / recent row: click = Same % scale; hover shows the
   *  three placement buttons over the exchange cell. */
  function compareRow(row: FilteredRow, i: () => number) {
    return (
      <div
        data-name="symbol-search-dialog-content-item"
        data-role={compareHome() ? "recent-symbol-item" : "list-item"}
        data-symbol-name={row.symbolName}
        data-type={row.marketType}
        role="option"
        aria-selected={i() === highlightIdx()}
        class={"symbol-search-row cmp-search-row" + (i() === highlightIdx() ? " is-highlighted" : "")}
        onMouseEnter={() => setHighlightIdx(i())}
        onClick={() => addCompare(row.symbolName, "percent")}
      >
        {compareInfo(row.ticker, row.description, row.logoSrc, row.titleHighlight, row.descriptionHighlight)}
        <div class="cmp-search-buttons" data-name="compare-buttons-group">
          <For each={COMPARE_BUTTONS}>
            {(b) => (
              <button
                type="button"
                class="cmp-search-button"
                onClick={(e) => { e.stopPropagation(); addCompare(row.symbolName, b.placement); }}
              >
                {b.label}
              </button>
            )}
          </For>
        </div>
        <div class="symbol-search-cell symbol-search-exchange-cell cmp-search-exchange">
          <div class="symbol-search-market-type">{row.marketType}</div>
          <div class="symbol-search-exchange-source">
            <span class="symbol-search-exchange" title={row.exchangeTooltip ?? row.exchange}>{row.exchange}</span>
          </div>
          <Show when={rowFlag(row)}>
            <span class="symbol-search-flag" aria-hidden="true">
              <img src={rowFlag(row)!} alt="" crossOrigin="anonymous" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />
            </span>
          </Show>
        </div>
      </div>
    );
  }

  return (
    <Portal mount={document.body}>
      <div
        class="symbol-search-backdrop"
        role="presentation"
        onMouseDown={() => props.onClose()}
      >
        <div
          class="symbol-search-dialog"
          classList={{ "is-compare": !!props.compare }}
          role="dialog"
          data-name={props.compare ? "compare-dialog" : props.watchlist ? "watchlist-symbol-search-dialog" : "symbol-search-items-dialog"}
          aria-label={dialogTitle()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <header class="symbol-search-header">
            <span class="symbol-search-title">{dialogTitle()}</span>
            <button
              type="button"
              aria-label="Close menu"
              class="symbol-search-close"
              onClick={() => props.onClose()}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 18 18"
                width="18"
                height="18"
              >
                <path
                  stroke="currentColor"
                  stroke-width="1.2"
                  fill="none"
                  d="m1.5 1.5 15 15m0-15-15 15"
                />
              </svg>
            </button>
          </header>

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

          {/* Filter chips — Stocks + All tabs. No Country and Sector chips:
              both are plan-dependent: this feed is US-only and the
              provider's reference search has no sector filter, so they are
              omitted rather than rendered dead. Only the working Type chip
              (provider `type` filter) remains. */}
          <Show when={!props.compare && category() === "stocks"}>
            <div class="symbol-search-filters">
              {/* Type — functional dropdown (Massive `type` filter). */}
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
                <For each={listRows()}>{(row, i) => compareRow(row, i)}</For>
              </div>
            </Show>
            <Show when={props.compare && !compareHome()}>
              <Show when={rows().length > 0} fallback={<Show when={!searching()}><div class="ot-empty-state symbol-search-empty">No matches</div></Show>}>
                <div class="symbol-search-list is-compare" role="listbox" ref={listEl}>
                  <For each={rows()}>{(row, i) => compareRow(row, i)}</For>
                </div>
              </Show>
            </Show>
            <Show
              when={!props.compare && rows().length > 0}
              fallback={
                <Show when={!props.compare && !searching()}>
                  <div class="ot-empty-state symbol-search-empty">No matches</div>
                </Show>
              }
            >
              <div
                class="symbol-search-list"
                classList={{ "is-watchlist": !!props.watchlist && !multiMode(), "has-list-actions": anyInList() }}
                role="listbox"
                ref={listEl}
              >
                <For each={rows()}>
                  {(row, i) => {
                    const isActive = () => row.symbolName === props.activeSymbol;
                    const isHighlighted = () => i() === highlightIdx();
                    return (
                      <div
                        data-name="symbol-search-dialog-content-item"
                        data-symbol-name={row.symbolName}
                        data-type={row.marketType}
                        role="option"
                        aria-selected={isHighlighted()}
                        class={
                          "symbol-search-row" +
                          (isActive() ? " is-active-symbol" : "") +
                          (isHighlighted() ? " is-highlighted" : "") +
                          (flashed() === row.symbolName ? " is-flashed" : "")
                        }
                        onMouseEnter={() => setHighlightIdx(i())}
                        onClick={(e) => commit(row, e.shiftKey)}
                      >
                        <div class="symbol-search-cell symbol-search-info-cell">
                          <span class="symbol-search-marker" aria-hidden="true">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 12" width="14" height="12" fill="currentColor">
                              <path d="M14 12l-4-6 4-6H0v12z" />
                            </svg>
                          </span>
                          <span class="symbol-search-logo" aria-hidden="true">
                            <Show
                              when={row.logoSrc}
                              fallback={
                                <span class="symbol-search-logo-letter">
                                  {row.ticker[0]}
                                </span>
                              }
                            >
                              <img
                                src={row.logoSrc!}
                                alt=""
                                crossOrigin="anonymous"
                                decoding="async"
                                onError={(e) =>
                                  ((e.currentTarget as HTMLImageElement).style.display =
                                    "none")
                                }
                              />
                            </Show>
                          </span>
                          <div class="symbol-search-title-cell">
                            {renderHighlighted(row.ticker, row.titleHighlight)}
                          </div>
                        </div>

                        <div class="symbol-search-cell symbol-search-desc-cell">
                          {renderHighlighted(row.description, row.descriptionHighlight)}
                        </div>

                        <div class="symbol-search-cell symbol-search-exchange-cell">
                          <div class="symbol-search-market-type">
                            {row.marketType}
                          </div>
                          <div class="symbol-search-exchange-source">
                            <Show when={row.primaryExchange}>
                              <span class="symbol-search-primary-icon" title="Primary exchange" aria-hidden="true">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="14" height="14" fill="none">
                                  <path fill="currentColor" d="M15 11.5V14H3v-2.5zm-2.25-3.75L15 6v4H3V6l2.25 1.75L9 4z" />
                                </svg>
                              </span>
                            </Show>
                            <span
                              class="symbol-search-exchange"
                              title={row.exchangeTooltip ?? row.exchange}
                            >
                              {row.exchange}
                            </span>
                          </div>
                          <Show when={rowFlag(row)}>
                            <span class="symbol-search-flag" aria-hidden="true">
                              <img
                                src={rowFlag(row)!}
                                alt=""
                                crossOrigin="anonymous"
                                onError={(e) =>
                                  ((e.currentTarget as HTMLImageElement).style.display =
                                    "none")
                                }
                              />
                            </span>
                          </Show>
                        </div>

                        <Show when={!multiMode() && props.watchlist}>
                          {(wl) => (
                            <div class="symbol-search-cell symbol-search-actions-cell">
                              <Show
                                when={wl().has(row.symbolName)}
                                fallback={
                                  <span
                                    role="img"
                                    class="symbol-search-action is-add"
                                    title="Add to Watchlist"
                                    innerHTML={ICON_ADD}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      addRow(row);
                                      afterAction(e.shiftKey);
                                    }}
                                  />
                                }
                              >
                                <span
                                  role="img"
                                  class="symbol-search-action is-remove"
                                  title="Remove from Watchlist"
                                  innerHTML={ICON_REMOVE}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    wl().remove(row.symbolName);
                                    afterAction(e.shiftKey);
                                  }}
                                />
                                <span
                                  role="img"
                                  class="symbol-search-action is-goto"
                                  title="Go to symbol"
                                  innerHTML={ICON_GOTO}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    wl().goTo(row.symbolName);
                                    props.onClose();
                                  }}
                                />
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
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
                  Search using ISIN and CUSIP codes
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
        </div>
      </div>
    </Portal>
  );
}
