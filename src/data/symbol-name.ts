/*
 * Symbol name helpers. A symbol's identity is its full name
 * "EXCHANGE:TICKER" (charts, watchlists, drawings, alerts, live events), so a
 * provider listing one ticker on two exchanges can serve both.
 */
import { defaultExchange } from "./providers";

/** "EXCHANGE:TICKER" → its parts; bare tickers default to the active
 *  provider's default exchange. */
export function splitSymbol(symbol: string): { exchange: string; ticker: string } {
  const head = symbol.split(",")[0].trim();
  if (head.includes(":")) {
    const [exchange, ticker] = head.split(":");
    return { exchange, ticker };
  }
  return { exchange: defaultExchange(), ticker: head };
}

/** True for a full name ("NASDAQ:AAPL"). */
export function isFullSymbol(symbol: string): boolean {
  return symbol.includes(":");
}

/** Ticker part of a symbol ("NASDAQ:AAPL" → "AAPL"; a bare ticker as is). */
export function tickerOf(symbol: string): string {
  return splitSymbol(symbol).ticker;
}
