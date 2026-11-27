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
import { isSpreadSymbol, spreadLegs } from "./spread-symbol";

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
/** A data plugin's quote as a trade (#421); `time` UNIX seconds. */
export type PluginTrade = Finite<gen.PluginTrade, "time" | "price" | "volume">;
/** A quote update; `source` is "live" (today's session traded) or "prev", null
 *  on the stream push path. */
export type TradeTick = Omit<Finite<gen.TradeTick, "price">, "source"> & { source: "live" | "prev" | null };

/** Declare one pane's charted-symbol subscription. Pass `null` to clear that
 *  pane's slot. `pane` scopes the slot within this window (the backend keys
 *  it "<window>:<pane>"), so multi-pane layouts each hold their own symbol
 *  instead of overwriting a single global slot. */
export async function setChartSubscription(symbol: string | null, pane = "0"): Promise<void> {
  // A formula streams its legs: the first in the pane's slot, the others in slots of their own ("<pane>~1"…).
  const legs = isSpreadSymbol(symbol) ? spreadLegs(symbol!) : [symbol];
  const had = legSlots.get(pane) ?? 1;
  legSlots.set(pane, legs.length);
  const slot = (k: number) => (k === 0 ? pane : `${pane}~${k}`);
  // An imported series has no live data.
  const live = (s: string | null | undefined) => (s && !isLocalSymbol(s) ? s : null);
  const calls = legs.map((leg, k) => unwrap(commands.setChartSubscription(slot(k), live(leg))));
  for (let k = legs.length; k < had; k++) calls.push(unwrap(commands.setChartSubscription(slot(k), null)));
  await Promise.all(calls);
}

/** How many slots each pane's symbol holds (a formula: one per leg). */
const legSlots = new Map<string, number>();

/** The symbols to stream for these: a formula's legs instead of it, an imported series' none. */
function liveLegs(symbols: string[]): string[] {
  const out = symbols.flatMap((s) => (isSpreadSymbol(s) ? spreadLegs(s) : [s])).filter((s) => !isLocalSymbol(s));
  return [...new Set(out)];
}

/** Replace THIS WINDOW's watchlist subscription with this exact set. Several
 *  features contribute symbols to the channel (watchlist rows, alert rules,
 *  tab titles — see data/subscriptions.ts); the backend merges the per-window
 *  sets, so another window's union can't clobber this one. */
export async function setWatchlistSubscription(symbols: string[]): Promise<void> {
  await unwrap(commands.setWatchlistSubscription(liveLegs(symbols)));
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

/** The live ticks of the symbols on a tick chart: a data plugin's (#376) and, on a real-time session, the app's own. */
export async function onTicks(fn: (ev: PluginTicks) => void): Promise<UnlistenFn> {
  const offs = await Promise.all([events.pluginTicks.listen((e) => fn(e.payload)), events.liveTicks.listen((e) => fn(e.payload))]);
  return () => offs.forEach((off) => off());
}

/** The bid and ask of the charted symbols: the stream's on a real-time session, a data plugin's. */
export function onChartQuote(fn: (ev: gen.ChartQuote) => void): Promise<UnlistenFn> {
  return events.chartQuote.listen((e) => fn(e.payload));
}

/** The quotes of the data plugins' charted symbols as trades: the live source of their seconds bars (#421). */
export function onPluginTrade(fn: (ev: PluginTrade) => void): Promise<UnlistenFn> {
  return events.pluginTrade.listen((e) => fn(e.payload as PluginTrade));
}

/** A pane (or a script's slot) shows `symbol` on a tick interval (null: none): its data plugin, or the app's own
 *  real-time stream, sends its ticks. */
export async function setTickSubscription(symbol: string | null, pane: string): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  // A formula has no trades.
  await unwrap(commands.watchTicks(pane, isLocalSymbol(symbol) || isSpreadSymbol(symbol) ? null : symbol));
}

export function onTradeTick(fn: (ev: TradeTick) => void): Promise<UnlistenFn> {
  return events.tradeTick.listen((e) => fn(e.payload as TradeTick));
}
