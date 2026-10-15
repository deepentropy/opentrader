/**
 * Broker emulator: Pine's strategy.* order model, run bar by bar.
 *
 * Per bar i (the reference app's historical-bar model, calc_on_every_tick off):
 *   1. `processBar(i)`: fill orders placed before bar i. Market orders fill at
 *      the open. Stop / limit orders are checked along the intrabar path:
 *      open -> high -> low -> close when the high is closer to the open than
 *      the low, else open -> low -> high -> close. A gap through the order
 *      price fills at the open.
 *   2. The strategy script runs at the bar close and places / changes orders.
 *   3. `processClose(i)` (process_orders_on_close only): market orders placed
 *      at this close fill at the close.
 *
 * Rules matched on the reference app reports (.tmp/backtester):
 *   - bar prices are rounded to mintick (nearest, on the exact binary value)
 *     before orders are checked; fills are on the tick grid; slippage (ticks)
 *     is added to market and stop fills, against the trader;
 *   - stop / limit prices are rounded to mintick away from the market (buy
 *     stop and sell limit up, sell stop and buy limit down), except within
 *     1/10,000 of a tick of a tick level;
 *   - default quantity is computed when the order is placed: fixed, cash /
 *     price, or equity * % / price, commission included, rounded down to the
 *     quantity step. Equity values open trades at the rounded close. The price
 *     is the close for market orders; for stop / limit orders the order price,
 *     or the close when the order price is already crossed;
 *   - an entry against the open position closes it and opens the new one in
 *     the same fill; entries beyond `pyramiding` are not filled; at most one
 *     entry order fills per bar (exit orders are not limited);
 *   - strategy.exit brackets attach to each open trade of `from_entry`; a
 *     partial exit (qty_percent, rounded down) splits the trade in two;
 *   - trade excursions count the prices after the fill (the close for a fill
 *     at the close), the open too for a trade opened at the open and still
 *     open after the fills of that tick, and include the entry commission;
 *   - tick prices are n * mintick on the binary value (35 * 0.01 =
 *     0.35000000000000003), quantities are floored without epsilon, and the
 *     sizing equity is taken without binary noise (10 decimals);
 *   - an entry with quantity 0 only closes an opposite position;
 *   - strategy.order is not limited by pyramiding, nets against the position
 *     and is reported with entry = null;
 *   - pending strategy.exit orders are cancelled when a fill leaves the
 *     position flat, and dropped at the next bar when flat with no pending
 *     entry they could apply to;
 *   - several orders crossed by a gap fill the one closest to the open first;
 *   - trailing stops: activation at entry + trail_points (rounded like a
 *     limit), best price = exact prices after activation, stop = best -
 *     trunc(trail_offset) ticks, rounded like a stop.
 *
 *   - trade excursions also count the exit fill price (slippage included):
 *     always for a market exit, after prices seen for a price-order exit; a
 *     trade closed by a market order at the open does not see the raw open;
 *   - a strategy.close does not fill after a market entry of the same batch,
 *     filled or rejected (bb-mean-reversion, rsi-volume-macd-ema);
 *   - an empty comment shows the order id;
 *   - several entries fill on one bar, in either direction, stop or limit;
 *   - a stop / limit entry keeps the quantity it was placed with, its own
 *     plus the position it was placed against: the position expected once the
 *     market orders already placed in that script run have filled (a market
 *     entry or a close order called before it counts, one called after it
 *     does not). It opens both when the position closed before the fill or
 *     when it pyramids, and one placed while flat only closes the position
 *     opened since. A market entry closes the position at its fill and opens
 *     its own quantity;
 *   - an exit applies to the trades open and the entry orders pending when it
 *     is called (and to later trades of such an id): a call with no trade and
 *     no order of its entry id is no order;
 *   - a trade closed at a price of exactly 0 is reported with a profit of 0
 *     and no profit percent (the net profit keeps the loss);
 *   - orders that reach the same tick fill in the order they were placed. An
 *     entry called again with another quantity (the position it was placed
 *     against included) or a price on another tick is a new order, behind the
 *     others; a new price on the same tick keeps its place. The exit legs of
 *     a trade another order closed a part of are new orders too;
 *   - a stop / limit entry is checked when it is placed (pyramiding limit,
 *     funds for its own quantity), not when it fills;
 *   - exits reserve the trade quantity in creation order; qty_percent counts
 *     on the filled entry quantity; an entry that closes every trade of an
 *     entry id cancels the exits live on them, also when an entry of that id
 *     is pending again;
 *   - the legs of one strategy.exit fill in hash order of their entry ids
 *     (updateLegOrder) and close the oldest trades first (FIFO). A leg belongs
 *     to its entry fill: it keeps its quantity when another leg closed its
 *     trade, and legs of entries filled after the exit call fill in entry
 *     order;
 *   - a fill that leaves the position flat removes the exits that were live
 *     on it; an exit still waiting for its entry to fill stays.
 *
 * Bar magnifier (use_bar_magnifier, lower-timeframe bars per chart bar; rules matched on
 * .tmp/strategy-properties): the path is the chart open (market orders fill there), then each
 * lower-timeframe bar (a jump to its open, then open -> nearer extreme -> other extreme -> close), then a
 * jump to the chart close; a jump fills the orders it crosses at the price reached. A margin call found at
 * the chart open is sized there and fills at the first lower-timeframe open; trades opened at the chart
 * open count it in their range once the path moves on.
 *
 * Limit fill assumption (backtest_fill_limits_assumption = N): a limit order needs the price N ticks beyond
 * its level; it fills at its level when the path reaches that price, at the price on a jump (gap) beyond
 * it. Trades see the level, not the price beyond it.
 *
 * Margin (margin_long / margin_short above 0, the Pine v6 default of 100;
 * rules matched on .tmp/oakscript-strategies):
 *   - a market entry is checked twice against the equity at the last script
 *     run. Its own quantity at the close it was placed on (no slippage): when
 *     it does not fit, the order only closes an opposite position. Then its
 *     fill against the state at that script run, not the state at the fill:
 *     the position of the script run plus the quantity it fills gives the
 *     position to fund, the part held then at that close, the new part at
 *     the higher of the fill price and the price at placement (the close plus
 *     the slippage for a buy, the close for a sell). When that does not fit
 *     it is not filled at all (not resized, a reversal keeps the position).
 *     So trades opened by earlier orders of the same batch count in a
 *     reversal and not in an entry that adds to them, and a position closed
 *     by an earlier close order still counts. A stop / limit entry is
 *     checked at placement instead (its own quantity at the higher of its
 *     sizing price and the close, the open trades at the close): one that does
 *     not fit is not placed (an order of that id placed earlier goes too), or
 *     only closes the position it reverses. At its fill, its own quantity at
 *     the fill price must fit the equity it was placed with, else it does not
 *     fill at all (a gap beyond its price; .tmp/issue47);
 *   - margin calls are checked at each point of the intrabar path (open,
 *     high / low, close) with Pine's documented formula: when the available
 *     funds are below 0, 4 times the quantity that covers the loss (at least
 *     one quantity step) is closed at that price plus the slippage, oldest
 *     trade first (order "Margin call <n>");
 *   - a margin call fills only if the margin of the position it leaves, at its
 *     fill price, fits in the equity it was sized with; else it is dropped (its
 *     number is used). The funds are checked once more after the script run:
 *     that call waits for the next open, after the script's market orders;
 *   - while a margin call fills, the funds are checked again after each trade
 *     it closes, at the fill price and without the profit of that trade (the
 *     trades closed before it count; no call at a price of 0): a shortage
 *     there makes one more margin call (the last shortage
 *     counts), filled at the next tick on the position of that tick, whatever
 *     its side. The trades left open see the fill price;
 *   - the trades a margin call does not reach lose their exit legs until the
 *     exit is called again or another order closes a part of the trade. A
 *     call that cannot fill takes the legs of every open trade, and the trade
 *     it would have closed a part of keeps a leg for the rest only;
 *   - a margin call made by the fill of another one that waits for the bar's
 *     last tick fills there after the script run: the script sees the
 *     position before it and strategy.cancel_all() cancels it (number used).
 *     So does a margin call found at the bar's last tick.
 *
 * OCA groups and risk rules (rules matched on .tmp/issue47, the built-in strategies):
 *   - an entry or order of an OCA group cancels the other orders of its group
 *     when it fills (cancel), or lowers their quantity by its fill (reduce);
 *   - strategy.risk.allow_entry_in: an entry the other way only closes;
 *   - strategy.risk.max_intraday_loss: see riskPoint;
 *     strategy.risk.max_intraday_filled_orders: see recordFill. A rule that
 *     fires cancels every pending order, closes the position ("Close Position
 *     (...)") and no order is placed until the next day (the bar's local day in
 *     the exchange zone: a daily or weekly bar is one day).
 *
 * Code layers (src/backtester/broker/, each class extends the one before; Broker is the last): state (order book,
 * trades, position, sizing / tick helpers), ledger (trades opened / closed, equity events, fill records), closes
 * (FIFO / ANY close rules), margin (funds checks, margin calls), entries (entry / order fills, OCA), path (price
 * orders along the bar path, exit legs), orders (the script API); pure helpers in ticks, costs and trade-report.
 */
import type { Bar } from './types';
import { OrderBook } from './broker/orders';
import { EPS } from './broker/types';

export { StrategyRuntimeError } from './broker/types';
export type { CloseOptions, EntryOptions, EquityEvent, ExitOptions, OcaType, RiskRule } from './broker/types';

export class Broker extends OrderBook {
  // ------------------------------------------------------------ emulation

  /** Fill the orders placed before bar `i` along bar i's price path. */
  processBar(i: number): void {
    this.scriptEquity = i > 0 ? this.fundsEquity : this.props.initialCapital;
    this.scriptPos = this.positionSize;
    this.scriptClose = i > 0 ? this.roundPrice(this.bars[i - 1].close) : 0;
    if (i > 0) this.fillDeferredCalls(this.roundPrice(this.bars[i - 1].close));
    // The funds are checked once more after the script run of the last bar, at its close: that margin call
    // fills at this open, after the script's market orders (5 margin call numbers per bar, the last one filled
    // at the next open).
    // With process_orders_on_close that check was made after the fills at the close (see processClose).
    if (i > 0 && !this.props.processOrdersOnClose) this.checkMargin(this.roundPrice(this.bars[i - 1].close), undefined, true);
    this.bar = i;
    if (this.dayOf(i) !== this.riskDay) {
      this.riskDay = this.dayOf(i);
      this.dayMaxEquity = -Infinity;
      this.dayFills = 0;
    }
    this.fillRiskClose(this.roundPrice(this.bars[i].open));
    this.dropOrphanExits();
    // Bar magnifier: the path runs through the lower-timeframe bars of the chart bar (each one open -> nearer
    // extreme -> other extreme -> close, a gap between two of them fills at the later open).
    const sub = this.intrabars?.[i];
    const legs: readonly Bar[] = sub && sub.length ? sub : [this.bars[i]];
    // The first tick is the chart bar's open (market orders fill at it with the magnifier too).
    const first = this.bars[i];
    // Orders are checked on the bar prices rounded to the tick.
    const open = this.roundPrice(first.open);
    // The open reaches the trades still open after the market fills: a trade closed at the open sees
    // its fill price only (slippage included).
    const held = [...this.openTrades];
    // The max intraday loss check after the fills at the open counts the realized profit from before them, except
    // on the day's first tick (bar up/down strategy AAPL 1W bar 12: a short reversed with a profit of 1,410.70 at a
    // weekly open is not closed).
    const realizedBefore = this.dayMaxEquity === -Infinity ? undefined : this.props.initialCapital + this.netProfit;
    this.touchEquity(open);
    this.fillMarketOrders(open);
    this.touchTrades(open, first.open, held.filter((t) => this.openTrades.includes(t)));
    let cur = open;
    this.fillAt(cur, first.open);
    this.fillRiskCloseNow(open);
    this.riskPoint(open, realizedBefore);
    // With lower-timeframe bars, trades opened at the chart open and still open at the next tick (the first
    // lower-timeframe open) count the chart open in their range (rsi-mean-reversion AAPL 3D); a trade closed at
    // the open itself does not (triple-ema-trend SPY 1h).
    const fresh = this.openTrades.filter((t) => !held.includes(t));
    // Without them too: a trade opened at the open and still open after the fills of that tick sees the open (a
    // market buy at 44.84, 100 ticks of slippage on a 43.84 open, closed at 43.87 before the low: drawdown 1.00
    // a share; no slippage: the commission).
    if (!(sub && sub.length)) this.touchTrades(open, first.open, fresh);
    // With lower-timeframe bars, a margin call found at the chart open is sized there and fills at the next tick
    // (the first lower-timeframe open: ut-bot-v2 AAPL 1D, 80 shares at 32.40 sized at the 32.38 open).
    const deferMargin = !!(sub && sub.length);
    if (!deferMargin) this.checkMargin(open);
    for (let k = 0; k < legs.length; k++) {
      const b = legs[k];
      // Each lower-timeframe open is a tick of its own (a gap from the previous tick fills there); a bar
      // without them starts its path at its open.
      if (sub && sub.length) {
        const o = this.roundPrice(b.open);
        if (k === 0) this.touchTrades(open, first.open, fresh.filter((t) => this.openTrades.includes(t)));
        this.touch(o, b.open);
        if (k === 0 && deferMargin) this.checkMargin(open, o);
        this.fillAt(o, b.open);
        this.fillRiskCloseNow(o);
        this.fillPendingCalls(o);
        this.fillRiskClose(o);
        this.checkMargin(o);
        this.riskPoint(o);
        cur = o;
      }
      const high = this.roundPrice(b.high);
      const low = this.roundPrice(b.low);
      const close = this.roundPrice(b.close);
      const upFirst = Math.abs(b.high - b.open) < Math.abs(b.low - b.open);
      // [price on the tick grid, exact price] (trailing stops follow the exact price).
      const path: [number, number][] = upFirst ? [[high, b.high], [low, b.low], [close, b.close]] : [[low, b.low], [high, b.high], [close, b.close]];
      for (let n = 0; n < path.length; n++) {
        const [to, raw] = path[n];
        this.walk(cur, to);
        this.fillRiskCloseNow(to);
        cur = to;
        this.touch(to, raw);
        // A margin call that waits for the bar's last tick fills after the script run (see fillDeferredCalls).
        const last = n === path.length - 1 && !(sub && sub.length);
        if (last) this.deferPendingCalls();
        else this.fillPendingCalls(to);
        // Also at the bar's last tick (greedy strategy SPY 5m bar 5987: a margin call at the high, closed at the close).
        this.fillRiskClose(to);
        this.checkMargin(to, to, false, last);
        this.riskPoint(to);
        // The day's highest equity counts the bar closes, not the prices inside the bars.
        if (last && this.maxIntradayLoss) this.dayMaxEquity = Math.max(this.dayMaxEquity, this.props.initialCapital + this.netProfit + this.openProfitAt(to));
      }
    }
    // The last tick is the chart bar's close, reached by a jump like the lower-timeframe opens (an order it
    // crosses fills at the close).
    if (sub && sub.length) {
      const b = this.bars[i];
      const close = this.roundPrice(b.close);
      this.touch(close, b.close);
      this.fillAt(close, b.close);
      this.deferPendingCalls();
      this.checkMargin(close, close, false, true);
      this.riskPoint(close);
    }
  }

  /**
   * strategy.risk.max_intraday_loss at a point of the path: the loss from the day's highest equity (its first tick
   * and its bar closes), marked at price p. When it reaches the limit (percent of that highest equity, or cash) the
   * pending orders are cancelled, the position is closed at p and trading stops until the next day (bar-up/down
   * strategy AAPL 1D trade 1: a short of 100,000 at 0.10, the high reaches 0.11, a loss of 1,000 = 1 %, closed
   * there; SPY 4h bar 4445: not the low of the bar before, the loss from it would be 1,090).
   * `realized`: at the open, the capital plus the net profit before the fills of that tick (a short of 55 to 74
   * from 133.74 reversed at a 114.59 open is closed by the rule: the day's highest equity counts the short's open
   * profit at the 114.07 first tick, the equity after the reversal not yet its 1,053 to 1,417 profit; 40 is not).
   */
  private riskPoint(p: number, realized = this.props.initialCapital + this.netProfit): void {
    const rule = this.maxIntradayLoss;
    if (!rule || this.halted) return;
    const equity = realized + this.openProfitAt(p);
    if (this.dayMaxEquity === -Infinity) this.dayMaxEquity = equity;
    const limit = rule.type === 'cash' ? rule.value : (rule.value / 100) * this.dayMaxEquity;
    if (this.dayMaxEquity - equity < limit - EPS) return;
    this.halt();
    if (this.openTrades.length) this.closePosition('Close Position (Max intraday Loss)', p);
  }

  /** The close the filled-orders rule asked for after an order fill, at the tick p of that fill (an order filled
   *  on the way to a point of the path belongs to that point). */
  private fillRiskCloseNow(p: number): void {
    const id = this.riskCloseNow;
    if (id === null) return;
    this.riskCloseNow = null;
    if (this.openTrades.length) this.closePosition(id, p);
  }

  /** The close the filled-orders rule asked for after a margin call, at the next tick p. */
  private fillRiskClose(p: number): void {
    const id = this.pendingRiskClose;
    if (id === null) return;
    this.pendingRiskClose = null;
    if (this.openTrades.length) this.closePosition(id, p);
  }

  /** process_orders_on_close: fill the orders just placed at bar i's close. */
  processClose(i: number): void {
    this.bar = i;
    this.scriptEquity = this.fundsEquity;
    const close = this.roundPrice(this.bars[i].close);
    this.scriptPos = this.positionSize;
    this.scriptClose = close;
    this.touch(close, this.bars[i].close);
    this.fillMarketOrders(close);
    this.fillAt(close, this.bars[i].close);
    // Trades filled at this close see the close as their first price after the fill.
    this.touch(close, this.bars[i].close);
    // The funds check after these fills is the one after the script run: its margin call is sized here and fills
    // at the next open (a short of 228,000 filled at a 43.44 close with 1.00 of slippage: 12,184 bought back at
    // the next open, 43.94 + 1.00, not at the close).
    this.checkMargin(close, undefined, true);
  }
}
