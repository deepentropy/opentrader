/**
 * Funds and margin: the funds checks of entries (at placement, at the fill, market entries against the state at
 * the last script run) and the margin calls along the path (sizing, fill, follow-up and deferred calls).
 */
import type { Direction } from '../types';
import { decimalSumAtMost } from '../decimal';
import { CloseFills } from './closes';
import { fillEquity } from './costs';
import { EPS, type EntryOrder, type MarginCallOrder } from './types';

export abstract class MarginBook extends CloseFills {
  /**
   * Equity the funds checks of orders count: the realized part as for margin calls (see marginRealized) plus the
   * open profit against the position's average price, at the current close. A market buy of 714,286 at a 0.10
   * close after a loss of 28,571.400000000005 on 100,000 is not filled: 71,428.59999999999 < 71,428.60.
   */
  protected get fundsEquity(): number {
    const pos = this.positionSize;
    const close = this.roundPrice(this.bars[this.bar].close);
    return this.marginRealized() + (pos === 0 ? 0 : (close - this.positionAvgPrice) * pos * this.sym.pointValue);
  }

  /** Value of `qty` at `price` for the funds checks, without binary noise (1,125,000 x 0.05 = 56,250). */
  private orderValue(qty: number, price: number): number {
    return Number((qty * price * this.sym.pointValue).toFixed(8));
  }

  private marginRatio(direction: Direction): number {
    return (direction === 'long' ? this.props.marginLong : this.props.marginShort) / 100;
  }

  /**
   * Margin: a new trade of `qty` in `direction` at `price` fits in the available funds: the equity at the
   * last script run minus the margin of the open trades (none when the fill closes them first). Always
   * true without margin.
   */
  protected fundsCover(direction: Direction, qty: number, price: number, closesOpenTrades = false, equity = this.scriptEquity, mark = price): boolean {
    const ratio = this.marginRatio(direction);
    if (ratio <= 0) return true;
    let used = 0;
    if (!closesOpenTrades) for (const t of this.openTrades) used += this.orderValue(t.qty, mark) * this.marginRatio(t.direction);
    const available = equity - used;
    return this.orderValue(qty, price) * ratio <= available;
  }

  /** Margin: the own quantity of market entry `o` fits in the equity at the close it was placed on (no slippage). */
  protected ownFits(o: EntryOrder): boolean {
    const ratio = this.marginRatio(o.direction);
    return ratio <= 0 || this.orderValue(o.qty, o.placedClose) * ratio <= this.scriptEquity;
  }

  /**
   * Margin: the own quantity of entry `o` fits in the equity it was placed with (see fillEquity), at the higher
   * of the fill price and the price it was sized at (greedy strategy AAPL 1D bar 2986: a buy stop at 0.40 sized
   * at the 0.41 close, 14,643 on 6,003.63, does not fill at a 0.40 open), in exact decimals (see
   * decimalSumAtMost): a buy stop of 714,286 at 0.10 placed on 71,428.59999999999 fills, one of 1,100,000 on
   * 100,000 does not, one of 67,404 at 0.41000000000000003 (41 ticks of 0.01) on 27,635.64 does not.
   */
  protected ownFitsAt(o: EntryOrder, price: number): boolean {
    const ratio = this.marginRatio(o.direction);
    return ratio <= 0 || decimalSumAtMost([[o.qty, Math.max(price, o.sizePrice), this.sym.pointValue, ratio]], o.placedEquity);
  }

  /**
   * Margin: a market entry that fills `fillQty` (its own quantity plus the opposite position it closes) is checked
   * against the state at the last script run, not the state at the fill: the position there plus this fill gives
   * the position to fund. The part already held then counts at that close, the new part at the higher of the
   * fill price and the price at placement (the close with the slippage for a buy, the close for a sell). The
   * values are exact decimals against the equity of fillEquity: an all-in long of 565,153 reversed on a
   * 0.41000000000000003 close (41 ticks of 0.01) with 231,712.73000000074 does not fill (565,153 x
   * 0.41000000000000003 = 231,712.7300000000169), one of 565,152 does, and so does the same reversal on a 0.38
   * close.
   */
  protected marketFundsCover(o: EntryOrder, fillQty: number, price: number): boolean {
    const buy = o.direction === 'long';
    const ratio = this.marginRatio(o.direction);
    if (ratio <= 0) return true;
    const before = this.scriptPos;
    const after = before + (buy ? fillQty : -fillQty);
    // The fill only reduces the position of the last script run.
    if (after === 0 || (before !== 0 && after > 0 === before > 0 && Math.abs(after) <= Math.abs(before))) return true;
    const held = before !== 0 && after > 0 === before > 0 ? Math.abs(before) : 0;
    const checkPrice = Math.max(price, buy ? o.sizePrice : o.placedClose);
    const pv = this.sym.pointValue;
    return decimalSumAtMost(
      [
        [held, this.scriptClose, pv, ratio],
        [Math.abs(after) - held, checkPrice, pv, ratio],
      ],
      fillEquity(this.scriptEquity),
    );
  }

  /** Margin call at price p (a point of the intrabar path), Pine's algorithm; it fills at `fill` (default p, see
   *  processBar for the chart open with lower-timeframe bars), at the next open when `atClose`, after the script run
   *  when `lastTick`. */
  protected checkMargin(p: number, fill = p, atClose = false, lastTick = false): void {
    const call = this.marginCallAt(p, this.marginRealized());
    if (!call) return;
    if (atClose) this.pendingCalls.push(call);
    // Found at the bar's last tick, it fills there after the script run: the script sees the position before it
    // (volatility expansion-close SPY 1h bar 207: a short of 478, a call of 8 at the close; the buy stop placed by
    // that script run reverses 478, not 470).
    else if (lastTick) this.deferredCalls.push(call);
    else this.fillMarginCall(call, fill);
  }

  /**
   * The realized part of the equity the funds check counts: the capital plus the sum of the winning trades' profits
   * plus the sum of the losing trades' profits (two running sums, not one: their binary noise decides the calls at
   * exactly 0 available funds, 178 of 179 such checks of the reference reports), less the entry commission of the
   * open trades.
   */
  protected marginRealized(): number {
    let cm = 0;
    for (const t of this.openTrades) cm += t.entryCommission;
    return this.props.initialCapital + (this.grossProfit + this.grossLoss) - cm;
  }

  /**
   * The margin call the funds ask for with the open trades marked at price p, or null. `realized`: see
   * marginRealized.
   *
   * Arithmetic of the reference app, measured on 190 probes at exactly 0 available funds (capital = quantity x
   * entry price) and on 59,624 checks of the reference reports:
   *   - open profit = (p - average price of the position) x position, the average price being cost / quantity
   *     (a long of 1,552,120 at 0.22: an average of 0.22000000000000003);
   *   - margin = the position's value at p without binary noise (1,250,000 x 0.14 = 175,000, not
   *     175,000.00000000003), times the margin ratio;
   *   - a call when realized + open profit - margin < 0; its size is 4 x the shares the available funds, without
   *     binary noise, cover at p (-5,325.45 / 0.15 = 35,503, not 35,502.99999999998), at least one step.
   */
  protected marginCallAt(p: number, realized: number, force = false): MarginCallOrder | null {
    const pos = this.positionSize;
    if (pos === 0) return null;
    const long = pos > 0;
    const ratio = this.marginRatio(long ? 'long' : 'short');
    if (ratio <= 0) return null;
    const pv = this.sym.pointValue;
    // No call can be sized at a price of 0 (the check after a trade closed at 0, slippage as large as the price).
    if (!(p > 0)) return null;
    const openProfit = (p - this.positionAvgPrice) * pos * pv;
    const equity = realized + openProfit;
    const margin = Number((Math.abs(pos) * p * pv).toFixed(8)) * ratio;
    const available = equity - margin;
    // `force`: a call already decided (see sizeAtFill), sized here.
    if (available >= 0 && !force) return null;
    const step = this.sym.qtyStep;
    const loss = Math.min(0, Number(available.toFixed(8))) / ratio;
    const cover = Math.trunc(Math.abs(loss / (p * pv)) / step) * step;
    return { kind: 'call', seq: ++this.seq, size: cover > 0 ? cover * 4 : step, equity };
  }

  /**
   * A margin call made by the fill of another one waits for the next tick. When that tick is the bar's last one
   * (the close), it fills there but after the script run of the bar: the script sees the position before it, and
   * strategy.cancel_all() cancels it (its number is used). Shorts of 1,349 and 2,592, a call of 3,208 at the high
   * of a bar that closes there: 733 more in a strategy that does not call cancel_all, none in one that does.
   */
  protected deferPendingCalls(): void {
    if (!this.pendingCalls.length) return;
    this.deferredCalls.push(...this.pendingCalls);
    this.pendingCalls = [];
  }

  /** Fill the margin calls that waited for the script run of the last bar, at its close (`this.bar` is still it). */
  protected fillDeferredCalls(close: number): void {
    if (!this.deferredCalls.length) return;
    const calls = this.deferredCalls;
    this.deferredCalls = [];
    for (const c of calls) this.fillMarginCall(c, close);
  }

  /** Margin calls made by the fill of another one fill at the next tick. */
  protected fillPendingCalls(p: number): void {
    if (!this.pendingCalls.length) return;
    const calls = this.pendingCalls;
    this.pendingCalls = [];
    for (const c of calls) this.fillMarginCall(c, p);
  }

  /** Fill a margin call at tick price p: a market order, oldest trade first. */
  protected fillMarginCall(call: MarginCallOrder, p: number): void {
    const pos = this.positionSize;
    // No position left for it (the call that made it closed the rest): no order, no number. A call that waited
    // for this tick closes the position it finds, also one on the other side opened since (a call of 4,856 made
    // while short, then two buy limits: 4,856 of the new long sold at the next tick).
    if (pos === 0) return;
    if (call.sizeAtFill) {
      const sized = this.marginCallAt(p, this.marginRealized(), true);
      if (!sized) return;
      call = sized;
    }
    const id = `Margin call ${this.marginCalls++}`;
    const long = pos > 0;
    const pv = this.sym.pointValue;
    const ratio = this.marginRatio(long ? 'long' : 'short');
    const size = Math.min(Math.abs(pos), call.size);
    // The margin call is a market order: it fills with the slippage (pivot-points SPY 1h bar 1533: 204.32 on a
    // 204.35 open, 3 ticks).
    const fill = Math.max(0, this.slip(p, !long));
    // It fills only if the margin of the position it leaves, at the fill price, fits in the equity it was sized
    // with (a short of 1,000 at 0.08, price 0.09, slippage 0.03: 312 fill with an equity of 82.90, 308 do not
    // with 83.00). A call that does not fill is dropped (not tried at the next tick).
    if ((Math.abs(pos) - size) * fill * pv * ratio > call.equity + EPS) {
      // A call that does not fill still takes the exit legs: every open trade loses them until the exit is called
      // again or another order closes a part of the trade, and the trade the call would have closed a part of
      // keeps a leg for the rest only (shorts of 1,728 and 9,321, a call of 2,448 that cannot fill: no exit
      // fills on that bar; after a buy of 1,944 the exit of the second lot closes 8,601 = 9,321 - 720, not 9,105).
      let left = size;
      for (const t of this.openTrades) {
        for (const x of this.exits.values()) if (x.fromEntry === '' || x.fromEntry === t.entryId) t.exitsDropped.add(x.id);
        const reached = Math.min(left, t.qty);
        left -= reached;
        if (reached > 0 && reached < t.qty && reached > t.callQty) {
          t.lotQty = Math.max(0, t.lotQty - (reached - t.callQty));
          t.callQty = reached;
        }
      }
      return;
    }
    // While it fills, the funds are checked again after each trade it closes, at the fill price and without the
    // profit of that trade (the trades closed before it count). A shortage makes one more margin call for the
    // next tick; the last shortage counts (lots of 20, 24, 112, 112 and a call of 172: 92 more; lots of 20, 23,
    // 112, 113: 1 more; shorts of 1,000 and 217,320 at 43.59, a call of 7,112 at 45.88: 15,360 more, the loss
    // of the first lot counted).
    let next: MarginCallOrder | null = null;
    let left = size;
    const held = [...this.openTrades];
    const prevOrderQty = this.orderFillQty;
    this.orderFillQty = size;
    for (const t of held) {
      if (left <= 0) {
        // The trades the margin call does not reach lose their exit legs, until the exit is called again
        // (pivot-points SPY 4h bar 1339: 48 of `short1` closed, `close short2` does not fill with `close short1`
        // at bar 1342; lots of 200 and 68, a call of 172: the exit of the second lot never fills).
        for (const x of this.exits.values()) if (x.fromEntry === '' || x.fromEntry === t.entryId) t.exitsDropped.add(x.id);
        continue;
      }
      // A trade it closes a part of has its legs (again: pivot-points SPY 1h bar 8648, `long2` not reached by the
      // first margin call, 1 share closed by the second, the 14 left closed by `close long2`).
      t.exitsDropped.clear();
      const q = Math.min(left, t.qty);
      left -= q;
      const before = this.marginRealized();
      this.closeTradeQty(t, q, fill, 'Margin call', true);
      // The equity after the fill marks the trades left at the tick price, not at the fill price with the
      // slippage (largest drawdown percent of a history with calls filled at 0).
      const event = this.equityEvents[this.equityEvents.length - 1];
      event.marginCall = true;
      event.v = this.props.initialCapital + this.netProfit + this.openProfitAt(p);
      next = this.marginCallAt(fill, before) ?? next;
    }
    this.orderFillQty = prevOrderQty;
    if (next) this.pendingCalls.push(next);
    // The trades left open see the fill price (pivot-points SPY 1h bar 8648: the share closed at the next tick
    // counts the 308.62 of the first margin call in its drawdown).
    this.touchTrades(fill, fill, this.openTrades);
    this.recordFill(id, 'Margin call', !long, null, fill, size, 'MARKET');
  }
}
