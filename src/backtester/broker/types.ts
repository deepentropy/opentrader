/**
 * Broker records: the script API options, the orders of the order book (entries, closes, exits, margin calls), open
 * trades, stop / limit orders on the path, equity events and the strategy runtime error.
 */
import type { Direction } from '../types';

/** A margin call: a market order that closes `size` of the position (less when the position is smaller). */
export interface MarginCallOrder {
  kind: 'call';
  seq: number;
  size: number;
  /** Equity the call was sized with. */
  equity: number;
  /** Found at an entry's fill price: sized at the tick it fills at (see walk). */
  sizeAtFill?: boolean;
}

export type OcaType = 'none' | 'cancel' | 'reduce';

/** strategy.risk.* rules the broker applies. */
export type RiskRule =
  | { rule: 'allow_entry_in'; direction: 'all' | 'long' | 'short' }
  | { rule: 'max_intraday_loss'; value: number; type: 'percent_of_equity' | 'cash' }
  | { rule: 'max_intraday_filled_orders'; count: number };

/** What an alert on the strategy's order fills gives for a fill besides the order: the call's alert_message. */
export interface FillAlert {
  message: string;
}

export interface EntryOptions {
  qty?: number;
  limit?: number;
  stop?: number;
  comment?: string;
  /** Pine `alert_message`: the text of {{strategy.order.alert_message}} when the order fills. */
  alertMessage?: string;
  /** One-cancels-all group: `cancel` cancels the other orders of the group when one fills, `reduce` lowers their
   *  quantity by the quantity filled (cancelled at 0). */
  ocaName?: string;
  ocaType?: OcaType;
  /** Pine `when=` (deprecated argument): the call is ignored when false. */
  when?: boolean;
}

export interface CloseOptions {
  comment?: string;
  alertMessage?: string;
  qty?: number;
  qtyPercent?: number;
  when?: boolean;
}

export interface ExitOptions {
  fromEntry?: string;
  qty?: number;
  qtyPercent?: number;
  /** Take profit distance, ticks. */
  profit?: number;
  /** Stop loss distance, ticks. */
  loss?: number;
  limit?: number;
  stop?: number;
  /** Trailing stop: activation distance from the entry price, ticks. */
  trailPoints?: number;
  /** Trailing stop: activation price. */
  trailPrice?: number;
  /** Trailing stop: distance from the best price after activation, ticks. */
  trailOffset?: number;
  comment?: string;
  commentProfit?: string;
  commentLoss?: string;
  commentTrailing?: string;
  /** Pine alert_message / alert_profit / alert_loss / alert_trailing (a leg's own text, else alert_message). */
  alertMessage?: string;
  alertProfit?: string;
  alertLoss?: string;
  alertTrailing?: string;
  when?: boolean;
}

export interface EntryOrder {
  kind: 'entry';
  /** Price the order was sized at when placed (the close, or the order price; slippage included). */
  sizePrice: number;
  /** Sized by the strategy's default quantity (no qty argument). */
  defaultSized?: boolean;
  /** Close of the bar the order was placed on (tick grid, no slippage). */
  placedClose: number;
  /** Equity when the order was placed (the funds a stop / limit entry is checked against at its fill). */
  placedEquity: number;
  /** Stop / limit price on the tick grid, null for a market order. */
  level: number | null;
  /** Opposite position the entry was placed against (its reversal part, fixed at placement). */
  reverseQty: number;
  /** strategy.order: no pyramiding limit, no reversal (it nets against the position). */
  isOrder: boolean;
  seq: number;
  id: string;
  direction: Direction;
  qty: number;
  /** OCA group (null = none). */
  ocaName: string | null;
  ocaType: OcaType;
  limit: number | null;
  stop: number | null;
  comment: string;
  /** For alerts on the fills. */
  alert?: FillAlert;
}

export interface CloseOrder {
  kind: 'close';
  seq: number;
  /** Order id in the filled orders: "Close entry(s) order <id>" / "Close position order". */
  orderId: string;
  /** null = whole position (strategy.close_all). */
  entryId: string | null;
  qty: number | null;
  qtyPercent: number | null;
  comment: string;
  alert?: FillAlert;
}

export interface ExitOrder {
  kind: 'exit';
  seq: number;
  /** Order number of the legs: the call that created them or last changed their price. */
  legSeq: number;
  /** The order has had a leg on an open trade (it is live, not waiting for its entry to fill). */
  attached: boolean;
  id: string;
  /** '' = every open trade. */
  fromEntry: string;
  qty: number | null;
  qtyPercent: number | null;
  profit: number | null;
  loss: number | null;
  limit: number | null;
  stop: number | null;
  trailPoints: number | null;
  trailPrice: number | null;
  trailOffset: number | null;
  comment: string;
  commentProfit: string;
  commentLoss: string;
  commentTrailing: string;
  /** For alerts on the fills of each leg. */
  alerts?: { profit: FillAlert; loss: FillAlert; trailing: FillAlert };
}

export interface OpenTrade {
  seq: number;
  /** Order number of the entry fill (exit legs of this trade count from it). */
  fillSeq: number;
  entryId: string;
  direction: Direction;
  qty: number;
  price: number;
  bar: number;
  signal: string;
  /** Entry commission not yet charged to a closed part. */
  entryCommission: number;
  high: number;
  low: number;
  /** Exit ids already filled for this trade (an exit fills once per trade). */
  exitsDone: Set<string>;
  /** Exit ids whose leg on this trade a margin call removed (until the exit is called again). */
  exitsDropped: Set<string>;
  /** Quantity of each exit bracket, fixed when the bracket first applies. */
  exitQty: Map<string, number>;
  /** Trailing stops of this trade: best price since activation, per exit id. */
  trail: Map<string, number>;
  /**
   * Quantity of this entry fill its exit legs still hold. A leg closes the oldest trades first (FIFO), not its own
   * trade, so this is not `qty`: a trade closed by the leg of another entry keeps its own legs.
   */
  lotQty: number;
  /** Quantity filled at the entry (qty_percent base; margin calls and partial exits reduce `qty`). */
  filledQty: number;
  /** Part of the trade a margin call that did not fill would have closed: it has no exit leg. */
  callQty: number;
}

/** A stop / limit order on the path, `level` on the tick grid. */
export interface PriceOrder {
  seq: number;
  buy: boolean;
  isStop: boolean;
  level: number;
  /** Price that triggers the fill: the level, or N ticks beyond it for limit orders (backtest_fill_limits_assumption). */
  trigger: number;
  /** price = fill price, slippage included; raw = exact price reached (trailing activation). */
  fill(price: number, raw: number): boolean;
  /** An entry (strategy.entry / strategy.order). */
  entry?: boolean;
}

export const EPS = 1e-9;

/** A strategy runtime error, as the reference app stops the script (e.g. RE10141). */
export class StrategyRuntimeError extends Error {
  constructor(
    readonly bar: number,
    readonly code: string,
    message: string,
    /** The invalid value, when the error is about one. */
    readonly value?: number,
  ) {
    super(`Error on bar ${bar}: ${message}`);
  }
}

/**
 * 'p' = a price reached on the path while trades are open, 'c' = after a trade
 * record closes, 'e' = after an entry fill (commission paid).
 */
export interface EquityEvent {
  t: 'p' | 'c' | 'e';
  /** Equity marked to market at that price. */
  v: number;
  /** initial capital + net profit (closed trades, entry commissions paid). */
  realized: number;
  /** No open trade after the event. */
  flat: boolean;
  /** Close event of a margin call. */
  marginCall?: boolean;
}
