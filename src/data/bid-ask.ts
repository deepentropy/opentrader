/*
 * The best bid and ask of the charted symbols: the chart's "Bid and ask" lines and labels. They come with live data
 * only (a real-time session's quotes and snapshots, a data plugin's quotes): delayed data has none, so the lines
 * leave when real-time data ends.
 */
import { createStore, produce } from "solid-js/store";
import { events } from "../bindings";
import { onChartQuote } from "./datafeed-live";

export type BidAsk = { time: number; bid: number | null; ask: number | null };

const [quotes, setQuotes] = createStore<Record<string, BidAsk>>({});

/** A quote into the store: an older one than the kept one (a snapshot behind the stream) does not replace it. */
export function takeQuote(symbol: string, q: BidAsk): void {
  const key = symbol.toUpperCase();
  const kept = quotes[key];
  if (kept && q.time > 0 && kept.time > q.time) return;
  setQuotes(key, { time: q.time, bid: q.bid ?? kept?.bid ?? null, ask: q.ask ?? kept?.ask ?? null });
}

let started = false;
function start(): void {
  if (started || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  started = true;
  void onChartQuote((q) => takeQuote(q.symbol, { time: q.time ?? 0, bid: q.bid, ask: q.ask }));
  // Real-time data ended: no bid and ask any more.
  void events.marketTier.listen((e) => {
    if (e.payload.tier !== "realtime") setQuotes(produce((s) => { for (const k of Object.keys(s)) delete s[k]; }));
  });
}

/** The bid and ask of `symbol` (reactive); undefined until a quote came. */
export function bidAskFor(symbol: string | null | undefined): BidAsk | undefined {
  start();
  return symbol ? quotes[symbol.toUpperCase()] : undefined;
}
