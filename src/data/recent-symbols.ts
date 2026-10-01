/*
 * Recently used symbols ("RECENT SYMBOLS" of the Compare dialog): the
 * symbols picked in the symbol search and the compared symbols, most recent
 * first, ten kept (the reference list showed ten).
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

const KEY = "ot:recent-symbols";
const MAX = 10;

function load(): string[] {
  try {
    const v: unknown = JSON.parse(kv.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

const [recent, setRecent] = createSignal<string[]>(load());

/** Full names "EXCHANGE:TICKER", most recent first. */
export const recentSymbols = recent;

/** Move `symbol` to the top of the list. */
export function recordRecentSymbol(symbol: string): void {
  const s = symbol.toUpperCase();
  const next = [s, ...recent().filter((x) => x !== s)].slice(0, MAX);
  setRecent(next);
  kv.setItem(KEY, JSON.stringify(next));
}
