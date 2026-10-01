/*
 * Symbol flags: one colour flag per symbol, shared by every watchlist and the
 * chart legend (the reference app's marked symbols service: a flag shows in
 * every list holding the symbol). Keyed by the full symbol
 * ("EXCHANGE:TICKER"). The last colour picked is used for the next flag.
 *
 * Saved under kv `ot:symbol-flags`. The first load after this store existed
 * takes the flags the watchlist rows carried (per row, per list) — first
 * colour found wins — see watchlist-store.
 */
import { createStore, reconcile } from "solid-js/store";
import { createSignal } from "solid-js";
import type { FlagColor } from "./watchlist";
import * as kv from "./kv";

const KEY = "ot:symbol-flags";
const LAST_KEY = "ot:symbol-flag-last-color";

/** The flag colours, in menu order. */
export const FLAG_COLORS: FlagColor[] = ["red", "blue", "green", "orange", "purple", "cyan", "pink"];

function read(): Record<string, FlagColor> | null {
  try {
    const raw = kv.getItem(KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, FlagColor> = {};
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (typeof c === "string" && (FLAG_COLORS as string[]).includes(c)) out[k] = c as FlagColor;
    }
    return out;
  } catch {
    return {};
  }
}

const stored = read();
const [flags, setFlags] = createStore<Record<string, FlagColor>>(stored ?? {});
const [lastColor, setLastColorSig] = createSignal<FlagColor>(
  ((): FlagColor => {
    const c = kv.getItem(LAST_KEY);
    return c && (FLAG_COLORS as string[]).includes(c) ? (c as FlagColor) : "red";
  })(),
);

function save(): void {
  kv.setItem(KEY, JSON.stringify({ ...flags }));
}

kv.onExternalChange(KEY, () => setFlags(reconcile(read() ?? {})));

/** True when the store has never been saved (the one-time migration runs). */
export function needsMigration(): boolean {
  return stored === null;
}

/** One-time seed from the watchlist rows' flags (first colour wins). */
export function seedFlags(pairs: [string, FlagColor][]): void {
  const next: Record<string, FlagColor> = {};
  for (const [sym, c] of pairs) if (!next[sym]) next[sym] = c;
  setFlags(reconcile(next));
  save();
}

/** The symbol's flag colour, or null. Reactive. */
export function flagOf(symbol: string): FlagColor | null {
  return flags[symbol] ?? null;
}

/** Flag (colour) or unflag (null) a symbol. A colour becomes the last used. */
export function setFlag(symbol: string, color: FlagColor | null): void {
  if (color) {
    setFlags(symbol, color);
    setLastColorSig(color);
    kv.setItem(LAST_KEY, color);
  } else {
    setFlags(symbol, undefined as unknown as FlagColor);
  }
  save();
}

/** Every flag (symbol -> colour). Reactive. */
export function allFlags(): Record<string, FlagColor> {
  return flags;
}

/** Unflag every symbol. */
export function clearAllFlags(): void {
  setFlags(reconcile({}));
  save();
}

/** The colour the next flag gets (the last picked; red at first). */
export function lastFlagColor(): FlagColor {
  return lastColor();
}
