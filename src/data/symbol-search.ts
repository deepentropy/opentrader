/*
 * Symbol-search mock data — backs the symbol-search dialog
 *   (data-name="symbol-search-items-dialog").
 *
 * The live backend returns server-ranked rows on each keystroke; the mock
 * filters this static table client-side.  Row schema: data-symbol-name,
 * data-type, marketType, exchange, logo, country flag.
 */
export type SymbolType =
  | 'stock' | 'fund' | 'futures' | 'forex' | 'crypto'
  | 'index' | 'bond' | 'economy' | 'options' | 'dr';

export type SymbolCategoryId =
  | 'all' | 'stocks' | 'funds' | 'futures' | 'forex'
  | 'crypto' | 'indices' | 'bonds' | 'economy' | 'options';

export type SymbolRow = {
  /** "NASDAQ:INTC" — full symbol passed to the chart. */
  symbolName: string;
  /** "INTC" — ticker shown in the title cell. */
  ticker: string;
  /** "Intel Corporation" — long name. */
  description: string;
  /** "stock" / "dr" / "etf" / "futures" / … — drives the type chip text. */
  marketType: string;
  /** "NASDAQ", "NYSE", "FX", "BINANCE", … — drives the right-side label. */
  exchange: string;
  /** Tooltip for the exchange chip, e.g. "NASDAQ — NASDAQ Stock Market". */
  exchangeTooltip?: string;
  /** True when the exchange owns the primary listing (icon prepended). */
  primaryExchange?: boolean;
  /** Logo URL. No source is wired up, so rows fall back to a letter avatar. */
  logoSrc?: string;
  /** Country / exchange flag URL. Unset — the flag is omitted when absent. */
  flagSrc?: string;
  /** Listing country (ISO 3166 alpha-2) from the search data; rows without
   *  it fall back to their exchange's country (data/country-flags.ts). */
  country?: string;
  /** Tab routing — "dr" rows map into the Stocks tab too. */
  category: SymbolCategoryId;
  /** Initial-load "recent" list flag — these float to the top with no query. */
  recent?: boolean;
};

/** Category tabs of the dialog. */
export const CATEGORIES: { id: SymbolCategoryId; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'stocks',   label: 'Stocks' },
  { id: 'funds',    label: 'Funds' },
  { id: 'futures',  label: 'Futures' },
  { id: 'forex',    label: 'Forex' },
  { id: 'crypto',   label: 'Crypto' },
  { id: 'indices',  label: 'Indices' },
  { id: 'bonds',    label: 'Bonds' },
  { id: 'economy',  label: 'Economy' },
  { id: 'options',  label: 'Options' },
];

/**
 * Options for the "All types" dropdown on the filter-chip strip. `code` is the
 * active provider's security-type filter (null = no filter), wired through
 * `search_tickers`. The concrete option list is vendor-specific and lives in the
 * provider adapter; it's re-exported here (as an accessor, `TYPE_FILTERS()`, so
 * it follows the active provider) and keeps symbol-search the front door.
 */
export type TypeFilter = { label: string; code: string | null };
export { typeFilters as TYPE_FILTERS } from "./providers";

/*
 * A focused, retail-trader-relevant catalogue.  The "INTC" group holds
 * NASDAQ + BOATS primary/derivative pairs for the default load.  The
 * remaining rows cover each tab so users can switch categories and see
 * content.
 */
export const SYMBOLS: SymbolRow[] = [
  // ── Stocks (recent) ─────────────────────────────────────────────────────
  {
    symbolName: 'NASDAQ:INTC', ticker: 'INTC', description: 'Intel Corporation',
    marketType: 'stock', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'stocks', recent: true,
  },
  {
    symbolName: 'BOATS:INTC', ticker: 'INTC', description: 'Intel Corporation',
    marketType: 'stock', exchange: 'BOATS',
    category: 'stocks', recent: true,
  },
  {
    symbolName: 'NASDAQ:AAPL', ticker: 'AAPL', description: 'Apple Inc.',
    marketType: 'stock', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'stocks', recent: true,
  },
  {
    symbolName: 'NASDAQ:NVDA', ticker: 'NVDA', description: 'NVIDIA Corporation',
    marketType: 'stock', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'stocks',
  },
  {
    symbolName: 'NASDAQ:MSFT', ticker: 'MSFT', description: 'Microsoft Corporation',
    marketType: 'stock', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'stocks',
  },
  {
    symbolName: 'NASDAQ:TSLA', ticker: 'TSLA', description: 'Tesla, Inc.',
    marketType: 'stock', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'stocks',
  },
  {
    symbolName: 'NYSE:GME', ticker: 'GME', description: 'GameStop Corp.',
    marketType: 'stock', exchange: 'NYSE',
    exchangeTooltip: 'NYSE — New York Stock Exchange', primaryExchange: true,
    category: 'stocks',
  },
  {
    symbolName: 'NASDAQ:AMD', ticker: 'AMD', description: 'Advanced Micro Devices, Inc.',
    marketType: 'stock', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'stocks',
  },

  // ── Funds (ETFs) ────────────────────────────────────────────────────────
  {
    symbolName: 'NASDAQ:QQQ', ticker: 'QQQ', description: 'Invesco QQQ Trust, Series 1',
    marketType: 'fund', exchange: 'NASDAQ',
    exchangeTooltip: 'NASDAQ — NASDAQ Stock Market', primaryExchange: true,
    category: 'funds',
  },
  {
    symbolName: 'AMEX:SPY', ticker: 'SPY', description: 'SPDR S&P 500 ETF Trust',
    marketType: 'fund', exchange: 'AMEX',
    exchangeTooltip: 'AMEX — NYSE American', primaryExchange: true,
    category: 'funds',
  },
  {
    symbolName: 'AMEX:IWM', ticker: 'IWM', description: 'iShares Russell 2000 ETF',
    marketType: 'fund', exchange: 'AMEX',
    exchangeTooltip: 'AMEX — NYSE American', primaryExchange: true,
    category: 'funds',
  },

  // ── Futures ────────────────────────────────────────────────────────────
  {
    symbolName: 'CME_MINI:ES1!', ticker: 'ES1!', description: 'E-Mini S&P 500 Futures',
    marketType: 'futures', exchange: 'CME',
    exchangeTooltip: 'CME — Chicago Mercantile Exchange', primaryExchange: true,
    category: 'futures',
  },
  {
    symbolName: 'CME_MINI:NQ1!', ticker: 'NQ1!', description: 'E-Mini Nasdaq-100 Futures',
    marketType: 'futures', exchange: 'CME',
    exchangeTooltip: 'CME — Chicago Mercantile Exchange', primaryExchange: true,
    category: 'futures',
  },
  {
    symbolName: 'NYMEX:CL1!', ticker: 'CL1!', description: 'Crude Oil Futures',
    marketType: 'futures', exchange: 'NYMEX',
    exchangeTooltip: 'NYMEX — New York Mercantile Exchange', primaryExchange: true,
    category: 'futures',
  },
  {
    symbolName: 'COMEX:GC1!', ticker: 'GC1!', description: 'Gold Futures',
    marketType: 'futures', exchange: 'COMEX',
    exchangeTooltip: 'COMEX — Commodity Exchange', primaryExchange: true,
    category: 'futures',
  },

  // ── Forex ──────────────────────────────────────────────────────────────
  {
    symbolName: 'FX:EURUSD', ticker: 'EURUSD', description: 'Euro / U.S. Dollar',
    marketType: 'forex', exchange: 'FX', primaryExchange: true,
    category: 'forex', recent: true,
  },
  {
    symbolName: 'FX:GBPUSD', ticker: 'GBPUSD', description: 'British Pound / U.S. Dollar',
    marketType: 'forex', exchange: 'FX', primaryExchange: true,
    category: 'forex',
  },
  {
    symbolName: 'FX:USDJPY', ticker: 'USDJPY', description: 'U.S. Dollar / Japanese Yen',
    marketType: 'forex', exchange: 'FX', primaryExchange: true,
    category: 'forex',
  },
  {
    symbolName: 'OANDA:XAUUSD', ticker: 'XAUUSD', description: 'Gold Spot / U.S. Dollar',
    marketType: 'forex', exchange: 'OANDA',
    exchangeTooltip: 'OANDA — OANDA', primaryExchange: false,
    category: 'forex',
  },

  // ── Crypto ─────────────────────────────────────────────────────────────
  {
    symbolName: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', description: 'Bitcoin / TetherUS',
    marketType: 'crypto', exchange: 'BINANCE', primaryExchange: true,
    category: 'crypto', recent: true,
  },
  {
    symbolName: 'BINANCE:ETHUSDT', ticker: 'ETHUSDT', description: 'Ethereum / TetherUS',
    marketType: 'crypto', exchange: 'BINANCE', primaryExchange: true,
    category: 'crypto',
  },
  {
    symbolName: 'COINBASE:SOLUSD', ticker: 'SOLUSD', description: 'Solana / U.S. Dollar',
    marketType: 'crypto', exchange: 'COINBASE', primaryExchange: true,
    category: 'crypto',
  },
  {
    symbolName: 'CRYPTOCAP:BTC', ticker: 'BTC', description: 'Bitcoin Total Market Cap, $',
    marketType: 'index', exchange: 'CRYPTOCAP', primaryExchange: true,
    category: 'crypto',
  },

  // ── Indices ────────────────────────────────────────────────────────────
  {
    symbolName: 'TVC:SPX', ticker: 'SPX', description: 'S&P 500 Index',
    marketType: 'index', exchange: 'TVC', primaryExchange: true,
    category: 'indices',
  },
  {
    symbolName: 'TVC:NDX', ticker: 'NDX', description: 'NASDAQ 100 Index',
    marketType: 'index', exchange: 'TVC', primaryExchange: true,
    category: 'indices',
  },
  {
    symbolName: 'TVC:DJI', ticker: 'DJI', description: 'Dow Jones Industrial Average Index',
    marketType: 'index', exchange: 'TVC', primaryExchange: true,
    category: 'indices',
  },
  {
    symbolName: 'TVC:VIX', ticker: 'VIX', description: 'Volatility S&P 500 Index',
    marketType: 'index', exchange: 'TVC', primaryExchange: true,
    category: 'indices',
  },

  // ── Bonds ──────────────────────────────────────────────────────────────
  {
    symbolName: 'TVC:US10Y', ticker: 'US10Y', description: 'US Government Bonds 10 YR Yield',
    marketType: 'bond', exchange: 'TVC', primaryExchange: true,
    category: 'bonds',
  },
  {
    symbolName: 'TVC:US02Y', ticker: 'US02Y', description: 'US Government Bonds 2 YR Yield',
    marketType: 'bond', exchange: 'TVC', primaryExchange: true,
    category: 'bonds',
  },

  // ── Economy ────────────────────────────────────────────────────────────
  {
    symbolName: 'ECONOMICS:USCPI', ticker: 'USCPI', description: 'United States Consumer Price Index',
    marketType: 'economy', exchange: 'ECONOMICS', primaryExchange: true,
    category: 'economy',
  },
  {
    symbolName: 'ECONOMICS:USINTR', ticker: 'USINTR', description: 'United States Interest Rate',
    marketType: 'economy', exchange: 'ECONOMICS', primaryExchange: true,
    category: 'economy',
  },
  {
    symbolName: 'ECONOMICS:USIRYY', ticker: 'USIRYY', description: 'United States Inflation Rate (YoY)',
    marketType: 'economy', exchange: 'ECONOMICS', primaryExchange: true,
    category: 'economy',
  },

  // ── Options ────────────────────────────────────────────────────────────
  {
    symbolName: 'OPRA:SPY250620C580', ticker: 'SPY 6/20/25 $580 C', description: 'SPY June 20 2025 580 Call',
    marketType: 'options', exchange: 'OPRA', primaryExchange: true,
    category: 'options',
  },
  {
    symbolName: 'OPRA:AAPL250620C220', ticker: 'AAPL 6/20/25 $220 C', description: 'AAPL June 20 2025 220 Call',
    marketType: 'options', exchange: 'OPRA', primaryExchange: true,
    category: 'options',
  },
];

/**
 * Filter the catalogue by an active tab + query string.  Highlight ranges
 * are returned alongside so the renderer can wrap `<em>` around matched
 * substrings.
 */
export type FilteredRow = SymbolRow & {
  titleHighlight: [number, number] | null;
  descriptionHighlight: [number, number] | null;
};

export function filterSymbols(
  category: SymbolCategoryId,
  query: string,
): FilteredRow[] {
  const q = query.trim().toUpperCase();
  const base = SYMBOLS.filter((s) => category === 'all' || s.category === category);
  if (!q) {
    // No query → return the catalogue order; recent first if any.
    const recent = base.filter((s) => s.recent);
    const others = base.filter((s) => !s.recent);
    return [...recent, ...others].map((s) => ({ ...s, titleHighlight: null, descriptionHighlight: null }));
  }
  const matches: FilteredRow[] = [];
  for (const s of base) {
    const tIdx = s.ticker.toUpperCase().indexOf(q);
    const dIdx = s.description.toUpperCase().indexOf(q);
    if (tIdx < 0 && dIdx < 0) continue;
    matches.push({
      ...s,
      titleHighlight: tIdx >= 0 ? [tIdx, tIdx + q.length] : null,
      descriptionHighlight: dIdx >= 0 ? [dIdx, dIdx + q.length] : null,
    });
  }
  // Ranking — exact ticker match first, then ticker-prefix, then description.
  matches.sort((a, b) => {
    const ta = a.ticker.toUpperCase() === q ? 0 : a.titleHighlight?.[0] === 0 ? 1 : a.titleHighlight ? 2 : 3;
    const tb = b.ticker.toUpperCase() === q ? 0 : b.titleHighlight?.[0] === 0 ? 1 : b.titleHighlight ? 2 : 3;
    return ta - tb;
  });
  return matches;
}

/* ── Live symbol search ─────────────────────────────────────────────────────
 * The vendor-specific mapping of raw `search_tickers` results into rows lives in
 * the active provider adapter (./providers); here we keep the generic ranking +
 * filtering that's identical regardless of vendor. */
import type { SymbolSearchResult } from "../bindings";
import { searchResultToRow } from "./providers";

/** Display exchanges treated as "major" US listings for ranking. Operates on the
 *  normalized exchange names the adapter produces, so it stays vendor-neutral. */
const MAJOR_EXCHANGES = new Set(["NASDAQ", "NYSE", "NYSE ARCA", "NYSE AMERICAN", "CBOE BZX", "IEX"]);

/** Map + filter + rank live results into dialog rows. The provider ranks with no
 *  popularity signal, so we re-rank by match quality (exact → prefix → substring
 *  → name-only) then listing quality (major-exchange equity → ETF → OTC/other),
 *  stable within a rank. */
export function liveResultsToRows(
  results: SymbolSearchResult[],
  category: SymbolCategoryId,
  query: string,
): FilteredRow[] {
  const q = query.trim().toUpperCase();
  const rows = results.map(searchResultToRow);
  const base = category === "all" ? rows : rows.filter((r) => r.category === category);
  const mapped: FilteredRow[] = base.map((r) => {
    const tIdx = r.ticker.toUpperCase().indexOf(q);
    const dIdx = r.description.toUpperCase().indexOf(q);
    return {
      ...r,
      titleHighlight: tIdx >= 0 ? [tIdx, tIdx + q.length] : null,
      descriptionHighlight: dIdx >= 0 ? [dIdx, dIdx + q.length] : null,
    };
  });
  const matchRank = (r: FilteredRow): number =>
    r.ticker.toUpperCase() === q ? 0 : r.titleHighlight?.[0] === 0 ? 1 : r.titleHighlight ? 2 : 3;
  const listingRank = (r: FilteredRow): number => {
    const major = MAJOR_EXCHANGES.has(r.exchange);
    const isEquity = r.marketType === "stock" || r.marketType === "dr";
    return major && isEquity ? 0 : major ? 1 : 2;
  };
  return mapped
    .map((r, i) => ({ r, i }))
    .sort((a, b) => matchRank(a.r) - matchRank(b.r) || listingRank(a.r) - listingRank(b.r) || a.i - b.i)
    .map(({ r }) => r)
    // A broad prefix (e.g. one letter) can match hundreds of tickers; cap the
    // rendered list after ranking so the dialog shows the best matches, not a
    // wall of rows. 50 fills the scroll area with room to spare.
    .slice(0, 50);
}
