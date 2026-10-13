/**
 * Exact decimal arithmetic on the shortest decimal form of numbers (the digits JavaScript prints for them), for the
 * funds checks that the reference app makes in decimals: 565,153 x 0.41000000000000003 (the price 41 x 0.01) is
 * 231,712.73000000001695459, above an equity of 231,712.73.
 */

/** `x` as an integer and a power-of-ten scale: 0.41000000000000003 -> [41000000000000003n, 17]. */
function decimal(x: number): [bigint, number] {
  if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`);
  const [mantissa, exp] = String(x).toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [int, frac = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  let digits = BigInt(int + frac);
  let scale = frac.length - Number(exp ?? 0);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return [negative ? -digits : digits, scale];
}

/** Sum of the exact products of each term's factors, as an integer and a power-of-ten scale. */
function sumOfProducts(terms: number[][]): [bigint, number] {
  const products = terms.map((factors) =>
    factors.reduce<[bigint, number]>(
      ([v, s], f) => {
        const [d, k] = decimal(f);
        return [v * d, s + k];
      },
      [1n, 0],
    ),
  );
  const scale = Math.max(0, ...products.map(([, s]) => s));
  return [products.reduce((sum, [v, s]) => sum + v * 10n ** BigInt(scale - s), 0n), scale];
}

/** True when the sum of the exact products of `terms` (each a list of factors) is at most `limit`, exactly. */
export function decimalSumAtMost(terms: number[][], limit: number): boolean {
  const [sum, scale] = sumOfProducts(terms);
  const [l, ls] = decimal(limit);
  const s = Math.max(scale, ls);
  return sum * 10n ** BigInt(s - scale) <= l * 10n ** BigInt(s - ls);
}
