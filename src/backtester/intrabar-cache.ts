/*
 * Worker side of the bar magnifier series: a request carries the lower-timeframe bars once per version, later
 * requests only name the series (key, version). Used by the backtest worker and the OakScript worker.
 */
import type { Bar } from './types';
import type { IntrabarsRef } from './worker-types';

/** Bar magnifier series by key (the few charts running with it), latest version only. */
const intrabarCache = new Map<string, { version: number; bars: Bar[] }>();
const INTRABAR_SERIES = 4;

/** The lower-timeframe bars a request names (undefined when none, or the worker no longer has that version). */
export function intrabarsOf(x: IntrabarsRef | undefined): Bar[] | undefined {
  if (!x) return undefined;
  if (x.bars) {
    intrabarCache.delete(x.key);
    intrabarCache.set(x.key, { version: x.version, bars: x.bars });
    while (intrabarCache.size > INTRABAR_SERIES) intrabarCache.delete(intrabarCache.keys().next().value!);
    return x.bars;
  }
  const hit = intrabarCache.get(x.key);
  return hit && hit.version === x.version ? hit.bars : undefined;
}
