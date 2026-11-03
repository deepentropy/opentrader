/*
 * Script screener state: which screener the panel shows (stock or script),
 * the current script screen (symbol source, indicator, its inputs, interval,
 * calculation settings, filters, columns, sort) and the saved screens, kept
 * in kv:
 *   ot:screener:kind:v1          "stock" | "script"
 *   ot:screener:script:v1        the current screen and the saved one it came from
 *   ot:screener:script:saved:v1  the saved screens
 * The rows of the last scan stay in memory only.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "./kv";
import { isScriptInterval, type ScriptFilter, type ScriptInterval, type ScriptSort } from "./script-screen";

export type ScreenerKind = "stock" | "script";

/** Symbols scanned: an OpenTrader watchlist, or an index of the live table ("SPX"...). */
export type ScriptSource = { kind: "watchlist"; id: string } | { kind: "index"; code: string };

export type ScriptScreen = {
  /** Registry id of the indicator; null before one is picked. */
  indicatorId: string | null;
  /** Inputs changed from the indicator's defaults. */
  inputs: Record<string, unknown>;
  interval: ScriptInterval;
  /** The indicator's "CALCULATION" settings: its own timeframe (null: the screener's interval) and "Wait for
   *  timeframe closes" (a bar still forming is left out). */
  calcInterval: ScriptInterval | null;
  waitClose: boolean;
  source: ScriptSource;
  /** One pill per filter, set or not (a new indicator starts with one per output, up to ten). */
  filters: ScriptFilter[];
  /** Visible columns in order (column keys); null: the indicator's default columns. */
  columns: string[] | null;
  sort: ScriptSort | null;
};

export type SavedScriptScreen = { id: string; name: string; screen: ScriptScreen; updatedAt: number };

const KIND_KEY = "ot:screener:kind:v1";
const SCREEN_KEY = "ot:screener:script:v1";
const SAVED_KEY = "ot:screener:script:saved:v1";

export const emptyScriptScreen = (): ScriptScreen => ({
  indicatorId: null,
  inputs: {},
  interval: "1D",
  calcInterval: null,
  waitClose: false,
  source: { kind: "index", code: "SPX" },
  filters: [],
  columns: null,
  sort: null,
});

function readSource(v: unknown): ScriptSource | null {
  const x = v as Partial<{ kind: string; id: string; code: string }> | null;
  if (x?.kind === "watchlist" && typeof x.id === "string") return { kind: "watchlist", id: x.id };
  if (x?.kind === "index" && typeof x.code === "string") return { kind: "index", code: x.code };
  return null;
}

/** A stored screen, its missing or invalid parts back to the defaults. */
export function readScriptScreen(v: unknown): ScriptScreen {
  const s = v as Partial<ScriptScreen> | null;
  const base = emptyScriptScreen();
  if (!s || typeof s !== "object") return base;
  return {
    indicatorId: typeof s.indicatorId === "string" ? s.indicatorId : null,
    inputs: s.inputs && typeof s.inputs === "object" ? s.inputs : {},
    interval: isScriptInterval(s.interval) ? s.interval : base.interval,
    calcInterval: isScriptInterval(s.calcInterval) ? s.calcInterval : null,
    waitClose: s.waitClose === true,
    source: readSource(s.source) ?? base.source,
    filters: Array.isArray(s.filters)
      ? s.filters.filter((f) => f && typeof f.id === "string" && typeof f.key === "string" && (f.op === null || typeof f.op === "string"))
      : [],
    columns: Array.isArray(s.columns) ? s.columns.filter((k) => typeof k === "string") : null,
    sort: s.sort && typeof s.sort.key === "string" ? s.sort : null,
  };
}

function readJson(key: string): unknown {
  try {
    const raw = kv.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readSaved(): SavedScriptScreen[] {
  const v = readJson(SAVED_KEY);
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x.id === "string" && typeof x.name === "string")
    .map((x) => ({ id: x.id, name: x.name, screen: readScriptScreen(x.screen), updatedAt: Number(x.updatedAt) || 0 }));
}

const store = createRoot(() => {
  const [kind, setKind] = createSignal<ScreenerKind>(kv.getItem(KIND_KEY) === "script" ? "script" : "stock");
  const cur = readJson(SCREEN_KEY) as { savedId?: unknown; screen?: unknown } | null;
  // Before saved screens, the current screen was stored alone.
  const stored = cur && typeof cur === "object" && "screen" in cur ? cur.screen : cur;
  const [screen, setScreen] = createSignal<ScriptScreen>(readScriptScreen(stored));
  const [savedId, setSavedId] = createSignal<string | null>(cur && typeof cur.savedId === "string" ? cur.savedId : null);
  const [saved, setSaved] = createSignal<SavedScriptScreen[]>(readSaved());
  return { kind, setKind, screen, setScreen, savedId, setSavedId, saved, setSaved };
});

const persistCurrent = () => kv.setItem(SCREEN_KEY, JSON.stringify({ savedId: store.savedId(), screen: store.screen() }));
const persistSaved = () => kv.setItem(SAVED_KEY, JSON.stringify(store.saved()));
const newId = () => `sscr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const scriptScreenStore = {
  kind: store.kind,
  setKind(k: ScreenerKind): void {
    store.setKind(k);
    kv.setItem(KIND_KEY, k);
  },
  screen: store.screen,
  update(fn: (s: ScriptScreen) => ScriptScreen): void {
    store.setScreen(fn(store.screen()));
    persistCurrent();
  },

  /** Saved screens, newest first. */
  saved: () => [...store.saved()].sort((a, b) => b.updatedAt - a.updatedAt),
  savedId: store.savedId,
  /** The saved screen the current one came from, if it still exists. */
  current(): SavedScriptScreen | undefined {
    const id = store.savedId();
    return id ? store.saved().find((x) => x.id === id) : undefined;
  },
  /** The current screen differs from its saved copy (or was never saved). */
  unsaved(): boolean {
    const c = scriptScreenStore.current();
    return !c || !same(c.screen, store.screen());
  },
  /** Save in place; false when the screen was never saved (ask a name, then saveAs). */
  save(): boolean {
    const c = scriptScreenStore.current();
    if (!c) return false;
    store.setSaved(store.saved().map((x) => (x.id === c.id ? { ...x, screen: store.screen(), updatedAt: Date.now() } : x)));
    persistSaved();
    return true;
  },
  saveAs(name: string): void {
    const id = newId();
    store.setSaved([...store.saved(), { id, name, screen: store.screen(), updatedAt: Date.now() }]);
    store.setSavedId(id);
    persistSaved();
    persistCurrent();
  },
  open(id: string): void {
    const c = store.saved().find((x) => x.id === id);
    if (!c) return;
    store.setScreen(readScriptScreen(JSON.parse(JSON.stringify(c.screen))));
    store.setSavedId(id);
    persistCurrent();
  },
  rename(id: string, name: string): void {
    store.setSaved(store.saved().map((x) => (x.id === id ? { ...x, name } : x)));
    persistSaved();
  },
  remove(id: string): void {
    store.setSaved(store.saved().filter((x) => x.id !== id));
    if (store.savedId() === id) store.setSavedId(null);
    persistSaved();
    persistCurrent();
  },
};
