/*
 * Indicators dialog search — ranking and matched-letter highlight.
 *
 * Same rule as the reference app's study search:
 *   4  short name equals the query
 *   3  short name contains the query
 *   2  name contains the query, or the query letters are word initials of
 *      the name read from its start ("rsi" → "Relative strength index")
 * Rows matching none are dropped; ties keep the earlier match first, then the
 * list order.  The highlight marks the contained text, else the initials.
 */

/** A row the search can rank: display name plus an optional short name. */
export type Searchable = { name: string; shortName?: string };

/** Characters that start a word for the initials match. */
const isWordStart = (text: string, i: number): boolean => i === 0 || /[\s/-]/.test(text[i - 1]);

/**
 * Positions of the query letters as word initials: the first letter at
 * `from` (or anywhere when `anchored` is false), each next letter at the
 * start of a later word.  Null when the query does not fit.
 */
function initials(text: string, query: string, anchored: boolean): number[] | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return null;
  const starts = anchored ? [0] : [...t].map((_, i) => i).filter((i) => t[i] === q[0]);
  for (const first of starts) {
    if (t[first] !== q[0]) continue;
    const at = [first];
    let pos = first;
    for (let k = 1; k < q.length; k++) {
      let next = -1;
      for (let j = pos + 1; j < t.length; j++) {
        if (t[j] === q[k] && isWordStart(t, j)) { next = j; break; }
      }
      if (next < 0) break;
      at.push(next);
      pos = next;
    }
    if (at.length === q.length) return at;
  }
  return null;
}

/** Match priority and position of one row (priority 0 = no match). */
function score(row: Searchable, query: string): { priority: number; index: number } {
  const q = query.toLowerCase();
  const primary = (row.shortName || row.name).toLowerCase();
  const name = row.name.toLowerCase();
  if (primary === q) return { priority: 4, index: 0 };
  let i = primary.indexOf(q);
  if (i >= 0) return { priority: 3, index: i };
  i = name.indexOf(q);
  if (i >= 0) return { priority: 2, index: i };
  if (initials(row.name, query, true)) return { priority: 2, index: 0 };
  return { priority: 0, index: 0 };
}

/** Rows matching `query`, best first. */
export function rankRows<T extends Searchable>(rows: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return rows;
  return rows
    .map((row, order) => ({ row, order, ...score(row, q) }))
    .filter((r) => r.priority > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index || a.order - b.order)
    .map((r) => r.row);
}

/** Split `text` into plain / matched parts for the highlight. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i >= 0) {
    for (let k = i; k < i + q.length; k++) marks[k] = true;
  } else {
    for (const k of initials(text, q, true) ?? initials(text, q, false) ?? []) marks[k] = true;
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let k = 0; k < text.length; k++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[k]) last.text += text[k];
    else parts.push({ text: text[k], hit: marks[k] });
  }
  return parts;
}
