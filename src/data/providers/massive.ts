/*
 * Massive frontend presentation adapter — the vendor-specific normalization the
 * datafeed facade can't express generically. Mirrors the backend
 * `data/provider/massive.rs`: to add a vendor, write a sibling adapter and
 * switch the active one in ./index.ts.
 *
 * Vendor-specific frontend transforms:
 *   • exchange-code normalization — Massive's reference endpoint reports the
 *     primary exchange as an ISO-10383 MIC ("XNAS"); the UI shows the friendly
 *     name ("NASDAQ").
 *   • symbol-search mapping — turning raw `search_tickers` results (Massive
 *     security-type / market codes) into dialog rows, plus the Type-filter
 *     dropdown options. The generic ranking/filtering stays in ../symbol-search.
 */
import type { SymbolSearchResult } from "../../bindings";
import type { SymbolRow, SymbolCategoryId, TypeFilter } from "../symbol-search";

/** Bare tickers with no "EXCHANGE:" prefix default to this exchange. */
export const defaultExchange = "NASDAQ";

/** ISO-10383 MIC → common exchange name. Unmapped codes fall through
 *  unchanged (they may already be a friendly name). */
const EXCHANGE_NAMES: Record<string, string> = {
  XNAS: "NASDAQ",
  XNGS: "NASDAQ",
  XNCM: "NASDAQ",
  XNMS: "NASDAQ",
  XNYS: "NYSE",
  ARCX: "NYSE ARCA",
  XASE: "AMEX",
  AMEX: "AMEX",
  BATS: "CBOE BZX",
  BATY: "CBOE BYX",
  EDGX: "CBOE EDGX",
  EDGA: "CBOE EDGA",
  IEXG: "IEX",
  OTC: "OTC",
  OTCM: "OTC",
  OTCLINK: "OTC",
};

/** Map a primary-exchange MIC code to its display name, falling back to the
 *  raw value when there's no mapping (or it's already a friendly name). */
export function exchangeName(code: string | null | undefined): string {
  if (!code) return "";
  return EXCHANGE_NAMES[code.toUpperCase()] ?? code;
}

/** MIC → exchange prefix of the symbol's full name: the listing exchange as
 *  the reference app names it (listed_exchange / pro_name, resolved
 *  01/10/2026): NYSE Arca listings are "AMEX" (AMEX:SPY, AMEX:IWM), like NYSE
 *  American; Cboe BZX listings are "CBOE" (CBOE:AAAU, CBOE:AAPE); OTC
 *  listings "OTC" (OTC:TCEHY). */
const EXCHANGE_CODES: Record<string, string> = {
  XNAS: "NASDAQ", XNGS: "NASDAQ", XNCM: "NASDAQ", XNMS: "NASDAQ",
  XNYS: "NYSE", ARCX: "AMEX", XASE: "AMEX", AMEX: "AMEX",
  BATS: "CBOE", BATY: "CBOE", EDGX: "CBOE", EDGA: "CBOE",
  IEXG: "IEX", OTC: "OTC", OTCM: "OTC", OTCLINK: "OTC", XOTC: "OTC", PSGM: "OTC", PINX: "OTC",
};

/** Exchange prefix of a symbol's full name for a primary-exchange MIC (the
 *  default exchange when unknown). */
export function exchangeCode(code: string | null | undefined): string {
  if (!code) return defaultExchange;
  const c = code.toUpperCase();
  return EXCHANGE_CODES[c] ?? c.replace(/\s+/g, "");
}

// ── Symbol search ────────────────────────────────────────────────────────────

/** "All types" dropdown options — Massive `type` codes
 *  (/v3/reference/tickers/types); null = no filter. */
export const typeFilters: TypeFilter[] = [
  { label: 'All types',          code: null },
  { label: 'Common stock',       code: 'CS' },
  { label: 'ETF',                code: 'ETF' },
  { label: 'ETN',                code: 'ETN' },
  { label: 'Fund',               code: 'FUND' },
  { label: 'Preferred stock',    code: 'PFD' },
  { label: 'Depositary receipt', code: 'ADRC' },
  { label: 'Warrant',            code: 'WARRANT' },
  { label: 'Right',              code: 'RIGHT' },
  { label: 'Unit',               code: 'UNIT' },
  { label: 'Structured product', code: 'SP' },
  { label: 'Bond',               code: 'BOND' },
  { label: 'Index',              code: 'IX' },
];

/** Massive MIC (primary_exchange) → display exchange label for search rows.
 *  Distinct from `EXCHANGE_NAMES` above (the detail-panel map): the two
 *  differ for a few codes (e.g. XASE), so they are kept apart to preserve each
 *  surface's labels. */
const SEARCH_EXCHANGE_NAMES: Record<string, string> = {
  XNAS: "NASDAQ", XNGS: "NASDAQ", XNCM: "NASDAQ", XNMS: "NASDAQ",
  XNYS: "NYSE", ARCX: "NYSE ARCA", XASE: "NYSE AMERICAN",
  BATS: "CBOE BZX", BATY: "CBOE BYX", EDGX: "CBOE EDGX", EDGA: "CBOE EDGA",
  IEXG: "IEX", OTCM: "OTC", OTCLINK: "OTC", XOTC: "OTC", PSGM: "OTC", PINX: "OTC",
};

/** Massive security type code → the short marketType label shown on the chip. */
const TYPE_LABELS: Record<string, string> = {
  CS: "stock", ADRC: "dr", ADRP: "dr", ADRR: "dr", GDR: "dr",
  ETF: "etf", ETN: "etn", ETV: "etf", ETS: "etf", FUND: "fund",
  PFD: "preferred", WARRANT: "warrant", RIGHT: "right", UNIT: "unit",
  SP: "structured", BOND: "bond", IX: "index",
};

/** Massive market → category-tab id. Massive's "stocks" market is a catch-all
 *  that also includes ETFs/ETNs/funds/indices, so TYPE_CATEGORY below refines it
 *  by security type (otherwise ETFs leak into the Stocks tab). */
const MARKET_CATEGORY: Record<string, SymbolCategoryId> = {
  stocks: "stocks", otc: "stocks", crypto: "crypto", fx: "forex", indices: "indices",
};

/** Massive security type → category-tab override (takes priority over the market
 *  mapping). Tab routing: ETF/ETN/funds → Funds, indices → Indices,
 *  bonds → Bonds. Common stock + depositary receipts (CS/ADRC/…) fall through to
 *  the Stocks tab via the market mapping. */
const TYPE_CATEGORY: Partial<Record<string, SymbolCategoryId>> = {
  ETF: "funds", ETN: "funds", ETV: "funds", ETS: "funds", FUND: "funds",
  IX: "indices", BOND: "bonds",
};

/** Map one raw `search_tickers` reference result into a dialog row. The vendor
 *  half of symbol search; ../symbol-search applies the generic ranking. */
export function searchResultToRow(r: SymbolSearchResult): SymbolRow {
  const ex = (r.primaryExchange && SEARCH_EXCHANGE_NAMES[r.primaryExchange]) || r.primaryExchange || "";
  // The row shows the descriptive name; the symbol's identity uses the code.
  const code = r.primaryExchange ? exchangeCode(r.primaryExchange) : "";
  const market = r.market ?? "stocks";
  const marketType =
    (r.type && TYPE_LABELS[r.type]) ||
    (market === "crypto" ? "crypto" : market === "fx" ? "forex" : market === "indices" ? "index" : "stock");
  return {
    symbolName: code ? `${code}:${r.ticker}` : r.ticker,
    ticker: r.ticker,
    description: r.name ?? "",
    marketType,
    exchange: ex,
    exchangeTooltip: ex || undefined,
    primaryExchange: !!ex,
    // Security type wins over the market bucket so ETFs/ETNs/funds land in Funds
    // (Massive files them under the "stocks" market) rather than the Stocks tab.
    category: (r.type && TYPE_CATEGORY[r.type]) || MARKET_CATEGORY[market] || "stocks",
    // Listing country: US-locale stocks / OTC / indices (forex pairs and
    // crypto have no listing country).
    country: r.locale === "us" && market !== "fx" && market !== "crypto" ? "US" : undefined,
  };
}

// ── Adapter object ───────────────────────────────────────────────────────────
// This adapter bundled as one object for the registry in ./index. `name` must
// match the backend's `DataProvider::name()` ("massive") so the frontend can
// select it from what `get_data_provider` reports.
import type { FrontendProvider } from "./index";

export const massive: FrontendProvider = {
  name: "massive",
  defaultExchange,
  exchangeName,
  exchangeCode,
  searchResultToRow,
  typeFilters,
};
