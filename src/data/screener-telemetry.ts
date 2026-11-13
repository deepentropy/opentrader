/*
 * Screener usage statistics (src/data/analytics.ts): what people do with the
 * screener, never what they look at. Events carry catalogue ids only (fields,
 * column sets, popular screens, built-in indicators): no ticker, no screen or
 * watchlist name, no filter value.
 *
 *   screener_changed        { screener, change, field? }  one step of a screen (screenChanges)
 *   screener_screen_opened  { screener, from: "saved" | "popular" | "new", popular? }
 *   screener_screen_saved   { screener, as: "save" | "new" }
 *   screener_switched       { to: "stock" | "etf" | "script" }
 *   screener_result_opened  { screener, view }
 *   screener_exported       { screener, to: "csv" | "watchlist" }
 *   script_screen_run       { indicator, interval, source, symbols }
 *
 * A change repeated on the same field (a value typed digit by digit, a slider)
 * counts once per `REPEAT_MS`.
 */
import { track } from "./analytics";
import type { ColumnRef, Filter, Screen } from "./screener-catalog";

export type ScreenChange = { change: string; field?: string };

const REPEAT_MS = 30_000;
const last = new Map<string, number>();

const fieldOf = (c: ColumnRef): string => c.id;
const filterKey = (f: Filter): string => fieldOf(f.left);
const filterBody = (f: Filter): string => JSON.stringify(f.type === "CheckboxGroup" ? f.values : [f.operation, f.offsetRangeId, f.target, f.right]);

/** The steps from one screen to the next, by kind (catalogue ids only). */
export function screenChanges(prev: Screen, next: Screen): ScreenChange[] {
  const out: ScreenChange[] = [];
  const before = new Map(prev.filters.map((f) => [f.id, f]));
  const after = new Map(next.filters.map((f) => [f.id, f]));
  for (const [id, f] of after) {
    const old = before.get(id);
    if (!old) out.push({ change: "filter_added", field: filterKey(f) });
    else if (filterKey(old) !== filterKey(f)) out.push({ change: "filter_field", field: filterKey(f) });
    else if (filterBody(old) !== filterBody(f)) out.push({ change: "filter_set", field: filterKey(f) });
  }
  for (const [id, f] of before) if (!after.has(id)) out.push({ change: "filter_removed", field: filterKey(f) });
  if (prev.activeColumnSetId !== next.activeColumnSetId) out.push({ change: "column_set", field: next.activeColumnSetId });
  if (JSON.stringify(prev.customColumns) !== JSON.stringify(next.customColumns)) {
    const was = new Set((prev.customColumns ?? []).map(fieldOf));
    const now = new Set((next.customColumns ?? []).map(fieldOf));
    const added = [...now].filter((c) => !was.has(c));
    const removed = [...was].filter((c) => !now.has(c));
    for (const c of added) out.push({ change: "column_added", field: c });
    for (const c of removed) out.push({ change: "column_removed", field: c });
    if (!added.length && !removed.length) out.push({ change: "columns_moved" });
  }
  if (JSON.stringify(prev.sort) !== JSON.stringify(next.sort)) out.push({ change: "sort", field: fieldOf(next.sort.sortBy) });
  if ((prev.viewMode ?? "table") !== (next.viewMode ?? "table")) out.push({ change: "view", field: next.viewMode ?? "table" });
  if ((prev.watchlistId === null) !== (next.watchlistId === null)) out.push({ change: "scope", field: next.watchlistId === null ? "market" : "watchlist" });
  if ((prev.primaryListing ?? true) !== (next.primaryListing ?? true)) out.push({ change: "primary_listing", field: String(next.primaryListing ?? true) });
  return out;
}

/** Once per `REPEAT_MS` for the same key. */
function once(key: string, now = Date.now()): boolean {
  const t = last.get(key);
  if (t !== undefined && now - t < REPEAT_MS) return false;
  last.set(key, now);
  return true;
}

/** The changes of one undoable step of the Stock / ETF screener. */
export function trackScreenChange(prev: Screen, next: Screen): void {
  const screener = next.type ?? "stock";
  for (const c of screenChanges(prev, next)) {
    if (once(`${screener}:${c.change}:${c.field ?? ""}`)) track("screener_changed", { screener, ...c });
  }
}

/** Any other screener event (see the list above). */
export function trackScreener(event: string, props: Record<string, string | number | boolean | null> = {}): void {
  track(event, props);
}

/** Test hook: forget the repeat window. */
export function resetScreenerTelemetry(): void {
  last.clear();
}
