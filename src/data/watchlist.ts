/*
 * Watchlist inventory — the default right-rail watchlist.
 *
 * The component that consumes it (window/right-rail/Watchlist.tsx) is
 * hand-maintained.
 *
 * The ROWS array is a one-shot snapshot of pre-market quotes; the live data
 * feed replaces the values.
 */
import type { IconName } from '../components/Icon';

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
export type SortField = "symbol" | "last" | "chg" | "change" | "volume" | "ext" | "flag";
export type SortKey = "default" | `${SortField}-asc` | `${SortField}-desc`;

export type HeaderItem = {
  dataName: string;
  label: string | null;
  currentValue: string | null;
  iconName: IconName | null;
};

// Column-header strip: 4 right-aligned spans, 14px text, 27px row with a 1px
// bottom divider.
export const COLUMN_HEADERS: { key: 'symbol' | 'last' | 'changePercent' | 'prePost'; label: string }[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'last', label: 'Last' },
  { key: 'changePercent', label: 'Chg%' },
  { key: 'prePost', label: 'Ext' },
];

export const HEADER_ITEMS: HeaderItem[] = [
  {
    "dataName": "watchlists-button",
    "label": "Strong",
    "currentValue": "Strong",
    "iconName": "wl-watchlists"
  },
  {
    "dataName": "add-symbol-button",
    "label": "Add symbol",
    "currentValue": null,
    "iconName": "wl-add-symbol"
  },
  {
    "dataName": "settings-button",
    "label": "Settings",
    "currentValue": null,
    "iconName": "wl-settings"
  }
];

// Sectioned watchlist — default seed (active list "Strong"). Sections in
// display order; every symbol is flagged blue in this snapshot.
// `change`/`volume` aren't included here (hidden columns) → those cells show
// "—" until a live snapshot lands. The flat ROWS export
// below drives the Massive subscription and any section-agnostic consumer.
export const GROUPS: Group[] = [
  {
    name: "INDEX",
    rows: [
      { ticker: "AMEX:SPY", short: "SPY", last: "754.60", changePercent: "0.55%", prePostChange: "0.11%", flag: "blue" },
      { ticker: "NASDAQ:QQQ", short: "QQQ", last: "735.60", changePercent: "0.84%", prePostChange: "0.07%", flag: "blue" },
      { ticker: "AMEX:IWM", short: "IWM", last: "292.03", changePercent: "0.57%", prePostChange: "−0.15%", flag: "blue" },
    ],
  },
  {
    name: "LONGS",
    rows: [
      { ticker: "AMEX:UMAC", short: "UMAC", last: "29.60", changePercent: "57.20%", prePostChange: "−1.42%", flag: "blue" },
    ],
  },
  {
    name: "1ST WL",
    rows: [
      { ticker: "NASDAQ:AXTI", short: "AXTI", last: "115.70", changePercent: "−5.76%", prePostChange: "1.12%", flag: "blue" },
      { ticker: "NASDAQ:INTC", short: "INTC", last: "120.89", changePercent: "−0.72%", prePostChange: "0.66%", flag: "blue" },
      { ticker: "NASDAQ:QUBT", short: "QUBT", last: "12.24", changePercent: "7.18%", prePostChange: "−0.33%", flag: "blue" },
      { ticker: "NASDAQ:INOD", short: "INOD", last: "99.35", changePercent: "11.63%", prePostChange: "1.60%", flag: "blue" },
      { ticker: "NASDAQ:FLNC", short: "FLNC", last: "21.36", changePercent: "0.66%", prePostChange: "−0.14%", flag: "blue" },
      { ticker: "NASDAQ:FCEL", short: "FCEL", last: "24.39", changePercent: "2.95%", prePostChange: "1.97%", flag: "blue" },
    ],
  },
  {
    name: "2ND WL",
    rows: [
      { ticker: "NASDAQ:AMD", short: "AMD", last: "518.09", changePercent: "4.55%", prePostChange: "0.91%", flag: "blue" },
      { ticker: "NASDAQ:AAOI", short: "AAOI", last: "169.02", changePercent: "−6.01%", prePostChange: "1.06%", flag: "blue" },
      { ticker: "NYSE:BW", short: "BW", last: "19.18", changePercent: "−1.13%", prePostChange: "0.26%", flag: "blue" },
      { ticker: "NASDAQ:ARM", short: "ARM", last: "335.27", changePercent: "10.76%", prePostChange: "3.33%", flag: "blue" },
    ],
  },
  {
    name: "SEMICONDUCTORS",
    rows: [
      { ticker: "NASDAQ:TSEM", short: "TSEM", last: "275.50", changePercent: "−0.82%", prePostChange: "1.56%", flag: "blue" },
      { ticker: "NASDAQ:NVTS", short: "NVTS", last: "28.51", changePercent: "−1.28%", prePostChange: "0.82%", flag: "blue" },
    ],
  },
  {
    name: "QUANTUM",
    rows: [
      { ticker: "NYSE:INFQ", short: "INFQ", last: "17.77", changePercent: "14.94%", prePostChange: "3.21%", flag: "blue" },
      { ticker: "NASDAQ:GFS", short: "GFS", last: "80.63", changePercent: "−0.59%", prePostChange: "0.73%", flag: "blue" },
      { ticker: "NASDAQ:RGTI", short: "RGTI", last: "27.03", changePercent: "9.79%", prePostChange: "0.30%", flag: "blue" },
      { ticker: "NYSE:QBTS", short: "QBTS", last: "29.49", changePercent: "7.31%", prePostChange: "−0.24%", flag: "blue" },
      { ticker: "NASDAQ:QS", short: "QS", last: "9.13", changePercent: "0.22%", prePostChange: "0.00%", flag: "blue" },
      { ticker: "NYSE:IONQ", short: "IONQ", last: "70.14", changePercent: "7.25%", prePostChange: "−0.29%", flag: "blue" },
    ],
  },
  {
    name: "QUANTUM SUPPLY CHAIN",
    rows: [
      { ticker: "NASDAQ:IPGP", short: "IPGP", last: "117.35", changePercent: "0.31%", prePostChange: "0.56%", flag: "blue" },
      { ticker: "NYSE:COHR", short: "COHR", last: "376.95", changePercent: "−0.85%", prePostChange: "0.49%", flag: "blue" },
      { ticker: "NASDAQ:LITE", short: "LITE", last: "860.62", changePercent: "−4.62%", prePostChange: "1.81%", flag: "blue" },
    ],
  },
  {
    name: "MEMORY CHIP",
    rows: [
      { ticker: "NASDAQ:MRAM", short: "MRAM", last: "31.26", changePercent: "4.30%", prePostChange: "0.77%", flag: "blue" },
      { ticker: "NASDAQ:SNDK", short: "SNDK", last: "1,641.64", changePercent: "3.25%", prePostChange: "2.10%", flag: "blue" },
    ],
  },
  {
    name: "DATA CENTER INFRASTRUCTURE",
    rows: [
      { ticker: "NASDAQ:CRDO", short: "CRDO", last: "222.35", changePercent: "0.51%", prePostChange: "2.75%", flag: "blue" },
      { ticker: "NYSE:VRT", short: "VRT", last: "314.18", changePercent: "−1.75%", prePostChange: "1.97%", flag: "blue" },
      { ticker: "NASDAQ:STX", short: "STX", last: "880.72", changePercent: "1.16%", prePostChange: "1.17%", flag: "blue" },
    ],
  },
  {
    name: "PHOTONICS/OPTICAL NETWORKING",
    rows: [
      { ticker: "NASDAQ:POET", short: "POET", last: "13.26", changePercent: "−0.15%", prePostChange: "0.53%", flag: "blue" },
      { ticker: "NYSE:CIEN", short: "CIEN", last: "570.18", changePercent: "−2.04%", prePostChange: "0.57%", flag: "blue" },
    ],
  },
];

/** Flat list of every row across all groups — drives the Massive snapshot
 *  subscription and any consumer that doesn't care about sections. */
export const ROWS: Row[] = GROUPS.flatMap((g) => g.rows);

// ── Watchlist settings (gear popover) ────────────────────────────────────────
// Ported from the reference mock.

export const WL_SETTINGS_ICONS = {
  check:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 9" fill="none"><path stroke="currentColor" stroke-width="2" d="M0.999878 4L3.99988 7L9.99988 1"></path></svg>',
};

/** Customize-columns checkbox keys (`data-qa-id`s). */
export type WlColumnKey = "last" | "change" | "change_percent" | "volume" | "rchp";
/** Symbol-display radio value (`ticker` = symbol, `description` = company name). */
export type WlSymbolDisplay = "ticker" | "description";

export interface WlSettings {
  /** Table view (true) vs the two-line tile view (false). */
  tableView: boolean;
  /** Per-column visibility (the always-present Symbol column is not listed). */
  columns: Record<WlColumnKey, boolean>;
  /** Show the per-row logo badge. */
  logo: boolean;
  /** Primary row label — ticker symbol or company name. */
  symbolDisplay: WlSymbolDisplay;
}

/** Default checkbox/toggle/radio states. */
export const WL_SETTINGS_DEFAULTS: WlSettings = {
  tableView: true,
  columns: { last: true, change: false, change_percent: true, volume: false, rchp: true },
  logo: true,
  symbolDisplay: "ticker",
};

/** Customize-columns rows: `menuLabel` shows in the popover, `header` is the
 *  short column-strip label, in display order (after the fixed Symbol column). */
export const WL_COLUMNS: { key: WlColumnKey; menuLabel: string; header: string }[] = [
  { key: "last", menuLabel: "Last", header: "Last" },
  { key: "change", menuLabel: "Change", header: "Chg" },
  { key: "change_percent", menuLabel: "Change %", header: "Chg%" },
  { key: "volume", menuLabel: "Volume", header: "Vol" },
  { key: "rchp", menuLabel: "Extended Hours", header: "Ext" },
];

/** Symbol-display radio options (order: Symbol then Name). */
export const WL_SYMBOL_DISPLAY: { value: WlSymbolDisplay; label: string }[] = [
  { value: "ticker", label: "Symbol" },
  { value: "description", label: "Name" },
];

/* ── Watchlists dropdown-menu data (ported from the mock) ──────────────── */
export const WL_ICONS = {
  // Flag marker — a banner notched on its right edge (vb 14×12).
  flag: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 12" fill="currentColor" focusable="false" preserveAspectRatio="none"><path d="M14 12l-4-6 4-6H0v12z"></path></svg>',
  // Section chevron (vb 18×18).
  chevron: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="m4.67 7.38.66-.76L9 9.84l3.67-3.22.66.76L9 11.16 4.67 7.38Z"></path></svg>',
  // Trash/delete glyph (vb 18×18) — revealed on hover for
  // both a row (remove symbol) and a section header (delete section).
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="M12 4h3v1h-1.04l-.88 9.64a1.5 1.5 0 0 1-1.5 1.36H6.42a1.5 1.5 0 0 1-1.5-1.36L4.05 5H3V4h3v-.5C6 2.67 6.67 2 7.5 2h3c.83 0 1.5.67 1.5 1.5V4ZM7.5 3a.5.5 0 0 0-.5.5V4h4v-.5a.5.5 0 0 0-.5-.5h-3ZM5.05 5l.87 9.55a.5.5 0 0 0 .5.45h5.17a.5.5 0 0 0 .5-.45L12.94 5h-7.9Z"></path></svg>',
  // Down-caret on the watchlists menu button (vb 16×8, rendered 8×4 — the
  // standard dropdown caret size). NOT the flag glyph the mock previously
  // (mis)used here.
  menuArrow: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8"><path fill="currentColor" d="M0 1.475l7.396 6.04.596.485.593-.49L16 1.39 14.807 0 7.393 6.122 8.58 6.12 1.186.08z"></path></svg>',
  // Column-sort indicator (vb 18×18) — an up-arrow. Shown only on the active
  // sort column; ascending renders as-is (up), descending flips it vertically
  // (the `desc` class applies `transform: scaleY(-1)`).
  sortArrow: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d="M8.5 3.84l.34.28 4 3.5-.66.76L9.01 5.6V14H8V5.6L4.84 8.38l-.66-.76 4-3.5.33-.28z"></path></svg>',
  // Column-header tooltip glyphs (vb 7×9), up / down. The tooltip shows the
  // direction the NEXT click applies: down when the column is sorted
  // ascending, else up.
  sortTipUp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 9" width="7" height="9" fill="none"><path stroke="currentColor" d="M6 4L3.5 1.5L1 4M3.5 9V2"/></svg>',
  sortTipDown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 9" width="7" height="9" fill="none"><path stroke="currentColor" d="M6 5L3.5 7.5L1 5M3.5 7.5V0"/></svg>',
};

/* Watchlists dropdown-menu icons — 28×28 row icons + the 18×18 favourite
 * star on the recently-used lists. */
export const WL_MENU_ICONS = {
  addAlert: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="m19.54 4.5 3.96 4.32-.74.68-3.96-4.32.74-.68ZM7.46 4.5 3.5 8.82l.74.68L8.2 5.18l-.74-.68ZM19.74 10.33A7.5 7.5 0 0 1 21 14.5v.5h1v-.5a8.5 8.5 0 1 0-8.5 8.5h.5v-1h-.5a7.5 7.5 0 1 1 6.24-11.67Z"></path><path fill="currentColor" d="M13 9v5h-3v1h4V9h-1ZM19 20v-4h1v4h4v1h-4v4h-1v-4h-4v-1h4Z"></path></svg>',
  makeCopy: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M8 9.5H6.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V20m-8-1.5h11a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1h-11a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1z"></path></svg>',
  rename: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M16.73 6.56a2.5 2.5 0 0 1 3.54 0l1.17 1.17a2.5 2.5 0 0 1 0 3.54l-.59.58-9 9-1 1-.14.15H6v-4.7l.15-.15 1-1 9-9 .58-.59Zm2.83.7a1.5 1.5 0 0 0-2.12 0l-.23.24 3.29 3.3.23-.24a1.5 1.5 0 0 0 0-2.12l-1.17-1.17Zm.23 4.24L16.5 8.2l-8.3 8.3 3.3 3.3 8.3-8.3Zm-9 9L7.5 17.2l-.5.5V21h3.3l.5-.5Z"></path></svg>',
  addSection: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M4 10h5V9H4v1zM11 10h6V9h-6v1zM24 10h-5V9h5v1zM6.5 14c-.83 0-1.5.67-1.5 1.5v3c0 .83.67 1.5 1.5 1.5h15c.83 0 1.5-.67 1.5-1.5v-3c0-.83-.67-1.5-1.5-1.5h-15zM6 15.5c0-.28.22-.5.5-.5h15c.28 0 .5.22.5.5v3a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5v-3z"></path></svg>',
  clearList: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M5.5 16.5c1 3 7 7 11 7 2-4 2-8.5 2-8.5s-1-3.5-2-4-4.5.5-4.5.5-3 3.5-6.5 5z"></path><path stroke="currentColor" d="M15.5 11l3-6s.5-1 1.5-.5.5 1.5.5 1.5l-3 6M12 11.5l6.5 3.5M7.5 19c2-.5 4-2.5 4-2.5m0 5.5c2-1 3-3.5 3-3.5"></path></svg>',
  createList: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none"><path fill="currentColor" d="M23 13h-1V4H6v19.476L14 20l3.008 1.307-.42.907L14 21.09 5 25V3h18zm0 6h4v1h-4v4h-1v-4h-4v-1h4v-4h1zm-6-3H9v-1h8zm2-4H9v-1h10zm0-4.005H9v-1h10z"></path></svg>',
  uploadList: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M6.5 16v4.5a1 1 0 001 1h14a1 1 0 001-1V16M14.5 18V5.5m-4 4l4-4l4 4"></path></svg>',
  openList: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M5.5 11.5v8a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-8m-17 0v-4a1 1 0 0 1 1-1h4l2 2h9a1 1 0 0 1 1 1v2m-17 0h17"></path></svg>',
  star: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" fill="none"><path fill="currentColor" d="M9 1l2.35 4.76 5.26.77-3.8 3.7.9 5.24L9 13l-4.7 2.47.9-5.23-3.8-3.71 5.25-.77L9 1z"></path></svg>',
};


export interface WlMenuAction {
  value: string;
  label: string;
  /** Leading icon SVG; omitted for the toggle row. */
  icon?: string;
  /** Renders a right-aligned switch instead of nothing (Share list). */
  toggle?: boolean;
  /** Right-aligned keyboard hint (Open list…). */
  shortcut?: string;
}

/* The dropdown groups, in order; rendered with a divider between groups.  The
 * `recentlyUsed` group is the saved-list switcher (renders WATCHLIST_TABS). */
export const WL_MENU_GROUPS: { actions?: WlMenuAction[]; recentlyUsed?: boolean }[] = [
  {
    actions: [
      { value: 'share-switcher', label: 'Share list', toggle: true },
      { value: 'add-alert', label: 'Add alert on the list…', icon: WL_MENU_ICONS.addAlert },
      { value: 'make-copy', label: 'Make a copy…', icon: WL_MENU_ICONS.makeCopy },
      { value: 'rename', label: 'Rename', icon: WL_MENU_ICONS.rename },
      { value: 'add-section', label: 'Add section', icon: WL_MENU_ICONS.addSection },
      { value: 'clear-list', label: 'Clear list', icon: WL_MENU_ICONS.clearList },
    ],
  },
  {
    actions: [
      { value: 'create-list', label: 'Create new list…', icon: WL_MENU_ICONS.createList },
      { value: 'upload-list', label: 'Upload list…', icon: WL_MENU_ICONS.uploadList },
    ],
  },
  { recentlyUsed: true },
  {
    actions: [
      { value: 'open-list', label: 'Open list…', icon: WL_MENU_ICONS.openList, shortcut: 'Shift + W' },
    ],
  },
];

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
  { name: 'Main', emoji: '🎡', flag: null, active: false },
  { name: 'Strong', emoji: null, flag: 'blue', active: true },
  { name: '9EMA', emoji: '⚡', flag: null, active: false },
];
