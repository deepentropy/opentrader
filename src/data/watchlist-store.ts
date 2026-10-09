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
import { createRoot, createEffect, createSignal, on, untrack } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
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
  /** Symbols with no section, shown before the first section. */
  extras: Row[];
  /** Flagged/favourited — drives the "Flagged lists" section of the list
   *  manager (favourite-watchlist star). */
  favorite: boolean;
  /** The sort last applied to the list (table-header / "Sort by" menu), or
   *  "default". A sort re-orders the rows once and the new order is the
   *  list's order; this field only marks which column it was, for the header
   *  arrow and the back-to-own-order button. Not saved: any change of the
   *  list's content, a list switch or a restart sets it back to "default". */
  sort: SortKey;
};

/** Per-list price-move alert: notify when any symbol's |change%| ≥ threshold.
 *  Keyed by list id; absent = no alert. A local list alert. */
type AlertMap = Record<string, number>;

type StoreShape = { lists: WatchList[]; activeId: string; alerts: AlertMap; v?: number };

/** Saved shape version. 2: the rows with no section come before the first
 *  section (they came after the last one). */
const SHAPE_VERSION = 2;

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
  return { lists, activeId: slug(active.name), alerts: {}, v: SHAPE_VERSION };
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
          sort: "default" as SortKey,
        }));
        parsed.alerts ??= {};
        // Older saves drew the rows with no section after the last section:
        // they join it, so every row stays where it was on screen.
        if ((parsed.v ?? 1) < SHAPE_VERSION) {
          for (const l of parsed.lists) {
            if (!l.groups.length || !l.extras.length) continue;
            const last = l.groups[l.groups.length - 1];
            last.rows = [...last.rows, ...l.extras];
            l.extras = [];
          }
          parsed.v = SHAPE_VERSION;
        }
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
        JSON.stringify({
          lists: state.lists.map((l) => ({ ...l, sort: "default" })),
          activeId: state.activeId,
          alerts: state.alerts,
          v: SHAPE_VERSION,
        }),
      );
    } catch {
      /* best-effort */
    }
  });
});

// Recently used lists (the watchlist menu): a list goes to the top when it is
// opened, five at most, newest first (the reference app's recent symbol
// lists); a deleted list leaves it.
const RECENTS_KEY = "ot:watchlist:recents";
const RECENTS_MAX = 5;
function loadRecents(): string[] {
  try {
    const v = JSON.parse(kv.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}
const [recents, setRecentsRaw] = createSignal<string[]>(loadRecents());
function setRecents(next: string[]): void {
  setRecentsRaw(next);
  kv.setItem(RECENTS_KEY, JSON.stringify(next));
}
createRoot(() => {
  createEffect(
    on(() => state.activeId, (id) => {
      if (id) setRecents([id, ...untrack(recents).filter((x) => x !== id)].slice(0, RECENTS_MAX));
    }, { defer: true }),
  );
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
kv.onExternalChange(STORAGE_KEY, () => {
  beforeSort.clear();
  setState(load());
});

// ── Colour lists ("Red list", "Blue list", …) ────────────────────────────
// The reference app's flagged lists: one list per flag colour holding the
// symbols flagged with it. They are store lists (id `color-<colour>`, `flag`
// = the colour) kept in step with symbol-flags.ts both ways: a flag change
// rebuilds the colour lists' rows; adding / removing a row of a colour list
// (any store mutator) flags / unflags the symbol (`syncColorFlags`). The
// list dialog shows them under "Flagged lists" (Red always, the others when
// they hold symbols).

export const COLOR_LIST_TITLES: Partial<Record<FlagColor, string>> = {
  red: "Red list",
  blue: "Blue list",
  green: "Green list",
  orange: "Orange list",
  purple: "Purple list",
  cyan: "Cyan list",
  pink: "Pink list",
};
const COLOR_ORDER: FlagColor[] = ["red", "blue", "green", "orange", "purple", "cyan", "pink"];
export const colorListId = (c: FlagColor) => `color-${c}`;
const colorOfList = (l: WatchList): FlagColor | null => (l.id.startsWith("color-") ? l.flag : null);
const rowsOf = (l: WatchList) => [...l.extras, ...l.groups.flatMap((g) => g.rows)];
/** Where a row appended to a list goes: its last section, or the rows with
 *  no section when it has no section. */
const endOf = (l: WatchList): Row[] => (l.groups.length ? l.groups[l.groups.length - 1].rows : l.extras);
const newRow = (ticker: string): Row => ({ ticker, short: tickerOf(ticker), last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null });

// Every colour list exists (empty ones are hidden by the dialog).
{
  const missing = COLOR_ORDER.filter((c) => !state.lists.some((l) => l.id === colorListId(c)));
  if (missing.length) {
    setState("lists", (ls) => [
      ...ls,
      ...missing.map((c): WatchList => ({ id: colorListId(c), name: COLOR_LIST_TITLES[c] ?? c, flag: c, emoji: null, groups: [], extras: [], favorite: false, sort: "default" })),
    ]);
  }
}

/** Flags → colour lists: each colour list holds exactly the symbols flagged
 *  with its colour (rows kept in place, new ones appended). */
createRoot(() => {
  createEffect(() => {
    const flags = symbolFlags.allFlags();
    const byColor = new Map<FlagColor, string[]>();
    for (const [sym, c] of Object.entries(flags)) {
      if (!c) continue;
      const a = byColor.get(c) ?? [];
      a.push(sym);
      byColor.set(c, a);
    }
    untrack(() => {
      state.lists.forEach((l, i) => {
        const c = colorOfList(l);
        if (!c) return;
        const want = new Set(byColor.get(c) ?? []);
        const have = new Set(rowsOf(l).map((r) => r.ticker));
        const add = [...want].filter((s) => !have.has(s));
        const drop = [...have].some((s) => !want.has(s));
        if (!add.length && !drop) return;
        setState("lists", i, produce((wl: WatchList) => {
          for (const g of wl.groups) g.rows = g.rows.filter((r) => want.has(r.ticker));
          wl.extras = wl.extras.filter((r) => want.has(r.ticker));
          endOf(wl).push(...add.map(newRow));
        }));
      });
    });
  });
});

/** Colour lists → flags, after a store mutation: a symbol added to a colour
 *  list takes its colour; a symbol of that colour missing from it is
 *  unflagged. */
function syncColorFlags(): void {
  const flags = symbolFlags.allFlags();
  for (const l of state.lists) {
    const c = colorOfList(l);
    if (!c) continue;
    const inList = new Set(rowsOf(l).map((r) => r.ticker));
    for (const s of inList) if (flags[s] !== c) symbolFlags.setFlag(s, c);
    for (const [s, fc] of Object.entries(flags)) if (fc === c && !inList.has(s)) symbolFlags.setFlag(s, null);
  }
}

// ── List items ─────────────────────────────────────────────────────────────
// A list read as one sequence, the way it is drawn: the rows with no section,
// then each section header followed by its rows. An item is named by its id:
// the ticker of a row, `###NAME` for a section header. Selection and drags
// work on these ids.

const SECTION_ID_PREFIX = "###";
export const sectionId = (name: string): string => SECTION_ID_PREFIX + name;
export const isSectionId = (id: string): boolean => id.startsWith(SECTION_ID_PREFIX);
export const sectionNameOf = (id: string): string => id.slice(SECTION_ID_PREFIX.length);

type ListRows = Pick<WatchList, "groups" | "extras">;

/** Every item of a list, in order. */
export function listItems(l: ListRows): string[] {
  return [...l.extras.map((r) => r.ticker), ...l.groups.flatMap((g) => [sectionId(g.name), ...g.rows.map((r) => r.ticker)])];
}

/** The items on screen: the rows of a collapsed section are left out. */
export function shownItems(l: ListRows, collapsed: ReadonlySet<string>): string[] {
  return [
    ...l.extras.map((r) => r.ticker),
    ...l.groups.flatMap((g) => [sectionId(g.name), ...(collapsed.has(g.name) ? [] : g.rows.map((r) => r.ticker))]),
  ];
}

/** Whether the dragged items `ids` may land before / after `targetId`
 *  (`shown` = the items on screen). Symbols and expanded section headers go
 *  anywhere. A collapsed section carries its symbols, so it only lands on a
 *  section boundary, and it does not travel with symbols or with an expanded
 *  section that holds rows. */
export function canMoveItems(
  shown: readonly string[],
  collapsed: ReadonlySet<string>,
  ids: readonly string[],
  targetId: string,
  after: boolean,
): boolean {
  const isCollapsed = (id: string) => isSectionId(id) && collapsed.has(sectionNameOf(id));
  const sectionNext = (i: number) => i < shown.length - 1 && isSectionId(shown[i + 1]);
  if (!ids.some(isCollapsed)) return true;
  const mixed = ids.some((id) => {
    if (!isSectionId(id)) return true;
    if (isCollapsed(id)) return false;
    const i = shown.indexOf(id);
    return !(i === shown.length - 1 || sectionNext(i)); // an expanded section with rows
  });
  if (mixed) return false;
  if (isCollapsed(targetId)) return true;
  const at = shown.indexOf(targetId);
  if (at === shown.length - 1 && after) return true;
  return (after && sectionNext(at)) || (!after && isSectionId(targetId));
}

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

/** Row order of a list from before its first sort (tickers per section, then
 *  the ungrouped rows), keyed by list id. Held in memory only. */
const beforeSort = new Map<string, { groups: string[][]; extras: string[] }>();

/** Forget a list's sort: its current order is its own order from now on. */
function dropSort(id: string): void {
  beforeSort.delete(id);
  const i = state.lists.findIndex((l) => l.id === id);
  if (i >= 0 && state.lists[i].sort !== "default") setState("lists", i, "sort", "default");
}

/** Mutate the active list in place (via solid-store `produce`). A change of
 *  the list's content ends its sort (`keepSort` for the few that do not
 *  touch the rows). */
function mutateActive(fn: (l: WatchList) => void, keepSort = false): void {
  const i = activeIndex();
  if (i >= 0) {
    setState("lists", i, produce(fn));
    if (!keepSort) dropSort(state.lists[i].id);
  }
  syncColorFlags();
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
  /** Lists shown in pickers and menus: the colour lists only when they hold
   *  symbols (the Red list always) or are open. */
  shownLists: (): WatchList[] =>
    state.lists.filter((l) => !l.id.startsWith("color-") || l.flag === "red" || l.id === state.activeId || rowsOf(l).length > 0),
  activeId: () => state.activeId,
  /** Recently opened lists, newest first (existing lists only). */
  recentLists: (): WatchList[] =>
    recents().map((id) => state.lists.find((l) => l.id === id)).filter((l): l is WatchList => !!l),
  active: (): WatchList | undefined => state.lists.find((l) => l.id === state.activeId),

  setActive(id: string): void {
    if (!state.lists.some((l) => l.id === id)) return;
    // The list left behind keeps its sorted order, not its sort state.
    if (id !== state.activeId) dropSort(state.activeId);
    setState("activeId", id);
  },

  /** Create a new empty list and switch to it; returns its id. */
  createList(name = "New list"): string {
    const nm = uniqueName(name);
    const id = uniqueId(nm);
    setState("lists", (ls) => [...ls, { id, name: nm, flag: null, emoji: null, groups: [], extras: [], favorite: false, sort: "default" }]);
    setState("activeId", id);
    return id;
  },

  /** Duplicate the active list (sections + extras) as `name` and switch to the copy. */
  copyActive(name?: string): string {
    const a = state.lists[activeIndex()];
    if (!a) return state.activeId;
    const nm = uniqueName(name ?? `${a.name} copy`);
    const id = uniqueId(nm);
    setState("lists", (ls) => [
      ...ls,
      { id, name: nm, flag: null, emoji: null, groups: cloneGroups(a.groups), extras: a.extras.map((r) => ({ ...r })), favorite: false, sort: "default" },
    ]);
    setState("activeId", id);
    return id;
  },

  /** Duplicate any list by id (sections + extras); does NOT switch active.
   *  Returns the copy's id. */
  copyList(id: string, name?: string): string | undefined {
    const src = state.lists.find((l) => l.id === id);
    if (!src) return undefined;
    const nm = uniqueName(name ?? `${src.name} copy`);
    const cid = uniqueId(nm);
    setState("lists", (ls) => [
      ...ls,
      { id: cid, name: nm, flag: null, emoji: null, groups: cloneGroups(src.groups), extras: src.extras.map((r) => ({ ...r })), favorite: false, sort: "default" },
    ]);
    return cid;
  },

  /** Delete a list by id. No-op on the last remaining list; if the active list
   *  is removed, the first surviving list becomes active. Also drops the list's
   *  alert threshold + fired-dedupe entries — a recreated list with the same
   *  name re-slugs to the same id and must not inherit them. */
  deleteList(id: string): void {
    // Colour lists cannot be deleted (they are the flagged symbols).
    if (state.lists.length <= 1 || id.startsWith("color-")) return;
    const wasActive = state.activeId === id;
    setState("lists", (ls) => ls.filter((l) => l.id !== id));
    if (wasActive) setState("activeId", state.lists[0]?.id ?? "");
    if (id in state.alerts) {
      setState("alerts", produce((a: AlertMap) => {
        delete a[id];
      }));
    }
    clearFiredForList(id);
    if (recents().includes(id)) setRecents(recents().filter((x) => x !== id));
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

  /** Sort the active list: `sorter` re-orders the rows of each section and of
   *  the ungrouped rows, once, and that order becomes the list's order. The
   *  order from before the first sort is kept for `resetSort`. */
  applySort(key: Exclude<SortKey, "default">, sorter: (rows: Row[]) => Row[]): void {
    mutateActive((l) => {
      if (l.sort === "default") {
        beforeSort.set(l.id, {
          groups: l.groups.map((g) => g.rows.map((r) => r.ticker)),
          extras: l.extras.map((r) => r.ticker),
        });
      }
      for (const g of l.groups) g.rows = sorter(g.rows);
      l.extras = sorter(l.extras);
      l.sort = key;
    }, true);
  },
  /** Back to the order from before the sort. */
  resetSort(): void {
    mutateActive((l) => {
      const snap = beforeSort.get(l.id);
      if (snap) {
        // Rows not in the snapshot keep their place after the known ones.
        const restore = (rows: Row[], order: string[] | undefined): Row[] => {
          const at = new Map((order ??= []).map((t, i) => [t, i]));
          const pos = (r: Row) => at.get(r.ticker) ?? order.length;
          return [...rows].sort((a, b) => pos(a) - pos(b));
        };
        l.groups.forEach((g, i) => {
          g.rows = restore(g.rows, snap.groups[i]);
        });
        l.extras = restore(l.extras, snap.extras);
      }
      l.sort = "default";
    }, true);
    beforeSort.delete(state.activeId);
  },

  renameActive(name: string): void {
    mutateActive((l) => {
      l.name = name.trim() || l.name;
    }, true);
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
  /** Insert rows into the active list at `anchor`.
   *  Rows already in the list are skipped: same full name, or a row stored
   *  under the new row's short name (both are checked). A missing anchor falls
   *  back to the end of the list, so an appended symbol joins the last
   *  section. Returns the added tickers. */
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
      endOf(l).push(...fresh);
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
  /** Move the items `ids` (rows and section headers, ids as in `listItems`)
   *  before / after the item `targetId`, in their order on screen
   *  (drag-and-drop). A section header moves alone, so the rows around it
   *  change section: the rows under its new place join it, the rows it leaves
   *  join the section above. A collapsed section (`collapsed` = their names)
   *  keeps its rows and moves with them. */
  moveItems(ids: readonly string[], targetId: string, after: boolean, collapsed: ReadonlySet<string>): void {
    const cur = state.lists[activeIndex()];
    if (!cur) return;
    const shown = shownItems(cur, collapsed);
    const picked = new Set(ids);
    const moved = shown.filter((id) => picked.has(id));
    if (!moved.length || picked.has(targetId) || !shown.includes(targetId)) return;
    const order = shown.filter((id) => !picked.has(id));
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, ...moved);
    // Stored row objects are reused, so a moved row keeps its identity.
    const raw = unwrap(cur);
    const rowOf = new Map(rowsOf(raw).map((r) => [r.ticker, r]));
    const hidden = new Map(raw.groups.filter((g) => collapsed.has(g.name)).map((g) => [g.name, g.rows]));
    const extras: Row[] = [];
    const groups: Group[] = [];
    let into = extras;
    for (const id of order) {
      if (isSectionId(id)) {
        const name = sectionNameOf(id);
        const g: Group = { name, rows: [...(hidden.get(name) ?? [])] };
        groups.push(g);
        into = g.rows;
      } else {
        const r = rowOf.get(id);
        if (r) into.push(r);
      }
    }
    mutateActive((l) => {
      l.groups = groups;
      l.extras = extras;
    });
  },
  /** Remove the items `ids` (rows and section headers, ids as in `listItems`)
   *  from the active list. A removed section header leaves its rows: they
   *  join the section above, or the rows with no section. */
  removeItems(ids: readonly string[]): void {
    const cur = state.lists[activeIndex()];
    if (!cur) return;
    const picked = new Set(ids);
    const raw = unwrap(cur);
    const extras: Row[] = raw.extras.filter((r) => !picked.has(r.ticker));
    const groups: Group[] = [];
    let into = extras;
    for (const g of raw.groups) {
      if (!picked.has(sectionId(g.name))) {
        const kept: Group = { name: g.name, rows: [] };
        groups.push(kept);
        into = kept.rows;
      }
      for (const r of g.rows) if (!picked.has(r.ticker)) into.push(r);
    }
    mutateActive((l) => {
      l.groups = groups;
      l.extras = extras;
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
  /** Append a row to ANOTHER list ("Add X to watchlist" submenu).
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
      endOf(wl).push({ ...row, flag: null });
    }));
    dropSort(state.lists[i].id);
    syncColorFlags();
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
    dropSort(state.lists[i].id);
    syncColorFlags();
  },
  /** Create a new list seeded with one row WITHOUT switching the active list
   *  ("Add X to watchlist → Create new list…"). Returns the new name. */
  createListWith(row: Row | Row[], name = "New list"): string {
    const nm = uniqueName(name);
    const id = uniqueId(nm);
    const rows = (Array.isArray(row) ? row : [row]).map((r) => ({ ...r, flag: null }));
    setState("lists", (ls) => [
      ...ls,
      { id, name: nm, flag: null, emoji: null, groups: [], extras: rows, favorite: false, sort: "default" },
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
