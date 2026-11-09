/*
 * Symbol search state: the query (and the token under the caret in the watchlist's comma mode), the category tab
 * and type filter, the live and Economy results, the rows shown and the highlighted one.
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import {
  CATEGORIES,
  TYPE_FILTERS,
  migrateTypeCode,
  SYMBOLS,
  filterSymbols,
  liveResultsToRows,
  type FilteredRow,
  type SymbolRow,
  type SymbolCategoryId,
} from "../../../data/symbol-search";
import { economicSources, getTickerInfo, searchEconomic, searchSymbols } from "../../../data/datafeed";
import { LOCAL_EXCHANGE, localSeriesList, localSymbol } from "../../../data/local-series";
import { recentSymbols } from "../../../data/recent-symbols";
import type { SymbolSearchResult } from "../../../bindings";
import { searchResultToRow } from "../../../data/providers";
import * as kv from "../../../data/kv";
import type { SymbolSearchProps } from "./types";

/** Durable key for the Type filter chip, so the chosen filter survives both a
 *  query change (already independent state) and closing/reopening the modal or
 *  an app reload. Stores the provider's security `type`; absent = "All types" (null). */
const TYPE_FILTER_KEY = "ot:symbol-search:type-filter";
/** The symbol search opens on the category tab used last (All at first). */
const CATEGORY_KEY = "ot:symbol-search:category";
export function loadCategory(): SymbolCategoryId {
  const raw = kv.getItem(CATEGORY_KEY);
  return raw && CATEGORIES.some((c) => c.id === raw) ? (raw as SymbolCategoryId) : "all";
}

/** Read the persisted Type filter, ignoring anything not in the current
 *  catalog. A code saved by an earlier version is translated and saved back. */
export function loadTypeCode(): string | null {
  const saved = kv.getItem(TYPE_FILTER_KEY);
  if (saved == null) return null;
  const code = migrateTypeCode(saved);
  if (!TYPE_FILTERS().some((t) => t.code === code)) return null;
  if (code !== saved) kv.setItem(TYPE_FILTER_KEY, code);
  return code;
}

/** Persist the Type filter — remove the key for "All types" (null = no filter). */
export function persistTypeCode(code: string | null): void {
  if (code == null) kv.removeItem(TYPE_FILTER_KEY);
  else kv.setItem(TYPE_FILTER_KEY, code);
}

/** Live search runs only inside the Tauri shell (the Rust command hits
 *  the gateway); elsewhere (browser / offline) we fall back to the static list. */
export const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
export function tokenAt(text: string, pos: number): { value: string; offset: number } | null {
  return symbolTokens(text).find((t) => t.offset <= pos && pos <= t.offset + t.value.length) ?? null;
}
/** Names that contain a spread operator are quoted. */
export const TOKEN_ESCAPE_RE = /[+\-/*]/;

/** Economy rows in the catalogue's order (most popular first), with the query highlighted. */
function economyRows(results: SymbolSearchResult[], query: string): FilteredRow[] {
  const q = query.toUpperCase();
  return results.map((r) => {
    const row = searchResultToRow(r);
    const t = q ? row.ticker.toUpperCase().indexOf(q) : -1;
    const d = q ? row.description.toUpperCase().indexOf(q) : -1;
    return { ...row, titleHighlight: t >= 0 ? [t, t + q.length] : null, descriptionHighlight: d >= 0 ? [d, d + q.length] : null };
  });
}

/** Local tab: the imported series matching the query (name or description). */
function localRows(query: string): FilteredRow[] {
  const q = query.trim().toUpperCase();
  const rows: FilteredRow[] = [];
  for (const s of localSeriesList()) {
    const t = q ? s.name.indexOf(q) : -1;
    const d = q ? s.description.toUpperCase().indexOf(q) : -1;
    if (q && t < 0 && d < 0) continue;
    rows.push({
      symbolName: localSymbol(s.name),
      ticker: s.name,
      description: s.description,
      marketType: "",
      exchange: LOCAL_EXCHANGE,
      category: "local",
      titleHighlight: t >= 0 ? [t, t + q.length] : null,
      descriptionHighlight: d >= 0 ? [d, d + q.length] : null,
    });
  }
  return rows;
}

// Economy tab filters, kept for the app session (null = all).
export const [econCountry, setEconCountry] = createSignal<string | null>(null);
export const [econSource, setEconSource] = createSignal<string | null>(null);
export const [econCategory, setEconCategory] = createSignal<string | null>(null);

/** Countries of the economic catalogue (its series are US ones), by region:
 *  the Economy tab's country filter. */
const ECON_REGIONS: { title: string; countries: { code: string; name: string }[] }[] = [
  { title: "North America", countries: [{ code: "US", name: "USA" }] },
];
export const econCountryName = (code: string) =>
  ECON_REGIONS.flatMap((r) => r.countries).find((c) => c.code === code)?.name ?? code;

export type SymbolSearch = ReturnType<typeof createSymbolSearch>;

export function createSymbolSearch(props: SymbolSearchProps) {
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
  // Active "All types" filter — null = no type filter (the `type` parameter of the search).
  // Seeded from the persisted value so it survives reopen / reload.
  const [typeCode, setTypeCode] = createSignal<string | null>(loadTypeCode());
  const [typeMenuOpen, setTypeMenuOpen] = createSignal(false);
  const typeLabel = () =>
    TYPE_FILTERS().find((t) => t.code === typeCode())?.label ?? "All types";
  // The type filter belongs to the Stocks tab (the reference shows it there
  // only): other tabs and the Compare dialog search without it.
  const activeType = createMemo(() => (!props.compare && category() === "stocks" ? typeCode() : null));

  // Results: live gateway typeahead inside Tauri (debounced per keystroke),
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
  // Economy tab: the catalogue's series, the most popular for an empty query, within the Sources / Categories
  // filters (null until they arrive, or outside the tab).
  const economy = () => HAS_TAURI && !props.compare && !multiMode() && category() === "economy";
  const [econRaw, setEconRaw] = createSignal<SymbolSearchResult[] | null>(null);
  const [sources, setSources] = createSignal<string[]>([]);
  let econSeq = 0;
  createEffect(() => {
    if (!economy()) {
      econSeq++;
      setEconRaw(null);
      return;
    }
    const q = searchText().trim();
    const source = econSource();
    const cat = econCategory();
    const my = ++econSeq;
    const handle = window.setTimeout(async () => {
      try {
        const data = await searchEconomic(q, source, cat);
        if (econSeq === my) setEconRaw(data);
      } catch {
        if (econSeq === my) setEconRaw([]);
      }
    }, q ? 250 : 0);
    onCleanup(() => window.clearTimeout(handle));
  });
  createEffect(() => {
    if (economy() && untrack(sources).length === 0) economicSources().then(setSources).catch(() => {});
  });
  // Economy tab: the countries panel (opened from the country chip) and its search.
  const [countryPanel, setCountryPanel] = createSignal(false);
  const [countryQuery, setCountryQuery] = createSignal("");
  createEffect(() => {
    if (!economy()) setCountryPanel(false);
  });
  const countryRegions = createMemo(() => {
    const q = countryQuery().trim().toLowerCase();
    return ECON_REGIONS.map((r) => ({ ...r, countries: r.countries.filter((c) => !q || c.name.toLowerCase().includes(q)) })).filter(
      (r) => r.countries.length > 0,
    );
  });
  // Network fetch — depends on query + type only, NOT category.
  createEffect(() => {
    const q = searchText().trim();
    const type = activeType();
    // On the Economy tab too: its empty state counts the symbols of the other markets.
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
  // without a refetch. With an explicit type filter, the gateway already constrains
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
    const econ = econRaw();
    if (econ) {
      const country = econCountry();
      return economyRows(country ? econ.filter((r) => (r.locale ?? "").toUpperCase() === country) : econ, q);
    }
    if (cat === "local") return localRows(q);
    const type = activeType();
    const raw = liveRaw();
    // All tab: the imported series that match come first.
    const local = cat === "all" && q.length > 0 ? localRows(q) : [];
    if (!HAS_TAURI || q.length < 1 || raw == null) {
      const base = filterSymbols(cat, q);
      return q.length < 1 && cat === "all" ? [...historyRows(), ...base] : [...local, ...base];
    }
    return [...local, ...liveResultsToRows(raw, type ? "all" : cat, q)];
  });

  // Empty state of a tab other than All (reference app): "<query> not found in
  // <tab> with such criteria", the count of the symbols of the other markets
  // and "Show me" (the All tab); else "No symbols match your criteria".
  const otherCount = createMemo(() => {
    const q = searchText().trim();
    if (!q || category() === "all") return 0;
    const raw = liveRaw();
    if (HAS_TAURI && raw == null) return 0;
    return raw ? liveResultsToRows(raw, "all", q).length : filterSymbols("all", q).length;
  });
  const categoryLabel = () => CATEGORIES.find((c) => c.id === category())?.label ?? "";
  // Pre-select the row matching the active symbol when the result set
  // changes (incl. on query / tab change); fall back to the first row.
  createEffect(() => {
    const list = rows();
    const idx = list.findIndex((r) => r.symbolName === props.activeSymbol);
    setHighlightIdx(idx >= 0 ? idx : 0);
  });

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

  return {
    category, setCategory, query, setQuery, caret, setCaret, multiMode, searchText, highlightIdx, setHighlightIdx,
    typeCode, setTypeCode, typeMenuOpen, setTypeMenuOpen, typeLabel, searching, economy, sources,
    countryPanel, setCountryPanel, countryQuery, setCountryQuery, countryRegions,
    rows, otherCount, categoryLabel, dialogTitle, compareHome, listRows,
  };
}
