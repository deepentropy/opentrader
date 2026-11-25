/*
 * Datafeed live-tick subscriptions — Feature 9.
 *
 * The generated commands and events, plus what they don't do: imported series
 * have no live data, so they never reach the backend's subscription slots.
 * Vendor-neutral: the backend's active provider owns the live transport (REST
 * poll vs WebSocket) and emits these events.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { commands, events, type Candle, type PluginTicks } from "../bindings";
import type * as gen from "../bindings";
import { unwrap, type Finite } from "./datafeed-rest";
import { isLocalSymbol } from "./local-series";

type BarField = "time" | "open" | "high" | "low" | "close" | "volume";

/** One minute bar of a charted symbol; `time` is the bar start, UNIX seconds.
 *  `day` is today's full-session daily bar when the transport knows it: its
 *  `time` is the snapshot's update stamp, not a bar boundary (the datafeed
 *  re-buckets it, see bucketLiveTick). */
export type ChartAggregate = Finite<Omit<gen.ChartAggregate, "day">, BarField> & {
  day: Finite<Candle, BarField> | null;
};
/** One 1-second bar of a charted symbol. */
export type SecondAggregate = Finite<gen.SecondAggregate, BarField>;
/** The trades of a charted symbol over a tenth of a second (a subscriber's); `time` UNIX seconds. */
export type ChartTrade = Finite<gen.ChartTrade, "time" | "price" | "high" | "low" | "volume">;
/** A quote update; `source` is "live" (today's session traded) or "prev", null
 *  on the stream push path. */
export type TradeTick = Omit<Finite<gen.TradeTick, "price">, "source"> & { source: "live" | "prev" | null };

/** Declare one pane's charted-symbol subscription. Pass `null` to clear that
 *  pane's slot. `pane` scopes the slot within this window (the backend keys
 *  it "<window>:<pane>"), so multi-pane layouts each hold their own symbol
 *  instead of overwriting a single global slot. */
export async function setChartSubscription(symbol: string | null, pane = "0"): Promise<void> {
  // An imported series has no live data.
  await unwrap(commands.setChartSubscription(pane, isLocalSymbol(symbol) ? null : symbol));
}

/** Replace THIS WINDOW's watchlist subscription with this exact set. Several
 *  features contribute symbols to the channel (watchlist rows, alert rules,
 *  tab titles — see data/subscriptions.ts); the backend merges the per-window
 *  sets, so another window's union can't clobber this one. */
export async function setWatchlistSubscription(symbols: string[]): Promise<void> {
  await unwrap(commands.setWatchlistSubscription(symbols.filter((s) => !isLocalSymbol(s))));
}

export function onChartAggregate(fn: (ev: ChartAggregate) => void): Promise<UnlistenFn> {
  return events.chartAggregate.listen((e) => fn(e.payload as ChartAggregate));
}

export function onSecondAggregate(fn: (ev: SecondAggregate) => void): Promise<UnlistenFn> {
  return events.secondAggregate.listen((e) => fn(e.payload as SecondAggregate));
}

export function onChartTrade(fn: (ev: ChartTrade) => void): Promise<UnlistenFn> {
  return events.chartTrade.listen((e) => fn(e.payload as ChartTrade));
}

/** The live ticks of the data plugins' symbols on a tick chart (#376). */
export function onPluginTicks(fn: (ev: PluginTicks) => void): Promise<UnlistenFn> {
  return events.pluginTicks.listen((e) => fn(e.payload));
}

/** A pane shows `symbol` on a tick interval (null: no tick chart): its data plugin streams its ticks. */
export async function setTickSubscription(symbol: string | null, pane: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  await commands.pluginWatchTicks(pane, isLocalSymbol(symbol) ? null : symbol);
}

export function onTradeTick(fn: (ev: TradeTick) => void): Promise<UnlistenFn> {
  return events.tradeTick.listen((e) => fn(e.payload as TradeTick));
}
