/**
 * Broker state: the order book, open trades, risk-rule state and report records every broker layer shares (the
 * Broker is one object: each layer extends the one below it), with the position getters and the sizing / tick
 * rounding helpers.
 */
import type { Bar, FilledOrder, StrategyProperties, SymbolInfo, Trade } from '../types';
import { localDay } from '../../data/session/zone';
import { commission as orderCommission } from './costs';
import * as tick from './ticks';
import { StrategyRuntimeError, type CloseOrder, type EntryOrder, type EquityEvent, type ExitOrder, type MarginCallOrder, type OpenTrade } from './types';

export abstract class BrokerState {
  readonly long = 'long' as const;
  readonly short = 'short' as const;

  protected seq = 0;
  protected bar = 0;
  protected entries = new Map<string, EntryOrder>();
  protected closes: CloseOrder[] = [];
  protected exits = new Map<string, ExitOrder>();
  protected openTrades: OpenTrade[] = [];
  /** Trades closed by the leg of another trade, while the position is open (their own legs stay active). */
  protected displaced: OpenTrade[] = [];
  /**
   * close_entries_rule "ANY": strategy.close calls with a quantity that closed a part of their trades only. They stay
   * live and close the same quantity of the next trade of that id when it opens (see fillCloseAny).
   */
  protected liveCloses: CloseOrder[] = [];
  /** Quantity of the order being filled: a cash-per-order commission is split over the trades it touches. */
  protected orderFillQty = 0;
  protected tradeSeq = 0;
  /** Fill order of the per-trade legs of each exit id (see updateLegOrder). */
  protected legOrder = new Map<string, OpenTrade[]>();
  /** Margin calls so far, filled or not (order ids "Margin call <n>"). */
  protected marginCalls = 0;
  /** Margin calls that wait for the next tick (made by the fill of another one) or the next open (made at the close). */
  protected pendingCalls: MarginCallOrder[] = [];
  /** Margin calls that wait for the script run of the current bar (see deferPendingCalls). */
  protected deferredCalls: MarginCallOrder[] = [];
  /** Equity at the last script run (the bar close before the fills): the funds an entry fill is checked against. */
  protected scriptEquity = 0;
  /** Position (signed) and close at the last script run: the state a market entry fill is checked against. */
  protected scriptPos = 0;
  protected scriptClose = 0;
  /** strategy.risk.allow_entry_in: entries the other way only close the position. */
  protected allowEntryIn: 'all' | 'long' | 'short' = 'all';
  protected maxIntradayLoss: { value: number; type: 'percent_of_equity' | 'cash' } | null = null;
  protected maxIntradayFills: number | null = null;
  /** Trading day of the risk rules: the bar's local day in the exchange zone (a daily or weekly bar is one). */
  protected riskDay = NaN;
  /** Highest equity of the trading day, and the orders filled on it. */
  protected dayMaxEquity = -Infinity;
  protected dayFills = 0;
  /** A risk rule stopped trading for the rest of this day. */
  protected haltedDay = NaN;
  /** Order id of the close the filled-orders rule asked for after a margin call: it fills at the next tick. */
  protected pendingRiskClose: string | null = null;
  /** The close the filled-orders rule asked for after an order fill: it fills at the tick of that fill. */
  protected riskCloseNow: string | null = null;

  readonly closedTrades: Trade[] = [];
  readonly filledOrders: FilledOrder[] = [];
  netProfit = 0;
  /** Sums of the closed trades' profits above and below 0: the realized profit the funds check counts. */
  protected grossProfit = 0;
  protected grossLoss = 0;
  commissionPaid = 0;
  /** Equity events for the max drawdown / run-up metrics (see EquityEvent). */
  readonly equityEvents: EquityEvent[] = [];
  maxContractsHeld = { all: 0, long: 0, short: 0 };
  /** Running sums over closedTrades (profit, profitPercent) for all, winning (> 0) and losing (< 0) trades. */
  readonly closedStats = {
    all: { count: 0, profit: 0, percent: 0 },
    win: { count: 0, profit: 0, percent: 0 },
    loss: { count: 0, profit: 0, percent: 0 },
  };

  constructor(
    protected readonly bars: Bar[],
    readonly props: StrategyProperties,
    readonly sym: SymbolInfo,
    /** Bar magnifier: the lower-timeframe bars inside each chart bar (by chart bar index). A bar without them
     *  uses its own OHLC path. */
    protected readonly intrabars?: readonly (readonly Bar[] | undefined)[],
  ) {}

  // ------------------------------------------------------------ position

  get positionSize(): number {
    let s = 0;
    for (const t of this.openTrades) s += t.direction === 'long' ? t.qty : -t.qty;
    return s;
  }

  get positionAvgPrice(): number {
    let q = 0;
    let v = 0;
    for (const t of this.openTrades) {
      q += t.qty;
      v += t.qty * t.price;
    }
    return q > 0 ? v / q : NaN;
  }

  /** Number of open trades (strategy.opentrades). */
  get openTradesCount(): number {
    return this.openTrades.length;
  }

  /** Open profit at the current close, rounded to the tick (as the equity used for order sizing). */
  get openProfit(): number {
    return this.openProfitAt(this.roundPrice(this.bars[this.bar].close));
  }

  get equity(): number {
    return this.props.initialCapital + this.netProfit + this.openProfit;
  }

  /**
   * strategy.openprofit: the position against its average price at the current close, commission not counted (a
   * long of 1,000 at 0.13 and 3,000 at 0.14 marked at 0.16: 49.999999999999936, not the per-trade sum
   * 49.99999999999993).
   */
  get scriptOpenProfit(): number {
    const pos = this.positionSize;
    if (pos === 0) return 0;
    return (this.roundPrice(this.bars[this.bar].close) - this.positionAvgPrice) * pos * this.sym.pointValue;
  }

  /** Entry commission of the open trades (strategy.grossloss counts it while the trades are open). */
  get openEntryCommission(): number {
    let cm = 0;
    for (const t of this.openTrades) cm += t.entryCommission;
    return cm;
  }

  openProfitAt(price: number): number {
    let s = 0;
    for (const t of this.openTrades) s += (t.direction === 'long' ? 1 : -1) * (price - t.price) * t.qty * this.sym.pointValue;
    return s;
  }

  /** Margin of the open trades valued at `price` (margin_long / margin_short percent of their value). */
  marginAt(price: number): number {
    let s = 0;
    for (const t of this.openTrades) s += t.qty * price * this.sym.pointValue * ((t.direction === 'long' ? this.props.marginLong : this.props.marginShort) / 100);
    return s;
  }

  /** Largest margin of the open trades at a price reached on the path or at an entry fill (the reference app
   *  maxMarginUsed: 1 contract of AlphaTrend on SPY 15 min = the highest high, 779.37). */
  maxMarginUsed = 0;

  /** A risk rule stopped trading for the rest of the current bar's day: new orders are ignored. */
  protected get halted(): boolean {
    return this.bars.length > 0 && this.haltedDay === this.dayOf(this.bar);
  }

  protected dayOf(i: number): number {
    return localDay(this.sym.timezone, this.bars[i].time);
  }

  /** close_entries_rule "FIFO" (the default): orders for an entry id close the oldest trades first. */
  protected get fifo(): boolean {
    return this.props.closeEntriesRule !== 'ANY';
  }

  // ------------------------------------------------------------ sizing, costs, rounding

  /** Explicit qty: RE10024 when negative, rounded down to the quantity step. */
  protected checkQty(q: number, fn: string): number {
    if (q < 0 || q > 1e12) {
      throw new StrategyRuntimeError(
        this.bar,
        'RE10024',
        `Invalid \`qty\` value (${q}) in the \`${fn}()\` call. Use a positive number less or equal to 1000000000000.`,
        q,
      );
    }
    return this.floorQty(q);
  }

  /**
   * Price the order would fill at if triggered now: the close for market orders; for stop / limit
   * orders the order price, or the close when it is already crossed. Slippage included.
   */
  protected sizingPrice(buy: boolean, orderPrice: number | null, isStop: boolean): number {
    const close = this.roundPrice(this.bars[this.bar].close);
    let base = close;
    if (orderPrice !== null) {
      const higher = buy === isStop; // buy stop / sell limit fill at or above their price
      base = higher ? Math.max(orderPrice, close) : Math.min(orderPrice, close);
    }
    return orderPrice === null || isStop ? this.slip(base, buy) : base;
  }

  protected defaultQty(price: number, fn: string): number {
    const p = this.props;
    if (p.defaultQtyType === 'fixed') return this.checkQty(p.defaultQtyValue, fn);
    // Equity without binary noise (65828.48, not 65828.47999999998): on an exact share
    // boundary the reference app's floor behaves like the decimal value (3 cases checked). 8 decimals: the noise
    // of thousands of summed trade profits reaches 1e-10 (inside bar strategy SPY 5m bar 12725: 91,591.50 for
    // 122 shares at 750.75).
    const equity = Number(this.equity.toFixed(8));
    const cash = p.defaultQtyType === 'cash' ? p.defaultQtyValue : (equity * p.defaultQtyValue) / 100;
    if (p.defaultQtyType === 'percent_of_equity' && cash < 0) {
      throw new StrategyRuntimeError(
        this.bar,
        'RE10141',
        'Cannot create an order with negative quantity. Current qty_type is percent_of_equity and equity is less than 0.',
      );
    }
    let q: number;
    switch (p.commissionType) {
      case 'percent':
        q = cash / (price * this.sym.pointValue * (1 + p.commissionValue / 100));
        break;
      case 'cash_per_contract':
        q = cash / (price * this.sym.pointValue + p.commissionValue);
        break;
      case 'cash_per_order':
        q = (cash - p.commissionValue) / (price * this.sym.pointValue);
        break;
    }
    return this.checkQty(q, fn);
  }

  /** Commission of `qty` at `price` for the order being filled (see costs.ts). */
  protected commission(qty: number, price: number): number {
    return orderCommission(this.props, this.sym.pointValue, qty, price, this.orderFillQty);
  }

  /** price is on the tick grid; slippage moves it against the trader (see ticks.ts). */
  protected slip(price: number, buy: boolean): number {
    return tick.slip(price, buy, this.sym.mintick, this.props.slippage);
  }

  protected floorQty(q: number): number {
    return tick.floorQty(q, this.sym.qtyStep);
  }

  /** Nearest tick, on the exact binary value (see ticks.ts). */
  roundPrice(p: number): number {
    return tick.roundPrice(p, this.sym.mintick);
  }

  /** Order price rounded away from the market (see ticks.ts). */
  protected roundOrderPrice(p: number, buy: boolean, isStop: boolean): number {
    return tick.roundOrderPrice(p, buy, isStop, this.sym.mintick);
  }

  /** n ticks as a price, on the binary value (see ticks.ts). */
  protected ticks(n: number): number {
    return tick.ticks(n, this.sym.mintick);
  }

  /** Price a limit order at `level` needs to fill: `fillLimitsTicks` ticks beyond it (below for a buy). */
  protected limitTrigger(level: number, buy: boolean): number {
    return tick.limitTrigger(level, buy, this.props.fillLimitsTicks, this.sym.mintick);
  }
}
