/*
 * Values of the watchlist's columns read from the screener's market table: "Rel Vol" (today's volume / the average
 * of the last 10 sessions, the screener's "Rel vol") and the metric columns added from "Add column" (ADR %, average
 * volume, P/E...). The table loads every 10 s only while a watchlist shows such a column; each update reads the shown
 * list's tickers, all fields in one scan. A symbol the table does not hold (futures, forex, crypto, a plugin's or a
 * CSV series) has no value.
 */
import { createEffect, onCleanup, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { onScreenerUpdate, screenerClose, screenerOpen, screenerScan } from "./screener-api";

const OWNER = "watchlist:metrics";
/** Field of "Rel Vol". */
export const RVOL_FIELD = "relative_volume_10d_calc";
/** Field of a row's currency (the unit of its prices and amounts). */
const CURRENCY_FIELD = "currency";
const bare = (s: string) => (s.split(":").pop() ?? s).toUpperCase();

type Value = number | string;
/** field -> ticker -> value. */
const [values, setValues] = createStore<Record<string, Record<string, Value>>>({});

/** A field's value for a symbol ("NASDAQ:AAPL" or "AAPL"); undefined until (or unless) the table has it. Reactive. */
export function metricValueOf(field: string, symbol: string): Value | undefined {
  return values[field]?.[bare(symbol)];
}

/** Relative volume of a symbol; undefined until the table has it. Reactive. */
export function relativeVolumeOf(symbol: string): number | undefined {
  const v = metricValueOf(RVOL_FIELD, symbol);
  return typeof v === "number" ? v : undefined;
}

/** Currency of a symbol's prices in the table (null when unknown). Reactive. */
export function metricCurrencyOf(symbol: string): string | null {
  const v = metricValueOf(CURRENCY_FIELD, symbol);
  return typeof v === "string" ? v : null;
}

/** Keep `fields` of `symbols` loaded while any field is asked for (call in a component: stops with it). */
export function useWatchlistMetrics(symbols: () => string[], fields: () => string[]): void {
  let open = false;
  let off: (() => void) | null = null;
  const read = async () => {
    const tickers = [...new Set(untrack(symbols).map(bare))];
    const wanted = untrack(fields);
    if (!open || !tickers.length || !wanted.length) return;
    const columns = [...new Set([...wanted, CURRENCY_FIELD])];
    const res = await screenerScan({ columns, filter: [], sort: null, range: [0, tickers.length], tickers });
    const next: Record<string, Record<string, Value>> = Object.fromEntries(columns.map((f) => [f, {}]));
    for (const r of res.rows) {
      columns.forEach((f, i) => {
        const v = r.d[i];
        if (typeof v === "number" || (typeof v === "string" && v)) next[f][r.s.toUpperCase()] = v;
      });
    }
    setValues(reconcile(next));
  };
  const close = () => {
    open = false;
    off?.();
    off = null;
    void screenerClose(OWNER).catch(() => {});
  };
  createEffect(() => {
    const on = fields().length > 0;
    if (on && !open) {
      open = true;
      void screenerOpen(OWNER)
        .then(read)
        .catch((e) => console.warn("[watchlist] metrics", e));
      void onScreenerUpdate((u) => {
        if (!u.error) void read().catch(() => {});
      }).then((f) => (open && !off ? (off = f) : f()));
    } else if (!on && open) {
      close();
    }
  });
  // Another list, symbols added or a column added: read them at once, not at the next update.
  createEffect(() => {
    symbols();
    if (fields().length) void read().catch(() => {});
  });
  onCleanup(() => {
    if (open) close();
  });
}
