/*
 * What a broker supports (#320): the order ticket, the chart trading lines, the DOM and the account manager offer
 * only that. A broker plugin reports it in `broker.state.capabilities`; the replay broker supports everything.
 */
import type { BrokerCapabilities } from "../../bindings";
import type { OrderRequest, OrderType, TradingOrder } from "./types";

export type TradingCapabilities = {
  /** Order types, in the ticket's order. */
  orderTypes: OrderType[];
  /** Take profit / stop loss on a new order. */
  brackets: boolean;
  /** Take profit / stop loss on an open position. */
  positionBrackets: boolean;
  /** Close part of a position. */
  partialClose: boolean;
  /** Modify a working order's price or quantity. */
  modifyOrders: boolean;
};

export const ORDER_TYPES: OrderType[] = ["market", "limit", "stop", "stopLimit"];

export const ALL_CAPABILITIES: TradingCapabilities = {
  orderTypes: ORDER_TYPES,
  brackets: true,
  positionBrackets: true,
  partialClose: true,
  modifyOrders: true,
};

/** A plugin's capabilities; a field it leaves out is supported (as the app reads `broker.state`). */
export function capabilitiesOf(c: BrokerCapabilities | null | undefined): TradingCapabilities {
  if (!c) return ALL_CAPABILITIES;
  const listed = c.orderTypes ? ORDER_TYPES.filter((t) => c.orderTypes!.includes(t)) : ORDER_TYPES;
  return {
    // A broker that lists no order type the app knows would leave the ticket without one: all of them, it refuses.
    orderTypes: listed.length ? listed : ORDER_TYPES,
    brackets: c.brackets ?? true,
    positionBrackets: c.positionBrackets ?? true,
    partialClose: c.partialClose ?? true,
    modifyOrders: c.modifyOrders ?? true,
  };
}

/** The broker takes this order as it is: its type, and its take profit / stop loss. */
export function takesOrder(c: TradingCapabilities, req: Pick<OrderRequest, "type" | "takeProfit" | "stopLoss">): boolean {
  if (!c.orderTypes.includes(req.type)) return false;
  return c.brackets || (req.takeProfit === null && req.stopLoss === null);
}

/** A line (or DOM mark) of `o` may be dragged to a new price, or its bracket cancelled: a working order is modified,
 *  an order's take profit / stop loss is a modify of its order, the position's sets its brackets. */
export function canMove(c: TradingCapabilities, o: TradingOrder): boolean {
  if (o.kind === "order") return c.modifyOrders;
  if (o.parentId === "position") return c.positionBrackets;
  return c.modifyOrders && c.brackets;
}

/** A working order's take profit / stop loss can be added from its line: a modify that sets them. */
export const canAddOrderBrackets = (c: TradingCapabilities) => c.modifyOrders && c.brackets;
