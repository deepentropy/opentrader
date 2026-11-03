/*
 * Values of the watchlist's "Rel Vol" column: the relative volume (today's volume / the average of the last 10
 * sessions) of the screener's market table, the same value as the screener's "Rel vol" column. The table loads
 * every 10 s only while a watchlist shows the column; each update reads the shown list's tickers.
 */
import { createEffect, onCleanup, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { onScreenerUpdate, screenerClose, screenerOpen, screenerScan } from "./screener-api";

const OWNER = "watchlist:rvol";
const bare = (s: string) => (s.split(":").pop() ?? s).toUpperCase();

const [rvol, setRvol] = createStore<Record<string, number>>({});

/** Relative volume of a symbol ("NASDAQ:AAPL" or "AAPL"); undefined until the table has it. Reactive. */
export function relativeVolumeOf(symbol: string): number | undefined {
  return rvol[bare(symbol)];
}

/** Keep the relative volumes of `symbols` loaded while `wanted` holds (call in a component: stops with it). */
export function useRelativeVolumes(symbols: () => string[], wanted: () => boolean): void {
  let open = false;
  let off: (() => void) | null = null;
  const read = async () => {
    const tickers = [...new Set(untrack(symbols).map(bare))];
    if (!open || !tickers.length) return;
    const res = await screenerScan({ columns: ["relative_volume_10d_calc"], filter: [], sort: null, range: [0, tickers.length], tickers });
    const next: Record<string, number> = {};
    for (const r of res.rows) if (typeof r.d[0] === "number") next[r.s.toUpperCase()] = r.d[0];
    setRvol(reconcile(next));
  };
  const close = () => {
    open = false;
    off?.();
    off = null;
    void screenerClose(OWNER).catch(() => {});
  };
  createEffect(() => {
    const on = wanted();
    if (on && !open) {
      open = true;
      void screenerOpen(OWNER)
        .then(read)
        .catch((e) => console.warn("[watchlist] relative volume", e));
      void onScreenerUpdate((u) => {
        if (!u.error) void read().catch(() => {});
      }).then((f) => (open && !off ? (off = f) : f()));
    } else if (!on && open) {
      close();
    }
  });
  // Another list, or symbols added: read them at once, not at the next update.
  createEffect(() => {
    symbols();
    if (untrack(wanted)) void read().catch(() => {});
  });
  onCleanup(() => {
    if (open) close();
  });
}
