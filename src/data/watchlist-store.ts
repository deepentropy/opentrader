/*
 * Multi-list watchlist store — holds several named lists (each with its own
 * sections + ungrouped "extras"), tracks the active one, and persists the whole
 * thing to localStorage. Seeded from WATCHLIST_TABS + GROUPS: the active
 * list gets the seed sections; the others start empty.
 *
 * This backs the watchlist-menu actions (Create / Make a copy / Rename / Add
 * section / Clear list / Upload) and the quick-switch toolbar. It is a process
 * singleton — a createRoot autosave effect mirrors every change to storage.
 */
import { createRoot, createEffect, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  GROUPS,
  WATCHLIST_TABS,
  type FlagColor,
  type Group,
  type Row,
  type SortKey,
} from "./watchlist";
import * as symbolFlags from "./symbol-flags";
import * as kv from "./kv";
import { isFullSymbol, tickerOf, toFullSymbol } from "./datafeed";

export type WatchList = {
  id: string;
  name: string;
  /** Left-edge / toolbar marker — a colour flag, an emoji, or neither. */
  flag: FlagColor | null;
  emoji: string | null;
  groups: Group[];
  /** Symbols added via "Add symbol" — ungrouped, shown after the sections. */
  extras: Row[];
  /** Flagged/favourited — drives the "Flagged lists" section of the list
   *  manager (favourite-watchlist star). */
  favorite: boolean;
  /** Per-list sort order (table-header / "Sort by" menu). "default" keeps the
   *  list's manual/file order. Each list remembers its own. */
  sort: SortKey;
};

/** Per-list price-move alert: notify when any symbol's |change%| ≥ threshold.
 *  Keyed by list id; absent = no alert. A local list alert. */
type AlertMap = Record<string, number>;

type StoreShape = { lists: WatchList[]; activeId: string; alerts: AlertMap };

const STORAGE_KEY = "ot:watchlist:lists:v1";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "list";
}

function cloneGroups(gs: Group[]): Group[] {
  return gs.map((g) => ({ name: g.name, rows: g.rows.map((r) => ({ ...r })) }));
}

function seed(): StoreShape {
  const lists: WatchList[] = WATCHLIST_TABS.map((t) => ({
    id: slug(t.name),
    name: t.name,
    flag: t.flag,
    emoji: t.emoji,
    // Only the seeded (active) list carries section data; the rest are empty
    // until the user adds symbols.
    groups: t.active ? cloneGroups(GROUPS) : [],
    extras: [],
    favorite: false,
    sort: "default",
  }));
  const active = WATCHLIST_TABS.find((t) => t.active) ?? WATCHLIST_TABS[0];
  return { lists, activeId: slug(active.name), alerts: {} };
}

function isValid(s: unknown): s is StoreShape {
  return (
    !!s &&
    typeof s === "object" &&
    Array.isArray((s as StoreShape).lists) &&
    (s as StoreShape).lists.length > 0 &&
    typeof (s as StoreShape).activeId === "string"
  );
}

function load(): StoreShape {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValid(parsed)) {
        // Normalise fields added in later versions so older saves still load.
        parsed.lists = parsed.lists.map((l) => ({
          ...l,
          groups: l.groups ?? [],
          extras: l.extras ?? [],
          favorite: l.favorite ?? false,
          sort: l.sort ?? "default",
        }));
        parsed.alerts ??= {};
        // Repair a dangling activeId (e.g. the active list was removed).
        if (!parsed.lists.some((l) => l.id === parsed.activeId)) {
          parsed.activeId = parsed.lists[0].id;
        }
        return parsed;
      }
    }
  } catch {
    /* malformed / unavailable — fall back to the seed */
  }
  return seed();
}

const [state, setState] = createStore<StoreShape>(load());

// Flags moved to one flag per symbol (symbol-flags.ts): the first run takes
// the row flags of every list (first colour found wins).
if (symbolFlags.needsMigration()) {
  const pairs: [string, FlagColor][] = [];
  for (const l of state.lists) {
    for (const g of l.groups) for (const r of g.rows) if (r.flag) pairs.push([r.ticker, r.flag]);
    for (const r of l.extras) if (r.flag) pairs.push([r.ticker, r.flag]);
  }
  symbolFlags.seedFlags(pairs);
}

// Autosave: a root-scoped effect serialises the store on every change.
createRoot(() => {
  createEffect(() => {
    try {
      kv.setItem(
        STORAGE_KEY,
        JSON.stringify({ lists: state.lists, activeId: state.activeId, alerts: state.alerts }),
      );
    } catch {
      /* best-effort */
    }
  });
});

// Rows holding a bare ticker (lists saved before full names, imported files)
// get their primary listing: quotes, sessions and the chart key on the full
// name. Runs again whenever such a row appears.
createRoot(() => {
  createEffect(() => {
    const bare = new Set<string>();
    for (const l of state.lists) {
      for (const r of [...l.groups.flatMap((g) => g.rows), ...l.extras]) if (!isFullSymbol(r.ticker)) bare.add(r.ticker);
    }
    for (const b of bare) {
      void toFullSymbol(b).then(
        (full) => {
          const fix = (r: Row) => (r.ticker === b ? { ...r, ticker: full, short: tickerOf(full) } : r);
          setState("lists", (ls) =>
            ls.map((l) => ({ ...l, groups: l.groups.map((g) => ({ ...g, rows: g.rows.map(fix) })), extras: l.extras.map(fix) })),
          );
        },
        () => undefined, // lookup failed (offline): kept as typed, retried on the next start
      );
    }
  });
});

// Live cross-window sync: when another window edits any list, re-load the whole
// shape (setState merges lists/activeId/alerts; the autosave effect above then
// re-serialises to an identical string, which kv.setItem dedups to a no-op).
kv.onExternalChange(STORAGE_KEY, () => setState(load()));

// ── UI request bus ─────────────────────────────────────────────────────────
// Lets a global shortcut (Shift+W) ask the watchlist — which only mounts while
// the rail's "base" tab is open — to pop the "Open list" picker. A consume-once
// flag (not persisted): App sets it, the watchlist's mount-time effect consumes
// it exactly once, so it works whether the panel is already mounted or mounts
// in response, and never re-fires on a later remount or page reload.
const [openListPending, setOpenListPending] = createSignal(false);
/** Ask the (mounted-or-about-to-mount) watchlist to open the "Open list" picker. */
export const requestOpenList = (): void => {
  setOpenListPending(true);
};
/** Reactively true exactly once per request; clears the flag as it reads it. */
export const consumeOpenListRequest = (): boolean => {
  if (!openListPending()) return false;
  setOpenListPending(false);
  return true;
};

// ── List-alert fired dedupe ─────────────────────────────────────────────────
// The fired (list, symbol) entries behind the per-list price-move alert. Lives
// here (not in Watchlist.tsx, whose module-scope evaluator consumes it) so
// deleteList can clear a removed list's entries without an import cycle.
// Persists to kv so a reload doesn't re-fire; saving a new threshold re-arms
// the list (clearFiredForList, from the watchlist's saveAlert).
const FIRED_ALERTS_KEY = "ot:watchlist:list-alert-fired:v1";
function loadFiredAlerts(): Set<string> {
  try {
    const raw = kv.getItem(FIRED_ALERTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.filter((k) => typeof k === "string"));
    }
  } catch {
    /* malformed — start empty */
  }
  return new Set();
}
/** The fired `${listId}:${SYMBOL}` keys — mutate via has/add + saveFiredAlerts. */
export const firedAlerts = loadFiredAlerts();
export function saveFiredAlerts(): void {
  try {
    kv.setItem(FIRED_ALERTS_KEY, JSON.stringify([...firedAlerts]));
  } catch {
    /* best-effort */
  }
}
kv.onExternalChange(FIRED_ALERTS_KEY, () => {
  firedAlerts.clear();
  for (const k of loadFiredAlerts()) firedAlerts.add(k);
});

/** Re-arm a list's alert: forget its fired (list, symbol) entries. */
export function clearFiredForList(listId: string): void {
  let changed = false;
  for (const k of [...firedAlerts]) {
    if (k.startsWith(`${listId}:`)) {
      firedAlerts.delete(k);
      changed = true;
    }
  }
  if (changed) saveFiredAlerts();
}

const activeIndex = () => state.lists.findIndex((l) => l.id === state.activeId);

/** Mutate the active list in place (via solid-store `produce`). */
function mutateActive(fn: (l: WatchList) => void): void {
  const i = activeIndex();
  if (i >= 0) setState("lists", i, produce(fn));
}

/** Where "Add symbol" inserts:
 *  `{ section }` = right after that section's header (section right-click),
 *  `{ section, after }` = right after that row (row right-click; `section` is
 *  the row's section, null = extras), `null` = end of the list (header button). */
export type AddAnchor = { section: string; after?: undefined } | { section: string | null; after: string } | null;

const shortOf = (name: string) => name.slice(name.indexOf(":") + 1);

function uniqueName(base: string): string {
  let name = base;
  for (let n = 2; state.lists.some((l) => l.name === name); n++) name = `${base} ${n}`;
  return name;
}
function uniqueId(base: string): string {
  const root = slug(base);
  let id = root;
  for (let n = 2; state.lists.some((l) => l.id === id); n++) id = `${root}-${n}`;
  return id;
}
/** Reactive accessors + mutators. Reading `.groups`/`.extras` off `active()`
 *  is fine-grained reactive through the store proxy. */
export const watchlistStore = {
  lists: () => state.lists,
  activeId: () => state.activeId,
  active: (): WatchList | undefined => state.lists.find((l) => l.id === state.activeId),

  setActive(id: string): void {
    if (state.lists.some((l) => l.id === id)) setState("activeId", id);
  },

  /** Create a new empty list and switch to it; returns its id. */
  createList(name = "New list"): string {
    const nm = uniqueName(name);
    const id = uniqueId(nm);
    setState("lists", (ls) => [...ls, { id, name: nm, flag: null, emoji: null, groups: [], extras: [], favorite: false, sort: "default" }]);
    setState("activeId", id);
    return id;
  },

  /** Duplicate the active list (sections + extras) and switch to the copy. */
  copyActive(): string {
    const a = state.lists[activeIndex()];
    if (!a) return state.activeId;
    const nm = uniqueName(`${a.name} copy`);
    const id = uniqueId(nm);
    setState("lists", (ls) => [
      ...ls,
      { id, name: nm, flag: null, emoji: null, groups: cloneGroups(a.groups), extras: a.extras.map((r) => ({ ...r })), favorite: false, sort: a.sort },
    ]);
    setState("activeId", id);
    return id;
  },

  /** Duplicate any list by id (sections + extras); does NOT switch active.
   *  Returns the copy's id. */
  copyList(id: string): string | undefined {
    const src = state.lists.find((l) => l.id === id);
    if (!src) return undefined;
    const nm = uniqueName(`${src.name} copy`);
    const cid = uniqueId(nm);
    setState("lists", (ls) => [
      ...ls,
      { id: cid, name: nm, flag: null, emoji: null, groups: cloneGroups(src.groups), extras: src.extras.map((r) => ({ ...r })), favorite: false, sort: src.sort },
    ]);
    return cid;
  },

  /** Delete a list by id. No-op on the last remaining list; if the active list
   *  is removed, the first surviving list becomes active. Also drops the list's
   *  alert threshold + fired-dedupe entries — a recreated list with the same
   *  name re-slugs to the same id and must not inherit them. */
  deleteList(id: string): void {
    if (state.lists.length <= 1) return;
    const wasActive = state.activeId === id;
    setState("lists", (ls) => ls.filter((l) => l.id !== id));
    if (wasActive) setState("activeId", state.lists[0]?.id ?? "");
    if (id in state.alerts) {
      setState("alerts", produce((a: AlertMap) => {
        delete a[id];
      }));
    }
    clearFiredForList(id);
  },

  /** Rename a list by id. */
  renameList(id: string, name: string): void {
    const i = state.lists.findIndex((l) => l.id === id);
    if (i >= 0) setState("lists", i, "name", (cur) => name.trim() || cur);
  },

  /** Toggle a list's flagged/favourite state (the list-manager star). */
  toggleFavorite(id: string): void {
    const i = state.lists.findIndex((l) => l.id === id);
    if (i >= 0) setState("lists", i, "favorite", (f) => !f);
  },

  /** Create a list from imported sections (and any ungrouped symbols). A flat
   *  symbol list (no `###` headers) lands as a single "IMPORTED" section so it
   *  renders under a header like the rest. */
  importList(name: string, groups: Group[], extras: Row[] = []): string {
    const nm = uniqueName(name || "Imported list");
    const id = uniqueId(nm);
    let finalGroups = groups;
    let finalExtras = extras;
    if (!groups.length && extras.length) {
      finalGroups = [{ name: "IMPORTED", rows: extras }];
      finalExtras = [];
    }
    setState("lists", (ls) => [...ls, { id, name: nm, flag: null, emoji: null, groups: finalGroups, extras: finalExtras, favorite: false, sort: "default" }]);
    setState("activeId", id);
    return id;
  },

  /** Set the active list's sort order (persisted with the list). */
  setSort(key: SortKey): void {
    mutateActive((l) => {
      l.sort = key;
    });
  },

  renameActive(name: string): void {
    mutateActive((l) => {
      l.name = name.trim() || l.name;
    });
  },
  clearActive(): void {
    mutateActive((l) => {
      l.groups = [];
      l.extras = [];
    });
  },
  addSection(name: string): void {
    mutateActive((l) => {
      l.groups.push({ name, rows: [] });
    });
  },
  renameSection(oldName: string, newName: string): void {
    mutateActive((l) => {
      const g = l.groups.find((g) => g.name === oldName);
      if (g) g.name = newName;
    });
  },
  deleteSection(name: string): void {
    mutateActive((l) => {
      l.groups = l.groups.filter((g) => g.name !== name);
    });
  },
  removeRow(sectionName: string, ticker: string): void {
    mutateActive((l) => {
      const g = l.groups.find((g) => g.name === sectionName);
      if (g) g.rows = g.rows.filter((r) => r.ticker !== ticker);
    });
  },
  /** Insert rows into the active list at `anchor`.
   *  Rows already in the list are skipped: same full name, or a row stored
   *  under the new row's short name (both are checked). A missing anchor falls
   *  back to the end of the list. The end of the list is the extras when they
   *  hold rows (they render last), else the last section, so an appended
   *  symbol joins the last section. Returns the added tickers. */
  addSymbols(rows: Row[], anchor: AddAnchor): string[] {
    const added: string[] = [];
    mutateActive((l) => {
      const has = (t: string) =>
        l.groups.some((g) => g.rows.some((r) => r.ticker === t || r.ticker === shortOf(t))) ||
        l.extras.some((r) => r.ticker === t || r.ticker === shortOf(t));
      const fresh: Row[] = [];
      for (const r of rows) {
        if (has(r.ticker) || fresh.some((f) => f.ticker === r.ticker)) continue;
        fresh.push(r);
      }
      if (!fresh.length) return;
      added.push(...fresh.map((r) => r.ticker));
      const bucket = (s: string | null) => (s == null ? l.extras : l.groups.find((g) => g.name === s)?.rows);
      if (anchor) {
        const dst = bucket(anchor.section);
        if (dst && anchor.after == null) {
          dst.splice(0, 0, ...fresh);
          return;
        }
        const i = dst ? dst.findIndex((r) => r.ticker === anchor.after) : -1;
        if (dst && i >= 0) {
          dst.splice(i + 1, 0, ...fresh);
          return;
        }
      }
      const end = l.extras.length || !l.groups.length ? l.extras : l.groups[l.groups.length - 1].rows;
      end.push(...fresh);
    });
    return added;
  },
  /** Remove a symbol from the active list wherever it sits (section or extras). */
  removeSymbol(ticker: string): void {
    mutateActive((l) => {
      for (const g of l.groups) g.rows = g.rows.filter((r) => r.ticker !== ticker);
      l.extras = l.extras.filter((r) => r.ticker !== ticker);
    });
  },
  /** Move a symbol row within / across sections (drag-and-drop reorder).
   *  `fromSection`/`toSection` name a section, or `null` for the ungrouped
   *  "extras" bucket. `toIndex` is the insertion index in the *target* list
   *  (after the row has been pulled out of its source). A no-op if the row or
   *  target list can't be found. */
  moveRow(
    fromSection: string | null,
    ticker: string,
    toSection: string | null,
    toIndex: number,
  ): void {
    mutateActive((l) => {
      const src = fromSection == null ? l.extras : l.groups.find((g) => g.name === fromSection)?.rows;
      if (!src) return;
      const i = src.findIndex((r) => r.ticker === ticker);
      if (i < 0) return;
      const [row] = src.splice(i, 1);
      const dst = toSection == null ? l.extras : l.groups.find((g) => g.name === toSection)?.rows;
      if (!dst) {
        src.splice(i, 0, row); // target vanished — put it back where it was
        return;
      }
      // Same list: removing an earlier element shifts the insertion point left.
      let idx = toIndex;
      if (fromSection === toSection && i < idx) idx--;
      idx = Math.max(0, Math.min(idx, dst.length));
      dst.splice(idx, 0, row);
    });
  },
  removeExtra(ticker: string): void {
    mutateActive((l) => {
      l.extras = l.extras.filter((r) => r.ticker !== ticker);
    });
  },
  /** Set (or clear, with `null`) a symbol's colour flag. Flags belong to
   *  the symbol (symbol-flags.ts): it shows in every list holding it. */
  setRowFlag(ticker: string, flag: FlagColor | null): void {
    symbolFlags.setFlag(ticker, flag);
  },
  /** Unflag every symbol, in all lists ("Unflag all symbols"). */
  clearAllFlags(): void {
    symbolFlags.clearAllFlags();
  },
  /** Append a row to ANOTHER list's extras ("Add X to watchlist" submenu).
   *  Deduped by full ticker across the target's sections and extras. Returns
   *  true when the row was added, false when it already existed (a no-op) so the
   *  caller can word its toast truthfully. */
  addRowTo(listId: string, row: Row): boolean {
    const i = state.lists.findIndex((l) => l.id === listId);
    if (i < 0) return false;
    const l = state.lists[i];
    const exists =
      l.groups.some((g) => g.rows.some((r) => r.ticker === row.ticker)) ||
      l.extras.some((r) => r.ticker === row.ticker);
    if (exists) return false;
    setState("lists", i, produce((wl: WatchList) => {
      wl.extras.push({ ...row, flag: null });
    }));
    return true;
  },
  /** Whether a list holds a symbol, stored under its full or short name
   *  (the same match as addSymbols). */
  listHas(listId: string, ticker: string): boolean {
    const l = state.lists.find((x) => x.id === listId);
    if (!l) return false;
    const m = (r: Row) => r.ticker === ticker || r.ticker === shortOf(ticker);
    return l.groups.some((g) => g.rows.some(m)) || l.extras.some(m);
  },
  /** Remove a symbol (full or short name) from any list (legend "Add X to
   *  watchlist" submenu: a checked list row removes the symbol). */
  removeRowFrom(listId: string, ticker: string): void {
    const i = state.lists.findIndex((l) => l.id === listId);
    if (i < 0) return;
    const keep = (r: Row) => r.ticker !== ticker && r.ticker !== shortOf(ticker);
    setState("lists", i, produce((wl: WatchList) => {
      for (const g of wl.groups) g.rows = g.rows.filter(keep);
      wl.extras = wl.extras.filter(keep);
    }));
  },
  /** Create a new list seeded with one row WITHOUT switching the active list
   *  ("Add X to watchlist → Create new list…"). Returns the new name. */
  createListWith(row: Row): string {
    const nm = uniqueName("New list");
    const id = uniqueId(nm);
    setState("lists", (ls) => [
      ...ls,
      { id, name: nm, flag: null, emoji: null, groups: [], extras: [{ ...row, flag: null }], favorite: false, sort: "default" },
    ]);
    return nm;
  },

  // ── List alerts (local price-move alert per list) ──
  alerts: () => state.alerts,
  alertFor: (listId: string): number | undefined => state.alerts[listId],
  setAlert(listId: string, threshold: number): void {
    setState("alerts", listId, threshold);
  },
  clearAlert(listId: string): void {
    setState("alerts", produce((a: AlertMap) => {
      delete a[listId];
    }));
  },
};
