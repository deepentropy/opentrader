/**
 * Backtester types. Names follow Pine's strategy() arguments and the reference app's
 * Strategy Tester report (reportData), so a report can be compared field by
 * field with the one the reference app computes.
 */

export interface Bar {
  /** Bar open time, UNIX seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Direction = 'long' | 'short';
export type QtyType = 'fixed' | 'cash' | 'percent_of_equity';
export type CommissionType = 'percent' | 'cash_per_contract' | 'cash_per_order';

/** strategy() declaration arguments (Properties tab of the strategy settings). */
export interface StrategyProperties {
  initialCapital: number;
  currency: string;
  defaultQtyType: QtyType;
  defaultQtyValue: number;
  /** Max entries in the same direction. 0 behaves like 1 (Pine default). */
  pyramiding: number;
  commissionType: CommissionType;
  commissionValue: number;
  /** Slippage in ticks, applied to market and stop fills. */
  slippage: number;
  processOrdersOnClose: boolean;
  closeEntriesRule: 'FIFO' | 'ANY';
  /** Margin percent of long / short positions; 0 = no margin (no margin calls, no funds check). */
  marginLong: number;
  marginShort: number;
  /** backtest_fill_limits_assumption: a limit order fills only when the price goes this many ticks beyond its
   *  level (0 = when the price touches it). Properties tab "Limit order execution". */
  fillLimitsTicks: number;
  /** use_bar_magnifier: fills on historical bars follow the lower-timeframe bars of each chart bar when they
   *  are given (Properties tab "Bar detalization" High). */
  barMagnifier: boolean;
  /** calc_on_order_fills: an extra script run right after each fill ("On order fill"). */
  calcOnOrderFills: boolean;
  /** calc_on_every_tick: script runs on each realtime update ("On realtime bar tick"); no effect on history bars. */
  calcOnEveryTick: boolean;
  /** calc_on_every_history_tick: script runs on every tick of history bars ("On history bar tick"). */
  calcOnEveryHistoryTick: boolean;
  /** fill_orders_on_standard_ohlc: on Heikin Ashi charts, fills use the standard bars ("Heikin Ashi mode"). */
  fillOrdersOnStandardOhlc: boolean;
}

export const DEFAULT_PROPERTIES: StrategyProperties = {
  initialCapital: 1_000_000,
  currency: 'USD',
  defaultQtyType: 'fixed',
  defaultQtyValue: 1,
  pyramiding: 1,
  commissionType: 'percent',
  commissionValue: 0,
  slippage: 0,
  processOrdersOnClose: false,
  closeEntriesRule: 'FIFO',
  // Pine v5 default (the TypeScript ports are v5 scripts); v6 scripts default to 100.
  marginLong: 0,
  marginShort: 0,
  fillLimitsTicks: 0,
  barMagnifier: false,
  calcOnOrderFills: false,
  calcOnEveryTick: false,
  calcOnEveryHistoryTick: false,
  fillOrdersOnStandardOhlc: false,
};

export interface SymbolInfo {
  /** Minimum price move. Order and fill prices are rounded to it. */
  mintick: number;
  pointValue: number;
  /** Order quantity step (1 = whole shares). Quantities are rounded down to it. */
  qtyStep: number;
  /** Exchange time zone (syminfo.timezone): sessions, timestamp() inputs. */
  timezone: string;
}

export const DEFAULT_SYMBOL: SymbolInfo = { mintick: 0.01, pointValue: 1, qtyStep: 1, timezone: 'America/New_York' };

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';

/** One executed fill (the reference app `filledOrders` item). */
export interface FilledOrder {
  /** Bar index of the fill. */
  bar: number;
  /** Open time of the fill bar, UNIX ms. */
  time: number;
  /** Order id (Pine `id=`). */
  id: string;
  comment: string;
  buy: boolean;
  /** true = entry, false = exit, null = strategy.order (the reference app `e`). */
  entry: boolean | null;
  price: number;
  qty: number;
  type: OrderType;
}

export interface TradeLeg {
  /** Signal: the order id or comment. */
  signal: string;
  price: number;
  bar: number;
  /** Bar open time, UNIX milliseconds (the reference app report unit). */
  time: number;
}

/** One trade (the reference app `trades` item). Open trades have `exit` marked to the last close. */
export interface Trade {
  direction: Direction;
  entryId: string;
  entry: TradeLeg;
  exit: TradeLeg;
  open: boolean;
  qty: number;
  /** Net profit including commission. */
  profit: number;
  profitPercent: number;
  commission: number;
  /** Commission paid at the entry (part of `commission`). */
  entryCommission: number;
  /** Max favorable excursion (run-up), currency. */
  runUp: number;
  runUpPercent: number;
  /** Max adverse excursion (drawdown), currency, positive. */
  drawdown: number;
  drawdownPercent: number;
  cumProfit: number;
  /** Profit / equity before the trade (closed trades), the reference app `cp.p`. */
  profitPercentOfEquity: number;
}

export interface SidePerformance {
  netProfit: number;
  netProfitPercent: number;
  grossProfit: number;
  grossProfitPercent: number;
  grossLoss: number;
  grossLossPercent: number;
  /** Gross profit / loss of the trades before commission. */
  grossProfitWC: number;
  grossLossWC: number;
  commissionPaid: number;
  profitFactor: number | null;
  totalTrades: number;
  totalOpenTrades: number;
  numberOfWiningTrades: number;
  numberOfLosingTrades: number;
  percentProfitable: number | null;
  avgTrade: number | null;
  avgTradePercent: number | null;
  avgWinTrade: number | null;
  avgWinTradePercent: number | null;
  avgLosTrade: number | null;
  avgLosTradePercent: number | null;
  ratioAvgWinAvgLoss: number | null;
  largestWinTrade: number | null;
  largestWinTradePercent: number | null;
  largestLosTrade: number | null;
  largestLosTradePercent: number | null;
  avgBarsInTrade: number | null;
  avgBarsInWinTrade: number | null;
  avgBarsInLossTrade: number | null;
  maxContractsHeld: number;
}

export interface Performance {
  all: SidePerformance;
  long: SidePerformance;
  short: SidePerformance;
  openPL: number;
  openPLPercent: number;
  maxStrategyDrawDown: number;
  maxStrategyDrawDownPercent: number;
  maxStrategyRunUp: number;
  maxStrategyRunUpPercent: number;
  buyHoldReturn: number;
  buyHoldReturnPercent: number | null;
  /** Price change from the first entry price to the last close. */
  buyHoldGainPercent: number | null;
}

export interface BacktestReport {
  currency: string;
  properties: StrategyProperties;
  /** Closed trades first (chronological), then open trades. */
  trades: Trade[];
  filledOrders: FilledOrder[];
  performance: Performance;
  /** Equity at each bar close. */
  equity: number[];
  /** Buy & hold PnL at each bar close: whole shares bought with the initial
   *  capital at the first entry price (0 before the first entry). */
  buyHold: number[];
  /** First and last bar open times, UNIX ms (the testing period). */
  range: { from: number; to: number };
  /** Time spent in the run, milliseconds. */
  elapsedMs: number;
}
