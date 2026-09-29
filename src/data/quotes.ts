/*
 * Background live-quote store.
 *
 * Holds the latest per-symbol quote from the live feed (the Massive REST
 * snapshot poller, or a WS push after an upgrade) in a process-singleton
 * solid-store, and keeps the "watchlist" subscription registered for the
 * active list's symbols whether or not the watchlist panel is mounted.
 *
 * Why this lives outside the Watchlist component: the panel unmounts when the
 * rail tab closes (RightRail uses <Show>). Previously the live state, the
 * `trade-tick` listener, and the subscription all lived in the component, so
 * closing the panel cleared the subscription (background updates stopped) and
 * dropped the cached quotes (a refetch flash on reopen). Hoisting them here
 * makes the feed run for the app's lifetime: the panel just reads this store,
 * so reopening shows the current prices instantly and they never stop ticking.
 */
import { createRoot, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { onTradeTick, type TradeTick } from "./datafeed";
import { setSubscription } from "./subscriptions";
import { watchlistStore } from "./watchlist-store";

/** Live per-symbol quote. Fields stay null until a tick carries them, so the
 *  static probe value shows until then. `last`/`change`/`changePercent`/`volume`
 *  are the regular session; `extChangePercent` is the pre/post-market move. */
export type LiveQuote = {
  last: number;
  change: number | null;
  changePercent: number | null;
  extChangePercent: number | null;
  volume: number | null;
  source: "live" | "prev" | null;
};

// Keyed by upper-case symbol. A solid-store so consumers get fine-grained
// reactivity per field (a row only re-renders the cell whose value changed).
const [quotes, setQuotes] = createStore<Record<string, LiveQuote>>({});

/** Reactive read of one symbol's quote (undefined until a tick arrives). */
export function quoteFor(symbol: string): LiveQuote | undefined {
  return quotes[symbol.toUpperCase()];
}

function applyTick(t: TradeTick): void {
  const key = t.symbol.toUpperCase();
  const cur = quotes[key];
  // Null fields (the WS push path carries none) must not clobber a value the
  // poller already supplied — keep the prior value for those.
  setQuotes(key, {
    last: t.price,
    change: t.change ?? cur?.change ?? null,
    changePercent: t.changePercent ?? cur?.changePercent ?? null,
    extChangePercent: t.extChangePercent ?? cur?.extChangePercent ?? null,
    volume: t.volume ?? cur?.volume ?? null,
    source: t.source ?? cur?.source ?? null,
  });
}

// App-lifetime feed: one tick listener and one subscription effect, owned by a
// detached root so they never get torn down with a component.
createRoot(() => {
  // Keep the backend subscribed to the active list's symbols at all times.
  // (The alert engine contributes its own symbols under a separate key — see
  // data/subscriptions.ts for the union coordinator.)
  createEffect(() => {
    const a = watchlistStore.active();
    const rows = a ? [...a.groups.flatMap((g) => g.rows), ...a.extras] : [];
    const symbols = [...new Set(rows.map((r) => r.short.toUpperCase()))];
    setSubscription("watchlist", symbols);
  });

  onTradeTick(applyTick);
});
