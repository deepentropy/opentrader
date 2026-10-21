/*
 * Broker-neutral trading types: what the order ticket, the toasts, the chart
 * trading lines and the dialogs read from a broker. The replay broker (paper
 * trading in Bar Replay) is the one broker on this build.
 */

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stopLimit";

/** A working order. Brackets of an order (take profit / stop loss) are their
 *  own orders with `parentId` set. */
export type TradingOrder = {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  /** "order": a placed order; "tp" / "sl": a bracket of an order or of the
   *  position (`parentId` = the order id, or the position id). */
  kind: "order" | "tp" | "sl";
  parentId: string | null;
  /** The brackets an order carries until it fills. */
  takeProfit: number | null;
  stopLoss: number | null;
};

export type TradingPosition = {
  id: string;
  symbol: string;
  side: Side;
  /** Absolute quantity. */
  qty: number;
  avgPrice: number;
  /** Unrealized profit at the last price, account currency. */
  pl: number;
  takeProfit: number | null;
  stopLoss: number | null;
};

export type TradingExecution = {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  /** UNIX seconds. */
  time: number;
};

export type TradingQuote = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  minTick: number;
};

/** What the order ticket sends. */
export type OrderRequest = {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
};

/** Order notifications (toasts). `label`: "Market", "Limit", "Stop",
 *  "Stop Limit", "Take Profit", "Stop Loss". */
export type TradingEvent = {
  kind: "placed" | "executed" | "modified" | "cancelled" | "rejected";
  label: string;
  symbol: string;
  side: Side;
  qty: number;
  /** The order price (none for a market order). */
  price: number | null;
  message?: string;
};

export const ORDER_LABEL: Record<OrderType, string> = {
  market: "Market",
  limit: "Limit",
  stop: "Stop",
  stopLimit: "Stop Limit",
};
