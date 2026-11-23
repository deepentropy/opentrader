/*
 * The broker the trading UI talks to: the replay broker on a chart in Bar Replay (paper trading), else the broker
 * plugin the user connected (#315). The order ticket, the DOM and the toasts follow the focused chart; the chart
 * trading lines ask for their own chart (`paneId`).
 */
import { isPaneInReplay, replayActivePane, replayEnabled, setReplayActivePane } from "../replay";
import { strategyTester } from "../strategy-tester-store";
import { pluginBroker } from "./plugin-broker";
import { replayBroker } from "./replay-broker";
import type { ExitLevel, OrderRequest, TradingEvent } from "./types";

/** The broker of a chart (none given: of the focused one). */
export function brokerOf(paneId?: number | null) {
  if (paneId != null) return isPaneInReplay(paneId) ? replayBroker : pluginBroker;
  return replayEnabled() && replayActivePane() !== null ? replayBroker : pluginBroker;
}

/** A chart shows trading (its lines, the Buy / Sell buttons): in replay, or traded through the connected broker. */
export const tradesOn = (paneId: number) => isPaneInReplay(paneId) || pluginBroker.trades(paneId);

/** Make a chart the focused one of its broker (its Buy / Sell buttons clicked). */
export function focusPane(paneId: number) {
  if (isPaneInReplay(paneId)) setReplayActivePane(paneId);
  else strategyTester.setActiveChartId(String(paneId));
}

const refusals = new Set<(e: TradingEvent) => void>();

/** The current broker, read through: every call goes to `brokerOf` its chart. */
export const broker = {
  version: () => replayBroker.version() + pluginBroker.version(),
  activePane: () => brokerOf().activePane(),
  tradability: () => brokerOf().tradability(),
  /** What the broker of a chart (none given: of the focused one) supports. */
  capabilities: (paneId?: number | null) => brokerOf(paneId).capabilities(),
  /** How the ticker of a chart (none given: of the focused one) trades: lots, point value, the broker's ticket fields. */
  instrument: (paneId?: number | null) => brokerOf(paneId).instrument(paneId),
  symbol: () => brokerOf().symbol(),
  description: (symbol: string) => brokerOf().description(symbol),
  iconUrl: (symbol: string) => brokerOf().iconUrl(symbol),
  isStock: (symbol: string) => brokerOf().isStock(symbol),
  quote: () => brokerOf().quote(),
  /** The focused chart's order book: the connected broker's (`broker.depth`); none in replay, which quotes one price. */
  depth: () => (brokerOf() === pluginBroker ? pluginBroker.depth() : null),
  /** A DOM tab shows the order book (until the returned function is called). */
  watchDepth: () => pluginBroker.watchDepth(),
  currency: (paneId?: number | null) => brokerOf(paneId).currency(paneId ?? undefined),
  /** The account's cash: the replay account's capital and net profit, or the broker's balance. */
  balance: () => brokerOf().balance(),
  /** The account's free margin (the ticket's "Margin used"); null when the broker doesn't say (the replay account
   *  trades without margin). */
  marginFree: () => (brokerOf() === pluginBroker ? pluginBroker.marginFree() : null),
  /** The focused chart's broker previews the order before it is sent (capability `orderPreview`). */
  preview: (req: OrderRequest) => pluginBroker.preview(req),
  position: (paneId: number) => brokerOf(paneId).position(paneId),
  orders: (paneId: number) => brokerOf(paneId).orders(paneId),
  executions: (paneId: number) => brokerOf(paneId).executions(paneId),
  place: (req: OrderRequest) => brokerOf().place(req),
  modify: (id: string, req: OrderRequest, paneId?: number) => brokerOf(paneId).modify(id, req, paneId),
  cancel: (id: string, paneId?: number) => brokerOf(paneId).cancel(id, paneId),
  closePosition: (qty: number | null = null, paneId?: number) => brokerOf(paneId).closePosition(qty, paneId),
  reverse: (paneId?: number) => brokerOf(paneId).reverse(paneId),
  setPositionBrackets: (tp: number | null, sl: number | null, paneId?: number) => brokerOf(paneId).setPositionBrackets(tp, sl, paneId),
  /** The position's exit levels (#330), in place of its take profit / stop loss. */
  setPositionExitLevels: (levels: ExitLevel[], paneId?: number) => brokerOf(paneId).setPositionExitLevels(levels, paneId),
  onEvent(fn: (e: TradingEvent) => void): () => void {
    const offReplay = replayBroker.onEvent(fn);
    const offPlugin = pluginBroker.onEvent(fn);
    refusals.add(fn);
    return () => {
      offReplay();
      offPlugin();
      refusals.delete(fn);
    };
  },
  /** An order the app refused before sending it (a dragged line at a price not valid, #370): the rejection toast. */
  refuse(e: Omit<TradingEvent, "kind">) {
    for (const fn of refusals) fn({ ...e, kind: "rejected" });
  },
};
