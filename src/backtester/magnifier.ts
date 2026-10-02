/**
 * Bar magnifier ("Bar detalization: High", Pine use_bar_magnifier): the lower timeframe whose bars drive the
 * fills on historical chart bars, and the tick count the Properties tab shows.
 *
 * Lower timeframe per chart interval, matched on the reference app's reports with the same strategies run on the
 * candidate lower timeframes (.tmp/strategy-properties): 1 -> 10S, 5 -> 30S, 10 -> 1, 15 -> 2, 30 -> 5,
 * 60 and 120 -> 10, 240 -> 30, 1D -> 60, 3D -> 240, 1W and 1M -> 1D. The other intervals follow the range of the
 * reference app's tick-count table they belong to (2-4 minutes -> 10S, 45 minutes -> 5...); 30S-58S -> 5S.
 * No lower timeframe below 30 seconds (the "High" tick count is 4 there, as "Default").
 */

/** Interval id parts: "5" (minutes), "30S", "1D", "1W", "1M", "100T" (ticks), "1R" (range). */
function parse(interval: string): { n: number; unit: string } | null {
  const m = /^(\d*)([SDWMTR]?)$/i.exec(interval.trim());
  if (!m) return null;
  return { n: Number(m[1] || 1), unit: m[2].toUpperCase() };
}

/** "High" detalization ticks per bar shown in the Properties tab (the reference app's table, by chart interval). */
export function detalizationTicks(interval: string): number {
  const p = parse(interval);
  if (!p) return 0;
  const { n, unit } = p;
  if (unit === 'R') return 4;
  if (unit === 'T') {
    if (n < 100) return 4;
    if (n <= 1000) return 40;
  }
  if (unit === 'S') {
    if (n < 30) return 4;
    if (n < 59) return 24;
  }
  if (unit === '') {
    if (n < 5) return 24;
    if (n < 15) return 40;
    if (n < 30) return 28;
    if (n < 240) return 24;
    if (n < 1440) return 32;
  }
  if (unit === 'D') {
    if (n < 3) return 96;
    if (n < 7) return 72;
  }
  return 28;
}

/** Lower-timeframe interval id of the bar magnifier for a chart interval; null when there is none. */
export function magnifierInterval(interval: string): string | null {
  const p = parse(interval);
  if (!p) return null;
  const { n, unit } = p;
  switch (unit) {
    case 'S':
      return n >= 30 && n < 59 ? '5S' : null;
    case '':
      if (n < 5) return '10S';
      if (n < 10) return '30S';
      if (n < 15) return '1';
      if (n < 30) return '2';
      if (n < 60) return '5';
      if (n < 240) return '10';
      if (n < 1440) return '30';
      return null;
    case 'D':
      return n < 3 ? '60' : n < 7 ? '240' : '1D';
    case 'W':
    case 'M':
      return '1D';
    default:
      return null;
  }
}

/** Seconds of a lower-timeframe interval id ("10S", "2", "60", "1D"). */
export function intervalSeconds(interval: string): number {
  const p = parse(interval);
  if (!p) return 0;
  const { n, unit } = p;
  return unit === 'S' ? n : unit === '' ? n * 60 : unit === 'D' ? n * 86400 : unit === 'W' ? n * 7 * 86400 : 0;
}
