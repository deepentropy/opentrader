/*
 * Script screener state: which screener the panel shows (stock or script)
 * and the current script screen (symbol source, indicator, its inputs,
 * interval, filters, columns, sort), kept in kv:
 *   ot:screener:kind:v1    "stock" | "script"
 *   ot:screener:script:v1  the script screen
 * The rows of the last scan stay in memory only.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "./kv";
import type { ScriptFilter, ScriptInterval, ScriptSort } from "./script-screen";

export type ScreenerKind = "stock" | "script";

/** Symbols scanned: an OpenTrader watchlist, or an index of the live table ("SPX"...). */
export type ScriptSource = { kind: "watchlist"; id: string } | { kind: "index"; code: string };

export type ScriptScreen = {
  /** Registry id of the indicator; null before one is picked. */
  indicatorId: string | null;
  /** Inputs changed from the indicator's defaults. */
  inputs: Record<string, unknown>;
  interval: ScriptInterval;
  source: ScriptSource;
  /** One pill per filter, set or not (a new indicator starts with one per output, up to ten). */
  filters: ScriptFilter[];
  /** Visible columns in order (column keys); null: the indicator's default columns. */
  columns: string[] | null;
  sort: ScriptSort | null;
};

const KIND_KEY = "ot:screener:kind:v1";
const SCREEN_KEY = "ot:screener:script:v1";

export const emptyScriptScreen = (): ScriptScreen => ({
  indicatorId: null,
  inputs: {},
  interval: "1D",
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

function readScreen(): ScriptScreen {
  try {
    const raw = kv.getItem(SCREEN_KEY);
    const s = raw ? (JSON.parse(raw) as Partial<ScriptScreen>) : null;
    if (!s || typeof s !== "object") return emptyScriptScreen();
    const base = emptyScriptScreen();
    return {
      indicatorId: typeof s.indicatorId === "string" ? s.indicatorId : null,
      inputs: s.inputs && typeof s.inputs === "object" ? s.inputs : {},
      interval: s.interval === "1W" || s.interval === "1M" ? s.interval : base.interval,
      source: readSource(s.source) ?? base.source,
      filters: Array.isArray(s.filters) ? s.filters.filter((f) => f && typeof f.id === "string" && typeof f.key === "string" && typeof f.op === "string") : [],
      columns: Array.isArray(s.columns) ? s.columns.filter((k) => typeof k === "string") : null,
      sort: s.sort && typeof s.sort.key === "string" ? s.sort : null,
    };
  } catch {
    return emptyScriptScreen();
  }
}

const store = createRoot(() => {
  const [kind, setKind] = createSignal<ScreenerKind>(kv.getItem(KIND_KEY) === "script" ? "script" : "stock");
  const [screen, setScreen] = createSignal<ScriptScreen>(readScreen());
  return { kind, setKind, screen, setScreen };
});

export const scriptScreenStore = {
  kind: store.kind,
  setKind(k: ScreenerKind): void {
    store.setKind(k);
    kv.setItem(KIND_KEY, k);
  },
  screen: store.screen,
  update(fn: (s: ScriptScreen) => ScriptScreen): void {
    const next = fn(store.screen());
    store.setScreen(next);
    kv.setItem(SCREEN_KEY, JSON.stringify(next));
  },
};
