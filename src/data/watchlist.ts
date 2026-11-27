/*
 * Watchlist model — rows, sections, sort keys, the panel's settings and the
 * flag colours, plus the default list a new profile starts with. The panel's
 * labels, icons and menus are in window/right-rail/watchlist/ui.ts.
 */
import type { ScriptInterval } from "./script-screen";

export type Row = {
  ticker: string;
  short: string;
  last: string;
  /** Absolute change — hidden by default (revealed only in "Advanced
   *  view"). Absent in the sectioned seed → falls back to "—". */
  change?: string;
  changePercent: string;
  /** Volume — also hidden by default; absent in the sectioned seed. */
  volume?: string;
  prePostChange: string;
  /** Left-edge colour flag, or null/absent when the symbol is unflagged. */
  flag?: FlagColor | null;
};

/** A named, collapsible section of the watchlist (section separators). */
export type Group = {
  name: string;
  rows: Row[];
};

/** Watchlist sort model — a `<field>-<dir>` key, or "default" for file/manual
 *  order. Shared by the table-header click-sort and the tile "Sort by" menu.
 *  `change` is change-PERCENT; `chg` is absolute change; `ext` is extended-hours;
 *  `flag` is the row flag colour (the header's flag button). */
export type SortField = "symbol" | "last" | "chg" | "change" | "volume" | "ext" | "flag" | "rvol" | "turnover" | AddedColumnKey;
export type SortKey = "default" | `${SortField}-asc` | `${SortField}-desc`;

// Default watchlist for a new profile (the "Watchlist" list): broad index
// ETFs and large caps. Quote fields are placeholders; the live feed fills
// them in.
export const GROUPS: Group[] = [
  {
    name: "INDEX",
    rows: [
      { ticker: "AMEX:SPY", short: "SPY", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:QQQ", short: "QQQ", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "AMEX:DIA", short: "DIA", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "AMEX:IWM", short: "IWM", last: "—", changePercent: "", prePostChange: "" },
    ],
  },
  {
    name: "LARGE CAPS",
    rows: [
      { ticker: "NASDAQ:AAPL", short: "AAPL", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:MSFT", short: "MSFT", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:NVDA", short: "NVDA", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:AMZN", short: "AMZN", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:GOOGL", short: "GOOGL", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:META", short: "META", last: "—", changePercent: "", prePostChange: "" },
      { ticker: "NASDAQ:TSLA", short: "TSLA", last: "—", changePercent: "", prePostChange: "" },
    ],
  },
];

// ── Watchlist settings (gear popover) ────────────────────────────────────────

/** Customize-columns checkbox keys (`data-qa-id`s). */
export type WlColumnKey = "last" | "change" | "change_percent" | "volume" | "rchp" | "rvol" | "turnover";
/** Symbol-display radio value (`ticker` = symbol, `description` = company name). */
export type WlSymbolDisplay = "ticker" | "description";

/** Key of a column added from "Add column" (its width, its sort): "x:" then an id. */
export type AddedColumnKey = `x:${string}`;
/** Key of any data column of the table: a checkbox column or an added one. */
export type WlColKey = WlColumnKey | AddedColumnKey;

/** A column added from "Add column" (not in the reference watchlist): a metric of the screener's market table (its
 *  catalog id and params), or a value of an indicator run on each symbol on a timeframe (`output`: the script
 *  screen's cell key, "out:<plot>" or "cond:<id>"; `header` and `title` kept from when it was added, so the column is
 *  named before the indicator library loads). */
export type WlAddedColumn =
  | { kind: "metric"; key: AddedColumnKey; col: { id: string; params: Record<string, string> } }
  | {
      kind: "script";
      key: AddedColumnKey;
      indicatorId: string;
      inputs: Record<string, unknown>;
      interval: ScriptInterval;
      output: string;
      header: string;
      title: string;
    };

export interface WlSettings {
  /** Table view (true) vs the two-line tile view (false). */
  tableView: boolean;
  /** Per-column visibility (the always-present Symbol column is not listed). */
  columns: Record<WlColumnKey, boolean>;
  /** Show the per-row logo badge. */
  logo: boolean;
  /** Primary row label — ticker symbol or company name. */
  symbolDisplay: WlSymbolDisplay;
  /** Columns added from "Add column", after the checkbox columns, in the order added. */
  added: WlAddedColumn[];
}

/** Default checkbox/toggle/radio states. */
export const WL_SETTINGS_DEFAULTS: WlSettings = {
  tableView: true,
  columns: { last: true, change: false, change_percent: true, volume: false, rchp: true, rvol: false, turnover: false },
  logo: true,
  symbolDisplay: "ticker",
  added: [],
};

/** Watchlist flag-marker palette.  Only `blue` is used by the default
 *  list. */
export type FlagColor = 'red' | 'blue' | 'green' | 'orange' | 'purple' | 'cyan' | 'pink' | 'yellow';

/** Flag sort order. Yellow sorts after pink. Unflagged rows always sort
 *  last, in both directions. */
export const FLAG_SORT_ORDER: FlagColor[] = ['red', 'blue', 'green', 'orange', 'purple', 'cyan', 'pink', 'yellow'];

export const FLAG_HEX: Record<FlagColor, string> = {
  red: '#ff5252',
  blue: '#2979ff',
  green: '#81c784',
  orange: '#fbc02d',
  purple: '#ba68c8',
  cyan: '#00e5ff',
  pink: '#f48fb1',
  yellow: '#ffeb3b',
};

/** Quick-switch saved lists (the "Recently used" group). Inactive lists show
 *  a Unicode emoji marker; the active one shows its colour flag. */
export type WatchlistTab = { name: string; emoji: string | null; flag: FlagColor | null; active: boolean };

export const WATCHLIST_TABS: WatchlistTab[] = [
  { name: 'Watchlist', emoji: null, flag: null, active: true },
];
