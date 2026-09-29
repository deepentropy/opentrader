/*
 * Year-range + performance stats for the WatchlistDetail panel, computed
 * client-side from the daily candle series (Feature 6a). Avoids a third
 * backend endpoint — the daily aggregates already power the chart.
 *
 * Performance lookbacks are in trading days (TV's convention):
 *   1W=5, 1M=21, 3M=63, 6M=126, 1Y=252. YTD anchors on the first close of
 *   the current calendar year.
 */
import type { Candle } from "../../bindings";

export type Performance = {
  "1W": number | null;
  "1M": number | null;
  "3M": number | null;
  "6M": number | null;
  YTD: number | null;
  "1Y": number | null;
};

export type YearRange = {
  high: number | null;
  low: number | null;
  avgVolume30d: number | null;
  performance: Performance;
};

const LOOKBACKS: Record<Exclude<keyof Performance, "YTD">, number> = {
  "1W": 5,
  "1M": 21,
  "3M": 63,
  "6M": 126,
  "1Y": 252,
};

function pct(last: number, past: number): number | null {
  if (!Number.isFinite(past) || past === 0) return null;
  return (last / past - 1) * 100;
}

export function computeYearRange(daily: Candle[]): YearRange {
  const bars = daily.filter(
    (c) => c.close != null && c.high != null && c.low != null,
  );
  const empty: YearRange = {
    high: null,
    low: null,
    avgVolume30d: null,
    performance: { "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null },
  };
  if (bars.length === 0) return empty;

  const n = bars.length;
  const last = bars[n - 1].close as number;

  let high = -Infinity;
  let low = Infinity;
  for (const b of bars) {
    high = Math.max(high, b.high as number);
    low = Math.min(low, b.low as number);
  }

  // Average volume over the last 30 sessions (or all, if fewer).
  const volWindow = bars.slice(Math.max(0, n - 30));
  const vols = volWindow.map((b) => b.volume ?? 0);
  const avgVolume30d = vols.length
    ? vols.reduce((a, v) => a + v, 0) / vols.length
    : null;

  const performance: Performance = {
    "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null,
  };
  for (const [key, lb] of Object.entries(LOOKBACKS) as [keyof Performance, number][]) {
    if (n > lb) performance[key] = pct(last, bars[n - 1 - lb].close as number);
  }

  // YTD — first session of the current UTC calendar year.
  const lastTime = bars[n - 1].time as number;
  const year = new Date(lastTime * 1000).getUTCFullYear();
  const firstOfYear = bars.find(
    (b) => new Date((b.time as number) * 1000).getUTCFullYear() === year,
  );
  if (firstOfYear) performance.YTD = pct(last, firstOfYear.close as number);

  return { high, low, avgVolume30d, performance };
}
