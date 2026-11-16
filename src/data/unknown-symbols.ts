/*
 * Symbols the data source says don't exist (#341): an expired contract or a renamed ticker left in a watchlist. They
 * are not asked for again (a watchlist of expired options would ask at every look) and the watchlist shows them as
 * the reference app does, the name in red. A plugin that connects again may know them: forgotten then.
 */
import { createSignal } from "solid-js";

/** The backend's error of a symbol that doesn't exist ("…: unknown symbol (NOT_FOUND)"). */
const NOT_FOUND = /\(NOT_FOUND[,)]/;

const [unknown, setUnknown] = createSignal<ReadonlySet<string>>(new Set());

/** The data source said `symbol` doesn't exist (reactive). */
export const isUnknownSymbol = (symbol: string): boolean => unknown().has(symbol.toUpperCase());

/** Remember `symbol` as unknown when `error` says so. */
export function noteSymbolError(symbol: string, error: unknown): void {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const key = symbol.toUpperCase();
  if (!NOT_FOUND.test(text) || unknown().has(key)) return;
  setUnknown(new Set([...unknown(), key]));
}

/** Ask for every symbol again (the data plugins changed). */
export function forgetUnknownSymbols(): void {
  if (unknown().size) setUnknown(new Set<string>());
}
