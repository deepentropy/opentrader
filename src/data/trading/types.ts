/*
 * Broker-neutral trading types: what the order ticket, the toasts, the chart
 * trading lines and the dialogs read from a broker. The replay broker (paper
 * trading in Bar Replay) is the one broker on this build.
 */

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stopLimit";

/** One exit level of an order or a position (#330): a part of its quantity with its own take profit and stop loss.
 *  `id` is the broker's (the level's bracket lines and cancels name it); a request leaves it out. */
export type ExitLevel = { id?: string; qty: number; takeProfit: number | null; stopLoss: number | null };

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
  /** Stop-limit: its stop was reached, only the limit works. */
  stopTriggered?: boolean;
  /** Its exit levels, in place of one take profit / stop loss (#330). */
  exitLevels?: ExitLevel[];
  /** A bracket of an exit level: the level's id. */
  levelId?: string;
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
  /** Its exit levels, in place of one take profit / stop loss (#330). */
  exitLevels?: ExitLevel[];
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
  /** The values picked in the broker's own ticket fields (a product type); left out, the last ones picked. */
  fields?: Record<string, string>;
  /** The time in force picked (a broker duration id); left out, the last one picked or the broker's default. */
  duration?: string;
  /** The broker's preview id of an order the user confirmed on the confirmation page. */
  confirmId?: string;
  /** Exit levels (#330), in place of `takeProfit` / `stopLoss` (then null): each its quantity, take profit and stop
   *  loss. */
  exitLevels?: ExitLevel[];
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
