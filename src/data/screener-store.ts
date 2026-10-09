/*
 * Stock screener screens: the current screen (draft), the local saved screens
 * and the undo/redo history, plus the split-view panel state.
 *
 * the reference app keeps screens in the account; OpenTrader keeps them in kv:
 *   ot:screener:screens:v1  saved screens + recently used order
 *   ot:screener:draft:v1    the current screen and the saved screen it came from
 *   ot:screener:open / ot:screener:width  split-view panel
 * With autosave off (the reference app default) a change marks the screen unsaved and the
 * topbar shows the Save button until it is saved. Undo/redo hold up to 100
 * steps (the reference app HISTORY_MAX_SIZE) and are cleared when another screen is opened.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "./kv";
import { LEGACY_DEFAULT_PILLS, POPULAR_SCREENS, defaultScreen, type Screen } from "./screener-catalog";

export type SavedScreen = { id: string; screen: Screen; updatedAt: number };

const SCREENS_KEY = "ot:screener:screens:v1";
const DRAFT_KEY = "ot:screener:draft:v1";
const OPEN_KEY = "ot:screener:open";
const WIDTH_KEY = "ot:screener:width";
const HISTORY_MAX = 100;
const RECENT_MAX = 5;

type Persisted = { screens: SavedScreen[]; recent: string[] };
/** `popularId`: the popular screen the current one was opened from. */
type Draft = { savedId: string | null; popularId?: string | null; screen: Screen };

function readJson<T>(key: string): T | null {
  try {
    const raw = kv.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Screen content without the filter ids (random per creation). */
const content = (s: Screen) => ({ ...s, filters: s.filters.map(({ id: _id, ...f }) => f) });
const newId = () => `scr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function isScreen(v: unknown): v is Screen {
  const s = v as Screen;
  return !!s && typeof s.title === "string" && Array.isArray(s.filters) && !!s.sort && typeof s.activeColumnSetId === "string";
}

/** Screen of a stored draft. A draft that was never changed (still the
 *  default or popular screen of an earlier version, with fewer default pills)
 *  becomes the current default, as a new screen would be. */
function draftScreen(d: Draft): Screen {
  if (d.savedId) return d.screen;
  const popular = POPULAR_SCREENS.find((p) => p.id === d.popularId);
  const make = (pills?: typeof LEGACY_DEFAULT_PILLS) => (popular ? popular.screen(pills) : defaultScreen(d.screen.title, pills));
  return same(content(d.screen), content(make(LEGACY_DEFAULT_PILLS))) ? make() : d.screen;
}

const store = createRoot(() => {
  const persisted = readJson<Persisted>(SCREENS_KEY);
  const [screens, setScreens] = createSignal<SavedScreen[]>(
    (persisted?.screens ?? []).filter((x) => x && typeof x.id === "string" && isScreen(x.screen)),
  );
  const [recent, setRecent] = createSignal<string[]>(persisted?.recent ?? []);
  const draft = readJson<Draft>(DRAFT_KEY);
  const [screen, setScreenRaw] = createSignal<Screen>(draft && isScreen(draft.screen) ? draftScreen(draft) : defaultScreen());
  const [savedId, setSavedId] = createSignal<string | null>(draft?.savedId ?? null);
  const [popularId, setPopularId] = createSignal<string | null>(draft?.popularId ?? null);
  const [past, setPast] = createSignal<Screen[]>([]);
  const [future, setFuture] = createSignal<Screen[]>([]);
  return { screens, setScreens, recent, setRecent, screen, setScreenRaw, savedId, setSavedId, popularId, setPopularId, past, setPast, future, setFuture };
});

function persistScreens(): void {
  kv.setItem(SCREENS_KEY, JSON.stringify({ screens: store.screens(), recent: store.recent() }));
}
function persistDraft(): void {
  kv.setItem(DRAFT_KEY, JSON.stringify({ savedId: store.savedId(), popularId: store.popularId(), screen: store.screen() }));
}
function touchRecent(id: string): void {
  store.setRecent([id, ...store.recent().filter((x) => x !== id)].slice(0, 50));
}

/** Replace the current screen without touching the history (open / new). */
function load(s: Screen, savedId: string | null, popularId: string | null = null): void {
  store.setScreenRaw(clone(s));
  store.setSavedId(savedId);
  store.setPopularId(popularId);
  store.setPast([]);
  store.setFuture([]);
  persistDraft();
}

export const screenerStore = {
  screen: store.screen,
  savedId: store.savedId,
  popularId: store.popularId,
  savedScreens: store.screens,

  /** Saved screen the current one came from, if any. */
  saved(): SavedScreen | undefined {
    const id = store.savedId();
    return id ? store.screens().find((s) => s.id === id) : undefined;
  },

  /** Unsaved changes: differs from its saved copy, from the popular screen
   *  it was opened from, or (neither) from the default screen of its title. */
  unsaved(): boolean {
    const saved = screenerStore.saved();
    const cur = store.screen();
    const popular = POPULAR_SCREENS.find((p) => p.id === store.popularId());
    const base = saved ? saved.screen : popular ? popular.screen() : defaultScreen(cur.title);
    return !same(content(cur), content(base));
  },

  /** Apply a change as one undoable step. */
  update(fn: (s: Screen) => Screen): void {
    const cur = store.screen();
    const next = fn(clone(cur));
    if (same(next, cur)) return;
    store.setPast([...store.past(), cur].slice(-HISTORY_MAX));
    store.setFuture([]);
    store.setScreenRaw(next);
    persistDraft();
  },

  canUndo: () => store.past().length > 0,
  canRedo: () => store.future().length > 0,
  undo(): void {
    const p = store.past();
    if (!p.length) return;
    store.setFuture([store.screen(), ...store.future()]);
    store.setScreenRaw(p[p.length - 1]);
    store.setPast(p.slice(0, -1));
    persistDraft();
  },
  redo(): void {
    const f = store.future();
    if (!f.length) return;
    store.setPast([...store.past(), store.screen()].slice(-HISTORY_MAX));
    store.setScreenRaw(f[0]);
    store.setFuture(f.slice(1));
    persistDraft();
  },

  /** Save in place. Returns false when the screen has never been saved (the
   *  caller asks for a name, then calls saveAs). */
  save(): boolean {
    const id = store.savedId();
    if (!id || !store.screens().some((s) => s.id === id)) return false;
    const snap = clone(store.screen());
    store.setScreens(store.screens().map((s) => (s.id === id ? { ...s, screen: snap, updatedAt: Date.now() } : s)));
    touchRecent(id);
    persistScreens();
    return true;
  },

  /** Save the current screen as a new saved screen named `name` (Save screen
   *  as / Make a copy) and continue on it. */
  saveAs(name: string): void {
    const id = newId();
    const snap = { ...clone(store.screen()), title: name };
    store.setScreens([...store.screens(), { id, screen: snap, updatedAt: Date.now() }]);
    touchRecent(id);
    persistScreens();
    store.setScreenRaw(clone(snap));
    store.setSavedId(id);
    store.setPopularId(null);
    persistDraft();
  },

  /** Rename the current screen (and its saved copy). */
  rename(name: string): void {
    const id = store.savedId();
    if (id) {
      store.setScreens(store.screens().map((s) => (s.id === id ? { ...s, screen: { ...s.screen, title: name }, updatedAt: Date.now() } : s)));
      persistScreens();
    }
    store.setScreenRaw({ ...store.screen(), title: name });
    persistDraft();
  },

  /** Create a saved screen from the default template and open it. */
  createNew(name: string): void {
    const id = newId();
    const s = defaultScreen(name);
    store.setScreens([...store.screens(), { id, screen: s, updatedAt: Date.now() }]);
    touchRecent(id);
    persistScreens();
    load(s, id);
  },

  open(id: string): void {
    const s = store.screens().find((x) => x.id === id);
    if (!s) return;
    touchRecent(id);
    persistScreens();
    load(s.screen, id);
  },

  /** Open a reference app popular screen (not saved: Save asks for a name). */
  openPopular(id: string): void {
    const p = POPULAR_SCREENS.find((x) => x.id === id);
    if (p) load(p.screen(), null, id);
  },

  /** Save a copy of a saved or popular screen under `name`, without opening
   *  it (the "Make a copy" row action of Open screen). */
  copyOf(screen: Screen, name: string): void {
    const id = newId();
    store.setScreens([...store.screens(), { id, screen: { ...clone(screen), title: name }, updatedAt: Date.now() }]);
    persistScreens();
  },

  remove(id: string): void {
    store.setScreens(store.screens().filter((s) => s.id !== id));
    store.setRecent(store.recent().filter((x) => x !== id));
    persistScreens();
    if (store.savedId() === id) {
      store.setSavedId(null);
      persistDraft();
    }
  },

  /** Recently used saved screens (menu "Recently used"). */
  recentScreens(): SavedScreen[] {
    const byId = new Map(store.screens().map((s) => [s.id, s] as const));
    const out = store.recent().map((id) => byId.get(id)).filter((s): s is SavedScreen => !!s);
    return out.slice(0, RECENT_MAX);
  },
};

// ── Split-view panel state ────────────────────────────────────────────────
export const PANEL_MIN_WIDTH = 420;
export const PANEL_DEFAULT_WIDTH = 931;

const panel = createRoot(() => {
  const [open, setOpen] = createSignal(kv.getItem(OPEN_KEY) === "1");
  const w = Number(kv.getItem(WIDTH_KEY));
  const [width, setWidth] = createSignal(Number.isFinite(w) && w >= PANEL_MIN_WIDTH ? w : PANEL_DEFAULT_WIDTH);
  const [fullscreen, setFullscreen] = createSignal(false);
  return { open, setOpen, width, setWidth, fullscreen, setFullscreen };
});

export const screenerPanel = {
  open: panel.open,
  width: panel.width,
  fullscreen: panel.fullscreen,
  setOpen(v: boolean): void {
    panel.setOpen(v);
    if (!v) panel.setFullscreen(false);
    kv.setItem(OPEN_KEY, v ? "1" : "0");
  },
  toggle(): void {
    screenerPanel.setOpen(!panel.open());
  },
  /** Live width while dragging; `commit` persists it. */
  setWidth(px: number, commit = false): void {
    panel.setWidth(Math.max(PANEL_MIN_WIDTH, Math.round(px)));
    if (commit) kv.setItem(WIDTH_KEY, String(panel.width()));
  },
  setFullscreen: panel.setFullscreen,
};
