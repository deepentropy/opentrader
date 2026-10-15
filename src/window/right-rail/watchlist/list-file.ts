/*
 * Uploaded watchlist files ("Upload list…"): the text read into sections and
 * ungrouped rows.
 */
import type { Group, Row } from "../../../data/watchlist";

/** Parse an uploaded watchlist file into sections + ungrouped rows. Follows
 *  this text format: a line starting with `###` names a section, and
 *  the symbols that follow (comma/space/semicolon/newline-separated) belong to
 *  it until the next `###`. Symbols before any `###` are ungrouped. Tokens may
 *  be bare ("AAPL") or exchange-qualified ("NASDAQ:AAPL"); dupes are dropped,
 *  and empty sections (e.g. a leading title line) are discarded. */
export function parseWatchlistFile(text: string): { groups: Group[]; extras: Row[] } {
  const seen = new Set<string>();
  const groups: Group[] = [];
  const extras: Row[] = [];
  let current = extras; // rows before the first section header stay ungrouped

  const addTokens = (chunk: string, target: Row[]) => {
    for (const raw of chunk.split(/[\s,;]+/)) {
      const tok = raw.trim().toUpperCase();
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      const short = tok.includes(":") ? tok.slice(tok.indexOf(":") + 1) : tok;
      target.push({ ticker: tok, short, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null });
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("###")) {
      const g: Group = { name: trimmed.replace(/^#+/, "").trim(), rows: [] };
      groups.push(g);
      current = g.rows;
      continue;
    }
    addTokens(trimmed, current);
  }

  return { groups: groups.filter((g) => g.rows.length > 0), extras };
}
