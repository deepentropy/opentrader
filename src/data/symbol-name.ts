/*
 * Symbol name helpers. A symbol's identity is its full name
 * "EXCHANGE:TICKER" (charts, watchlists, drawings, alerts, live events), so a
 * provider listing one ticker on two exchanges can serve both.
 */
import { defaultExchange } from "./providers";
import { isSpreadSymbol, spreadLegs, spreadShortName } from "./spread-symbol";

/** "EXCHANGE:TICKER" → its parts; bare tickers default to the active
 *  provider's default exchange. */
/** Symbol of a script's `request.seed(source, symbol, …)`: the imported series of that name (`LOCAL:<SYMBOL>`,
 *  data/local-series); the source (a data repository) has no place in the app. */
export function seedSymbol(_source: string, symbol: string): string {
  return `LOCAL:${symbol.trim().toUpperCase()}`;
}

export function splitSymbol(symbol: string): { exchange: string; ticker: string } {
  // A formula: its first leg's exchange, its legs' tickers ("NASDAQ:AAPL/NASDAQ:MSFT" → NASDAQ, "AAPL/MSFT").
  if (isSpreadSymbol(symbol)) {
    const first = spreadLegs(symbol)[0] ?? "";
    return { exchange: first.includes(":") ? first.slice(0, first.indexOf(":")) : defaultExchange(), ticker: spreadShortName(symbol) };
  }
  const head = symbol.split(",")[0].trim();
  if (head.includes(":")) {
    const [exchange, ticker] = head.split(":");
    return { exchange, ticker };
  }
  return { exchange: defaultExchange(), ticker: head };
}

/** True for a full name ("NASDAQ:AAPL"; a formula naming every leg in full). */
export function isFullSymbol(symbol: string): boolean {
  if (isSpreadSymbol(symbol)) return spreadLegs(symbol).every((leg) => leg.includes(":"));
  return symbol.includes(":");
}

/** Ticker part of a symbol ("NASDAQ:AAPL" → "AAPL"; a bare ticker as is). */
export function tickerOf(symbol: string): string {
  return splitSymbol(symbol).ticker;
}
