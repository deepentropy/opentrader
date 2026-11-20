/*
 * Order moves shared by the chart trading lines and the DOM ladder: a line
 * (or ladder mark) of an order dragged to a new price.
 */
import { broker, brokerOf } from "../../data/trading/broker";
import { ORDER_LABEL, type TradingOrder } from "../../data/trading/types";
import { orderPriceError } from "../../data/trading/price-rules";
import { requestWithPrice } from "../chart/trading-lines-model";
import { quotePrice } from "./ticket";

/** Move order `o` of chart `paneId` to `price`: its stop or limit (`limit`:
 *  the limit of a stop-limit); a bracket moves its order's or the
 *  position's take profit / stop loss. An order price the tick or the market
 *  refuses (#370) is not sent: a rejection toast says why, and false is
 *  returned. */
export function moveOrder(o: TradingOrder, price: number, limit: boolean, paneId: number, tick: number): boolean {
  if (o.kind === "order") {
    // The limit line, or the line of a stop-limit whose stop was reached: the limit price.
    const asLimit = limit || (o.type === "stopLimit" && o.stopTriggered);
    const field = asLimit || o.type === "limit" ? "limit" : "stop";
    // The market of the order's symbol: the broker's quote when it is the focused chart's.
    const q = brokerOf(paneId).quote();
    const market = q && q.symbol.toUpperCase() === o.symbol.toUpperCase() ? quotePrice(q, o.side) : null;
    const bad = orderPriceError({ type: o.type, side: o.side, field, price }, market, tick, broker.capabilities(paneId));
    if (bad) {
      broker.refuse({ label: ORDER_LABEL[o.type], symbol: o.symbol, side: o.side, qty: o.qty, price, message: bad });
      return false;
    }
    broker.modify(o.id, asLimit ? requestWithPrice(o, null, { limitPrice: price }) : requestWithPrice(o, price), paneId);
    return true;
  }
  const pos = broker.position(paneId);
  if (o.parentId === "position" && pos) {
    broker.setPositionBrackets(o.kind === "tp" ? price : pos.takeProfit, o.kind === "sl" ? price : pos.stopLoss, paneId);
    return true;
  }
  const parent = o.parentId ? broker.orders(paneId).find((x) => x.id === o.parentId) : undefined;
  if (!parent) return false;
  broker.modify(parent.id, requestWithPrice(parent, null, o.kind === "tp" ? { takeProfit: price } : { stopLoss: price }), paneId);
  return true;
}
