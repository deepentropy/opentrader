/*
 * Datafeed live-tick subscription helpers — Feature 9.
 *
 * Thin typed wrappers over the Tauri invoke + event APIs. Vendor-neutral: the
 * backend's active provider owns the live transport (REST poll vs WebSocket) and
 * emits these events. Intentionally hand-written (parallel to bindings.ts) so
 * the frontend can wire to the Rust live task before `bindings.ts` regenerates
 * on the next debug-build run. Once tauri-specta regenerates, these wrappers
 * remain valid — they just duplicate names the generator also produces.
 *
 * Event-name convention (`tauri_specta::Event`): struct name → kebab-case
 *   ChartAggregate  → "chart-aggregate"
 *   SecondAggregate → "second-aggregate"
 *   TradeTick       → "trade-tick"
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ChartAggregate = {
  symbol: string;
  /** Bar start, UNIX seconds — matches lightweight-charts UTCTimestamp. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Today's full-session daily bar, when the transport knows it (the REST
   *  snapshot poller does). Its `time` is the snapshot's update stamp, NOT a
   *  bar boundary — the datafeed re-buckets it (see bucketLiveTick). */
  day?: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null;
};

/** One 1-second bar from the stream (Massive `A` channel) for a charted
 *  symbol. Emitted only when the key is entitled to second bars and a chart
 *  is open; its volume covers that one second. */
export type SecondAggregate = {
  symbol: string;
  /** Bar start, UNIX seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type TradeTick = {
  symbol: string;
  /** Regular-session "Last" (not the latest pre/post trade). */
  price: number;
  /** Regular-session change / change% / volume from the REST snapshot poller.
   *  Null on the WS push path (a raw trade has none) — consumers keep the prior
   *  value. */
  change: number | null;
  changePercent: number | null;
  /** Pre/post-market move vs the regular close — the watchlist "Ext" column. */
  extChangePercent: number | null;
  volume: number | null;
  /** "live" (today's session traded) or "prev". Null on the WS path. */
  source: "live" | "prev" | null;
};

/** Declare one pane's charted-symbol subscription. Pass `null` to clear that
 *  pane's slot. `pane` scopes the slot within this window (the backend keys
 *  it "<window>:<pane>"), so multi-pane layouts each hold their own symbol
 *  instead of overwriting a single global slot. */
export async function setChartSubscription(symbol: string | null, pane = "0"): Promise<void> {
  await invoke("set_chart_subscription", { pane, symbol });
}

/** Replace THIS WINDOW's watchlist subscription with this exact set. Several
 *  features contribute symbols to the channel (watchlist rows, alert rules,
 *  tab titles — see data/subscriptions.ts); the backend merges the per-window
 *  sets, so another window's union can't clobber this one. */
export async function setWatchlistSubscription(symbols: string[]): Promise<void> {
  await invoke("set_watchlist_subscription", { symbols });
}

export function onChartAggregate(
  fn: (ev: ChartAggregate) => void,
): Promise<UnlistenFn> {
  return listen<ChartAggregate>("chart-aggregate", (e) => fn(e.payload));
}

export function onSecondAggregate(
  fn: (ev: SecondAggregate) => void,
): Promise<UnlistenFn> {
  return listen<SecondAggregate>("second-aggregate", (e) => fn(e.payload));
}

export function onTradeTick(fn: (ev: TradeTick) => void): Promise<UnlistenFn> {
  return listen<TradeTick>("trade-tick", (e) => fn(e.payload));
}
