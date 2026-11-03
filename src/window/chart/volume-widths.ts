/*
 * Widths of the Volume Candles chart type. The reference weighs each bar of its time scale by its volume,
 * 1 + log2(max(volume, 0.9 × average) / average), and spaces the bars by that weight: a candle and every column
 * under it (Volume) are as wide as their bar's slot. The bar slots of this chart are all equal, so the widths keep
 * the reference's proportions inside them: the heaviest bar on screen fills its slot, the others take their weight's
 * share of it. The average is over the bars on screen (over the whole history, decades of larger split-adjusted
 * volumes would make every recent candle a sliver).
 */

/** Width factor (0..1] of a bar's volume among the `volumes` of the bars on screen. */
export function volumeWidthFactor(volumes: readonly number[]): (volume: number) => number {
  let sum = 0;
  let n = 0;
  for (const v of volumes) {
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  if (n === 0) return () => 1;
  const average = sum / n;
  const weight = (v: number) => 1 + Math.log2(Math.max(v > 0 ? v : 0, 0.9 * average) / average);
  let max = 0;
  for (const v of volumes) max = Math.max(max, weight(v));
  return (v) => weight(v) / max;
}

/** Half width (px) of a candle body or a column at width factor `k` in a bar slot of `barSpacing` px: the full slot
 *  minus a 1px gap on either side, at least a sliver. */
export function volumeHalfWidth(barSpacing: number, k: number): number {
  return Math.max(0.8, Math.max(1, barSpacing / 2 - 1) * k);
}
