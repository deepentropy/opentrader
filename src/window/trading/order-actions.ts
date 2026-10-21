/*
 * Order moves shared by the chart trading lines and the DOM ladder: a line
 * (or ladder mark) of an order dragged to a new price.
 */
import { replayBroker } from "../../data/trading/replay-broker";
import type { TradingOrder } from "../../data/trading/types";
import { requestWithPrice } from "../chart/trading-lines-model";

/** Move order `o` of chart `paneId` to `price`: its stop or limit (`limit`:
 *  the limit of a stop-limit); a bracket moves its order's or the
 *  position's take profit / stop loss. */
export function moveOrder(o: TradingOrder, price: number, limit: boolean, paneId: number) {
  if (o.kind === "order") {
    // The limit line, or the line of a stop-limit whose stop was reached: the limit price.
    const asLimit = limit || (o.type === "stopLimit" && o.stopTriggered);
    replayBroker.modify(o.id, asLimit ? requestWithPrice(o, null, { limitPrice: price }) : requestWithPrice(o, price), paneId);
    return;
  }
  const pos = replayBroker.position(paneId);
  if (o.parentId === "position" && pos) {
    replayBroker.setPositionBrackets(o.kind === "tp" ? price : pos.takeProfit, o.kind === "sl" ? price : pos.stopLoss, paneId);
    return;
  }
  const parent = o.parentId ? replayBroker.orders(paneId).find((x) => x.id === o.parentId) : undefined;
  if (parent) replayBroker.modify(parent.id, requestWithPrice(parent, null, o.kind === "tp" ? { takeProfit: price } : { stopLoss: price }), paneId);
}
