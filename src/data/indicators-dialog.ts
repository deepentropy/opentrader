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
 *   empty        — empty-state
 *   placeholder  — empty list note (Invite-only; My scripts until the
 *                  user saves an OakScript script, then its rows)
 *   fundamentals — 4 sub-tabs × hierarchical metric list
 *
 * SIDEBAR_ICONS hold the FontIcon <svg> markup.
 */
import { STANDARD_ROWS, COMMUNITY_ROWS } from '../window/chart/indicators/registry';
import { strategyRows } from '../window/chart/indicators/strategy-entries';

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
      // Invite-only needs script accounts this app does not have.
      { id: "invite-only-scripts", label: "Invite-only", disabled: true },
    ],
  },
  {
    key: "builtIn",
    title: "Built-In",
    items: [
      // Technicals only: the Fundamentals metrics need financial data this
      // app does not load (their tab content below is kept, not listed).
      { id: "built-ins", label: "Technicals" },
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
};
/** A Fundamentals metric; depth 0 = parent, 1 = nested (dotted) child. */
export type FundamentalMetric = { name: string; depth: number };
export type FundamentalSubtab = { label: string; metrics: FundamentalMetric[] };

export type TabContent =
  | { kind: 'rows'; rows: IndicatorRow[] }
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
  // Built-In > Technicals — the library standard indicators (registry).
  'built-ins': { kind: 'rows', rows: STANDARD_ROWS.map((r) => ({ name: r.name, indicatorId: r.id })) },
  'fundamentals': { kind: 'fundamentals', subtabs: [
    { label: "Income statement", metrics: [
      { name: "Total revenue", depth: 0 },
      { name: "Cost of goods sold", depth: 0 },
      { name: "Deprecation and amortization", depth: 1 },
      { name: "Depreciation", depth: 1 },
      { name: "Amortization of intangibles", depth: 1 },
      { name: "Amortization of deferred charges", depth: 1 },
      { name: "Other cost of goods sold", depth: 1 },
      { name: "Gross profit", depth: 0 },
      { name: "Operating expenses (excl. COGS)", depth: 0 },
      { name: "Selling/general/admin expenses (total)", depth: 1 },
      { name: "Research & development", depth: 1 },
      { name: "Selling/general/admin expenses (other)", depth: 1 },
      { name: "Other operating expenses (total)", depth: 1 },
      { name: "Operating income", depth: 0 },
      { name: "Non-operating income (total)", depth: 0 },
      { name: "Interest expense, net of interest capitalized", depth: 1 },
      { name: "Interest expense on debt", depth: 1 },
      { name: "Interest capitalized", depth: 1 },
      { name: "Non-operating income (excl. interest expenses)", depth: 1 },
      { name: "Non-operating interest income", depth: 1 },
      { name: "Pretax equity in earnings", depth: 1 },
      { name: "Miscellaneous non-operating expense", depth: 1 },
      { name: "Unusual income/expense", depth: 1 },
      { name: "Impairments", depth: 1 },
      { name: "Restructuring charge", depth: 1 },
      { name: "Legal claim expense", depth: 1 },
      { name: "Unrealized gain/loss", depth: 1 },
      { name: "Other exceptional charges", depth: 1 },
      { name: "Pretax income", depth: 0 },
      { name: "Equity in earnings", depth: 0 },
      { name: "Taxes", depth: 0 },
      { name: "Income tax (current)", depth: 1 },
      { name: "Income tax (current - domestic)", depth: 1 },
      { name: "Income tax (current - foreign)", depth: 1 },
      { name: "Income tax, deferred", depth: 1 },
      { name: "Income tax (deferred - domestic)", depth: 1 },
      { name: "Income tax (deferred - foreign)", depth: 1 },
      { name: "Income tax credits", depth: 1 },
      { name: "Non-controlling/minority interest", depth: 0 },
      { name: "After tax other income/expense", depth: 0 },
      { name: "Net income before discontinued operations", depth: 0 },
      { name: "Discontinued operations", depth: 0 },
      { name: "Net income", depth: 0 },
      { name: "Dilution adjustment", depth: 0 },
      { name: "Preferred dividends", depth: 0 },
      { name: "Diluted net income available to common stockholders", depth: 0 },
      { name: "Basic earnings per share (basic EPS)", depth: 0 },
      { name: "Diluted earnings per share (diluted EPS)", depth: 0 },
      { name: "Average basic shares outstanding", depth: 0 },
      { name: "Diluted shares outstanding", depth: 0 },
      { name: "EBITDA", depth: 0 },
      { name: "EBIT", depth: 0 },
      { name: "Total operating expenses", depth: 0 },
    ] },
    { label: "Balance sheet", metrics: [
      { name: "Total assets", depth: 0 },
      { name: "Total current assets", depth: 1 },
      { name: "Cash and short term investments", depth: 1 },
      { name: "Cash & equivalents", depth: 1 },
      { name: "Short term investments", depth: 1 },
      { name: "Total receivables (net)", depth: 1 },
      { name: "Accounts receivable (trade, net)", depth: 1 },
      { name: "Accounts receivables (gross)", depth: 1 },
      { name: "Bad debt / Doubtful accounts", depth: 1 },
      { name: "Other receivables", depth: 1 },
      { name: "Total inventory", depth: 1 },
      { name: "Inventories (work in progress)", depth: 1 },
      { name: "Inventories (progress payments & other)", depth: 1 },
      { name: "Inventories (finished goods)", depth: 1 },
      { name: "Inventories (raw materials)", depth: 1 },
      { name: "Prepaid expenses", depth: 1 },
      { name: "Other current assets (total)", depth: 1 },
      { name: "Total non-current assets", depth: 1 },
      { name: "Long term investments", depth: 1 },
      { name: "Note receivable (long term)", depth: 1 },
      { name: "Investments in unconsolidated subsidiaries", depth: 1 },
      { name: "Other investments", depth: 1 },
      { name: "Net property/plant/equipment", depth: 1 },
      { name: "Gross property/plant/equipment", depth: 1 },
      { name: "Property/plant/equipment (buildings)", depth: 1 },
      { name: "Property/plant/equipment (construction in progress)", depth: 1 },
      { name: "Property/plant/equipment (machinery & equipment)", depth: 1 },
      { name: "Property/plant/equipment (land & improvement)", depth: 1 },
      { name: "Property/plant/equipment (leased property)", depth: 1 },
      { name: "Property/plant/equipment (leases)", depth: 1 },
      { name: "Property/plant/equipment (computer software and equipment)", depth: 1 },
      { name: "Property/plant/equipment (transportation equipment)", depth: 1 },
      { name: "Property/plant/equipment (other)", depth: 1 },
      { name: "Accumulated depreciation (total)", depth: 1 },
      { name: "Accumulated depreciation (buildings)", depth: 1 },
      { name: "Accumulated depreciation (construction in progress)", depth: 1 },
      { name: "Accumulated depreciation (machinery & equipment)", depth: 1 },
      { name: "Accumulated depreciation (land & improvement)", depth: 1 },
      { name: "Accumulated depreciation (leased property)", depth: 1 },
      { name: "Accumulated depreciation (leases)", depth: 1 },
      { name: "Accumulated depreciation (computer software and equipment)", depth: 1 },
      { name: "Accumulated depreciation (transportation equipment)", depth: 1 },
      { name: "Accumulated depreciation (other)", depth: 1 },
      { name: "Deferred tax assets", depth: 1 },
      { name: "Net intangible assets", depth: 1 },
      { name: "Goodwill (net)", depth: 1 },
      { name: "Goodwill (gross)", depth: 1 },
      { name: "Accumulated goodwill amortization", depth: 1 },
      { name: "Other intangibles (net)", depth: 1 },
      { name: "Other intangibles (gross)", depth: 1 },
      { name: "Accumulated amortization of other intangibles", depth: 1 },
      { name: "Deferred charges", depth: 1 },
      { name: "Other long term assets (total)", depth: 1 },
      { name: "Total liabilities", depth: 0 },
      { name: "Total current liabilities", depth: 1 },
      { name: "Short term debt", depth: 1 },
      { name: "Current portion of LT debt and capital leases", depth: 1 },
      { name: "Short term debt (excl. current portion of LT debt)", depth: 1 },
      { name: "Notes payable", depth: 1 },
      { name: "Other short term debt", depth: 1 },
      { name: "Accounts payable", depth: 1 },
      { name: "Income tax payable", depth: 1 },
      { name: "Dividends payable", depth: 1 },
      { name: "Accrued payroll", depth: 1 },
      { name: "Deferred income (current)", depth: 1 },
      { name: "Other current liabilities", depth: 1 },
      { name: "Total non-current liabilities", depth: 1 },
      { name: "Long term debt", depth: 1 },
      { name: "Long term debt (excl. lease liabilities)", depth: 1 },
      { name: "Capital and operating lease obligations", depth: 1 },
      { name: "Capitalized lease obligations", depth: 1 },
      { name: "Operating lease liabilities", depth: 1 },
      { name: "Provision for risks & charge", depth: 1 },
      { name: "Deferred tax liabilities", depth: 1 },
      { name: "Deferred income (non-current)", depth: 1 },
      { name: "Other non-current liabilities (total)", depth: 1 },
      { name: "Total equity", depth: 0 },
      { name: "Shareholders' equity", depth: 1 },
      { name: "Common equity (total)", depth: 1 },
      { name: "Retained earnings", depth: 1 },
      { name: "Paid in capital", depth: 1 },
      { name: "Common stock par / Carrying value", depth: 1 },
      { name: "Additional paid-in capital / Capital surplus", depth: 1 },
      { name: "Treasury stock (common)", depth: 1 },
      { name: "Other common equity", depth: 1 },
      { name: "Preferred stock (carrying value)", depth: 1 },
      { name: "Minority interest", depth: 1 },
      { name: "Total liabilities & shareholders' equities", depth: 0 },
      { name: "Total debt", depth: 0 },
      { name: "Net debt", depth: 0 },
    ] },
    { label: "Cash flow", metrics: [
      { name: "Cash from operating activities", depth: 0 },
      { name: "Funds from operations", depth: 1 },
      { name: "Net income (cash flow)", depth: 1 },
      { name: "Depreciation & amortization (cash flow)", depth: 1 },
      { name: "Depreciation/depletion", depth: 1 },
      { name: "Amortization", depth: 1 },
      { name: "Deferred taxes (cash flow)", depth: 1 },
      { name: "Non-cash items", depth: 1 },
      { name: "Changes in working capital", depth: 1 },
      { name: "Change in accounts receivable", depth: 1 },
      { name: "Change in taxes payable", depth: 1 },
      { name: "Change in accounts payable", depth: 1 },
      { name: "Change in accrued expenses", depth: 1 },
      { name: "Change in inventories", depth: 1 },
      { name: "Change in other assets/liabilities", depth: 1 },
      { name: "Cash from investing activities", depth: 0 },
      { name: "Purchase/sale of business (net)", depth: 1 },
      { name: "Sale of fixed assets & businesses", depth: 1 },
      { name: "Purchase/acquisition of business", depth: 1 },
      { name: "Purchase/sale of investments (net)", depth: 1 },
      { name: "Sale/maturity of investments", depth: 1 },
      { name: "Purchase of investments", depth: 1 },
      { name: "Capital expenditures", depth: 1 },
      { name: "Capital expenditures (fixed assets)", depth: 1 },
      { name: "Capital expenditures (other assets)", depth: 1 },
      { name: "Other investing cash flow items (total)", depth: 1 },
      { name: "Investing activities (other sources)", depth: 1 },
      { name: "Investing activities (other uses)", depth: 1 },
      { name: "Cash from financing activities", depth: 0 },
      { name: "Issuance/retirement of stock (net)", depth: 1 },
      { name: "Sale of common & preferred stock", depth: 1 },
      { name: "Repurchase of common & preferred stock", depth: 1 },
      { name: "Issuance/retirement of debt (net)", depth: 1 },
      { name: "Issuance/retirement of long term debt", depth: 1 },
      { name: "Issuance of long term debt", depth: 1 },
      { name: "Reduction of long term debt", depth: 1 },
      { name: "Issuance/retirement of short term debt", depth: 1 },
      { name: "Issuance/retirement of other debt", depth: 1 },
      { name: "Total cash dividends paid", depth: 1 },
      { name: "Common dividends paid", depth: 1 },
      { name: "Preferred dividends paid", depth: 1 },
      { name: "Other financing cash flow items (total)", depth: 1 },
      { name: "Financing activities (other sources)", depth: 1 },
      { name: "Financing activities (other uses)", depth: 1 },
      { name: "Free cash flow", depth: 0 },
    ] },
    { label: "Statistics", metrics: [
      { name: "Market capitalization", depth: 0 },
      { name: "Total common shares outstanding", depth: 0 },
      { name: "Free float", depth: 0 },
      { name: "Number of employees", depth: 0 },
      { name: "Dividends per share (common stock primary issue)", depth: 0 },
      { name: "Dividend yield %", depth: 0 },
      { name: "Dividend payout ratio %", depth: 0 },
      { name: "Price to earnings ratio", depth: 0 },
      { name: "Price to sales ratio", depth: 0 },
      { name: "Price to cash flow ratio", depth: 0 },
      { name: "Price to book ratio", depth: 0 },
      { name: "Enterprise value", depth: 0 },
      { name: "Enterprise value to EBITDA ratio", depth: 0 },
      { name: "Enterprise value to EBIT ratio", depth: 0 },
      { name: "Enterprise value to revenue ratio", depth: 0 },
      { name: "Price earnings ratio forward", depth: 0 },
      { name: "Price sales ratio forward", depth: 0 },
      { name: "Price to free cash flow ratio", depth: 0 },
      { name: "Price to tangible book ratio", depth: 0 },
      { name: "Price/earnings to growth ratio", depth: 0 },
      { name: "Return on assets %", depth: 0 },
      { name: "Return on equity %", depth: 0 },
      { name: "Return on common equity %", depth: 0 },
      { name: "Return on invested capital %", depth: 0 },
      { name: "Gross margin %", depth: 0 },
      { name: "Operating margin %", depth: 0 },
      { name: "EBITDA margin %", depth: 0 },
      { name: "Net margin %", depth: 0 },
      { name: "Return on equity adjusted to book value %", depth: 0 },
      { name: "Return on tangible assets %", depth: 0 },
      { name: "Return on tangible equity %", depth: 0 },
      { name: "Free cash flow margin %", depth: 0 },
      { name: "Quick ratio", depth: 0 },
      { name: "Current ratio", depth: 0 },
      { name: "Inventory turnover", depth: 0 },
      { name: "Asset turnover", depth: 0 },
      { name: "Debt to assets ratio", depth: 0 },
      { name: "Debt to equity ratio", depth: 0 },
      { name: "Long term debt to total assets ratio", depth: 0 },
      { name: "Long term debt to total equity ratio", depth: 0 },
      { name: "Debt to EBITDA ratio", depth: 0 },
      { name: "Net debt to EBITDA ratio", depth: 0 },
      { name: "Debt to revenue ratio", depth: 0 },
      { name: "Free cash flow per share", depth: 0 },
      { name: "Tangible book value per share", depth: 0 },
      { name: "Effective interest rate on debt %", depth: 0 },
      { name: "Equity to assets ratio", depth: 0 },
      { name: "Goodwill to assets ratio", depth: 0 },
      { name: "Interest coverage", depth: 0 },
      { name: "Inventory to revenue ratio", depth: 0 },
      { name: "Shares buyback ratio %", depth: 0 },
      { name: "Sloan ratio %", depth: 0 },
      { name: "EPS estimates", depth: 0 },
      { name: "Revenue estimates", depth: 0 },
      { name: "Revenue one year growth %", depth: 0 },
      { name: "EPS basic one year growth %", depth: 0 },
      { name: "EPS diluted one year growth %", depth: 0 },
      { name: "Accruals", depth: 0 },
      { name: "Tangible common equity ratio", depth: 0 },
      { name: "Revenue per employee", depth: 0 },
      { name: "Net income per employee", depth: 0 },
      { name: "Free cash flow per employee", depth: 0 },
      { name: "EBITDA per employee", depth: 0 },
      { name: "Operationg income per employee", depth: 0 },
      { name: "Total debt per employee", depth: 0 },
      { name: "Total assets per employee", depth: 0 },
      { name: "Research & development per employee", depth: 0 },
      { name: "Graham's number", depth: 0 },
      { name: "Quality ratio", depth: 0 },
      { name: "Gross profit to assets ratio", depth: 0 },
      { name: "Buyback yield %", depth: 0 },
      { name: "Cash conversion cycle", depth: 0 },
      { name: "Altman Z-score", depth: 0 },
      { name: "Piotroski F-score", depth: 0 },
      { name: "Sustainable growth rate %", depth: 0 },
      { name: "Research & development to revenue ratio %", depth: 0 },
      { name: "Earnings yield %", depth: 0 },
      { name: "Operating earnings yield %", depth: 0 },
      { name: "Tobin's Q (approximate)", depth: 0 },
      { name: "Beneish M-score", depth: 0 },
      { name: "KZ index", depth: 0 },
      { name: "Fulmer H factor", depth: 0 },
      { name: "Springate score", depth: 0 },
      { name: "Zmijewski score", depth: 0 },
      { name: "Cash to debt ratio", depth: 0 },
      { name: "COGS to revenue ratio", depth: 0 },
      { name: "Days inventory", depth: 0 },
      { name: "Days payable", depth: 0 },
      { name: "Days sales outstanding", depth: 0 },
    ] },
  ] },
  // Community — community indicators from the registry.
  // Community indicators, then the backtester's strategy ports (community
  // scripts too, marked with the strategy icon like the reference app's rows).
  'community': {
    kind: 'rows',
    rows: [
      ...COMMUNITY_ROWS.map((r) => ({ name: r.name, indicatorId: r.id })),
      ...strategyRows().map((r) => ({ name: r.name, indicatorId: r.id, author: r.author, scriptType: 'strategy' as const })),
    ],
  },
};
