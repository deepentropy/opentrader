/*
 * Chart price text, as the reference app's price formatter: the Symbol →
 * Precision choice sets the decimals ("Default" = the symbol's tick grid, see
 * SymbolSessions.formatPrice), the integer part is grouped by thousands with
 * "," and the decimal sign is "." (the English number format), negatives use
 * the "−" sign. One formatter per chart serves the price axis, the crosshair
 * and last-price labels (series priceFormat) and the legend values.
 */
import type { SymbolSessions } from "../../data/session";

const MINUS = "−";

/** "1234567.5" → "1,234,567.5" (sign and decimals untouched). */
export function groupThousands(text: string): string {
  const m = /^(-?)(\d+)(.*)$/.exec(text);
  if (!m) return text;
  const [, sign, int, rest] = m;
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (sign ? MINUS : "") + grouped + rest;
}

export type ChartPriceFormat = {
  format: (price: number) => string;
  /** Smallest price step of the series (price scale rounding). */
  minMove: number;
};

/** The chart price format for a Precision choice, or null when the library's
 *  own format stays (the fractional "1/2" … "1/320" choices). `grid` is the
 *  symbol's tick grid (null until its session resolves: 2 decimals). */
export function chartPriceFormat(precision: string | undefined, grid: SymbolSessions | null): ChartPriceFormat | null {
  const p = precision || "Default";
  if (p === "Default") {
    if (grid) return { format: (v) => groupThousands(grid.formatPrice(v)), minMove: grid.mintick };
    return fixed(2);
  }
  if (p === "Integer") return fixed(0);
  const m = /^(\d+)\s+decimal/.exec(p);
  if (m) return fixed(+m[1]);
  return null;
}

function fixed(decimals: number): ChartPriceFormat {
  return { format: (v) => groupThousands(v.toFixed(decimals)), minMove: 1 / 10 ** decimals };
}
