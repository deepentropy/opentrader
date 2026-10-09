/*
 * Watchlist — right-rail panel listing tracked symbols with last price and
 * change. Static seed values; live last-price overlay via
 * Feature 9 (Massive trades). Row click → updates the active chart symbol.
 *
 * Settings (Feature: watchlist settings, ported from the reference mock): the
 * header gear opens WatchlistSettingsMenu — Table/tile view, customizable
 * columns, logo toggle, Symbol/Name display. Persisted to localStorage.
 */
import { For, Show, createEffect, createMemo, createRoot, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { PanelHeader } from "../../components/PanelHeader";
import { IconButton } from "../../components/IconButton";
import {
  COLUMN_HEADERS,
  FLAG_HEX,
  FLAG_SORT_ORDER,
  HEADER_ITEMS,
  WL_COLUMNS,
  WL_ICONS,
  WL_SETTINGS_DEFAULTS,
  type FlagColor,
  type Group,
  type Row,
  type SortField,
  type SortKey,
  type WlColumnKey,
  type WlSettings,
} from "../../data/watchlist";
import {
  watchlistStore,
  consumeOpenListRequest,
  firedAlerts,
  saveFiredAlerts,
  clearFiredForList,
  canMoveItems,
  isSectionId,
  isDeletedList,
  listItems,
  sectionId,
  sectionNameOf,
  shownItems,
  type AddAnchor,
  type WatchList,
} from "../../data/watchlist-store";
import { currentWindowLabel } from "../shell/window-bridge";
import { flagOf, lastFlagColor } from "../../data/symbol-flags";
import { showConfirm } from "../../components/Dialogs";
import { promptCopyWatchlist, promptNewWatchlist } from "./watchlist-prompts";
import { WatchlistSettingsMenu } from "./WatchlistSettingsMenu";
import { WatchlistMenu } from "./WatchlistMenu";
import { SectionContextMenu, WatchlistContextMenu } from "./WatchlistContextMenu";
import { SymbolSearchDialog } from "../header/SymbolSearchDialog";
import { OpenListDialog } from "./OpenListDialog";
import { AddAlertDialog } from "./AddAlertDialog";
import { quoteFor as liveQuoteFor, type LiveQuote } from "../../data/quotes";
import { alertStore } from "../../data/alert-store";
import { alertSettings } from "../../data/alert-settings";
import { playAlertSound } from "../../data/alert-sounds";
import { setSubscription } from "../../data/subscriptions";
import { cachedSymbolSessions, localDay } from "../../data/session";
import { getTickerInfo, resolveSymbol } from "../../data/datafeed";
import * as kv from "../../data/kv";
import { marketSession } from "../../data/market-session";

const SETTINGS_KEY = "ot:watchlist:settings";

// Resizable column widths (px), persisted. The Symbol column flexes to fill the
// slack but has a resizable minimum (keyed SYMBOL_COL_KEY); data columns are
// fixed px. All draggable from the column dividers.
const COL_WIDTHS_KEY = "ot:watchlist:col-widths";
const SYMBOL_COL_KEY = "__symbol";
const DEFAULT_COL_W = 64;
const DEFAULT_SYMBOL_W = 110;
const MIN_COL_W = 40;
const MAX_COL_W = 280;
function loadColWidths(): Record<string, number> {
  try {
    const raw = kv.getItem(COL_WIDTHS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch {
    /* malformed / unavailable — fall back to defaults */
  }
  return {};
}

function isNegative(v: string): boolean {
  return v.startsWith("−") || v.startsWith("-");
}
function formatLast(price: number): string {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** Signed change, 2 decimals, Unicode minus (e.g. "0.76", "−3.04"). */
function fmtChange(v: number): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
}
/** Signed percent with Unicode minus (e.g. "6.92%", "−3.07%"). */
function fmtPercent(v: number): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
}
/** Compact volume with a K/M/B suffix, trailing zeros trimmed (e.g. "11.95 M",
 *  "4 M", "577.2 K"). */
function fmtVolume(v: number): string {
  const abs = Math.abs(v);
  const [div, suffix] =
    abs >= 1e9 ? [1e9, " B"] : abs >= 1e6 ? [1e6, " M"] : abs >= 1e3 ? [1e3, " K"] : [1, ""];
  return parseFloat((v / div).toFixed(2)).toString() + suffix;
}


/** Watchlist view of a symbol's own session: "extended" = pre/post-market
 *  (Ext column + amber status dot), "closed" = grey dot. A symbol whose
 *  session is not resolved yet shows neither (as "regular"). */
type MarketState = "regular" | "extended" | "closed";
function marketState(symbol: string, now: Date = new Date()): MarketState {
  const s = marketSession(symbol, now);
  return s === "closed" ? "closed" : s === "pre" || s === "post" ? "extended" : "regular";
}

function loadSettings(): WlSettings {
  try {
    const raw = kv.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<WlSettings>;
      return {
        ...WL_SETTINGS_DEFAULTS,
        ...s,
        columns: { ...WL_SETTINGS_DEFAULTS.columns, ...(s.columns ?? {}) },
      };
    }
  } catch {
    /* malformed / unavailable — fall back to defaults */
  }
  return { ...WL_SETTINGS_DEFAULTS, columns: { ...WL_SETTINGS_DEFAULTS.columns } };
}

type Props = {
  /** Active chart symbol in full form (e.g. "NASDAQ:TSLA"). May be undefined
   *  for tickers absent from the symbol-search dataset (e.g. watchlist-only
   *  names), which is why `activeTicker` exists for selection. */
  activeSymbol?: string;
  /** Active chart symbol in BARE form (e.g. "TSLA"). The chart symbol after a
   *  row click is always the bare ticker, so this is what reliably matches a
   *  row's `short` for the selection highlight. */
  activeTicker?: string;
  /** Fires with the full ticker ("NASDAQ:INTC") on row click. */
  onSymbolSelect?: (ticker: string) => void;
  /** Row menu "Add … to compare": the symbols join the focused chart as
   *  compared symbols, in this order. */
  onAddCompare?: (tickers: string[]) => void;
  /** Active chart interval (currently unused here; kept for future per-symbol
   *  actions that need it). */
  interval?: string;
};

/** Left-edge colour flag. The SVG markup is WL_ICONS.flag; CSS `color` does
 *  the tint. */
function FlagMarker(props: { flag: FlagColor }) {
  return (
    <span
      class="watchlist-flag"
      aria-hidden="true"
      style={{ color: FLAG_HEX[props.flag] }}
      innerHTML={WL_ICONS.flag}
    />
  );
}

/** A saved list's marker: its colour flag, else its emoji, else its initial —
 *  used in the header title and the quick-switch toolbar. */
function ListMarker(props: { flag: FlagColor | null; emoji: string | null; name: string }) {
  return (
    <Show
      when={props.flag}
      fallback={
        props.emoji
          ? <span class="watchlist-name-emoji">{props.emoji}</span>
          : <span class="watchlist-tab-initial">{props.name.charAt(0).toUpperCase()}</span>
      }
    >
      {(f) => <FlagMarker flag={f()} />}
    </Show>
  );
}

/** Parse an uploaded watchlist file into sections + ungrouped rows. Follows
 *  this text format: a line starting with `###` names a section, and
 *  the symbols that follow (comma/space/semicolon/newline-separated) belong to
 *  it until the next `###`. Symbols before any `###` are ungrouped. Tokens may
 *  be bare ("AAPL") or exchange-qualified ("NASDAQ:AAPL"); dupes are dropped,
 *  and empty sections (e.g. a leading title line) are discarded. */
function parseWatchlistFile(text: string): { groups: Group[]; extras: Row[] } {
  const seen = new Set<string>();
  const groups: Group[] = [];
  const extras: Row[] = [];
  let current = extras; // rows before the first section header stay ungrouped

  const addTokens = (chunk: string, target: Row[]) => {
    for (const raw of chunk.split(/[\s,;]+/)) {
      const tok = raw.trim().toUpperCase();
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      const short = tok.includes(":") ? tok.slice(tok.indexOf(":") + 1) : tok;
      target.push({ ticker: tok, short, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null });
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("###")) {
      const g: Group = { name: trimmed.replace(/^#+/, "").trim(), rows: [] };
      groups.push(g);
      current = g.rows;
      continue;
    }
    addTokens(trimmed, current);
  }

  return { groups: groups.filter((g) => g.rows.length > 0), extras };
}

// ── Sort model ── shared by the table-view column headers (click to sort) and
// the tile-view "Sort by" menu. The SortField/SortKey types live in the data
// layer (watchlist.ts) since the store persists the active list's sort.
/** A sortable table-header item: the flag button, the fixed Symbol column, or
 *  a data column. */
type HeaderCol = "flag" | "symbol" | WlColumnKey;
/** Maps a table column (incl. the fixed Symbol column) to its sort field. */
const COL_SORT: Record<HeaderCol, SortField> = {
  flag: "flag",
  symbol: "symbol",
  last: "last",
  change: "chg",
  change_percent: "change",
  volume: "volume",
  rchp: "ext",
};
/** Tile-view "Sort by" menu: each field has an ascending and a descending row. */
const SORT_MENU_FIELDS: { field: SortField; label: string }[] = [
  { field: "change", label: "Change %" },
  { field: "chg", label: "Change" },
  { field: "last", label: "Last" },
  { field: "symbol", label: "Symbol" },
];
/** Parse a stored display string ("−3.07%", "1,641.64") to a number. */
function numFromStr(s?: string): number {
  if (!s) return NaN;
  return parseFloat(s.replace(/−/g, "-").replace(/,/g, "").replace(/[%\s]/g, ""));
}

// ── List alerts (module singleton) ───────────────────────────────────────────
// Notify when a symbol of a list with an alert moves by at least the list's
// threshold (|session change %|). Every list with an alert is checked, not
// only the open one (its symbols are kept subscribed below). A symbol fires
// once per trading day (its exchange day), so the alert re-arms each day.
// A fire follows the alert settings (system notification, sound) and is
// written to the Alerts log. The evaluation loop must not depend on the panel
// being mounted (RightRail unmounts it with the tab), so it lives in a
// detached root at module scope — the same hoisting pattern as
// data/quotes.ts. The fired (list, symbol, day) dedupe set lives in
// watchlist-store (so deleteList can clear a removed list's entries); saving
// a new threshold re-arms the list (clearFiredForList, from saveAlert).

// Mounted panels subscribe here for the in-panel toast; the OS notification
// below fires whether or not any panel is showing.
type ListAlertListener = (title: string, body: string) => void;
/** Sound of a list alert fire (the alert dialog's default sound). */
const LIST_ALERT_SOUND = "fired";
const listAlertListeners = new Set<ListAlertListener>();

function fireListAlert(title: string, body: string, listId: string, symbol: string): void {
  alertStore.recordFire({
    alertId: `list:${listId}`,
    symbol,
    resolution: "1D",
    name: title,
    message: body,
    fireTime: Date.now(),
    barTime: null,
    soundFile: LIST_ALERT_SOUND,
    logoUrl: null,
  });
  playAlertSound(LIST_ALERT_SOUND);
  try {
    if (alertSettings.systemNotifications() && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    /* notifications unavailable — a mounted panel's toast still covers it */
  }
  for (const fn of [...listAlertListeners]) {
    try {
      fn(title, body);
    } catch {
      /* a bad listener must not break firing */
    }
  }
}

// App-lifetime evaluation: re-runs when the active list, its threshold, or any
// member quote changes (quotes.ts keeps the subscription alive for these rows).
// Main window ONLY — detached windows load this same module, and a second
// evaluator would double-fire every list alert (the kv dedupe set only syncs
// after its 120ms debounce). Secondary windows still render the panel UI.
createRoot(() => {
  // Symbols of every list with an alert stay subscribed (quotes.ts keeps
  // only the open list's symbols).
  createEffect(() => {
    const syms = new Set<string>();
    for (const l of watchlistStore.lists()) {
      if (watchlistStore.alertFor(l.id) == null) continue;
      for (const r of [...l.groups.flatMap((g) => g.rows), ...l.extras]) syms.add(r.ticker.toUpperCase());
    }
    setSubscription("list-alerts", [...syms]);
  });
  createEffect(() => {
    if (currentWindowLabel() !== "main") return;
    // Drop fired keys older than a week (one per symbol and day).
    const today = Math.floor(Date.now() / 86400000);
    let pruned = false;
    for (const k of [...firedAlerts]) {
      const d = Number(k.split(":").pop());
      if (Number.isFinite(d) && d > 10000 && d < today - 7) {
        firedAlerts.delete(k);
        pruned = true;
      }
    }
    if (pruned) saveFiredAlerts();
    for (const list of watchlistStore.lists()) {
      const threshold = watchlistStore.alertFor(list.id);
      if (threshold == null) continue;
      const rows = [...list.groups.flatMap((g) => g.rows), ...list.extras];
      for (const r of rows) {
        const cp = liveQuoteFor(r.ticker)?.changePercent ?? null;
        if (cp == null || Math.abs(cp) < threshold) continue;
        // Once per symbol per trading day (exchange day; local day until the
        // symbol's session is known).
        const tz = cachedSymbolSessions(r.ticker)?.timeZone;
        const day = tz ? localDay(tz, Date.now() / 1000) : Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
        const key = `${list.id}:${r.short.toUpperCase()}:${day}`;
        if (firedAlerts.has(key)) continue;
        firedAlerts.add(key);
        saveFiredAlerts();
        fireListAlert(
          `Alert · ${list.name}`,
          `${r.short.toUpperCase()} ${cp >= 0 ? "+" : ""}${cp.toFixed(2)}%`,
          list.id,
          r.ticker,
        );
      }
    }
  });
});

export function Watchlist(props: Props) {
  const watchlistsHeader = HEADER_ITEMS.find((h) => h.dataName === "watchlists-button");
  const activeWatchlist = watchlistsHeader?.currentValue ?? "Watchlist";
  const actionItems = HEADER_ITEMS.filter((h) => h.dataName !== "watchlists-button");

  // ── Active list (multi-list store) ──
  // The store owns the lists + which one is active and persists to localStorage.
  // Its sections/extras drive the rows; its marker drives the header + toolbar.
  const active = (): WatchList | undefined => watchlistStore.active();
  const groups = () => active()?.groups ?? [];
  const extras = () => active()?.extras ?? [];
  const listName = () => active()?.name ?? activeWatchlist;
  const allRows = () => extras().concat(groups().flatMap((g) => g.rows));

  // Inline header rename (the menu's "Rename" action edits the active list name).
  const [renamingList, setRenamingList] = createSignal(false);
  const [listDraft, setListDraft] = createSignal("");

  const [settings, setSettings] = createSignal<WlSettings>(loadSettings());
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // "Add symbol" search dialog + where its symbols are inserted (anchor:
  // header button = end of list, section menu = top of that section, row
  // menu = right after that row).
  const [addOpen, setAddOpen] = createSignal(false);
  const [addAnchor, setAddAnchor] = createSignal<AddAnchor>(null);
  // "Deleted symbols" takes no symbol by hand, no section and no new name.
  const inDeleted = () => isDeletedList(watchlistStore.activeId());
  const openAdd = (anchor: AddAnchor) => {
    if (inDeleted()) return;
    setAddAnchor(anchor);
    setAddOpen(true);
  };
  // "Open list…" picker + "Add alert…" dialog (watchlist menu actions).
  const [openListOpen, setOpenListOpen] = createSignal(false);
  const [alertOpen, setAlertOpen] = createSignal(false);
  // Sort (table header, tile-view "Sort by" menu). A sort re-orders the rows of
  // the active list once, with the values of that moment, and the result is
  // the list's order: later price ticks move no row. "default" goes back to
  // the order from before the sort.
  const sortBy = (): SortKey => active()?.sort ?? "default";
  const setSortBy = (next: SortKey | ((cur: SortKey) => SortKey)): void => {
    const key = typeof next === "function" ? next(sortBy()) : next;
    if (key === "default") watchlistStore.resetSort();
    else watchlistStore.applySort(key, (rows) => sortRows(key, rows));
  };
  const [sortMenuOpen, setSortMenuOpen] = createSignal(false);
  let sortWrapEl: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (sortMenuOpen() && sortWrapEl && !sortWrapEl.contains(e.target as Node)) setSortMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    onCleanup(() => window.removeEventListener("pointerdown", onDown));
  });
  // Hidden file input backing the menu's "Upload list…" action.
  let uploadInput: HTMLInputElement | undefined;

  // ── Transient toast (share confirmation, alert firing) ──
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: number | undefined;
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(null), 3000);
  };
  onCleanup(() => {
    if (toastTimer) clearTimeout(toastTimer);
  });
  // Surface module-singleton list-alert fires as an in-panel toast while mounted
  // (the singleton raises the OS notification itself, mounted or not).
  onMount(() => {
    const onFire: ListAlertListener = (title, body) => showToast(`${title}: ${body}`);
    listAlertListeners.add(onFire);
    onCleanup(() => listAlertListeners.delete(onFire));
  });
  createEffect(() => {
    try {
      kv.setItem(SETTINGS_KEY, JSON.stringify(settings()));
    } catch {
      /* best-effort */
    }
  });
  // Live cross-window sync for the view prefs (raw signal setters; the persist
  // effects above then re-write identical strings, which kv.setItem dedups).
  onCleanup(kv.onExternalChange(SETTINGS_KEY, () => setSettings(loadSettings())));
  // (Sort is per-list now — synced via the watchlist store's own cross-window sync.)

  /** Visible data columns (after the fixed Symbol column), in display order —
   *  driven by the gear's per-column checkboxes. */
  const visibleCols = () =>
    WL_COLUMNS.filter((c) => settings().columns[c.key]);

  /** Favourited lists — shown icon-only in the quick-switch bar under the title. */
  const favoriteLists = () => watchlistStore.lists().filter((l) => l.favorite);

  // Per-column widths (px), keyed by column key, drag-resizable from the column
  // dividers and persisted. Symbol flexes to fill the slack but has a resizable
  // minimum (so it hugs the left while the data columns hug the right).
  const [colWidths, setColWidths] = createSignal<Record<string, number>>(loadColWidths());
  onCleanup(kv.onExternalChange(COL_WIDTHS_KEY, () => setColWidths(loadColWidths())));
  const symbolW = () => colWidths()[SYMBOL_COL_KEY] ?? DEFAULT_SYMBOL_W;
  const gridTemplate = () =>
    `minmax(${symbolW()}px, 1fr) ${visibleCols().map((c) => `${colWidths()[c.key] ?? DEFAULT_COL_W}px`).join(" ")}`;

  // Root <aside> + column-header refs, and the guide line under a column
  // divider (x = divider centre, top = header bottom, both px from the aside).
  // It is drawn while a divider is hovered or dragged: 2px #132042 from the
  // header's bottom to the list's.
  let asideEl!: HTMLElement;
  let headersEl!: HTMLDivElement;
  const [guide, setGuide] = createSignal<{ x: number; top: number } | null>(null);
  let resizing = false;
  const showGuide = (handle: HTMLElement) => {
    const a = asideEl.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    // -1: the guide starts at the bottom of the header cells, over the
    // header's 1px border (separator top = 27 of the 28px strip).
    setGuide({ x: h.left + h.width / 2 - a.left, top: headersEl.getBoundingClientRect().bottom - 1 - a.top });
  };

  /** Drag a column's right-edge divider to resize that column (clamped);
   *  persists on release. The shared grid template repaints both header and
   *  rows; the guide line follows the divider while dragging. */
  function startColResize(e: PointerEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const isSymbol = key === SYMBOL_COL_KEY;
    const startW = colWidths()[key] ?? (isSymbol ? DEFAULT_SYMBOL_W : DEFAULT_COL_W);
    const min = isSymbol ? 60 : MIN_COL_W;
    const max = isSymbol ? MAX_COL_W : MAX_COL_W;
    resizing = true;
    showGuide(handle);
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(min, Math.min(max, startW + (ev.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [key]: w }));
      showGuide(handle);
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      resizing = false;
      // Released over the divider: it is still hovered, keep its guide.
      if (!handle.contains(document.elementFromPoint(ev.clientX, ev.clientY))) setGuide(null);
      try {
        kv.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths()));
      } catch {
        /* best-effort */
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }
  /** Column divider in the header: the resize grab area plus the hover line.
   *  Hidden (CSS) on the last column: there is no divider there, so the
   *  last column is not resizable. */
  const colResizeHandle = (key: string) => (
    <span
      class="watchlist-col-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => startColResize(e, key)}
      onPointerEnter={(e) => {
        if (!resizing) showGuide(e.currentTarget);
      }}
      onPointerLeave={() => {
        if (!resizing) setGuide(null);
      }}
    />
  );

  // ── Feature 9: live quote overlay (last + Chg/Chg%/Vol) on the static rows. ──
  // Quotes live in the process-singleton store (data/quotes.ts), which owns the
  // subscription and the trade-tick feed for the app's lifetime. The panel just
  // reads them, so closing/reopening keeps prices and never refetches.
  const quoteFor = (symbol: string): LiveQuote | undefined => liveQuoteFor(symbol);

  // (List-alert evaluation runs in the module-level singleton above — it must
  // keep firing while this panel is unmounted.)

  function lastForRow(row: { ticker: string; last: string }): string {
    const q = quoteFor(row.ticker);
    if (q?.last != null) return formatLast(q.last);
    return row.last;
  }

  // ── Company names (the "Name" symbol-display + tile sub-line) ──
  // Resolved lazily from Massive reference (get_ticker_info) and cached; falls
  // back to the ticker while loading or when the provider has no name. Fetched
  // only when needed: tile view, or table view with the "Name" radio selected.
  const [names, setNames] = createSignal<Record<string, string>>({});
  const needNames = () => !settings().tableView || settings().symbolDisplay === "description";
  const nameFor = (r: Row) => names()[r.ticker] || "";
  createEffect(() => {
    if (!needNames()) return; // tracks settings + the active list's rows
    const rows = allRows();
    const cached = untrack(names);
    const pending = rows.filter((r) => cached[r.ticker] === undefined);
    if (pending.length === 0) return;
    let cancelled = false;
    Promise.all(
      pending.map((r) =>
        getTickerInfo(r.ticker)
          .then((info) => ({ symbol: r.ticker, name: info?.name ?? "" }))
          .catch(() => ({ symbol: r.ticker, name: "" })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setNames((prev) => {
        const next = { ...prev };
        for (const { symbol, name } of results) next[symbol] = name;
        return next;
      });
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  /** Primary row label — company name when the "Name" radio is on and a name
   *  has resolved, otherwise the ticker. */
  const primaryLabel = (r: Row) =>
    settings().symbolDisplay === "description" && nameFor(r) ? nameFor(r) : r.short;

  /** The "Ext" column — pre/post-market move. Has a value only during the
   *  extended-hours sessions; blank during the regular session and while the
   *  market is fully closed (overnight / weekend). Prefers the live ext move,
   *  falling back to the stored static value. */
  function extForRow(r: Row): { text: string; tint?: "up" | "down" } {
    const q = quoteFor(r.ticker);
    const text = marketState(r.ticker) !== "extended"
      ? ""
      : q?.extChangePercent != null
        ? fmtPercent(q.extChangePercent)
        : r.prePostChange;
    return { text, tint: text ? (isNegative(text) ? "down" : "up") : undefined };
  }

  /** Market-status dot beside the ticker: grey while the row's market is fully
   *  closed, amber on a row carrying an extended-hours quote, none during
   *  the regular session. Returns the modifier class, or "" for no dot. */
  function dotClass(r: Row): string {
    if (marketState(r.ticker) === "closed") return "watchlist-status-dot closed";
    return extForRow(r).text !== "" ? "watchlist-status-dot" : "";
  }

  /** Map a column key to its display value + tint for a row, preferring the live
   *  quote and falling back to the stored static value. */
  function cellFor(r: Row, key: WlColumnKey): { text: string; tint?: "up" | "down" } {
    const q = quoteFor(r.ticker);
    switch (key) {
      case "last": return { text: lastForRow(r) };
      case "change": {
        // No static fallback in the sectioned capture → "—" (untinted) until a
        // live snapshot lands.
        const text = q?.change != null ? fmtChange(q.change) : r.change ?? "—";
        return { text, tint: text === "—" ? undefined : isNegative(text) ? "down" : "up" };
      }
      case "change_percent": {
        // No live quote yet (e.g. at the open) → blank, not a misleading 0.00%.
        if (q?.changePercent == null) return { text: "" };
        const text = fmtPercent(q.changePercent);
        return { text, tint: isNegative(text) ? "down" : "up" };
      }
      case "volume": {
        return { text: q?.volume != null ? fmtVolume(q.volume) : r.volume ?? "—" };
      }
      case "rchp": return extForRow(r);
    }
  }

  // ── Sorting (tile-view "Sort by") ── prefer the live quote, fall back to the
  // stored display value; missing values sort to the end either direction.
  const sortNumber = (r: Row, field: Exclude<SortField, "symbol" | "flag">): number => {
    const q = quoteFor(r.ticker);
    switch (field) {
      case "change": return q?.changePercent ?? numFromStr(r.changePercent);
      case "chg": return q?.change ?? numFromStr(r.change);
      case "last": return q?.last ?? numFromStr(r.last);
      case "volume": return q?.volume ?? numFromStr(r.volume);
      case "ext": return q?.extChangePercent ?? numFromStr(r.prePostChange);
    }
  };
  const sortRows = (key: Exclude<SortKey, "default">, rows: Row[]): Row[] => {
    const dash = key.lastIndexOf("-");
    const field = key.slice(0, dash);
    const sign = key.slice(dash + 1) === "asc" ? 1 : -1;
    const copy = [...rows];
    copy.sort((a, b) => {
      if (field === "symbol") return sign * a.short.localeCompare(b.short);
      if (field === "flag") {
        // LIST_COLORS index; unflagged = +∞ ascending / −∞ descending, so
        // it lands last either way.
        const none = sign === 1 ? Infinity : -Infinity;
        const af = flagOf(a.ticker);
        const bf = flagOf(b.ticker);
        const ai = af ? FLAG_SORT_ORDER.indexOf(af) : none;
        const bi = bf ? FLAG_SORT_ORDER.indexOf(bf) : none;
        return ai === bi ? 0 : sign * (ai - bi);
      }
      const av = sortNumber(a, field as Exclude<SortField, "symbol" | "flag">);
      const bv = sortNumber(b, field as Exclude<SortField, "symbol" | "flag">);
      const aMissing = !Number.isFinite(av);
      const bMissing = !Number.isFinite(bv);
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1; // missing values always last
      if (bMissing) return -1;
      return sign * (av - bv);
    });
    return copy;
  };

  // ── Table-header sort ── clicking a column header sorts by it: first click
  // ascending, then it toggles asc⇄desc. While the list is sorted a button at
  // the right end of the header returns to the order from before the sort.
  // Sorting runs within each section.
  const sortDirFor = (col: HeaderCol): "asc" | "desc" | null => {
    const f = COL_SORT[col];
    const cur = sortBy();
    return cur === `${f}-asc` ? "asc" : cur === `${f}-desc` ? "desc" : null;
  };
  const toggleSort = (col: HeaderCol) => {
    const f = COL_SORT[col];
    setSortBy((cur) => (cur === `${f}-asc` ? `${f}-desc` : `${f}-asc`));
  };
  // The sort arrow and the blue label show for 5 s only, each time the sort
  // lands on a column, then fade back to the plain header.
  const [flashField, setFlashField] = createSignal<SortField | null>(null);
  createEffect(() => {
    const key = sortBy();
    if (key === "default") {
      setFlashField(null);
      return;
    }
    setFlashField(key.slice(0, key.lastIndexOf("-")) as SortField);
    const t = setTimeout(() => setFlashField(null), 5000);
    onCleanup(() => clearTimeout(t));
  });
  const isFlashing = (col: HeaderCol) => flashField() === COL_SORT[col];
  const sortArrow = (col: HeaderCol) => (
    <span
      class="watchlist-sort-arrow"
      classList={{ active: isFlashing(col), desc: sortDirFor(col) !== "asc" }}
      aria-hidden="true"
      innerHTML={WL_ICONS.sortArrow}
    />
  );
  /** Header tooltip glyph: the direction the next click applies. */
  const sortTipIcon = (col: HeaderCol) => (sortDirFor(col) === "asc" ? WL_ICONS.sortTipDown : WL_ICONS.sortTipUp);

  const headerLabel = (key: WlColumnKey) =>
    WL_COLUMNS.find((c) => c.key === key)?.header ?? COLUMN_HEADERS.find((c) => c.key === key)?.label ?? key;

  // ── Selection ── one selection for the whole list: symbol rows and section
  // headers, by item id (a row's ticker, `sectionId(name)` for a header). A
  // plain click selects one item; Ctrl/Cmd + click toggles an item, Shift +
  // click adds the range from the last touched item (`focusId`), Shift +
  // Up/Down extends it, Ctrl/Cmd + A takes every item. It is not derived from
  // the charted symbol, so the clicked row stays lit even for watchlist-only
  // symbols; a change of the charted symbol or of the list puts it back on
  // the charted symbol's row (none when the list does not hold it).
  const [selection, setSelection] = createSignal<string[]>([]);
  const [focusId, setFocusId] = createSignal<string | null>(null);
  const selectedIds = createMemo(() => new Set(selection()));
  const selectOnly = (id: string | null) => {
    setSelection(id ? [id] : []);
    setFocusId(id);
  };
  // The row of the charted listing; a row still holding a bare ticker
  // matches by ticker.
  const chartRow = createMemo((): string | null => {
    const full = props.activeSymbol;
    const bare = props.activeTicker;
    const match =
      allRows().find((r) => r.ticker === full) ??
      allRows().find((r) => !r.ticker.includes(":") && !!bare && r.ticker === bare);
    return match ? match.ticker : null;
  });
  // The charted symbol as one value: the props are read through the pane's
  // state, which also changes for other reasons (a load that ends), and such
  // a change must not put the selection back.
  const chartKey = createMemo(() => `${props.activeSymbol ?? ""}|${props.activeTicker ?? ""}`);
  createEffect(on([chartKey, watchlistStore.activeId, chartRow], () => selectOnly(chartRow())));
  // An item that left the list leaves the selection.
  createEffect(() => {
    const a = active();
    const ids = new Set(a ? listItems(a) : []);
    const cur = untrack(selection);
    if (cur.some((id) => !ids.has(id))) setSelection(cur.filter((id) => ids.has(id)));
  });
  const isSelected = (r: Row) => selectedIds().has(r.ticker);
  const isSectionSelected = (name: string) => selectedIds().has(sectionId(name));

  // ── Section UI state ── the collapsed sections are saved with the list
  // (store); which one is being renamed is view state. A header click selects
  // the section; a second click on the already-selected title enters rename.
  // Switching lists ends a rename.
  const collapsed = createMemo(() => new Set(active()?.collapsed ?? []));
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  createEffect(() => {
    watchlistStore.activeId(); // track: reset interaction state on list switch
    setRenaming(null);
    setRenamingList(false);
  });

  const isCollapsed = (name: string) => collapsed().has(name);
  const setCollapse = (names: string[], value: boolean) => watchlistStore.setSectionsCollapsed(names, value);
  // The chevron of a selected header folds / unfolds every selected section.
  const toggleCollapse = (name: string) => {
    const picked = selection().filter(isSectionId).map(sectionNameOf);
    setCollapse(picked.includes(name) ? picked : [name], !isCollapsed(name));
  };

  // The items on screen, in order (rows of collapsed sections left out).
  const shown = createMemo(() => {
    const a = active();
    return a ? shownItems(a, collapsed()) : [];
  });
  const inListOrder = (ids: string[]) => {
    const set = new Set(ids);
    return shown().filter((id) => set.has(id));
  };
  /** A click on a row or a section header updates the selection. Returns
   *  true for a click with no modifier key (the one that also acts: loads the
   *  symbol, renames the section). */
  const clickItem = (e: MouseEvent, id: string): boolean => {
    const mod = e.ctrlKey || e.metaKey;
    const cur = selection();
    let next: string[];
    if (mod && !e.shiftKey && !e.altKey) {
      next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    } else if (e.shiftKey && !mod && !e.altKey && cur.length > 0) {
      const items = shown();
      let from = items.indexOf(focusId() ?? "");
      if (from < 0) from = items.reduce((acc, x, i) => (cur.includes(x) ? i : acc), -1);
      const to = items.indexOf(id);
      next = [...cur];
      if (from >= 0 && to >= 0) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (!next.includes(items[i])) next.push(items[i]);
      }
    } else {
      next = [id];
    }
    setSelection(inListOrder(next));
    setFocusId(id);
    rowsEl?.focus();
    return !mod && !e.shiftKey && !e.altKey;
  };
  const scrollToItem = (id: string) =>
    queueMicrotask(() => {
      const el = [...(rowsEl?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])].find((e) => e.dataset.itemId === id);
      el?.scrollIntoView({ block: "nearest" });
    });
  /** Shift + Up / Down: the selection grows by the next item, or gives back
   *  the last touched one when the step goes back into it. */
  const extendSelection = (dir: 1 | -1) => {
    const items = shown();
    const n = items.length;
    if (!n) return;
    const cur = selection();
    const focus = focusId();
    let at = items.indexOf(cur.length === 1 && cur[0] !== focus ? cur[0] : (focus ?? ""));
    if ((dir === -1 && at === 0) || (dir === 1 && at === n - 1)) return;
    if (at < 0 && dir === -1) at = n;
    const id = items[at + dir];
    if (cur.includes(id) && focus) setSelection(cur.filter((x) => x !== focus));
    else setSelection(inListOrder([...cur, id]));
    setFocusId(id);
    scrollToItem(id);
  };
  // ── Removal ── Delete / Backspace removes the selected items; the remove
  // button of a selected item removes all of them, of any other item that
  // item alone. More than one item asks first. A removed section header
  // leaves its rows in the list.
  const removeItems = (ids: string[], after?: () => void) => {
    if (!ids.length) return;
    const run = () => {
      watchlistStore.removeItems(ids);
      after?.();
      rowsEl?.focus();
    };
    if (ids.length === 1) {
      run();
      return;
    }
    showConfirm({
      title: "Remove selected symbols?",
      text: `Doing this will remove ${ids.length} selected symbols from your watchlist.`,
      mainText: "Remove",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: run,
      onCancel: () => rowsEl?.focus(),
    });
  };
  const removeFromButton = (id: string) => removeItems(selectedIds().has(id) ? selection() : [id]);
  // By key: the selection then goes to the row after the last removed item
  // (the first row when there is none after it; nothing when that item ended
  // the list). The charted symbol stays.
  const removeSelection = () => {
    const ids = selection();
    const a = active();
    if (!ids.length || !a) return;
    const last = ids[ids.length - 1];
    const all = listItems(a);
    let next: string | null = null;
    if (last !== all[all.length - 1]) {
      const items = shown();
      const at = items.indexOf(last);
      const isRow = (id: string) => !isSectionId(id) && id !== last;
      next = items.slice(at + 1).find(isRow) ?? items.slice(0, Math.max(at, 0)).find(isRow) ?? null;
    }
    removeItems(ids, () => selectOnly(next && !ids.includes(next) ? next : null));
  };
  const startRename = (name: string) => {
    setRenaming(name);
    setDraft(name);
  };
  const commitRename = () => {
    const cur = renaming();
    if (cur) selectOnly(sectionId(watchlistStore.renameSection(cur, draft())));
    setRenaming(null);
  };
  // Title click: select on the first click, edit on the second (when already
  // selected) — a select→edit model. A click with Ctrl or Shift only changes
  // the selection.
  const onTitleClick = (e: MouseEvent, name: string) => {
    if (renaming() === name) return; // already editing — clicks inside must not reset
    const wasSelected = isSectionSelected(name);
    if (clickItem(e, sectionId(name)) && wasSelected) startRename(name);
  };

  // ── Drag-and-drop reorder ── rows and section headers are dragged. A drag
  // that starts on a selected item moves the whole selection, in its order on
  // screen; on any other item it moves that item alone (and selects it). A
  // section header moves alone, so the rows around it change section; a
  // collapsed section moves with its rows and only lands on a section
  // boundary (`canMoveItems`). A sorted list is dragged like any other: the
  // move ends the sort and the order on screen is the list's order. `dragIds`
  // are the items in flight; `dropTarget` is the item the insertion line sits
  // on, before or after it.
  const [dragIds, setDragIds] = createSignal<string[]>([]);
  const [dropTarget, setDropTarget] = createSignal<{ id: string; after: boolean } | null>(null);
  // The drag image: one line per item in flight, its top-left corner at the
  // pointer. It replaces the browser's own image (the row under the pointer).
  const [dragAt, setDragAt] = createSignal<{ x: number; y: number } | null>(null);
  const noDragImage = new Image();
  noDragImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const trackDrag = (e: DragEvent) => setDragAt({ x: e.clientX, y: e.clientY });
  const endDrag = () => {
    document.removeEventListener("dragover", trackDrag);
    setDragIds([]);
    setDropTarget(null);
    setDragAt(null);
  };
  onCleanup(() => document.removeEventListener("dragover", trackDrag));

  const onItemDragStart = (e: DragEvent, id: string) => {
    if (!selectedIds().has(id)) selectOnly(id);
    setDragIds(inListOrder(selection()));
    setDragAt({ x: e.clientX, y: e.clientY });
    document.addEventListener("dragover", trackDrag);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", isSectionId(id) ? sectionNameOf(id) : id);
      e.dataTransfer.setDragImage(noDragImage, 0, 0);
    }
  };
  // Container-level drag-over: the WHOLE list is a drop zone, so the no-drop
  // cursor never shows over gaps/padding. The target is the item under the
  // pointer (the closest one over a gap), before it in its top half, after it
  // in its bottom half. No line over a dragged item; a place the dragged items
  // cannot take keeps the last valid line.
  const onRowsDragOver = (e: DragEvent) => {
    const ids = dragIds();
    if (!ids.length) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const container = e.currentTarget as HTMLElement;
    let el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-item-id]") ?? null;
    if (!el) {
      let bestDist = Infinity;
      for (const c of container.querySelectorAll<HTMLElement>("[data-item-id]")) {
        const rect = c.getBoundingClientRect();
        const dist = Math.abs(e.clientY - (rect.top + rect.height / 2));
        if (dist >= bestDist) continue;
        bestDist = dist;
        el = c;
      }
    }
    const id = el?.dataset.itemId;
    if (!el || !id) return;
    if (ids.includes(id)) {
      setDropTarget(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const after = e.clientY >= rect.top + rect.height / 2;
    if (canMoveItems(shown(), collapsed(), ids, id, after)) setDropTarget({ id, after });
  };
  const onRowsDrop = (e: DragEvent) => {
    const ids = dragIds();
    const t = dropTarget();
    if (ids.length && t) {
      e.preventDefault();
      watchlistStore.moveItems(ids, t.id, t.after, collapsed());
    }
    endDrag();
  };
  const onRowsDragEnd = () => endDrag();
  const isDragging = (id: string) => dragIds().includes(id);
  // Insertion line above (`drop-before`) or below (`drop-after`) an item.
  const dropBefore = (id: string) => {
    const t = dropTarget();
    return !!t && t.id === id && !t.after;
  };
  const dropAfter = (id: string) => {
    const t = dropTarget();
    return !!t && t.id === id && t.after;
  };

  // ── Added / found rows: highlighted for 500 ms, and the last one scrolls
  // into view.
  const [highlighted, setHighlighted] = createSignal<Set<string>>(new Set());
  let highlightTimer: number | undefined;
  onCleanup(() => window.clearTimeout(highlightTimer));
  const highlightRows = (ids: string[]) => {
    setHighlighted(new Set(ids));
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => setHighlighted(new Set<string>()), 500);
    const last = ids[ids.length - 1];
    if (last) scrollToItem(last);
  };
  const isHighlighted = (r: Row) => highlighted().has(r.ticker);

  // Add a symbol from the search dialog at the current anchor (deduped). The
  // chart symbol and the dialog stay as they are.
  const addSymbol = (name: string) => {
    const short = name.split(":").pop() || name;
    const added = watchlistStore.addSymbols(
      [{ ticker: name, short, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null }],
      addAnchor(),
    );
    if (added.length) highlightRows(added);
  };
  // Comma mode: resolve each bare name to "EXCHANGE:TICKER" (a name that
  // does not resolve is kept as typed), then insert them all, in order, at
  // the anchor.
  const addMany = (names: string[]) => {
    const anchor = addAnchor();
    void Promise.all(
      names.map((n) => (n.includes(":") ? Promise.resolve(n) : resolveSymbol(n).then((i) => i.fullName).catch(() => n))),
    ).then((full) => {
      const added = watchlistStore.addSymbols(
        full.map((name) => ({
          ticker: name, short: name.split(":").pop() || name, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null,
        })),
        anchor,
      );
      if (added.length) highlightRows(added);
    });
  };
  // Remove from the dialog. Removing the anchor row sends later adds to the
  // end of the list.
  const removeSymbolFromDialog = (name: string) => {
    watchlistStore.removeSymbol(name);
    const a = addAnchor();
    if (a && a.after === name) setAddAnchor(null);
  };
  // "Go to symbol": open its section if collapsed,
  // then highlight and scroll to it.
  const goToSymbol = (name: string) => {
    const g = groups().find((g) => g.rows.some((r) => r.ticker === name));
    if (g && isCollapsed(g.name)) setCollapse([g.name], false);
    highlightRows([name]);
  };

  // ── Watchlist-menu actions (wired to the multi-list store) ──
  // "Rename": inline-edit the active list's name in the header.
  const renameList = () => {
    if (inDeleted()) return;
    setListDraft(listName());
    setRenamingList(true);
  };
  const commitListRename = () => {
    watchlistStore.renameActive(listDraft());
    setRenamingList(false);
  };
  // "Add section": the new header goes before `before` (the row whose menu
  // asked for it; from the list menu, the charted symbol's row), at the end
  // of the list when there is no such row. It is highlighted and scrolled to.
  const addSection = (before: string | null) => {
    if (!inDeleted()) highlightRows([sectionId(watchlistStore.addSection(before))]);
  };
  // "Clear list": remove every symbol from the active list (they join
  // "Deleted symbols").
  const clearList = () =>
    showConfirm({
      title: "Clear all symbols?",
      text: "Doing this will remove all symbols from your watchlist.",
      mainText: "Clear",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => watchlistStore.clearActive(),
    });
  // "Create new list…": asks the name, then a new empty list, switched-to.
  const createList = () => promptNewWatchlist((name) => watchlistStore.createList(name));
  // "Make a copy…": asks the name, then duplicates the active list (sections + extras).
  const copyList = () => {
    const a = watchlistStore.active();
    if (a) promptCopyWatchlist(`${a.name} copy`, (name) => watchlistStore.copyActive(name));
  };
  // "Upload list…": open the hidden file picker; parsed in onUploadFile.
  const uploadList = () => uploadInput?.click();
  const onUploadFile = (file: File) => {
    void file.text().then((text) => {
      const { groups, extras } = parseWatchlistFile(text);
      if (groups.length || extras.length) {
        // Imported lists start in "default" (file) order — see importList — so
        // rows keep the file's order and don't reshuffle as live quotes arrive.
        watchlistStore.importList(file.name.replace(/\.[^.]+$/, ""), groups, extras);
      }
    });
  };
  // "Open list…": the search-and-switch picker.
  const openList = () => setOpenListOpen(true);
  // Shift+W (global, handled in App) routes here: App switches the rail to the
  // watchlist tab and flags a request, which this effect consumes once we're
  // mounted — opening the picker whether we were already showing or just mounted.
  createEffect(() => {
    if (consumeOpenListRequest()) setOpenListOpen(true);
  });
  // "Add alert on the list…": the threshold dialog.
  const addAlert = () => setAlertOpen(true);
  const saveAlert = (threshold: number) => {
    const listId = watchlistStore.activeId();
    watchlistStore.setAlert(listId, threshold);
    // Re-arm: clear any previously-fired entries for this list.
    clearFiredForList(listId);
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
    showToast(`Alert set: ±${threshold}% on ${active()?.name ?? "list"}`);
  };
  const removeAlert = () => {
    watchlistStore.clearAlert(watchlistStore.activeId());
    showToast("Alert removed");
  };

  // ── Keyboard navigation (ported from the reference mock) ──
  // When the list is focused: ↓ / Space load the next symbol, ↑ / Shift+Space
  // the previous one. Navigation is relative to the currently-loaded symbol and
  // runs over the *visible* rows (collapsed sections skipped) in display order.
  // The list container is made focusable (tabIndex=0) and a row click focuses
  // it so Space is delivered here next.
  let rowsEl: HTMLDivElement | undefined;
  // Nav order = rows of expanded sections, flattened in display order.
  const orderedRows = () =>
    extras().concat(
      groups()
        .filter((g) => !isCollapsed(g.name))
        .flatMap((g) => g.rows),
    );
  const navigate = (dir: 1 | -1) => {
    const rows = orderedRows();
    if (!props.onSymbolSelect || rows.length === 0) return;
    let cur = rows.findIndex((r) => isSelected(r));
    // No row selected (a section header is): go from the charted symbol.
    if (cur < 0) cur = rows.findIndex((r) => r.ticker === chartRow());
    // No current selection in the list → enter at the appropriate end.
    const next =
      cur < 0
        ? dir === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, cur + dir));
    if (next !== cur) props.onSymbolSelect(rows[next].ticker);
  };
  // App dispatches this when Space / Shift+Space is pressed while focus is on the
  // chart (not the list), so the watchlist still flips to the next/prev symbol.
  onMount(() => {
    const onNav = (e: Event) => {
      const dir = (e as CustomEvent<{ dir?: number }>).detail?.dir;
      navigate(dir === -1 ? -1 : 1);
    };
    window.addEventListener("watchlist-navigate", onNav);
    onCleanup(() => window.removeEventListener("watchlist-navigate", onNav));
  });
  const onListKeyDown = (e: KeyboardEvent) => {
    // While renaming a section (its input sits inside the keydown-bearing
    // `.watchlist-rows` grid) the nav keys must yield to the field — otherwise
    // Space / arrows scrub symbols mid-rename instead of editing the text.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const isSpace = e.code === "Space" || e.key === " ";
    if (e.shiftKey && (e.code === "ArrowDown" || e.code === "ArrowUp")) {
      e.preventDefault();
      extendSelection(e.code === "ArrowDown" ? 1 : -1);
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyA") {
      e.preventDefault();
      const a = active();
      if (a) setSelection(listItems(a));
    } else if (e.key === "Escape") {
      // Back to the charted symbol's row.
      e.preventDefault();
      selectOnly(chartRow());
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      removeSelection();
    } else if (e.code === "ArrowDown" || (isSpace && !e.shiftKey)) {
      e.preventDefault();
      navigate(1);
    } else if (e.code === "ArrowUp" || (isSpace && e.shiftKey)) {
      e.preventDefault();
      navigate(-1);
    } else if (e.altKey && e.key === "Enter") {
      // Alt+↵ flags/unflags the selected symbols. The bottom bar's maximize
      // (also Alt+↵) defers to the list whenever `.watchlist-rows` holds focus —
      // a Solid-delegated handler here can't cancel its sibling document
      // listener, so the deferral lives there, not in a useless stopPropagation.
      const rows = selectedRows();
      if (rows.length) {
        e.preventDefault();
        toggleFlags(rows);
      }
    }
  };
  // Select a row's symbol AND focus the list so Space / arrows flip next.
  const selectRow = (ticker: string) => {
    selectOnly(ticker); // optimistic: highlight immediately, even for
                        // watchlist-only symbols absent from the chart set
    props.onSymbolSelect?.(ticker);
    rowsEl?.focus();
  };

  // ── Context menus (right-click) ── one open menu at a time. The symbol-row
  // menu has this item set (flag toggle + colour row + add-to-list submenu +
  // note); rows are removed via the hover ×, not the menu. Section headers get
  // a Rename / Remove section / Add symbol menu.
  // `selected` = the rows the menu acts on when the clicked row is part of a
  // selection of several items (null = the clicked row alone).
  const [ctxMenu, setCtxMenu] = createSignal<{ row: Row; selected: Row[] | null; section: string | null; x: number; y: number } | null>(null);
  const [sectionCtx, setSectionCtx] = createSignal<{ name: string; x: number; y: number } | null>(null);
  const openContext = (e: MouseEvent, row: Row, section: string | null) => {
    e.preventDefault();
    if (!isSelected(row)) selectOnly(row.ticker); // right-click selects the row
    setCtxMenu({ row, selected: selection().length > 1 ? selectedRows() : null, section, x: e.clientX, y: e.clientY });
  };
  const openSectionContext = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isSectionSelected(name)) selectOnly(sectionId(name));
    setSectionCtx({ name, x: e.clientX, y: e.clientY });
  };
  // The selected symbols, in list order (section headers left out).
  const selectedRows = () => allRows().filter((r) => selectedIds().has(r.ticker));
  // "Flag/Unflag" (same as Alt+↵): symbols that all carry a flag lose it;
  // otherwise they all take the last used colour. Unflagging several symbols
  // asks first.
  const toggleFlags = (rows: Row[]) => {
    if (!rows.length) return;
    const color = rows.every((r) => flagOf(r.ticker)) ? null : lastFlagColor();
    const run = () => rows.forEach((r) => watchlistStore.setRowFlag(r.ticker, color));
    if (rows.length === 1 || color) {
      run();
      return;
    }
    showConfirm({
      title: "Unflag selected symbols?",
      text: "Doing this will unflag selected symbols from your watchlist.",
      mainText: "Unflag",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => {
        run();
        rowsEl?.focus();
      },
      onCancel: () => rowsEl?.focus(),
    });
  };
  // "Add … to" submenu: the lists it offers (the open list first, then the
  // others by name; no colour list, "Deleted symbols" only when it is the
  // open list) and a click on one of them.
  // A list holding every symbol loses them; any other list gets the ones it
  // misses.
  const ctxLists = () => {
    const id = watchlistStore.activeId();
    const all = watchlistStore.lists().filter((l) => !l.id.startsWith("color-") && (l.id === id || !isDeletedList(l.id)));
    return [
      ...all.filter((l) => l.id === id),
      ...all.filter((l) => l.id !== id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
  };
  const toggleRowsInList = (listId: string, rows: Row[]) => {
    const missing = rows.filter((r) => !watchlistStore.listHas(listId, r.ticker));
    if (!missing.length) rows.forEach((r) => watchlistStore.removeRowFrom(listId, r.ticker));
    else missing.forEach((r) => watchlistStore.addRowTo(listId, r));
  };
  const createListWithRows = (rows: Row[]) =>
    promptNewWatchlist((name) => {
      const nm = watchlistStore.createListWith(rows, name);
      showToast(`Added ${rows.length === 1 ? rows[0].short : `${rows.length} symbols`} to ${nm}`);
    });
  // "Add note": the editor lives in the details pane and shows the SELECTED
  // symbol's note — select the row, then ask the pane to open its note editor.
  const openNoteFor = (row: Row) => {
    selectRow(row.ticker);
    window.dispatchEvent(new CustomEvent("wl-open-note"));
  };

  // ── Per-section + per-row renderers (shared by table and tile views) ──
  // One section header: chevron (collapse), label / inline rename input, and a
  // remove button shown while the pointer is over the header (none on a
  // collapsed section).
  const groupHeader = (g: Group) => (
    <div
      class="watchlist-group"
      classList={{
        renaming: renaming() === g.name,
        highlighted: highlighted().has(sectionId(g.name)),
        selected: isSectionSelected(g.name) && renaming() !== g.name,
        dragging: isDragging(sectionId(g.name)),
        "drop-before": dropBefore(sectionId(g.name)),
        "drop-after": dropAfter(sectionId(g.name)),
      }}
      role="row"
      data-item-id={sectionId(g.name)}
      draggable={renaming() !== g.name}
      onClick={(e) => onTitleClick(e, g.name)}
      onContextMenu={(e) => openSectionContext(e, g.name)}
      onDragStart={(e) => onItemDragStart(e, sectionId(g.name))}
    >
      <button
        type="button"
        class="watchlist-group-expand"
        classList={{ collapsed: isCollapsed(g.name) }}
        aria-label={isCollapsed(g.name) ? "Expand section" : "Collapse section"}
        aria-expanded={!isCollapsed(g.name)}
        onClick={(e) => {
          e.stopPropagation();
          toggleCollapse(g.name);
        }}
        innerHTML={WL_ICONS.chevron}
      />
      <Show
        when={renaming() === g.name}
        fallback={<span class="watchlist-group-label">{g.name}</span>}
      >
        <input
          class="watchlist-group-rename"
          value={draft()}
          aria-label="Rename section"
          ref={(el) => queueMicrotask(() => el.focus())}
          onClick={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setRenaming(null);
          }}
          onBlur={commitRename}
        />
      </Show>
      <Show when={!isCollapsed(g.name)}>
        <button
          type="button"
          class="watchlist-group-delete"
          aria-label="Delete section"
          title="Delete section"
          onClick={(e) => {
            e.stopPropagation();
            removeFromButton(sectionId(g.name));
          }}
          innerHTML={WL_ICONS.trash}
        />
      </Show>
    </div>
  );

  // Remove-from-list trash — hidden until the row is hovered. Stops
  // propagation so removing doesn't also select.
  const removeButton = (onRemove: () => void) => (
    <button
      type="button"
      class="watchlist-row-remove"
      aria-label="Remove from list"
      title="Remove from list"
      innerHTML={WL_ICONS.trash}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
    />
  );

  // One table-view symbol row (dynamic column grid).
  const tableRow = (r: Row, section: string | null) => (
    <div
      role="row"
      class="watchlist-row"
      classList={{
        selected: isSelected(r),
        highlighted: isHighlighted(r),
        dragging: isDragging(r.ticker),
        "drop-before": dropBefore(r.ticker),
        "drop-after": dropAfter(r.ticker),
      }}
      data-symbol-full={r.ticker}
      data-symbol-short={r.short}
      data-item-id={r.ticker}
      aria-selected={isSelected(r) || undefined}
      style={{ "grid-template-columns": gridTemplate() }}
      draggable={true}
      onClick={(e) => {
        if (clickItem(e, r.ticker)) selectRow(r.ticker);
      }}
      onContextMenu={(e) => openContext(e, r, section)}
      onDragStart={(e) => onItemDragStart(e, r.ticker)}
    >
      <Show when={flagOf(r.ticker)}>{(f) => <FlagMarker flag={f()} />}</Show>
      <div class="watchlist-cell watchlist-symbol">
        <Show when={settings().logo}>
          <span class="ot-ticker-logo ot-ticker-logo--sm watchlist-logo" aria-hidden="true">{r.short.charAt(0)}</span>
        </Show>
        <span class="watchlist-ticker">{primaryLabel(r)}</span>
        <Show when={dotClass(r)}>
          {(c) => <span class={c()} aria-hidden="true" />}
        </Show>
      </div>
      <For each={visibleCols()}>
        {(c) => {
          // Derived accessor (not a one-shot const): each JSX read re-runs
          // cellFor → lastForRow → quoteFor, so live ticks re-render the cell.
          const cell = () => cellFor(r, c.key);
          return (
            <div class={`watchlist-cell ${cell().tint ?? ""}`} style={{ "text-align": "right" }}>
              {cell().text}
            </div>
          );
        }}
      </For>
      {removeButton(() => removeFromButton(r.ticker))}
    </div>
  );

  // One tile-view symbol row (two-line card): ticker + last on top, company
  // name + abs-change + change% below.
  const tileRow = (r: Row, section: string | null) => {
    const chg = () => cellFor(r, "change");
    const pct = () => cellFor(r, "change_percent");
    return (
      <div
        role="row"
        class="watchlist-tile"
        classList={{
          selected: isSelected(r),
          highlighted: isHighlighted(r),
          dragging: isDragging(r.ticker),
          "drop-before": dropBefore(r.ticker),
          "drop-after": dropAfter(r.ticker),
        }}
        data-symbol-full={r.ticker}
        data-item-id={r.ticker}
        aria-selected={isSelected(r) || undefined}
        draggable={true}
        onClick={(e) => {
          if (clickItem(e, r.ticker)) selectRow(r.ticker);
        }}
        onContextMenu={(e) => openContext(e, r, section)}
        onDragStart={(e) => onItemDragStart(e, r.ticker)}
      >
        <Show when={flagOf(r.ticker)}>{(f) => <FlagMarker flag={f()} />}</Show>
        <Show when={settings().logo}>
          <span class="ot-ticker-logo ot-ticker-logo--md watchlist-logo" aria-hidden="true">{r.short.charAt(0)}</span>
        </Show>
        <div class="watchlist-tile-main">
          <div class="watchlist-tile-line">
            <span class="watchlist-tile-ticker">{r.short}</span>
            <Show when={dotClass(r)}>
              {(c) => <span class={c()} aria-hidden="true" />}
            </Show>
            <span class="watchlist-tile-last">{lastForRow(r)}</span>
          </div>
          <div class="watchlist-tile-line watchlist-tile-line--sub">
            <span class="watchlist-tile-name">{nameFor(r)}</span>
            <span class={`watchlist-tile-change ${chg().tint ?? ""}`}>{chg().text}</span>
            <span class={`watchlist-tile-pct ${pct().tint ?? ""}`}>{pct().text}</span>
          </div>
        </div>
        {removeButton(() => removeFromButton(r.ticker))}
      </div>
    );
  };

  return (
    <aside ref={asideEl} class="ot-rail-panel watchlist" aria-label="Watchlist" style={{ position: "relative" }}>
      {/* Guide line under a hovered or dragged column divider. */}
      <Show when={guide()}>
        {(g) => <div class="watchlist-col-guide" aria-hidden="true" style={{ left: `${g().x}px`, top: `${g().top}px` }} />}
      </Show>
      <PanelHeader
        ariaLabel="Watchlist header"
        left={
          <Show
            when={renamingList()}
            fallback={
              <button
                class={"watchlist-name" + (menuOpen() ? " is-open" : "")}
                data-name="watchlists-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen()}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <ListMarker flag={active()?.flag ?? null} emoji={active()?.emoji ?? null} name={listName()} />
                <span class="watchlist-name-label">{listName()}</span>
                <span class="watchlist-name-arrow" aria-hidden="true" innerHTML={WL_ICONS.menuArrow} />
              </button>
            }
          >
            <input
              class="watchlist-name-rename"
              value={listDraft()}
              aria-label="Rename list"
              ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
              onInput={(e) => setListDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitListRename();
                else if (e.key === "Escape") setRenamingList(false);
              }}
              onBlur={commitListRename}
            />
          </Show>
        }
        right={
          <For each={actionItems}>
            {(h) => (
              <Tooltip text={h.label ?? ""} side="bottom">
                <IconButton
                  data-name={h.dataName}
                  aria-label={h.label ?? undefined}
                  class={
                    h.dataName === "settings-button" && settingsOpen()
                      ? "is-active"
                      : h.dataName === "add-symbol-button" && inDeleted()
                        ? "is-disabled"
                        : undefined
                  }
                  disabled={h.dataName === "add-symbol-button" && inDeleted()}
                  onClick={() => {
                    if (h.dataName === "settings-button") setSettingsOpen((o) => !o);
                    else if (h.dataName === "add-symbol-button") openAdd(null);
                  }}
                >
                  {h.iconName && <Icon name={h.iconName} size={18} />}
                </IconButton>
              </Tooltip>
            )}
          </For>
        }
      />

      <Show when={menuOpen()}>
        <WatchlistMenu
          lists={watchlistStore.shownLists()}
          activeId={watchlistStore.activeId()}
          onSelectList={(id) => watchlistStore.setActive(id)}
          onClose={() => setMenuOpen(false)}
          disabled={inDeleted() ? ["rename", "add-section"] : []}
          onRenameList={renameList}
          onAddSection={() => addSection(chartRow())}
          onClearList={clearList}
          onCreateList={createList}
          onCopyList={copyList}
          onUploadList={uploadList}
          onAddAlert={addAlert}
          onOpenList={openList}
        />
      </Show>

      <Show when={settingsOpen()}>
        <WatchlistSettingsMenu
          settings={settings()}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      {/* Quick-switch list toolbar — one round button per saved list; the
          active one is a white pill with the list's marker. Clicking switches
          the active list (multi-list store). */}
      {/* Favourite-lists quick bar: the flagged/favourited lists shown icon-only
          for one-click switching (a row of list markers under the title). */}
      <Show when={favoriteLists().length}>
        <div class="watchlist-tabs" role="toolbar" aria-label="Favourite watchlists">
          <For each={favoriteLists()}>
            {(t) => (
              <Tooltip text={t.name} side="bottom">
                <button
                  type="button"
                  class="watchlist-tab"
                  classList={{ active: t.id === watchlistStore.activeId() }}
                  aria-label={t.name}
                  aria-pressed={t.id === watchlistStore.activeId() || undefined}
                  onClick={() => watchlistStore.setActive(t.id)}
                >
                  <span class="watchlist-tab-round">
                    <ListMarker flag={t.flag} emoji={t.emoji} name={t.name} />
                  </span>
                </button>
              </Tooltip>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={settings().tableView}
        fallback={
          /* ── Tile view (two-line rows, grouped by section) ── */
          <>
          {/* Header: "Symbol" left, "Sort by ⌄" right. The sort menu sorts
              the rows in place. */}
          <div class="watchlist-tile-header" role="row">
            <span role="columnheader" class="watchlist-tile-header-symbol">Symbol</span>
            <div class="watchlist-sortby-wrap" ref={sortWrapEl}>
              <button
                type="button"
                class="watchlist-sortby"
                classList={{ "is-active": sortMenuOpen() || sortBy() !== "default" }}
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen()}
                onClick={() => setSortMenuOpen((o) => !o)}
              >
                <span>Sort by</span>
                <span class="watchlist-sortby-arrow" aria-hidden="true" innerHTML={WL_ICONS.menuArrow} />
              </button>
              <Show when={sortMenuOpen()}>
                <div class="watchlist-sort-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    class="watchlist-sort-item"
                    disabled={sortBy() === "default"}
                    onClick={() => {
                      setSortBy("default");
                      setSortMenuOpen(false);
                    }}
                  >
                    Customized order
                  </button>
                  <For each={SORT_MENU_FIELDS}>
                    {(opt) => (
                      <>
                        <div class="watchlist-sort-separator" role="separator" />
                        <For each={["asc", "desc"] as const}>
                          {(dir) => (
                            <button
                              type="button"
                              role="menuitem"
                              class="watchlist-sort-item"
                              data-name={`${opt.field}_${dir}`}
                              onClick={() => {
                                setSortBy(`${opt.field}-${dir}`);
                                setSortMenuOpen(false);
                              }}
                            >
                              <span
                                class="watchlist-sort-item-icon"
                                aria-hidden="true"
                                innerHTML={dir === "asc" ? WL_ICONS.sortAsc : WL_ICONS.sortDesc}
                              />
                              <span>{opt.label}</span>
                            </button>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
          <div
            class="watchlist-rows"
            role="grid"
            tabindex={0}
            ref={rowsEl}
            onKeyDown={onListKeyDown}
            onDragOver={onRowsDragOver}
            onDrop={onRowsDrop}
            onDragEnd={onRowsDragEnd}
          >
            <For each={extras()}>
              {(r) => tileRow(r, null)}
            </For>
            <For each={groups()}>
              {(g) => (
                <>
                  {groupHeader(g)}
                  <Show when={!isCollapsed(g.name)}>
                    <For each={g.rows}>
                      {(r) => tileRow(r, g.name)}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </div>
          </>
        }
      >
        {/* ── Table view (grouped by section) ── */}
        <div
          ref={headersEl}
          class="watchlist-column-headers"
          role="row"
          style={{ "grid-template-columns": gridTemplate() }}
        >
          <span
            role="columnheader"
            class="watchlist-column-header watchlist-column-symbol"
            aria-sort={sortDirFor("symbol") ? (sortDirFor("symbol") === "asc" ? "ascending" : "descending") : "none"}
          >
            {/* Flag-sort button in the 12px gutter left of "Symbol" (no
                arrow, no blue state; tooltip only). */}
            <span class="watchlist-column-flag">
              <Tooltip text="Click to sort by Flag" icon={sortTipIcon("flag")} side="top" farther>
                <button
                  type="button"
                  class="watchlist-column-flag-btn"
                  aria-label="Sort by flag"
                  onClick={() => toggleSort("flag")}
                  innerHTML={WL_ICONS.flag}
                />
              </Tooltip>
            </span>
            <Tooltip text="Click to sort by Symbol" icon={sortTipIcon("symbol")} side="top" farther>
              <button
                type="button"
                class="watchlist-column-label"
                classList={{ sorted: isFlashing("symbol") }}
                onClick={() => toggleSort("symbol")}
              >
                Symbol
              </button>
            </Tooltip>
            {sortArrow("symbol")}
            {colResizeHandle(SYMBOL_COL_KEY)}
          </span>
          <For each={visibleCols()}>
            {(c) => (
              <span
                role="columnheader"
                class="watchlist-column-header watchlist-column-header--num"
                aria-sort={sortDirFor(c.key) ? (sortDirFor(c.key) === "asc" ? "ascending" : "descending") : "none"}
              >
                {sortArrow(c.key)}
                <Tooltip text={`Click to sort by ${headerLabel(c.key)}`} icon={sortTipIcon(c.key)} side="top" farther>
                  <button
                    type="button"
                    class="watchlist-column-label"
                    classList={{ sorted: isFlashing(c.key) }}
                    onClick={() => toggleSort(c.key)}
                  >
                    {headerLabel(c.key)}
                  </button>
                </Tooltip>
                {colResizeHandle(c.key)}
              </span>
            )}
          </For>
          <Show when={sortBy() !== "default"}>
            <span class="watchlist-sort-reset-wrap">
              <Tooltip text="Return to custom watchlist order" side="top" farther>
                <button
                  type="button"
                  class="watchlist-sort-reset"
                  aria-label="Return to custom watchlist order"
                  onClick={() => setSortBy("default")}
                  innerHTML={WL_ICONS.sortReset}
                />
              </Tooltip>
            </span>
          </Show>
        </div>
        <div
          class="watchlist-rows"
          role="grid"
          tabindex={0}
          ref={rowsEl}
          onKeyDown={onListKeyDown}
          onDragOver={onRowsDragOver}
          onDrop={onRowsDrop}
          onDragEnd={onRowsDragEnd}
        >
          <For each={extras()}>
            {(r) => tableRow(r, null)}
          </For>
          <For each={groups()}>
            {(g) => (
              <>
                {groupHeader(g)}
                <Show when={!isCollapsed(g.name)}>
                  <For each={g.rows}>
                    {(r) => tableRow(r, g.name)}
                  </For>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>

      <Show when={addOpen()}>
        <SymbolSearchDialog
          activeSymbol={props.activeSymbol}
          onSelect={addSymbol}
          onClose={() => setAddOpen(false)}
          watchlist={{
            has: (name) => allRows().some((r) => r.ticker === name),
            add: addSymbol,
            addMany,
            remove: removeSymbolFromDialog,
            goTo: goToSymbol,
          }}
        />
      </Show>

      {/* Hidden picker backing the menu's "Upload list…" action. */}
      <input
        ref={uploadInput}
        type="file"
        accept=".txt,.csv,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) onUploadFile(file);
          e.currentTarget.value = ""; // allow re-uploading the same file
        }}
      />

      <Show when={openListOpen()}>
        <OpenListDialog
          lists={watchlistStore.lists()}
          activeId={watchlistStore.activeId()}
          onSelect={(id) => watchlistStore.setActive(id)}
          onClose={() => setOpenListOpen(false)}
        />
      </Show>

      <Show when={alertOpen()}>
        <AddAlertDialog
          listName={listName()}
          initial={watchlistStore.alertFor(watchlistStore.activeId())}
          onSave={saveAlert}
          onRemove={removeAlert}
          onClose={() => setAlertOpen(false)}
        />
      </Show>

      <Show when={ctxMenu()}>
        {(m) => (
          <WatchlistContextMenu
            row={m().row}
            selected={m().selected}
            x={m().x}
            y={m().y}
            lists={ctxLists()}
            listHas={(listId, ticker) => watchlistStore.listHas(listId, ticker)}
            onToggleFlag={toggleFlags}
            onSetFlag={(rows, flag) => rows.forEach((r) => watchlistStore.setRowFlag(r.ticker, flag))}
            onUnflagAll={() =>
              showConfirm({
                title: "Unflag all symbols?",
                text: "Doing this will unflag all symbols from all your watchlists.",
                mainText: "Unflag",
                cancelText: "Cancel",
                intent: "danger",
                onConfirm: () => watchlistStore.clearAllFlags(),
              })
            }
            onToggleList={toggleRowsInList}
            onCreateListWith={createListWithRows}
            canCompare={!!props.onAddCompare && (m().selected == null || selection().length <= 10)}
            onAddCompare={(rows) => props.onAddCompare?.(rows.map((r) => r.ticker))}
            onAddNote={openNoteFor}
            canAdd={!inDeleted()}
            onAddSection={() => addSection(m().row.ticker)}
            onAddSymbol={() => openAdd({ section: m().section, after: m().row.ticker })}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </Show>

      <Show when={sectionCtx()}>
        {(m) => (
          <SectionContextMenu
            name={m().name}
            x={m().x}
            y={m().y}
            onRename={(name) => startRename(name)}
            canRemove={!isCollapsed(m().name)}
            onRemove={(name) => removeFromButton(sectionId(name))}
            onAddSymbol={() => openAdd({ section: m().name })}
            onClose={() => setSectionCtx(null)}
          />
        )}
      </Show>

      <Show when={dragIds().length > 0 && dragAt()}>
        {(at) => (
          <Portal>
            <div class="watchlist-drag-image" aria-hidden="true" style={{ transform: `translate(${at().x}px, ${at().y}px)` }}>
              <For each={dragIds()}>
                {(id) => (
                  <div class="watchlist-drag-item" classList={{ "watchlist-drag-item--section": isSectionId(id) }}>
                    {isSectionId(id) ? sectionNameOf(id) : id.slice(id.indexOf(":") + 1)}
                  </div>
                )}
              </For>
            </div>
          </Portal>
        )}
      </Show>

      <Show when={toast()}>
        <div class="watchlist-toast" role="status">{toast()}</div>
      </Show>
    </aside>
  );
}
