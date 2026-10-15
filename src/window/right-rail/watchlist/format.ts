/*
 * Watchlist cell text with no panel state: price / change / percent / volume
 * formats, the stored display strings parsed back to numbers, and the market
 * state of a symbol's own session.
 */
import { marketSession } from "../../../data/market-session";

export function isNegative(v: string): boolean {
  return v.startsWith("−") || v.startsWith("-");
}
export function formatLast(price: number): string {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** Signed change, 2 decimals, Unicode minus (e.g. "0.76", "−3.04"). */
export function fmtChange(v: number): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
}
/** Signed percent with Unicode minus (e.g. "6.92%", "−3.07%"). */
export function fmtPercent(v: number): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
}
/** Compact volume with a K/M/B suffix, trailing zeros trimmed (e.g. "11.95 M",
 *  "4 M", "577.2 K"). */
export function fmtVolume(v: number): string {
  const abs = Math.abs(v);
  const [div, suffix] =
    abs >= 1e9 ? [1e9, " B"] : abs >= 1e6 ? [1e6, " M"] : abs >= 1e3 ? [1e3, " K"] : [1, ""];
  return parseFloat((v / div).toFixed(2)).toString() + suffix;
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
