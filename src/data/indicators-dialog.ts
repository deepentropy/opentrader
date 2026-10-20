/*
 * Indicators, metrics, and strategies dialog — data model.
 *
 * The chrome is static data: sidebar groups, icons, the Fundamentals metric
 * tree.  The indicator lists are NOT fabricated: Built-In → Technicals and
 * Community come from the real indicator library
 *   github.com/deepentropy/lightweight-charts-indicators
 * (via ../window/chart/indicators/registry.ts), so every listed indicator is
 * one the chart can actually compute.  Those rows carry the registry
 * `indicatorId`; clicking one adds the study to the chart.
 *
 * Sidebar uses data-qa-id="indicator-sidebar-item-<id>".  Each tab's
 * content is one of:
 *   rows         — NAME (+ optional indicatorId) · AUTHOR
 *   filtered     — round type tabs (Indicators / Strategies / ...) over rows
 *   empty        — empty-state
 *   placeholder  — empty list note (Invite-only; My scripts until the
 *                  user saves an OakScript script, then its rows)
 *   fundamentals — 4 sub-tabs × hierarchical metric list
 *
 * SIDEBAR_ICONS hold the FontIcon <svg> markup.
 */
import { STANDARD_ROWS, COMMUNITY_ROWS, CHART_PATTERN_ROWS, CANDLESTICK_ROWS, PROFILE_ROWS } from '../window/chart/indicators/registry';
import { builtinStrategyRows, strategyRows } from '../window/chart/indicators/strategy-entries';
import { METRICS, type MetricPeriod, type MetricTab } from './fundamental-metrics';

/** Fundamentals sub-tabs, in the reference order. */
const FUNDAMENTAL_TABS: [MetricTab, string][] = [
  ['income', 'Income statement'],
  ['balance', 'Balance sheet'],
  ['cashflow', 'Cash flow'],
  ['statistics', 'Statistics'],
];

/** `disabled`: listed greyed, not selectable (no backing service). */
export type SidebarItem = { id: string; label: string; disabled?: boolean };
export type SidebarGroup = { key: string; title: string; items: SidebarItem[] };

export const SIDEBAR: SidebarGroup[] = [
  {
    key: "personal",
    title: "Personal",
    items: [
      { id: "favorites", label: "Favorites" },
      { id: "my-scripts", label: "My scripts" },
      // Invite-only is not listed: the reference app hides it while it is
      // empty, and this app has no invite-only scripts.
    ],
  },
  {
    key: "builtIn",
    title: "Built-In",
    items: [
      { id: "built-ins", label: "Technicals" },
      { id: "fundamentals", label: "Fundamentals" },
    ],
  },
  {
    key: "community",
    title: "Community",
    items: [
      { id: "community", label: "Community" },
    ],
  },
];

export const DEFAULT_SIDEBAR_ITEM = 'favorites';
/** Opened when Favorites is hidden (no favourites yet). */
export const FALLBACK_SIDEBAR_ITEM = 'built-ins';

/** Exact sidebar glyphs (28×28 viewBox, currentColor) lifted from the app. */
export type IconDef = { viewBox: string; fill: string; inner: string };
export const SIDEBAR_ICONS: Record<string, IconDef> = {
  "favorites": { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"m17.13 9.74 7.37.9-5.44 5.06L20.4 23 14 19.38 7.6 23l1.34-7.3-5.44-5.06 7.37-.9L14 3l3.13 6.74Zm5.11 1.63-4.26 3.97 1.04 5.74L14 18.24l-5.02 2.84 1.04-5.74-4.26-3.97 5.79-.7L14 5.37l2.45 5.3 5.8.7Z\"></path>" },
  "my-scripts": { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" d=\"M11 10.5c0-1.02.27-1.89.8-2.5.54-.6 1.39-1 2.7-1 1.31 0 2.16.4 2.7 1 .53.61.8 1.48.8 2.5s-.27 1.89-.8 2.5c-.54.6-1.39 1-2.7 1-1.31 0-2.16-.4-2.7-1a3.75 3.75 0 0 1-.8-2.5zM14.5 6c-1.53 0-2.68.49-3.44 1.34A4.67 4.67 0 0 0 10 10.5c0 1.19.31 2.32 1.06 3.16.76.85 1.91 1.34 3.44 1.34s2.68-.49 3.44-1.34A4.67 4.67 0 0 0 19 10.5c0-1.19-.31-2.32-1.06-3.16C17.18 6.49 16.03 6 14.5 6zM7 23c0-2.4 1.83-5 5-5h5c3.17 0 5 2.6 5 5h1c0-2.85-2.17-6-6-6h-5c-3.83 0-6 3.15-6 6h1z\"></path>" },
  "invite-only-scripts": { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" d=\"M12 16a5 5 0 0 1 5 5h-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4H3a5 5 0 0 1 5-5zm9 1a4 4 0 0 1 4 4h-1a3 3 0 0 0-3-3h-3v-1zm-1.5-9c.464 0 .697 0 .892.025a3 3 0 0 1 2.583 2.583c.025.195.025.428.025.892s0 .697-.025.891l-.044.25a3 3 0 0 1-2.54 2.333l-.156.015c-.169.01-.387.01-.735.01s-.566 0-.735-.01l-.157-.015a3 3 0 0 1-2.539-2.334l-.044-.249C16 12.197 16 11.964 16 11.5s0-.697.025-.892a3 3 0 0 1 2.583-2.583C18.803 8 19.036 8 19.5 8M10 6c.464 0 .696 0 .892.022a3.5 3.5 0 0 1 3.085 3.086C14 9.303 14 9.536 14 10s0 .696-.023.891a3.5 3.5 0 0 1-3.085 3.086C10.696 14 10.464 14 10 14c-.348 0-.566 0-.735-.01l-.157-.013a3.5 3.5 0 0 1-3.039-2.785l-.047-.3C6.001 10.695 6 10.463 6 10c0-.348 0-.566.01-.736l.012-.156A3.5 3.5 0 0 1 8.808 6.07l.3-.047C9.304 6 9.536 6 10 6m9.5 3c-.496 0-.647.002-.76.017a2 2 0 0 0-1.722 1.722c-.015.114-.018.265-.018.76 0 .496.003.648.018.761a2 2 0 0 0 1.721 1.722c.114.015.265.018.761.018s.647-.003.76-.018a2 2 0 0 0 1.722-1.721c.015-.114.018-.266.018-.761 0-.496-.003-.647-.018-.761a2 2 0 0 0-1.721-1.722C20.147 9.002 19.996 9 19.5 9M10 7c-.492 0-.655.001-.78.015A2.5 2.5 0 0 0 7.016 9.22C7 9.345 7 9.51 7 10c0 .492.002.656.016.781a2.5 2.5 0 0 0 2.204 2.204c.125.014.288.016.78.016s.655-.002.78-.016a2.5 2.5 0 0 0 2.204-2.204c.014-.125.016-.289.016-.78s-.002-.655-.016-.78a2.5 2.5 0 0 0-2.204-2.205C10.655 7.001 10.492 7 10 7\"></path>" },
  "built-ins": { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" d=\"m22.85 7.85-4.58 4.59a2.5 2.5 0 0 1-3.54 0l-3.17-3.17a1.5 1.5 0 0 0-2.12 0l-4.59 4.58-.7-.7 4.58-4.59a2.5 2.5 0 0 1 3.54 0l3.17 3.17a1.5 1.5 0 0 0 2.12 0l4.59-4.58.7.7ZM11 22V22h-1V14h1V22Zm12 0V22h-1V14h1V22ZM8 22V22H7V16h1V22Zm6 0V22h-1V16h1V22Zm6 0V22h-1V16h1V22Zm-3 0V22h-1V18h1V22ZM5 22V22H4V19h1V22Z\"></path>" },
  "fundamentals": { viewBox: "0 0 28 28", fill: "currentColor", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M17.5 7H17v6h-3v-3H9v6H5v6h17V7h-4.5Zm.5 14h3V8h-3v13Zm-1 0v-7h-3v7h3Zm-4-7.5V21h-3V11h3v2.5ZM9 21v-4H6v4h3Z\"></path>" },
  "editors-picks": { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M7 6h14v17.015l-7-5.384-7 5.384zm1 1v13.985l6-4.616 6 4.616V7z\"></path>" },
  "top": { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" d=\"M22.002 23H5v-4h4v-3h4v-4h4V8h5.002zM6 22h3v-2H6zm4 0h3v-5h-3zm4 0h3v-9h-3zm4 0h3.002V9H18zM15 9h-1V6.665l-8.342 7.339-.66-.75L13.244 6H11V5h4z\"></path>" },
  "trending": { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M12.184 2.112a.5.5 0 0 1 .535-.061c1.825.89 3.823 2.451 5.024 4.597 1.112 1.984 1.528 4.446.527 7.265a2.47 2.47 0 0 0 1.614-1.196c.446-.781.545-1.878.143-3.055a.5.5 0 0 1 .822-.52l.088.086c.85.828 1.836 1.79 2.497 3.08.695 1.357 1.016 3.044.556 5.292-.705 3.44-3.17 6.396-6.342 7.378a.5.5 0 0 1-.372-.03c-1.03-.516-1.867-1.085-2.436-1.955-.433-.662-.686-1.461-.788-2.47-.752.68-1.234 1.299-1.54 1.87-.394.736-.512 1.422-.512 2.107a.5.5 0 0 1-.623.485c-3.382-.86-6.083-3.428-7.053-6.987-.693-2.547-.107-5.096 1.087-7.21 1.192-2.11 3.013-3.832 4.87-4.737a.5.5 0 0 1 .664.677c-.631 1.232-.563 1.822-.473 2.057l.01.026c.888-.905 1.43-1.649 1.695-2.48.294-.925.268-2.032-.162-3.707a.5.5 0 0 1 .169-.512m-1.84 7.863h-.002l-.005-.002-.01-.004a1 1 0 0 1-.105-.045 1.3 1.3 0 0 1-.215-.137 1.5 1.5 0 0 1-.468-.643c-.145-.375-.177-.855-.029-1.472a11.3 11.3 0 0 0-3.228 3.608c-1.099 1.945-1.601 4.222-.993 6.455.817 2.998 2.988 5.204 5.745 6.11a5.2 5.2 0 0 1 .596-1.924c.483-.902 1.288-1.828 2.563-2.816a.5.5 0 0 1 .807.39c.011 1.41.253 2.302.677 2.95.399.61.994 1.062 1.865 1.515 2.692-.919 4.841-3.503 5.468-6.56.418-2.04.119-3.495-.466-4.637-.341-.665-.783-1.235-1.266-1.764.02.808-.158 1.57-.526 2.214C20.13 14.305 18.99 15 17.5 15a.5.5 0 0 1-.458-.701c1.253-2.853.895-5.26-.171-7.163-.88-1.57-2.253-2.815-3.647-3.668.22 1.234.2 2.242-.094 3.166-.374 1.176-1.17 2.14-2.281 3.224a.5.5 0 0 1-.503.118z\"></path>" },
  "store": { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M14.002 2A4 4 0 0 1 18 5.999V7h4.001l1 17h-18l1-17h4.002V5.998A4 4 0 0 1 14.002 2m-7.41 20.5H21.41l-.823-14H18V11h-1.5V8.5h-4.997V11h-1.5V8.5H7.415zm7.41-19a2.5 2.5 0 0 0-2.5 2.498V7H16.5V5.999A2.5 2.5 0 0 0 14.002 3.5\"></path>" },
  // Community reuses the "trending" flame glyph.
  "community": { viewBox: "0 0 28 28", fill: "none", inner: "<path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M12.184 2.112a.5.5 0 0 1 .535-.061c1.825.89 3.823 2.451 5.024 4.597 1.112 1.984 1.528 4.446.527 7.265a2.47 2.47 0 0 0 1.614-1.196c.446-.781.545-1.878.143-3.055a.5.5 0 0 1 .822-.52l.088.086c.85.828 1.836 1.79 2.497 3.08.695 1.357 1.016 3.044.556 5.292-.705 3.44-3.17 6.396-6.342 7.378a.5.5 0 0 1-.372-.03c-1.03-.516-1.867-1.085-2.436-1.955-.433-.662-.686-1.461-.788-2.47-.752.68-1.234 1.299-1.54 1.87-.394.736-.512 1.422-.512 2.107a.5.5 0 0 1-.623.485c-3.382-.86-6.083-3.428-7.053-6.987-.693-2.547-.107-5.096 1.087-7.21 1.192-2.11 3.013-3.832 4.87-4.737a.5.5 0 0 1 .664.677c-.631 1.232-.563 1.822-.473 2.057l.01.026c.888-.905 1.43-1.649 1.695-2.48.294-.925.268-2.032-.162-3.707a.5.5 0 0 1 .169-.512m-1.84 7.863h-.002l-.005-.002-.01-.004a1 1 0 0 1-.105-.045 1.3 1.3 0 0 1-.215-.137 1.5 1.5 0 0 1-.468-.643c-.145-.375-.177-.855-.029-1.472a11.3 11.3 0 0 0-3.228 3.608c-1.099 1.945-1.601 4.222-.993 6.455.817 2.998 2.988 5.204 5.745 6.11a5.2 5.2 0 0 1 .596-1.924c.483-.902 1.288-1.828 2.563-2.816a.5.5 0 0 1 .807.39c.011 1.41.253 2.302.677 2.95.399.61.994 1.062 1.865 1.515 2.692-.919 4.841-3.503 5.468-6.56.418-2.04.119-3.495-.466-4.637-.341-.665-.783-1.235-1.266-1.764.02.808-.158 1.57-.526 2.214C20.13 14.305 18.99 15 17.5 15a.5.5 0 0 1-.458-.701c1.253-2.853.895-5.26-.171-7.163-.88-1.57-2.253-2.815-3.647-3.668.22 1.234.2 2.242-.094 3.166-.374 1.176-1.17 2.14-2.281 3.224a.5.5 0 0 1-.503.118z\"></path>" },
};

/** A list row.  `indicatorId`, when set, is the library registry id — the row
 *  is a real, plottable indicator and clicking it adds the study. */
export type IndicatorRow = {
  name: string;
  indicatorId?: string;
  badges?: string[];
  author?: string;
  boosts?: string;
  /** Strategy rows show the reference app's strategy marker icon after the name. */
  scriptType?: 'strategy';
  /** Short title (e.g. "RSI"); the search ranks it before the name. */
  shortName?: string;
  /** Fundamentals metric row (search results): its metric and periods (one button per period on hover). */
  metricKey?: string;
  periods?: MetricPeriod[];
};
/** A section title inside a list (Patterns tab, search results). */
export type SectionTitle = { section: string };
export type ListItem = IndicatorRow | SectionTitle;
export const isSection = (item: ListItem): item is SectionTitle => 'section' in item;

/** Round type tabs over a list, in the reference app's order per tab. */
export type FilterId = 'all' | 'indicators' | 'strategies' | 'profiles' | 'patterns';
export const FILTER_LABELS: Record<FilterId, string> = {
  all: 'All',
  indicators: 'Indicators',
  strategies: 'Strategies',
  profiles: 'Profiles',
  patterns: 'Patterns',
};
export type RowsFilter = { id: FilterId; items: ListItem[] };

/** Types every tab may filter on; a tab with only these collapses its bar. */
const COMMON_FILTERS = new Set<FilterId>(['all', 'indicators', 'strategies']);

/**
 * Reference rule for the filter bar: a type tab shows only when it has rows;
 * a bar of common types (All / Indicators / Strategies) is dropped when one
 * type is left, or All plus one.  `items` is then the list shown without a bar.
 */
export function visibleFilters(filters: RowsFilter[]): { filters: RowsFilter[]; items: ListItem[] } {
  const kept = filters.filter((f) => f.items.some((i) => !isSection(i)));
  const collapse = kept.every((f) => COMMON_FILTERS.has(f.id))
    && (kept.length <= 1 || (kept.length === 2 && kept.some((f) => f.id === 'all')));
  if (!collapse) return { filters: kept, items: [] };
  const only = kept.find((f) => f.id === 'all') ?? kept[0];
  return { filters: [], items: only?.items ?? [] };
}

/** Filters of a list of rows split by script type, All first. */
export function typeFilters(rows: IndicatorRow[]): RowsFilter[] {
  return [
    { id: 'all', items: rows },
    { id: 'indicators', items: rows.filter((r) => r.scriptType !== 'strategy') },
    { id: 'strategies', items: rows.filter((r) => r.scriptType === 'strategy') },
  ];
}

/**
 * Column header of a tab: the reference names it "Name" on Favorites (with
 * Author when a row has one), "Script name" elsewhere (with Author on the
 * community tab), and the Patterns type has no header row.
 */
export function listHeader(tab: string, filter: FilterId | null, rows: ListItem[]): { title: string; author: boolean } | null {
  if (tab === 'built-ins' && filter === 'patterns') return null;
  if (tab === 'favorites') return { title: 'Name', author: rows.some((r) => !isSection(r) && !!r.author) };
  return { title: 'Script name', author: tab === 'community' };
}
/** A Fundamentals metric; depth 0 = parent, 1 = nested (dotted) child. */
/** A metric row: its key, name, depth (1 = under the row above) and periods (first = the row's click; none = a
 *  price metric). */
export type FundamentalMetric = { key: string; name: string; depth: number; periods: MetricPeriod[] };
export type FundamentalSubtab = { label: string; metrics: FundamentalMetric[] };

export type TabContent =
  | { kind: 'rows'; rows: IndicatorRow[] }
  | { kind: 'filtered'; filters: RowsFilter[] }
  | { kind: 'empty'; title: string; body?: string; action?: string }
  | { kind: 'placeholder'; note: string }
  | { kind: 'fundamentals'; subtabs: FundamentalSubtab[] }
  | { kind: 'gap'; note: string };

export const TAB_CONTENT: Record<string, TabContent> = {
  // Favorites is user-curated and starts empty (no fabricated rows).
  'favorites': { kind: 'rows', rows: [] },
  'my-scripts': { kind: 'placeholder', note: 'No scripts here yet.' },
  'invite-only-scripts': { kind: 'placeholder', note: 'No invite-only scripts here yet.' },
  // No store here: the empty state without its "Go to Store" button.
  // Built-In > Technicals — the library standard indicators, the built-in
  // strategies (plain rows like the indicators: no strategy icon, no author),
  // the volume profile studies and the chart / candlestick patterns.
  'built-ins': { kind: 'filtered', filters: [
    { id: 'indicators', items: STANDARD_ROWS.map((r) => ({ name: r.name, shortName: r.shortName, indicatorId: r.id })) },
    { id: 'strategies', items: builtinStrategyRows().map((r) => ({ name: r.name, indicatorId: r.id })) },
    { id: 'profiles', items: PROFILE_ROWS.map((r) => ({ name: r.name, shortName: r.shortName, indicatorId: r.id })) },
    { id: 'patterns', items: [
      { section: 'Chart patterns' },
      ...CHART_PATTERN_ROWS.map((r) => ({ name: r.name, shortName: r.shortName, indicatorId: r.id })),
      { section: 'Candlestick patterns' },
      ...CANDLESTICK_ROWS.map((r) => ({ name: r.name, shortName: r.shortName, indicatorId: r.id })),
    ] },
  ] },
  // Built-In > Fundamentals — the metrics computed from the companies'
  // financial statements (data/fundamental-metrics.ts).
  'fundamentals': { kind: 'fundamentals', subtabs: FUNDAMENTAL_TABS.map(([tab, label]) => ({
    label,
    metrics: METRICS.filter((m) => m.tab === tab).map((m) => ({ key: m.key, name: m.name, depth: m.depth, periods: m.periods })),
  })) },
  // Community — community indicators from the registry.
  // Community indicators, then the backtester's strategy ports (community
  // scripts too, marked with the strategy icon like the reference app's rows).
  'community': {
    kind: 'filtered',
    filters: typeFilters([
      ...COMMUNITY_ROWS.map((r) => ({ name: r.name, shortName: r.shortName, indicatorId: r.id })),
      ...strategyRows().map((r) => ({ name: r.name, indicatorId: r.id, author: r.author, scriptType: 'strategy' as const })),
    ]),
  },
};
