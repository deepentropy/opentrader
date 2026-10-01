/*
 * Recently used symbols, most recent first. Two separate lists:
 *   search  : symbols picked in the symbol search (its empty-query list,
 *             All tab, shows them first);
 *   compare : compared symbols ("RECENT SYMBOLS" of the Compare dialog,
 *             ten kept: the reference list showed ten).
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";

export type RecentList = "search" | "compare";

const KEYS: Record<RecentList, string> = { search: "ot:recent-symbols:search", compare: "ot:recent-symbols" };
// The reference search list showed about 30 picked symbols before the
// popular ones; its cap is not known, 50 are kept here.
const MAX: Record<RecentList, number> = { search: 50, compare: 10 };

function load(list: RecentList): string[] {
  try {
    const v: unknown = JSON.parse(kv.getItem(KEYS[list]) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX[list]) : [];
  } catch {
    return [];
  }
}

const signals = {
  search: createSignal<string[]>(load("search")),
  compare: createSignal<string[]>(load("compare")),
};

/** Full names "EXCHANGE:TICKER" of a list, most recent first. */
export function recentSymbols(list: RecentList): string[] {
  return signals[list][0]();
}

/** Move `symbol` to the top of a list. */
export function recordRecentSymbol(list: RecentList, symbol: string): void {
  const s = symbol.toUpperCase();
  const [get, set] = signals[list];
  const next = [s, ...get().filter((x) => x !== s)].slice(0, MAX[list]);
  set(next);
  kv.setItem(KEYS[list], JSON.stringify(next));
}
