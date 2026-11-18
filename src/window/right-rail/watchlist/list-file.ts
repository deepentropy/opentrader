/*
 * Uploaded watchlist files ("Upload list…"): the text read into sections and
 * ungrouped rows, with the reference app's checks (#355).
 */
import type { Group, Row } from "../../../data/watchlist";

/** Largest file read, in KB. */
export const MAX_LIST_FILE_KB = 250;
/** Most symbols and sections a file may hold. */
export const MAX_LIST_FILE_ITEMS = 1000;

/** Why a file was refused: too big, not a list of symbols, too many symbols. */
export type ListFileError = "size" | "format" | "count";

/** A file larger than MAX_LIST_FILE_KB is not read. */
export const listFileTooBig = (bytes: number): boolean => bytes / 1024 > MAX_LIST_FILE_KB;

/** Parse an uploaded watchlist file into sections + ungrouped rows. Symbols
 *  are separated by commas, tabs or new lines (not spaces: a cell of several
 *  words stays one row); an item starting with `###` names a section, and the
 *  symbols after it belong to it until the next one. Symbols before any
 *  section are ungrouped. Items may be bare ("AAPL") or exchange-qualified
 *  ("NASDAQ:AAPL"); dupes are dropped, and empty sections are discarded.
 *  Refused: text with control characters or no item ("format"), more than
 *  MAX_LIST_FILE_ITEMS items ("count"). */
export function parseWatchlistFile(text: string): { groups: Group[]; extras: Row[] } | { error: ListFileError } {
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text) || /^[\r\n\t,]*$/.test(text)) return { error: "format" };
  const items = text
    .toUpperCase()
    .split(/[\t\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length > MAX_LIST_FILE_ITEMS) return { error: "count" };

  const seen = new Set<string>();
  const groups: Group[] = [];
  const extras: Row[] = [];
  let current = extras; // rows before the first section stay ungrouped
  for (const tok of items) {
    if (tok.startsWith("###")) {
      const g: Group = { name: tok.replace(/^#+/, "").trim(), rows: [] };
      groups.push(g);
      current = g.rows;
      continue;
    }
    if (seen.has(tok)) continue;
    seen.add(tok);
    const short = tok.includes(":") ? tok.slice(tok.indexOf(":") + 1) : tok;
    current.push({ ticker: tok, short, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null });
  }
  return { groups: groups.filter((g) => g.rows.length > 0), extras };
}
