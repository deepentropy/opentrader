/*
 * Values of the watchlist's indicator columns (added from "Add column", not in the reference watchlist): an
 * indicator run on each symbol of the shown list on the column's timeframe and read on the newest bar, the script
 * screener's scan (./script-screener). Any symbol with bars has values, futures and plugin symbols too.
 *
 * Columns of the same indicator, inputs and timeframe share one run. A run starts when the list or the columns change,
 * then again once a bar of the timeframe (every 5 minutes for 1 day and above). An intraday run takes the first
 * INTRADAY_MAX_SYMBOLS symbols of the list, as the script screener: each symbol costs a history request per run.
 */
import { createEffect, createMemo, on, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { runScriptScan } from "./script-screener";
import { INTRADAY_MAX_SYMBOLS, intradayMinutes, type ScriptInterval, type ScriptRow } from "./script-screen";
import { getIndicatorEntry, loadIndicatorLibrary } from "../window/chart/indicators/registry";
import { isUserIndicatorId } from "../window/chart/indicators/user-scripts";

/** What a run needs of a column. */
export type ScriptColumnSpec = { key: string; indicatorId: string; inputs: Record<string, unknown>; interval: ScriptInterval; output: string };

/** Daily and longer timeframes run again this often (the session in progress moves). */
const SLOW_REFRESH_MS = 5 * 60_000;
/** A run whose indicator is not there yet (a script not compiled) is tried again this soon. */
const RETRY_MS = 30_000;

/** column key -> symbol -> value (null: computed, none on the newest bar). */
const [values, setValues] = createStore<Record<string, Record<string, number | null>>>({});

/** A column's value for a symbol: undefined while not computed (or not computable), null when the indicator has
 *  none on the newest bar. Reactive. */
export function scriptColumnValueOf(key: string, symbol: string): number | null | undefined {
  return values[key]?.[symbol];
}

/** The indicator of a run, once its library or script is loaded. */
async function entryOf(id: string): Promise<IndicatorRegistryEntry | undefined> {
  if (!isUserIndicatorId(id)) await loadIndicatorLibrary();
  return getIndicatorEntry(id);
}

type Group = { indicatorId: string; inputs: Record<string, unknown>; interval: ScriptInterval; columns: { key: string; output: string }[] };

function groupsOf(columns: readonly ScriptColumnSpec[]): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const c of columns) {
    const id = JSON.stringify([c.indicatorId, c.inputs, c.interval]);
    const g = out.get(id) ?? { indicatorId: c.indicatorId, inputs: c.inputs, interval: c.interval, columns: [] };
    g.columns.push({ key: c.key, output: c.output });
    out.set(id, g);
  }
  return out;
}

/** Keep the values of `columns` for `symbols` computed (call in a component: stops with it). */
export function useScriptColumns(symbols: () => string[], columns: () => ScriptColumnSpec[]): void {
  // Runs restart on a change of the set of symbols or of the columns, not on a re-order of the list.
  const symbolsKey = createMemo(() => [...new Set(symbols())].join("\n"));
  const columnsKey = createMemo(() => JSON.stringify(columns()));
  createEffect(
    on([symbolsKey, columnsKey], ([syms]) => {
      const list = syms ? syms.split("\n") : [];
      if (!list.length) return;
      for (const g of groupsOf(columns()).values()) onCleanup(startRuns(g, list));
    }),
  );
}

/** Run a group now and again on its schedule; returns the stop. */
function startRuns(g: Group, symbols: string[]): () => void {
  let stopped = false;
  let timer: number | undefined;
  const mins = intradayMinutes(g.interval);
  const every = mins !== null ? Math.max(1, mins) * 60_000 : SLOW_REFRESH_MS;
  const list = mins !== null ? symbols.slice(0, INTRADAY_MAX_SYMBOLS) : symbols;
  const later = (ms: number) => {
    if (!stopped) timer = window.setTimeout(run, ms);
  };
  // Rows land in batches (one store write per 100 ms), not one write per symbol.
  let pending: ScriptRow[] = [];
  let flushTimer: number | undefined;
  const flush = () => {
    flushTimer = undefined;
    const rows = pending;
    pending = [];
    if (stopped) return;
    for (const c of g.columns) {
      const next: Record<string, number | null | undefined> = {};
      for (const r of rows) next[r.symbol] = r.error ? undefined : r.cells[c.output]?.value ?? null;
      setValues(c.key, (cur) => ({ ...(cur ?? {}), ...next }) as Record<string, number | null>);
    }
  };
  const run = async () => {
    const entry = await entryOf(g.indicatorId).catch(() => undefined);
    if (stopped) return;
    if (!entry) return later(RETRY_MS);
    try {
      await runScriptScan(
        { entry, inputs: { ...entry.defaultInputs, ...g.inputs }, interval: g.interval, symbols: list },
        {
          wanted: () => !stopped,
          onRow: (row) => {
            pending.push(row);
            flushTimer ??= window.setTimeout(flush, 100);
          },
          onMark: () => {},
        },
      );
    } catch (e) {
      console.warn("[watchlist] indicator column", e);
    } finally {
      window.clearTimeout(flushTimer);
      flush();
      later(every);
    }
  };
  void run();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearTimeout(flushTimer);
  };
}
