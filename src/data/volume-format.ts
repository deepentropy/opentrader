/*
 * Abbreviated numbers with a K / M / B / T letter, the reference app's volume
 * formatter: screener volume and money cells, the Strategy Tester capital pill
 * and trade sizes ("9.07 M", "810 K", "1.5 T").
 *
 * Rule: a number with at most 3 integer digits is rounded to `precision`
 * decimals and shown without a letter. A larger one is rounded to 2 decimals
 * of its unit FIRST, then the unit is chosen again from the rounded value
 * (999,999 → "1 M", not "1000 K"). Trailing zeros are trimmed, thousands
 * are grouped ("1,000 T"), a narrow no-break space precedes the letter and a
 * negative number takes the minus sign U+2212.
 */
const MINUS = "−";
const NNBSP = " ";
const UNITS: readonly { exp: number; letter: string }[] = [
  { exp: 3, letter: "K" },
  { exp: 6, letter: "M" },
  { exp: 9, letter: "B" },
  { exp: 12, letter: "T" },
];

const numerics = new Map<number, Intl.NumberFormat>();
function numeric(decimals: number): Intl.NumberFormat {
  let f = numerics.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
    numerics.set(decimals, f);
  }
  return f;
}

/** Integer digits of a non-negative number (0 for values under 1). */
const integerDigits = (v: number) => (v > 0 ? Math.floor(Math.log10(v)) + 1 : 0);

/** The unit for a number with `digits` integer digits: the first one whose
 *  exponent leaves at most 3 integer digits, else T. */
const unitFor = (digits: number) => UNITS.find((u) => u.exp >= digits - 3) ?? UNITS[UNITS.length - 1];

/** `precision`: decimals of a number shown without a letter (screener cells
 *  0, Strategy Tester 2). */
export function volumeFormat(value: number, precision = 0): string {
  let v = value;
  if (Math.abs(v) < 1) v = +v.toFixed(precision);
  const sign = v < 0 ? MINUS : "";
  v = Math.abs(v);
  let digits = integerDigits(v);
  if (digits <= 3) {
    v = +v.toFixed(precision);
    digits = integerDigits(v);
  }
  if (digits <= 3) return sign + numeric(precision).format(v);
  let unit = unitFor(digits);
  v = +(v / 10 ** unit.exp).toFixed(2) * 10 ** unit.exp;
  unit = unitFor(integerDigits(v));
  return sign + numeric(2).format(v / 10 ** unit.exp) + NNBSP + unit.letter;
}
