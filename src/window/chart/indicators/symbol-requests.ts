/*
 * The other symbols a script study asked for (`request.security`), given with each of its runs. They belong to the
 * series and the inputs the script asked them on: on another chart symbol or timeframe, or with other inputs, it asks
 * again. Kept, the old symbol's request went on deciding for the new one: `<symbol>_OI` of a symbol without open
 * interest left the study in error on every symbol after it (#411).
 */
import type { Bar } from "oakscriptjs";
import type { SymbolEvents, SymbolInfo } from "oakscriptjs/script";
import type { OtherSymbolData } from "../../../backtester/oakscript";

/** `events`: the dividends, splits and earnings of the symbol (`request.dividends`...), not bars. */
export type SymbolRequest = { symbol: string; timeframe: string; events?: boolean };
/** `list` is replaced, never emptied: a run holds the list of its own scope, and what it reports late stays out of
 *  the next one. */
export type SymbolRequests = { scope: string | null; list: SymbolRequest[] };

export const noRequests = (): SymbolRequests => ({ scope: null, list: [] });

/** The requests of `scope` (series and inputs): none yet when it changed. */
export function enterScope(requests: SymbolRequests, scope: string): void {
  if (requests.scope === scope) return;
  requests.scope = scope;
  requests.list = [];
}

export function addRequests(list: SymbolRequest[], more: SymbolRequest[]): void {
  for (const m of more) {
    if (!list.some((r) => r.symbol === m.symbol && r.timeframe === m.timeframe && !r.events === !m.events)) list.push(m);
  }
}

/** Bars, events and properties of the requested symbols, read through the chart's accessors (the chart loads them,
 *  and keeps them while a study reads them), and their part of the run's staleness key. `symbols` undefined: nothing
 *  requested; null: some are still loading (all of them are asked for). */
export function readRequests(
  list: SymbolRequest[],
  bars: ((symbol: string, timeframe: string) => Bar[] | undefined) | undefined,
  info: ((symbol: string) => SymbolInfo | undefined) | undefined,
  events?: (symbol: string) => SymbolEvents | undefined,
): { symbols: OtherSymbolData | undefined; key: string } | null {
  if (!list.length) return { symbols: undefined, key: "" };
  const symbols: OtherSymbolData = { bars: {}, info: {}, events: {} };
  let key = "";
  let loading = false;
  for (const r of list) {
    if (r.events) {
      const e = events?.(r.symbol);
      if (e === undefined) loading = true;
      else {
        symbols.events![r.symbol] = e;
        key += `|${r.symbol}:events:${JSON.stringify(e)}`;
      }
      continue;
    }
    const b = bars?.(r.symbol, r.timeframe);
    if (b === undefined) {
      loading = true;
      continue;
    }
    symbols.bars[`${r.symbol}|${r.timeframe}`] = b;
    const i = info?.(r.symbol);
    if (i) symbols.info[r.symbol] = i;
    // A symbol with bars whose properties are still loading holds the run (its syminfo.* would not be known).
    else if (b.length && info) loading = true;
    const last = b[b.length - 1];
    key += `|${r.symbol}:${r.timeframe}:${b.length}:${b[0]?.time}:${last?.time}:${last?.close}:${last?.volume}`;
  }
  return loading ? null : { symbols, key };
}

/** The series a study runs on: its chart's symbol, timeframe and session. */
export function seriesOf(chart: { tickerid?: string; timeframe?: string; sessionType?: string } | undefined): string {
  return `${chart?.tickerid ?? ""}|${chart?.timeframe ?? ""}|${chart?.sessionType ?? ""}`;
}

/** An accessor call of a study has its data at hand: not loading, not refused (no bars). */
export function callAnswered(fn: ((...args: unknown[]) => unknown) | undefined, args: unknown[]): boolean {
  let v: unknown;
  try {
    v = fn?.(...args);
  } catch {
    return false;
  }
  return v !== undefined && !(Array.isArray(v) && v.length === 0);
}
