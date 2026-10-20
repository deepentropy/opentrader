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

/** The chart price format for a Precision choice. `grid` is the symbol's
 *  tick grid (null until its session resolves: 2 decimals). The fractional
 *  choices "1/2" … "1/320" use the fractional format. */
export function chartPriceFormat(precision: string | undefined, grid: SymbolSessions | null, abbreviated = false): ChartPriceFormat | null {
  const p = precision || "Default";
  if (p === "Default") {
    const base = grid ? { format: (v: number) => groupThousands(grid.formatPrice(v)), minMove: grid.mintick } : fixed(2);
    return abbreviated ? { format: (v) => abbreviatedPrice(v, base.format), minMove: base.minMove } : base;
  }
  if (p === "Integer") return fixed(0);
  const m = /^(\d+)\s+decimal/.exec(p);
  if (m) return fixed(+m[1]);
  const f = /^(\d+)\/(\d+)$/.exec(p);
  if (f && +f[1] > 0 && +f[2] > 0) return fractional(+f[2], +f[1]);
  return null;
}

/** Abbreviated value (an economic series): from 1,000 on, at most 2 decimals and K / M / B / T after a space
 *  ("159.04 M", "−34 K"); below, the `small` format. */
export function abbreviatedPrice(v: number, small: (v: number) => string): string {
  const a = Math.abs(v);
  if (!(a >= 1e3)) return small(v);
  const [div, letter] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  return `${v < 0 ? MINUS : ""}${+(a / div).toFixed(2)} ${letter}`;
}

/** Fractional format (the reference price formatter, fractional mode):
 *  `<integer>'<fraction>` with the fraction in steps of minMove/priceScale,
 *  zero-padded to the digit count of priceScale (2/4/8: 1 digit, 16/32/64: 2,
 *  128/320: 3). Halves and quarters are written in tenths ("5"; "2", "5",
 *  "7"). Examples: 1/32 123.5 → "123'16", 1/4 123.25 → "123'2". */
function fractional(priceScale: number, minMove: number): ChartPriceFormat {
  const steps = priceScale / minMove;
  let digits = 1;
  for (let v = priceScale; v > 10; v /= 10) digits++;
  const tenths = priceScale === 2 ? [0, 5] : priceScale === 4 ? [0, 2, 5, 7] : null;
  return {
    minMove: minMove / priceScale,
    format: (price) => {
      const neg = price < 0;
      const a = Math.abs(price);
      let int = Math.floor(a);
      let frac = Math.round(a * steps) - int * steps;
      if (frac >= steps) {
        frac = 0;
        int += 1;
      }
      const shown = (tenths ? tenths[frac] ?? frac : frac) * minMove;
      const text = `${groupThousands(String(int))}'${String(shown).padStart(digits, "0")}`;
      return neg ? MINUS + text : text;
    },
  };
}

function fixed(decimals: number): ChartPriceFormat {
  return { format: (v) => groupThousands(v.toFixed(decimals)), minMove: 1 / 10 ** decimals };
}
