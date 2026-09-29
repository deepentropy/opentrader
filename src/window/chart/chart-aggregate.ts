/*
 * Client-side daily → weekly / monthly aggregation (Feature 8c).
 *
 * The bottom-bar 5Y / All tabs map to the 1W / 1M intervals. The Rust
 * backend only serves daily + minute aggregates, so weekly / monthly
 * candles are built here by bucketing the daily series. OHLC reduce:
 * open = first bar's open, high = max, low = min, close = last bar's
 * close, volume = sum.
 *
 * Bucketing is done in UTC to match the daily candles' timestamps:
 *   • week  → the Monday 00:00 UTC of the bar's week (ISO week start).
 *   • month → the 1st 00:00 UTC of the bar's month.
 * The bucket-start timestamp becomes the aggregated candle's `time`,
 * which lightweight-charts renders as a date (no intraday precision).
 */
import type { Candle } from "../../bindings";

export type AggregateUnit = "week" | "month";

/** Bucket-start (UNIX seconds, UTC) for the period containing `sec`.
 *  Exported so the live-tick path (datafeed bucketLiveTick) lands its
 *  weekly/monthly updates on exactly the keys this module aggregates to. */
export function bucketStart(sec: number, unit: AggregateUnit): number {
  const d = new Date(sec * 1000);
  if (unit === "month") {
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }
  // Week — back up to Monday. getUTCDay(): 0=Sun … 6=Sat.
  const dow = d.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor(midnight / 1000) - daysSinceMonday * 86400;
}

/**
 * Aggregate a sorted-ascending daily candle series into weekly / monthly
 * buckets. Candles with any null OHLC field are skipped. Input is assumed
 * time-ordered (the backend returns sorted); a defensive sort is applied
 * regardless so out-of-order ticks don't corrupt the reduce.
 */
export function aggregateCandles(daily: Candle[], unit: AggregateUnit): Candle[] {
  const clean = daily
    .filter(
      (c) =>
        c.time != null &&
        c.open != null &&
        c.high != null &&
        c.low != null &&
        c.close != null,
    )
    .sort((a, b) => (a.time as number) - (b.time as number));

  const out: Candle[] = [];
  let curKey = Number.NaN;
  let cur: Candle | null = null;

  for (const c of clean) {
    const key = bucketStart(c.time as number, unit);
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = {
        time: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      };
      curKey = key;
    } else if (cur) {
      cur.high = Math.max(cur.high as number, c.high as number);
      cur.low = Math.min(cur.low as number, c.low as number);
      cur.close = c.close;
      cur.volume = (cur.volume ?? 0) + (c.volume ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}
