/*
 * Watchlist sort: the sort model shared by the table-view column headers and
 * the tile-view "Sort by" menu, the row comparison (live quote first), and
 * the header state (direction, 5 s arrow / label flash, tooltip glyph).
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  COLUMN_HEADERS,
  FLAG_SORT_ORDER,
  WL_COLUMNS,
  WL_ICONS,
  type Row,
  type SortField,
  type SortKey,
  type WlColumnKey,
} from "../../../data/watchlist";
import { flagOf } from "../../../data/symbol-flags";
import { numFromStr } from "./format";
import { type WatchlistCx } from "./context";
import type { JSX } from "solid-js";

// ── Sort model ── shared by the table-view column headers (click to sort) and
// the tile-view "Sort by" menu. The SortField/SortKey types live in the data
// layer (watchlist.ts) since the store persists the active list's sort.
/** A sortable table-header item: the flag button, the fixed Symbol column, or
 *  a data column. */
export type HeaderCol = "flag" | "symbol" | WlColumnKey;
/** Maps a table column (incl. the fixed Symbol column) to its sort field. */
const COL_SORT: Record<HeaderCol, SortField> = {
  flag: "flag",
  symbol: "symbol",
  last: "last",
  change: "chg",
  change_percent: "change",
  volume: "volume",
  rchp: "ext",
};
/** Tile-view "Sort by" menu: each field has an ascending and a descending row. */
export const SORT_MENU_FIELDS: { field: SortField; label: string }[] = [
  { field: "change", label: "Change %" },
  { field: "chg", label: "Change" },
  { field: "last", label: "Last" },
  { field: "symbol", label: "Symbol" },
];

/** What createSort adds to the watchlist context. */
export interface SortApi {
  headerLabel: (key: WlColumnKey) => string;
  isFlashing: (col: HeaderCol) => boolean;
  sortArrow: (col: HeaderCol) => JSX.Element;
  sortDirFor: (col: HeaderCol) => "asc" | "desc" | null;
  sortRows: (key: Exclude<SortKey, "default">, rows: Row[]) => Row[];
  sortTipIcon: (col: HeaderCol) => string;
  toggleSort: (col: HeaderCol) => void;
}

export function createSort(cx: WatchlistCx): SortApi {
  const { quoteFor, setSortBy, sortBy } = cx;
  // ── Sorting (tile-view "Sort by") ── prefer the live quote, fall back to the
  // stored display value; missing values sort to the end either direction.
  const sortNumber = (r: Row, field: Exclude<SortField, "symbol" | "flag">): number => {
    const q = quoteFor(r.ticker);
    switch (field) {
      case "change": return q?.changePercent ?? numFromStr(r.changePercent);
      case "chg": return q?.change ?? numFromStr(r.change);
      case "last": return q?.last ?? numFromStr(r.last);
      case "volume": return q?.volume ?? numFromStr(r.volume);
      case "ext": return q?.extChangePercent ?? numFromStr(r.prePostChange);
    }
  };
  const sortRows = (key: Exclude<SortKey, "default">, rows: Row[]): Row[] => {
    const dash = key.lastIndexOf("-");
    const field = key.slice(0, dash);
    const sign = key.slice(dash + 1) === "asc" ? 1 : -1;
    const copy = [...rows];
    copy.sort((a, b) => {
      if (field === "symbol") return sign * a.short.localeCompare(b.short);
      if (field === "flag") {
        // LIST_COLORS index; unflagged = +∞ ascending / −∞ descending, so
        // it lands last either way.
        const none = sign === 1 ? Infinity : -Infinity;
        const af = flagOf(a.ticker);
        const bf = flagOf(b.ticker);
        const ai = af ? FLAG_SORT_ORDER.indexOf(af) : none;
        const bi = bf ? FLAG_SORT_ORDER.indexOf(bf) : none;
        return ai === bi ? 0 : sign * (ai - bi);
      }
      const av = sortNumber(a, field as Exclude<SortField, "symbol" | "flag">);
      const bv = sortNumber(b, field as Exclude<SortField, "symbol" | "flag">);
      const aMissing = !Number.isFinite(av);
      const bMissing = !Number.isFinite(bv);
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1; // missing values always last
      if (bMissing) return -1;
      return sign * (av - bv);
    });
    return copy;
  };

  // ── Table-header sort ── clicking a column header sorts by it: first click
  // ascending, then it toggles asc⇄desc. While the list is sorted a button at
  // the right end of the header returns to the order from before the sort.
  // Sorting runs within each section.
  const sortDirFor = (col: HeaderCol): "asc" | "desc" | null => {
    const f = COL_SORT[col];
    const cur = sortBy();
    return cur === `${f}-asc` ? "asc" : cur === `${f}-desc` ? "desc" : null;
  };
  const toggleSort = (col: HeaderCol) => {
    const f = COL_SORT[col];
    setSortBy((cur) => (cur === `${f}-asc` ? `${f}-desc` : `${f}-asc`));
  };
  // The sort arrow and the blue label show for 5 s only, each time the sort
  // lands on a column, then fade back to the plain header.
  const [flashField, setFlashField] = createSignal<SortField | null>(null);
  createEffect(() => {
    const key = sortBy();
    if (key === "default") {
      setFlashField(null);
      return;
    }
    setFlashField(key.slice(0, key.lastIndexOf("-")) as SortField);
    const t = setTimeout(() => setFlashField(null), 5000);
    onCleanup(() => clearTimeout(t));
  });
  const isFlashing = (col: HeaderCol) => flashField() === COL_SORT[col];
  const sortArrow = (col: HeaderCol) => (
    <span
      class="watchlist-sort-arrow"
      classList={{ active: isFlashing(col), desc: sortDirFor(col) !== "asc" }}
      aria-hidden="true"
      innerHTML={WL_ICONS.sortArrow}
    />
  );
  /** Header tooltip glyph: the direction the next click applies. */
  const sortTipIcon = (col: HeaderCol) => (sortDirFor(col) === "asc" ? WL_ICONS.sortTipDown : WL_ICONS.sortTipUp);

  const headerLabel = (key: WlColumnKey) =>
    WL_COLUMNS.find((c) => c.key === key)?.header ?? COLUMN_HEADERS.find((c) => c.key === key)?.label ?? key;

  return { headerLabel, isFlashing, sortArrow, sortDirFor, sortRows, sortTipIcon, toggleSort };
}
