/*
 * Watchlist cell text with no panel state: price / change / percent / volume
 * formats, the stored display strings parsed back to numbers, and the market
 * state of a symbol's own session.
 */
import { marketSession } from "../../../data/market-session";
import { cachedSymbolSessions } from "../../../data/session";
import { localNumber } from "../../../i18n/format";
import { groupThousands } from "../../chart/price-format";

export function isNegative(v: string): boolean {
  return v.startsWith("−") || v.startsWith("-");
}

/** A price of `symbol` on its tick grid (`minmov / pricescale`), as the chart's "Default" precision: "1.08646" for a
 *  currency pair quoted to 0.00001, "189.84" for a US stock. 2 decimals until the symbol's session (which carries
 *  the grid) resolves; reactive, so the text follows once it does. English marks, not grouped. */
export function priceText(price: number, symbol?: string): string {
  return (symbol ? cachedSymbolSessions(symbol) : null)?.formatPrice(price) ?? price.toFixed(2);
}
/** Size of a move of `symbol`'s `price` (a change, unsigned), with the decimals of that price's tick: a currency
 *  pair's change keeps its 5 decimals. 2 until the symbol's session resolves. */
export function moveText(move: number, symbol: string | undefined, price: number): string {
  const decimals = (symbol ? cachedSymbolSessions(symbol) : null)?.decimalsAt(price) ?? 2;
  return Math.abs(move).toFixed(decimals);
}

/** Last price on the symbol's tick grid, grouped by thousands (e.g. "1,641.64", "1.08646"). */
export function formatLast(price: number, symbol?: string): string {
  return localNumber(groupThousands(priceText(price, symbol)));
}
/** Signed change, Unicode minus (e.g. "0.76", "−3.04"), with the decimals of the tick of the price `of` moved
 *  (2 without it). */
export function fmtChange(v: number, of?: { symbol: string; price: number }): string {
  return localNumber((v < 0 ? "−" : "") + (of ? moveText(v, of.symbol, of.price) : Math.abs(v).toFixed(2)));
}
/** Signed percent with Unicode minus (e.g. "6.92%", "−3.07%"). */
export function fmtPercent(v: number): string {
  return localNumber((v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%");
}
/** Compact volume with a K/M/B suffix, trailing zeros trimmed (e.g. "11.95 M",
 *  "4 M", "577.2 K"). */
export function fmtVolume(v: number): string {
  const abs = Math.abs(v);
  const [div, suffix] =
    abs >= 1e9 ? [1e9, " B"] : abs >= 1e6 ? [1e6, " M"] : abs >= 1e3 ? [1e3, " K"] : [1, ""];
  return localNumber(parseFloat((v / div).toFixed(2)).toString() + suffix);
}

/** Watchlist view of a symbol's own session: "extended" = pre/post-market
 *  (Ext column + amber status dot), "closed" = grey dot. A symbol whose
 *  session is not resolved yet shows neither (as "regular"). */
export type MarketState = "regular" | "extended" | "closed";
export function marketState(symbol: string, now: Date = new Date()): MarketState {
  const s = marketSession(symbol, now);
  return s === "closed" ? "closed" : s === "pre" || s === "post" ? "extended" : "regular";
}

/** Parse a stored display string ("−3.07%", "1,641.64") to a number. */
export function numFromStr(s?: string): number {
  if (!s) return NaN;
  return parseFloat(s.replace(/−/g, "-").replace(/,/g, "").replace(/[%\s]/g, ""));
}
