/*
 * Symbol name helpers shared by the datafeed and the session store.
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
