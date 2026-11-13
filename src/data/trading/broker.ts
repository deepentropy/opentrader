/*
 * The broker the trading UI talks to: the replay broker on a chart in Bar Replay (paper trading), else the broker
 * plugin the user connected (#315). The order ticket, the DOM and the toasts follow the focused chart; the chart
 * trading lines ask for their own chart (`paneId`).
 */
import { isPaneInReplay, replayActivePane, replayEnabled, setReplayActivePane } from "../replay";
import { strategyTester } from "../strategy-tester-store";
import { pluginBroker } from "./plugin-broker";
import { replayBroker } from "./replay-broker";
import type { OrderRequest, TradingEvent } from "./types";

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

/** The current broker, read through: every call goes to `brokerOf` its chart. */
export const broker = {
  version: () => replayBroker.version() + pluginBroker.version(),
  activePane: () => brokerOf().activePane(),
  tradability: () => brokerOf().tradability(),
  symbol: () => brokerOf().symbol(),
  description: (symbol: string) => brokerOf().description(symbol),
  iconUrl: (symbol: string) => brokerOf().iconUrl(symbol),
  isStock: (symbol: string) => brokerOf().isStock(symbol),
  quote: () => brokerOf().quote(),
  currency: (paneId?: number | null) => brokerOf(paneId).currency(paneId ?? undefined),
  /** The account's cash: the replay account's capital and net profit, or the broker's balance. */
  balance: () => brokerOf().balance(),
  position: (paneId: number) => brokerOf(paneId).position(paneId),
  orders: (paneId: number) => brokerOf(paneId).orders(paneId),
  executions: (paneId: number) => brokerOf(paneId).executions(paneId),
  place: (req: OrderRequest) => brokerOf().place(req),
  modify: (id: string, req: OrderRequest, paneId?: number) => brokerOf(paneId).modify(id, req, paneId),
  cancel: (id: string, paneId?: number) => brokerOf(paneId).cancel(id, paneId),
  closePosition: (qty: number | null = null, paneId?: number) => brokerOf(paneId).closePosition(qty, paneId),
  reverse: (paneId?: number) => brokerOf(paneId).reverse(paneId),
  setPositionBrackets: (tp: number | null, sl: number | null, paneId?: number) => brokerOf(paneId).setPositionBrackets(tp, sl, paneId),
  onEvent(fn: (e: TradingEvent) => void): () => void {
    const offReplay = replayBroker.onEvent(fn);
    const offPlugin = pluginBroker.onEvent(fn);
    return () => {
      offReplay();
      offPlugin();
    };
  },
};
