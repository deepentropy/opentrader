/*
 * Gateway frontend presentation adapter — the source-specific normalization
 * the datafeed facade can't express generically. Mirrors the backend
 * `data/provider/gateway.rs`: to add a source, write a sibling adapter and
 * switch the active one in ./index.ts.
 *
 * Source-specific frontend transforms:
 *   • exchange-code normalization — the gateway reports the primary exchange
 *     as an ISO-10383 MIC ("XNAS"); the UI shows the friendly name ("NASDAQ").
 *   • symbol-search mapping — turning raw `search_tickers` results (the
 *     gateway's security types and markets) into dialog rows, plus the
 *     Type-filter dropdown options. The generic ranking/filtering stays in
 *     ../symbol-search.
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

/** Stocks tab "All types" dropdown options (the reference list without
 *  Pre-IPO, which has no provider type) — the gateway's security `type`
 *  values; null = no filter. */
export const typeFilters: TypeFilter[] = [
  { label: 'All types',          code: null },
  { label: 'Common stock',       code: 'stock' },
  { label: 'Preferred stock',    code: 'preferred' },
  { label: 'Depository Receipt', code: 'adr' },
  { label: 'Warrant',            code: 'warrant' },
];

/** Type filter saved by an earlier version (the upstream type codes) → its
 *  gateway type, so a saved filter survives the update. */
export const LEGACY_TYPE_CODES: Record<string, string> = {
  CS: 'stock', PFD: 'preferred', ADRC: 'adr', WARRANT: 'warrant',
};

/** Primary-exchange MIC → display exchange label for search rows.
 *  Distinct from `EXCHANGE_NAMES` above (the detail-panel map): the two
 *  differ for a few codes (e.g. XASE), so they are kept apart to preserve each
 *  surface's labels. */
const SEARCH_EXCHANGE_NAMES: Record<string, string> = {
  XNAS: "NASDAQ", XNGS: "NASDAQ", XNCM: "NASDAQ", XNMS: "NASDAQ",
  XNYS: "NYSE", ARCX: "NYSE ARCA", XASE: "NYSE AMERICAN",
  BATS: "CBOE BZX", BATY: "CBOE BYX", EDGX: "CBOE EDGX", EDGA: "CBOE EDGA",
  IEXG: "IEX", OTCM: "OTC", OTCLINK: "OTC", XOTC: "OTC", PSGM: "OTC", PINX: "OTC",
};

/** Security type → the short marketType label shown on the chip. */
const TYPE_LABELS: Record<string, string> = {
  stock: "stock", adr: "dr", etf: "etf", etn: "etn", etv: "etf", fund: "fund",
  preferred: "preferred", warrant: "warrant", right: "right", unit: "unit",
  structured: "structured", bond: "bond", index: "index",
};

/** Market → category-tab id. The "stocks" market is a catch-all that also
 *  includes ETFs/ETNs/funds/indices, so TYPE_CATEGORY below refines it by
 *  security type (otherwise ETFs leak into the Stocks tab). */
const MARKET_CATEGORY: Record<string, SymbolCategoryId> = {
  stocks: "stocks", otc: "stocks", crypto: "crypto", fx: "forex", indices: "indices",
};

/** Security type → category-tab override (takes priority over the market
 *  mapping). Tab routing: ETF/ETN/ETV/funds → Funds, indices → Indices,
 *  bonds → Bonds. Stocks + depositary receipts fall through to the Stocks tab
 *  via the market mapping. */
const TYPE_CATEGORY: Partial<Record<string, SymbolCategoryId>> = {
  etf: "funds", etn: "funds", etv: "funds", fund: "funds",
  index: "indices", bond: "bonds",
};

/** Map one raw `search_tickers` reference result into a dialog row. The
 *  source half of symbol search; ../symbol-search applies the generic ranking. */
export function searchResultToRow(r: SymbolSearchResult): SymbolRow {
  const ex = (r.exchange && SEARCH_EXCHANGE_NAMES[r.exchange]) || r.exchange || "";
  // The row shows the descriptive name; the symbol's identity uses the code.
  const code = r.exchange ? exchangeCode(r.exchange) : "";
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
    // (they are listed under the "stocks" market) rather than the Stocks tab.
    category: (r.type && TYPE_CATEGORY[r.type]) || MARKET_CATEGORY[market] || "stocks",
    // Listing country: US-locale stocks / OTC / indices (forex pairs and
    // crypto have no listing country).
    country: r.locale === "us" && market !== "fx" && market !== "crypto" ? "US" : undefined,
  };
}

/** A saved Type filter in this adapter's values: an earlier version's code
 *  is translated, anything else returned as it is. */
export function migrateTypeCode(code: string): string {
  return LEGACY_TYPE_CODES[code] ?? code;
}

// ── Adapter object ───────────────────────────────────────────────────────────
// This adapter bundled as one object for the registry in ./index. `name` must
// match the backend's `DataProvider::name()` ("gateway") so the frontend can
// select it from what `get_data_provider` reports.
import type { FrontendProvider } from "./index";

export const gateway: FrontendProvider = {
  name: "gateway",
  defaultExchange,
  exchangeName,
  exchangeCode,
  searchResultToRow,
  typeFilters,
  migrateTypeCode,
};
