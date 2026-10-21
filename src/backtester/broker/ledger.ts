/**
 * Trade ledger: trades opened and closed (a partial close splits a trade), closed-trade records and running stats,
 * trade excursions and equity events along the path, filled-order records (with the filled-orders risk rule and the
 * exits dropped when the position goes flat).
 */
import type { FilledOrder, MarginPoint, OrderType, Trade } from '../types';
import { roundCommission } from './costs';
import { BrokerState } from './state';
import { makeTrade } from './trade-report';
import { EPS, type EntryOrder, type FillAlert, type OpenTrade } from './types';

export abstract class TradeLedger extends BrokerState {
  /**
   * Run the fill of one order of `qty` (every trade it closes and the one it opens): a cash-per-order commission
   * is charged once for the order and split over them by quantity (a close of 11,000 over trades of 1,000, 3,000
   * and 7,000: 1.25 x 1,000 / 11,000 on the first; a reversal of 1,000 into 1,000: 0.625 each side).
   */
  protected asOneOrder<T>(qty: number, fill: () => T): T {
    const prev = this.orderFillQty;
    this.orderFillQty = qty;
    try {
      return fill();
    } finally {
      this.orderFillQty = prev;
    }
  }

  protected openTrade(o: EntryOrder, price: number): void {
    const entryCommission = this.commission(o.qty, price);
    // Entry commission is realized at the fill (it counts in net profit while the trade is open).
    this.netProfit -= entryCommission;
    this.commissionPaid += entryCommission;
    const t: OpenTrade = {
      seq: ++this.tradeSeq,
      fillSeq: ++this.seq,
      entryId: o.id,
      direction: o.direction,
      qty: o.qty,
      filledQty: o.qty,
      lotQty: o.qty,
      callQty: 0,
      price,
      bar: this.bar,
      signal: o.comment,
      entryCommission,
      // Excursions count the prices after the fill only.
      high: -Infinity,
      low: Infinity,
      exitsDone: new Set(),
      exitsDropped: new Set(),
      exitQty: new Map(),
      trail: new Map(),
    };
    this.openTrades.push(t);
    this.maxMarginUsed = Math.max(this.maxMarginUsed, this.marginAt(price));
    this.noteMarginFill(price);
    this.equityEvents.push({
      t: 'e',
      v: this.props.initialCapital + this.netProfit + this.openProfitAt(price),
      flat: false,
      realized: this.props.initialCapital + this.netProfit,
    });
    const long = this.openTrades.filter((x) => x.direction === 'long').reduce((s, x) => s + x.qty, 0);
    const short = this.openTrades.filter((x) => x.direction === 'short').reduce((s, x) => s + x.qty, 0);
    this.maxContractsHeld.long = Math.max(this.maxContractsHeld.long, long);
    this.maxContractsHeld.short = Math.max(this.maxContractsHeld.short, short);
    this.maxContractsHeld.all = Math.max(this.maxContractsHeld.all, long + short);
  }

  /** Close `qty` of trade t at `price`; a partial close splits the trade. */
  /** `market`: a market exit (close, reversal, strategy.order, margin call); see makeTrade. */
  protected closeTradeQty(t: OpenTrade, qty: number, price: number, signal: string, market = false, byLeg = false): void {
    if (qty <= 0) return;
    // An exit leg takes its quantity from its own entry fill (see the leg fill); any other close from this trade,
    // first from the part a margin call that did not fill left without a leg.
    if (!byLeg) {
      const noLeg = Math.min(t.callQty, qty);
      t.callQty -= noLeg;
      t.lotQty = Math.max(0, t.lotQty - (qty - noLeg));
    }
    const share = qty / t.qty;
    // The part of the entry commission a partial close takes is rounded like a commission; the trade keeps the rest
    // as it is (1.25 for 3,000, 1,234 closed: 0.5141666667, 0.7358333333 left).
    const entryCm = qty >= t.qty - EPS ? t.entryCommission : roundCommission(t.entryCommission * share);
    const exitCm = this.commission(qty, price);
    const trade = makeTrade(t, qty, price, signal, entryCm, exitCm, false, market, this.sym, this.bars, this.bar);
    this.netProfit += trade.profit + entryCm;
    if (trade.profit > 0) this.grossProfit += trade.profit;
    else this.grossLoss += trade.profit;
    this.commissionPaid += exitCm;
    trade.cumProfit = this.netProfit;
    trade.profitPercentOfEquity = trade.profit / Math.abs(this.props.initialCapital + this.netProfit - trade.profit);
    this.closedTrades.push(trade);
    const s = this.closedStats;
    for (const g of trade.profit > 0 ? [s.all, s.win] : trade.profit < 0 ? [s.all, s.loss] : [s.all]) {
      g.count++;
      g.profit += trade.profit;
      g.percent += trade.profitPercent * 100;
    }
    // A trade closed at a price of exactly 0 (slippage as large as the price) is reported with a profit of 0 and
    // no profit percent; the net profit and the cumulative profit keep the loss, and the report totals follow the
    // reported profits (the reference app: -80.08 cumulative, net profit 0 in the summary).
    if (price === 0) {
      trade.profit = 0;
      trade.profitPercent = NaN;
      trade.profitPercentOfEquity = 0;
    }
    t.entryCommission -= entryCm;
    t.qty -= qty;
    if (t.qty <= EPS) this.openTrades = this.openTrades.filter((x) => x !== t);
    // A trade another order closed a part of has new exit legs for what is left: they go behind the orders
    // already placed (a sell limit entry closes 3,205 of `long1`, 3,788: `close long2` then fills before
    // `close long1`, 583, on the same tick).
    else if (!byLeg) {
      t.fillSeq = ++this.seq;
      t.exitsDropped.clear();
    }
    this.noteMarginFill(price);
    this.equityEvents.push({
      t: 'c',
      v: this.props.initialCapital + this.netProfit + this.openProfitAt(price),
      flat: this.openTrades.length === 0,
      realized: this.props.initialCapital + this.netProfit,
    });
  }

  /** Open trades marked at the last close (exit commission included, like the reference app report). */
  openTradeReports(): Trade[] {
    const close = this.roundPrice(this.bars[this.bar].close);
    return this.openTrades.map((t) => {
      const tr = makeTrade(t, t.qty, close, '', t.entryCommission, this.commission(t.qty, close), true, false, this.sym, this.bars, this.bar);
      tr.cumProfit = this.netProfit + tr.profit;
      tr.profitPercentOfEquity = tr.profit / Math.abs(this.props.initialCapital + this.netProfit);
      return tr;
    });
  }

  /** Record a price reached on the path (equity events, trade excursions). */
  protected touch(p: number, raw = p): void {
    this.touchEquity(p);
    this.touchTrades(p, raw, this.openTrades);
  }

  protected touchEquity(p: number): void {
    const r = this.roundPrice(p);
    if (this.openTrades.length) {
      this.maxMarginUsed = Math.max(this.maxMarginUsed, this.marginAt(r));
      this.noteMarginPeak(this.marginPoint(r));
      this.equityEvents.push({
        t: 'p',
        v: this.props.initialCapital + this.netProfit + this.openProfitAt(r),
        flat: false,
        realized: this.props.initialCapital + this.netProfit,
      });
    }
  }

  /** Margin of the open trades at `price` and its share of the equity there (open profit included). */
  private marginPoint(price: number): MarginPoint {
    const value = this.marginAt(price);
    const equity = this.props.initialCapital + this.netProfit + this.openProfitAt(price);
    const percent = equity > 0 ? value / equity : value > 0 ? 1 : 0;
    return { time: this.bars[this.bar].time * 1000, value, percent, tradesOpen: this.openTrades.length };
  }

  private noteMarginPeak(p: MarginPoint): void {
    if (!this.marginPeak || p.value > this.marginPeak.value) this.marginPeak = p;
  }

  /**
   * Margin usage after a fill at `price` (the reference app's report marginUsage, matched item for item on the 24
   * reference reports that hold one: the margin of the open trades at the fill price over the equity there, and the
   * highest margin since the previous fill, at the extreme price for a long or a short). The fills of one bar make
   * one item with the state after the last of them. As for the margin used (readMarginUsed), a fill that leaves
   * the position flat or short with a short margin of 0 makes no item (cumulative RSI, long only: one item per
   * entry); the highest margin starts again after it all the same.
   */
  protected noteMarginFill(price: number): void {
    const p = this.marginPoint(price);
    this.noteMarginPeak(p);
    const peak = this.marginPeak ?? p;
    this.marginPeak = null;
    if ((this.positionSize > 0 ? this.props.marginLong : this.props.marginShort) === 0) return;
    const last = this.marginUsage[this.marginUsage.length - 1];
    if (last && last.current.time === p.time) {
      last.current = p;
      if (peak.value > last.peak.value) last.peak = peak;
    } else this.marginUsage.push({ current: p, peak });
  }

  protected touchTrades(p: number, raw: number, trades: OpenTrade[]): void {
    const r = this.roundPrice(p);
    for (const t of trades) {
      if (r > t.high) t.high = r;
      if (r < t.low) t.low = r;
      // Trailing stops follow the exact price, not the tick-rounded one.
      for (const [id, best] of t.trail) {
        if (t.direction === 'long' ? raw > best : raw < best) t.trail.set(id, raw);
      }
    }
  }

  protected recordFill(id: string, comment: string, buy: boolean, entry: boolean | null, price: number, qty: number, type: OrderType, alert?: FillAlert): void {
    const fill: FilledOrder = { bar: this.bar, time: this.bars[this.bar].time * 1000, id, comment, buy, entry, price, qty, type };
    if (alert) fill.alertMessage = alert.message;
    this.filledOrders.push(fill);
    // strategy.risk.max_intraday_filled_orders: margin calls count; at the limit the pending orders are cancelled
    // and the position is closed at the tick of that fill (greedy strategy SPY 15m bar 669: the 5th fill is a buy
    // stop at the open, closed there; SPY 5m bar 3188: a buy stop on the way up, closed at the high), at the next
    // tick when it is a margin call (SPY 1h bar 6790: a call at the high, closed at the low).
    if (this.maxIntradayFills !== null && !this.halted && ++this.dayFills >= this.maxIntradayFills) {
      this.halt();
      const close = 'Close Position (Max number of filled orders in one day)';
      if (id.startsWith('Margin call')) this.pendingRiskClose = close;
      else this.riskCloseNow = close;
    }
    // Pending strategy.exit orders are cancelled when a fill leaves the position flat. An exit still waiting for
    // its entry to fill stays (pivot-points SPY 15m: the exit of a limit entry placed while the opposite position
    // was open); one that was live on the closed position goes, whatever entries are pending (st-greed).
    if (this.openTrades.length === 0) {
      this.displaced = [];
      this.liveCloses = [];
      for (const [id, x] of this.exits) if (x.attached) this.exits.delete(id);
      this.dropOrphanExits();
    }
  }

  /** A risk rule fired: no order is left and none is placed until the next day. */
  protected halt(): void {
    this.haltedDay = this.dayOf(this.bar);
    this.entries.clear();
    this.exits.clear();
    this.closes = [];
  }

  /** Flat: exit orders that no pending entry can open a trade for are dropped. */
  protected dropOrphanExits(): void {
    if (this.openTrades.length || !this.exits.size) return;
    for (const [id, x] of this.exits) {
      const used = [...this.entries.values()].some((e) => x.fromEntry === '' || e.id === x.fromEntry);
      if (!used) this.exits.delete(id);
    }
  }
}
