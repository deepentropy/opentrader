/*
 * Market state of a symbol from its own sessions (./session): regular session
 * "open", "pre" / "post" market, else "closed" (overnight, weekend, holiday).
 * One source for the watchlist status dot + Ext column, the Details market
 * state, the chart legend status and the chart's pre/post-market price label.
 */
import { cachedSymbolSessions, type MarketSession } from "./session";

export type { MarketSession } from "./session";

/** Market state of `symbol` at `now`, or null until its sessions resolve.
 *  Reactive: re-reads once the session arrives (sessionsVersion). */
export function marketSession(symbol: string, now: Date = new Date()): MarketSession | null {
  return cachedSymbolSessions(symbol)?.status(now.getTime() / 1000) ?? null;
}
