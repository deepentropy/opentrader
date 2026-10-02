/*
 * Lower-timeframe bars for the bar magnifier (main thread). One series per symbol, lower timeframe, session and
 * split adjustment, fetched once through the datafeed and kept in memory: a later run only fetches older bars when
 * its chart history starts before the first request, and the newest bars at most once a minute (live charts).
 * Chart bars the series does not cover keep their OHLC path (the reference app also magnifies "when possible").
 */
import type { Candle } from '../bindings';
import { getBarsBefore, isAdjusted } from '../data/datafeed';
import type { SessionId } from '../data/session';
import { magnifierInterval } from './magnifier';
import type { ChartContext } from 'oakscriptjs/script';
import type { Bar } from './types';
import type { IntrabarsRef } from './worker-types';

export interface Intrabars {
  /** Series key (symbol, lower timeframe, session, adjustment); the worker caches the bars under it. */
  key: string;
  /** Changes when the bars change. */
  version: number;
  /** Lower-timeframe interval id ("10S", "2", "60", "1D"). */
  interval: string;
  bars: Bar[];
}

type Entry = Intrabars & { requestedFrom: number; refreshedAt: number; failedAt: number; pending: Promise<void> | null };

const TAIL_REFRESH_MS = 60_000;
/** A failed fetch is retried after this delay (runs follow every live update). */
const RETRY_MS = 60_000;
const cache = new Map<string, Entry>();
let versions = 0;

function toBars(rows: Candle[]): Bar[] {
  const out: Bar[] = [];
  for (const r of rows) {
    if (r.time == null || r.open == null || r.high == null || r.low == null || r.close == null) continue;
    out.push({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? undefined });
  }
  return out;
}

/** Trading days (the datafeed window unit) between `fromSec` and now, with a margin. */
const spanDays = (fromSec: number) => Math.ceil(((Date.now() / 1000 - fromSec) / 86400) * (252 / 365)) + 5;

/** Merge newer rows into a time-ascending series (newer rows replace the overlapping ones). */
function merge(old: Bar[], newer: Bar[]): Bar[] {
  if (!newer.length) return old;
  const start = newer[0].time;
  let k = old.length;
  while (k > 0 && old[k - 1].time >= start) k--;
  return [...old.slice(0, k), ...newer];
}

/**
 * The lower-timeframe bars covering chart bars from `fromSec` on, for `symbol` charted at `interval`; null when the
 * interval has no magnifier timeframe or the data cannot be fetched (the backtest then uses the OHLC paths).
 */
export async function intrabarsFor(symbol: string, interval: string, session: SessionId, fromSec: number, toSec: number): Promise<Intrabars | null> {
  const ltf = magnifierInterval(interval);
  if (!ltf || !symbol) return null;
  const adjusted = isAdjusted();
  const key = `${symbol}|${ltf}|${session}|${adjusted ? 'adj' : 'raw'}`;
  let entry = cache.get(key);
  try {
    if (entry?.pending) await entry.pending;
    entry = cache.get(key);
    const now = Date.now();
    if ((!entry || fromSec < entry.requestedFrom) && !(entry && now - entry.failedAt < RETRY_MS)) {
      const load = (async () => {
        const rows = toBars(await getBarsBefore(symbol, ltf, Math.ceil(now / 1000) + 86400, session, spanDays(fromSec)));
        cache.set(key, { key, version: ++versions, interval: ltf, bars: rows, requestedFrom: fromSec, refreshedAt: now, failedAt: 0, pending: null });
      })();
      cache.set(key, {
        key,
        version: entry?.version ?? 0,
        interval: ltf,
        bars: entry?.bars ?? [],
        requestedFrom: entry?.requestedFrom ?? Infinity,
        refreshedAt: entry?.refreshedAt ?? 0,
        failedAt: 0,
        pending: load,
      });
      await load;
    } else if (entry && toSec > (entry.bars[entry.bars.length - 1]?.time ?? -Infinity) && now - entry.refreshedAt > TAIL_REFRESH_MS) {
      const e = entry;
      const last = e.bars[e.bars.length - 1]?.time ?? fromSec;
      e.refreshedAt = now;
      e.pending = (async () => {
        const rows = toBars(await getBarsBefore(symbol, ltf, Math.ceil(now / 1000) + 86400, session, spanDays(last) + 1));
        const bars = merge(e.bars, rows.filter((b) => b.time >= last));
        cache.set(key, { ...e, bars, version: bars === e.bars ? e.version : ++versions, pending: null });
      })();
      await e.pending;
    }
  } catch (err) {
    console.warn(`[backtest] bar magnifier data for ${symbol} ${ltf}:`, err);
    const e = cache.get(key);
    if (e) {
      e.pending = null;
      e.failedAt = Date.now();
    }
  }
  const e = cache.get(key);
  return e && e.bars.length ? { key: e.key, version: e.version, interval: e.interval, bars: e.bars } : null;
}

/**
 * The magnifier series reference of a run (undefined without the magnifier, on Heikin Ashi bars or without data).
 * `sent` holds the versions the target worker already has: the bars ride only when the worker lacks that version
 * (the caller records it once posted).
 */
export async function intrabarsRef(
  magnify: boolean,
  heikinAshi: boolean | undefined,
  bars: Bar[],
  chart: ChartContext | undefined,
  sent: Map<string, number>,
): Promise<IntrabarsRef | undefined> {
  if (!magnify || heikinAshi || !bars.length || !chart?.tickerid || !chart.timeframe) return undefined;
  const session = chart.sessionType === 'extended' ? 'ETH' : 'RTH';
  const series = await intrabarsFor(chart.tickerid, chart.timeframe, session, bars[0].time, bars[bars.length - 1].time);
  if (!series) return undefined;
  const ref: IntrabarsRef = { key: series.key, version: series.version, interval: series.interval };
  if (sent.get(series.key) !== series.version) ref.bars = series.bars;
  return ref;
}
