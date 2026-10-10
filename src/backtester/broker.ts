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
 *     stop and sell limit up, sell stop and buy limit down);
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
 *     checked at placement instead (its own quantity at its sizing price,
 *     the open trades at the close);
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
 */
import type {
  Bar,
  Direction,
  FilledOrder,
  OrderType,
  StrategyProperties,
  SymbolInfo,
  Trade,
} from './types';

/** A margin call: a market order that closes `size` of the position (less when the position is smaller). */
interface MarginCallOrder {
  kind: 'call';
  seq: number;
  size: number;
  /** Equity the call was sized with. */
  equity: number;
}

export interface EntryOptions {
  qty?: number;
  limit?: number;
  stop?: number;
  comment?: string;
  /** Pine `when=` (deprecated argument): the call is ignored when false. */
  when?: boolean;
}

export interface CloseOptions {
  comment?: string;
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
  when?: boolean;
}

interface EntryOrder {
  kind: 'entry';
  /** Price the order was sized at when placed (the close, or the order price; slippage included). */
  sizePrice: number;
  /** Close of the bar the order was placed on (tick grid, no slippage). */
  placedClose: number;
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
  limit: number | null;
  stop: number | null;
  comment: string;
}

interface CloseOrder {
  kind: 'close';
  seq: number;
  /** Order id in the filled orders: "Close entry(s) order <id>" / "Close position order". */
  orderId: string;
  /** null = whole position (strategy.close_all). */
  entryId: string | null;
  qty: number | null;
  qtyPercent: number | null;
  comment: string;
}

interface ExitOrder {
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
}

interface OpenTrade {
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
interface PriceOrder {
  seq: number;
  buy: boolean;
  isStop: boolean;
  level: number;
  /** Price that triggers the fill: the level, or N ticks beyond it for limit orders (backtest_fill_limits_assumption). */
  trigger: number;
  /** price = fill price, slippage included; raw = exact price reached (trailing activation). */
  fill(price: number, raw: number): boolean;
}

const EPS = 1e-9;


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

/** Pine na (NaN) or undefined as "not set". */
const val = (v: number | undefined): number | null => (v === undefined || Number.isNaN(v) ? null : v);

export class Broker {
  readonly long = 'long' as const;
  readonly short = 'short' as const;

  private seq = 0;
  private bar = 0;
  private entries = new Map<string, EntryOrder>();
  private closes: CloseOrder[] = [];
  private exits = new Map<string, ExitOrder>();
  private openTrades: OpenTrade[] = [];
  /** Trades closed by the leg of another trade, while the position is open (their own legs stay active). */
  private displaced: OpenTrade[] = [];
  private tradeSeq = 0;
  /** Fill order of the per-trade legs of each exit id (see updateLegOrder). */
  private legOrder = new Map<string, OpenTrade[]>();
  /** Margin calls so far, filled or not (order ids "Margin call <n>"). */
  private marginCalls = 0;
  /** Margin calls that wait for the next tick (made by the fill of another one) or the next open (made at the close). */
  private pendingCalls: MarginCallOrder[] = [];
  /** Margin calls that wait for the script run of the current bar (see deferPendingCalls). */
  private deferredCalls: MarginCallOrder[] = [];
  /** Equity at the last script run (the bar close before the fills): the funds an entry fill is checked against. */
  private scriptEquity = 0;
  /** Position (signed) and close at the last script run: the state a market entry fill is checked against. */
  private scriptPos = 0;
  private scriptClose = 0;

  readonly closedTrades: Trade[] = [];
  readonly filledOrders: FilledOrder[] = [];
  netProfit = 0;
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
    private readonly bars: Bar[],
    readonly props: StrategyProperties,
    readonly sym: SymbolInfo,
    /** Bar magnifier: the lower-timeframe bars inside each chart bar (by chart bar index). A bar without them
     *  uses its own OHLC path. */
    private readonly intrabars?: readonly (readonly Bar[] | undefined)[],
  ) {}

  // ------------------------------------------------------------ script API

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

  entry(id: string, direction: Direction, opts: EntryOptions = {}): void {
    this.placeEntry(id, direction, opts, false, 'strategy.entry');
  }

  /** strategy.order: a raw order, not limited by pyramiding; it reduces an opposite position first. */
  order(id: string, direction: Direction, opts: EntryOptions = {}): void {
    this.placeEntry(id, direction, opts, true, 'strategy.order');
  }

  private placeEntry(id: string, direction: Direction, opts: EntryOptions, isOrder: boolean, fn: string): void {
    if (opts.when === false) return;
    const limit = val(opts.limit);
    const stop = val(opts.stop);
    if (limit !== null && stop !== null) throw new Error(`${fn}("${id}"): stop-limit orders are not supported`);
    const buy = direction === 'long';
    const orderPrice = stop !== null ? this.roundOrderPrice(stop, buy, true) : limit !== null ? this.roundOrderPrice(limit, buy, false) : null;
    const explicit = val(opts.qty);
    const sizePrice = this.sizingPrice(buy, orderPrice, stop !== null);
    let qty: number;
    try {
      qty = explicit !== null ? this.checkQty(explicit, fn) : this.defaultQty(sizePrice, fn);
    } catch (e) {
      // A limit order with no valid default size (price at zero or below, equity below zero) is no order and no
      // error in the reference app (pivot-points: levels below zero, and no trade once the capital is lost), where
      // a stop or market order stops the script (RE10024, RE10141).
      if (!(e instanceof StrategyRuntimeError) || explicit !== null || limit === null) throw e;
      this.entries.delete(id);
      return;
    }
    const prev = this.entries.get(id);
    const pos = this.positionSize;
    // A stop / limit entry is checked when it is placed, not when it fills: the pyramiding limit and the funds
    // for its own quantity at the price it was sized at. Once placed it fills whatever the position is by then
    // (pivot-points SPY 1h: a 6th entry at bar 3350, then the margin call; bar 1991: not placed, never filled).
    if (!isOrder && orderPrice !== null) {
      if (!this.canEnter(direction)) return;
      const reverses = pos !== 0 && (pos > 0) !== buy;
      // The open trades count at the current close (SPY 4h bar 869: 16 at 106.02 placed with 78 short at 103.82).
      const close = this.roundPrice(this.bars[this.bar].close);
      if (qty > 0 && !this.fundsCover(direction, qty, sizePrice, reverses, this.equity, close)) return;
    }
    // A stop / limit entry is placed against the position expected once the market orders already placed have
    // filled (a market buy of 10 then a sell limit entry of 5 in one script run: 15 sold; the limit entry called
    // first: 5; a close order called before it takes the position out, one called after does not).
    const against = orderPrice === null ? pos : this.expectedPosition();
    const reverseQty = !isOrder && against !== 0 && (against > 0) !== buy ? Math.abs(against) : 0;
    this.entries.set(id, {
      sizePrice,
      placedClose: this.roundPrice(this.bars[this.bar].close),
      reverseQty,
      kind: 'entry',
      isOrder,
      // A call that changes the quantity (the position it was placed against included) or the price on the tick
      // grid makes a new order, behind the ones already placed; a new price on the same tick keeps the order's
      // place (three buy limits on one tick: a, b, c fill in that order, b, c, a once a is called again with
      // another quantity or from another tick).
      seq: prev && prev.qty + prev.reverseQty === qty + reverseQty && prev.level === orderPrice ? prev.seq : ++this.seq,
      level: orderPrice,
      id,
      direction,
      qty,
      limit,
      stop,
      // An empty comment shows the order id (four-wma-tp-sl, mean-reversion-vf).
      comment: opts.comment || id,
    });
  }

  /** The position once the pending market orders (closes and market entries, in placement order) have filled. */
  private expectedPosition(): number {
    let pos = this.positionSize;
    const market: (EntryOrder | CloseOrder)[] = [...this.closes];
    for (const e of this.entries.values()) if (e.limit === null && e.stop === null) market.push(e);
    if (!market.length) return pos;
    market.sort((a, b) => a.seq - b.seq);
    // Quantity left per entry id for the close orders.
    const left = new Map<string, number>();
    for (const t of this.openTrades) left.set(t.entryId, (left.get(t.entryId) ?? 0) + (t.direction === 'long' ? t.qty : -t.qty));
    for (const o of market) {
      if (o.kind === 'close') {
        const held = o.entryId === null ? pos : (left.get(o.entryId) ?? 0);
        const size = Math.abs(held);
        const q = o.qty !== null ? Math.min(o.qty, size) : o.qtyPercent !== null ? this.floorQty((size * o.qtyPercent) / 100) : size;
        const signed = Math.sign(held) * q;
        pos -= signed;
        if (o.entryId === null) left.clear();
        else left.set(o.entryId, held - signed);
      } else {
        const signed = o.direction === 'long' ? o.qty : -o.qty;
        if (o.isOrder || pos === 0 || pos > 0 === signed > 0) pos += signed;
        else {
          pos = signed;
          left.clear();
        }
      }
    }
    return pos;
  }

  close(id: string, opts: CloseOptions = {}): void {
    if (opts.when === false) return;
    if (!this.openTrades.some((t) => t.entryId === id)) return;
    this.closes.push({
      kind: 'close',
      seq: ++this.seq,
      orderId: `Close entry(s) order ${id}`,
      entryId: id,
      qty: opts.qty ?? null,
      qtyPercent: opts.qtyPercent ?? null,
      comment: opts.comment || `Close entry(s) order ${id}`,
    });
  }

  closeAll(opts: { comment?: string; when?: boolean } = {}): void {
    if (opts.when === false) return;
    if (this.openTrades.length === 0) return;
    this.closes.push({
      kind: 'close',
      seq: ++this.seq,
      orderId: 'Close position order',
      entryId: null,
      qty: null,
      qtyPercent: null,
      comment: opts.comment || 'Close position order',
    });
  }

  exit(id: string, opts: ExitOptions = {}): void {
    if (opts.when === false) return;
    // An exit applies to the trades open and the entry orders pending when it is called: a call with no trade and
    // no order of `from_entry` is no order (an exit called before its entry, also in the same script run, never
    // fills; a later trade of an id that had one at the call gets its leg).
    const from = opts.fromEntry ?? '';
    const known = (t: { entryId: string }) => from === '' || t.entryId === from;
    if (!this.openTrades.some(known) && !this.displaced.some(known) && !(from === '' ? this.entries.size > 0 : this.entries.has(from))) {
      this.exits.delete(id);
      return;
    }
    const prev = this.exits.get(id);
    const comment = opts.comment || id;
    this.exits.set(id, {
      kind: 'exit',
      seq: prev?.seq ?? ++this.seq,
      legSeq: prev?.legSeq ?? this.seq,
      attached: false,
      id,
      fromEntry: opts.fromEntry ?? '',
      qty: val(opts.qty),
      qtyPercent: val(opts.qtyPercent),
      profit: val(opts.profit),
      loss: val(opts.loss),
      limit: val(opts.limit),
      stop: val(opts.stop),
      trailPoints: val(opts.trailPoints),
      trailPrice: val(opts.trailPrice),
      trailOffset: val(opts.trailOffset),
      comment,
      commentProfit: opts.commentProfit || comment,
      commentLoss: opts.commentLoss || comment,
      commentTrailing: opts.commentTrailing || comment,
    });
    for (const t of this.openTrades) t.exitsDropped.delete(id);
    this.updateLegOrder(id, prev);
  }

  /**
   * Fill order of the legs (one per open trade) of exit `id`. When the call changes the tick-rounded limit or
   * stop, the legs are re-created in hash order of their entry id (a 16-bucket table of String.hashCode) and take
   * the current trade quantity; otherwise they keep their place and legs of new trades go last. 1,626 of 1,626
   * exit groups on 14 runs (mean-reversion-vf, tomukas-scale-in).
   */
  private updateLegOrder(id: string, prev: ExitOrder | undefined): void {
    const x = this.exits.get(id)!;
    const matching = this.openTrades.filter((t) => x.fromEntry === '' || x.fromEntry === t.entryId);
    const buy = matching.length ? matching[0].direction === 'short' : false;
    const level = (v: number | null, isStop: boolean) => (v === null ? null : this.roundOrderPrice(v, buy, isStop));
    const changed = !prev || level(prev.limit, false) !== level(x.limit, false) || level(prev.stop, true) !== level(x.stop, true);
    if (changed) {
      if (prev) x.legSeq = ++this.seq;
      for (const t of matching) t.exitQty.delete(id);
      const bucket = (text: string) => {
        let h = 0;
        for (let k = 0; k < text.length; k++) h = (Math.imul(31, h) + text.charCodeAt(k)) | 0;
        return ((h ^ (h >>> 16)) & 15) >>> 0;
      };
      this.legOrder.set(
        id,
        matching
          .map((t, k) => ({ t, k }))
          .sort((a, b) => bucket(a.t.entryId) - bucket(b.t.entryId) || a.k - b.k)
          .map((e) => e.t),
      );
    } else {
      const cur = this.activeLegs(id);
      for (const t of matching) if (!cur.includes(t)) cur.push(t);
      this.legOrder.set(id, cur);
    }
  }

  /** Legs of exit `id` still to fill: open trades, and trades another leg closed that keep their own leg. */
  private activeLegs(id: string): OpenTrade[] {
    return (this.legOrder.get(id) ?? []).filter(
      (t) => !t.exitsDone.has(id) && !t.exitsDropped.has(id) && t.lotQty > EPS && (this.openTrades.includes(t) || this.displaced.includes(t)),
    );
  }

  cancel(id: string): void {
    this.entries.delete(id);
    this.exits.delete(id);
  }

  cancelAll(): void {
    this.entries.clear();
    this.exits.clear();
    // A margin call that waits for this script run is an order too: it is cancelled, its number is used.
    if (this.deferredCalls.length) {
      if (this.positionSize !== 0) this.marginCalls += this.deferredCalls.length;
      this.deferredCalls = [];
    }
  }

  // ------------------------------------------------------------ emulation

  /** Fill the orders placed before bar `i` along bar i's price path. */
  processBar(i: number): void {
    this.scriptEquity = i > 0 ? this.equity : this.props.initialCapital;
    this.scriptPos = this.positionSize;
    this.scriptClose = i > 0 ? this.roundPrice(this.bars[i - 1].close) : 0;
    if (i > 0) this.fillDeferredCalls(this.roundPrice(this.bars[i - 1].close));
    // The funds are checked once more after the script run of the last bar, at its close: that margin call
    // fills at this open, after the script's market orders (5 margin call numbers per bar, the last one filled
    // at the next open).
    if (i > 0) this.checkMargin(this.roundPrice(this.bars[i - 1].close), undefined, true);
    this.bar = i;
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
    this.touchEquity(open);
    this.fillMarketOrders(open);
    this.touchTrades(open, first.open, held.filter((t) => this.openTrades.includes(t)));
    let cur = open;
    this.fillAt(cur, first.open);
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
        this.fillPendingCalls(o);
        this.checkMargin(o);
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
        cur = to;
        this.touch(to, raw);
        // A margin call that waits for the bar's last tick fills after the script run (see fillDeferredCalls).
        if (n === path.length - 1 && !(sub && sub.length)) this.deferPendingCalls();
        else this.fillPendingCalls(to);
        this.checkMargin(to);
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
      this.checkMargin(close);
    }
  }

  /** Flat: exit orders that no pending entry can open a trade for are dropped. */
  private dropOrphanExits(): void {
    if (this.openTrades.length || !this.exits.size) return;
    for (const [id, x] of this.exits) {
      const used = [...this.entries.values()].some((e) => x.fromEntry === '' || e.id === x.fromEntry);
      if (!used) this.exits.delete(id);
    }
  }

  /** process_orders_on_close: fill the orders just placed at bar i's close. */
  processClose(i: number): void {
    this.bar = i;
    this.scriptEquity = this.equity;
    const close = this.roundPrice(this.bars[i].close);
    this.scriptPos = this.positionSize;
    this.scriptClose = close;
    this.touch(close, this.bars[i].close);
    this.fillMarketOrders(close);
    this.fillAt(close, this.bars[i].close);
    // Trades filled at this close see the close as their first price after the fill.
    this.touch(close, this.bars[i].close);
    this.checkMargin(close);
  }

  /** Market orders (market entries and closes) in the order they were placed. */
  private fillMarketOrders(base: number): void {
    const market: (EntryOrder | CloseOrder | MarginCallOrder)[] = [...this.closes, ...this.pendingCalls];
    for (const e of this.entries.values()) if (e.limit === null && e.stop === null) market.push(e);
    market.sort((a, b) => a.seq - b.seq);
    this.closes = [];
    this.pendingCalls = [];
    // A close order after a market entry of the same batch does not fill, whether the entry filled or was
    // rejected (strategy.order then strategy.close: bb-mean-reversion; a rejected reversal then strategy.close:
    // rsi-volume-macd-ema).
    let afterEntry = false;
    for (const o of market) {
      if (o.kind === 'call') {
        this.fillMarginCall(o, base);
      } else if (o.kind === 'entry') {
        this.entries.delete(o.id);
        this.fillEntry(o, this.slip(base, o.direction === 'long'), 'MARKET');
        afterEntry = true;
      } else if (!afterEntry) {
        this.fillClose(o, this.slip(base, this.positionSize < 0));
      }
    }
  }

  /**
   * Fill every price order already crossed at price p (gaps, new brackets). p was touched by the caller.
   * `reached`: p is the trigger the path just reached (walk), not a jump to it.
   */
  private fillAt(p: number, raw = p, reached = false): void {
    const market = this.roundPrice(p);
    for (let guard = 0; guard < 1000; guard++) {
      const hit = this.priceOrders()
        .filter((o) => (o.buy === o.isStop ? p >= o.trigger - EPS : p <= o.trigger + EPS))
        // Several orders crossed at once (gap): the one closest to the price fills first
        // (the reference app: a 0.26 sell limit before a 0.24 one on a 0.31 open).
        .sort((a, b) => Math.abs(p - a.level) - Math.abs(p - b.level) || a.seq - b.seq);
      let filled = false;
      for (const o of hit) {
        // On the path, a limit whose trigger (N ticks beyond it, fill assumption) is the price reached fills at
        // its level; a jump (gap) fills at the price.
        const price = o.isStop ? this.slip(market, o.buy) : reached && Math.abs(o.trigger - market) < EPS ? o.level : market;
        if (o.fill(price, raw)) {
          filled = true;
          break;
        }
      }
      if (!filled) return;
    }
  }

  /** Move the price from `from` to `to`, filling orders at their level. */
  private walk(from: number, to: number): void {
    const up = to > from;
    let cur = from;
    for (let guard = 0; guard < 1000; guard++) {
      const hit = this.priceOrders()
        .filter((o) => {
          const triggersUp = o.buy === o.isStop; // buy stop, sell limit
          if (triggersUp !== up) return false;
          return up ? o.trigger > cur + EPS && o.trigger <= to + EPS : o.trigger < cur - EPS && o.trigger >= to - EPS;
        })
        .sort((a, b) => (up ? a.trigger - b.trigger : b.trigger - a.trigger) || a.seq - b.seq);
      let filled = false;
      for (const o of hit) {
        // A limit order fills at its level, also when the price had to go beyond it (fill assumption).
        const price = o.isStop ? this.slip(o.level, o.buy) : o.level;
        // Trades see the order level, not the price beyond it that triggered a limit (fill assumption).
        this.touch(o.level);
        if (o.fill(price, o.trigger)) {
          cur = o.trigger;
          filled = true;
          this.fillAt(cur, cur, true);
          break;
        }
      }
      if (!filled) return;
    }
  }

  /** Active stop / limit orders: pending entries and exit brackets of open trades. */
  private priceOrders(): PriceOrder[] {
    const out: PriceOrder[] = [];
    for (const e of this.entries.values()) {
      if (e.limit === null && e.stop === null) continue;
      // Several entries fill on one bar, in either direction, stop or limit: pyramiding ones (pivot-points SPY 4h
      // bar 29), one against the trade just opened (a buy at 43.84, then a sell limit entry at 43.87 or a sell stop
      // entry at 43.60 on the same bar).
      const buy = e.direction === 'long';
      const isStop = e.stop !== null;
      const level = this.roundOrderPrice((isStop ? e.stop : e.limit) as number, buy, isStop);
      out.push({
        seq: e.seq,
        buy,
        isStop,
        level,
        trigger: isStop ? level : this.limitTrigger(level, buy),
        fill: (price) => {
          this.entries.delete(e.id);
          this.fillEntry(e, price, isStop ? 'STOP' : 'LIMIT');
          return true;
        },
      });
    }
    // Exits reserve the trade quantity in creation order: a later exit gets what the earlier ones leave
    // (btc-intraday-spot: "BE" never fills while "TP2" holds the rest; Pine User Manual, multi-level exits).
    const reserved = new Map<OpenTrade, number>();
    for (const x of this.exits.values()) {
      const order = this.activeLegs(x.id);
      const rest = [...this.openTrades, ...this.displaced].filter((t) => t.lotQty > EPS && !order.includes(t));
      const legTrades = [...order, ...rest];
      for (const t of legTrades) {
        if (x.fromEntry !== '' && x.fromEntry !== t.entryId) continue;
        if (t.exitsDone.has(x.id) || t.exitsDropped.has(x.id)) continue;
        let qty = t.exitQty.get(x.id);
        if (qty === undefined) {
          // qty_percent counts on the quantity filled at the entry.
          qty = x.qty !== null ? x.qty : x.qtyPercent !== null ? this.floorQty((t.filledQty * x.qtyPercent) / 100) : t.lotQty;
          t.exitQty.set(x.id, qty);
        }
        x.attached = true;
        const taken = reserved.get(t) ?? 0;
        qty = Math.min(qty, t.lotQty - taken);
        reserved.set(t, taken + Math.max(qty, 0));
        if (qty <= 0) continue;
        const buy = t.direction === 'short';
        const sign = t.direction === 'long' ? 1 : -1;
        const tick = this.sym.mintick;
        const limit = x.limit ?? (x.profit !== null ? t.price + sign * x.profit * tick : null);
        const stop = x.stop ?? (x.loss !== null ? t.price - sign * x.loss * tick : null);
        const q = qty;
        const fill = (price: number, type: OrderType, comment: string) => {
          // The leg closes its quantity from the oldest trades first (FIFO), not from its own trade.
          let rest = Math.min(q, this.openTrades.reduce((a, u) => a + u.qty, 0));
          const filled = rest;
          t.exitsDone.add(x.id);
          t.trail.delete(x.id);
          for (const u of [...this.openTrades]) {
            if (rest <= 0) break;
            const c = Math.min(rest, u.qty);
            this.closeTradeQty(u, c, price, comment, false, true);
            if (!this.openTrades.includes(u) && u.lotQty > EPS && u !== t) this.displaced.push(u);
            rest -= c;
          }
          t.lotQty = Math.max(0, t.lotQty - filled);
          if (!this.openTrades.includes(t) && t.lotQty > EPS && !this.displaced.includes(t)) this.displaced.push(t);
          this.recordFill(x.id, comment, buy, false, price, filled, type);
          return true;
        };
        const push = (isStop: boolean, level: number, f: (p: number, raw: number) => boolean, trigger = level) => {
          // A leg is as old as its exit call or its entry fill, the later of the two: the exits of entries
          // filled after the call fill in entry order (pivot-points SPY 1h bar 699).
          if (Number.isFinite(level)) out.push({ seq: Math.max(x.legSeq, t.fillSeq), buy, isStop, level, trigger, fill: f });
        };
        if (limit !== null) {
          const level = this.roundOrderPrice(limit, buy, false);
          push(false, level, (p) => fill(p, 'LIMIT', x.commentProfit), this.limitTrigger(level, buy));
        }
        if (stop !== null) push(true, this.roundOrderPrice(stop, buy, true), (p) => fill(p, 'STOP', x.commentLoss));
        if (x.trailOffset !== null && (x.trailPoints !== null || x.trailPrice !== null)) {
          const best = t.trail.get(x.id);
          if (best === undefined) {
            // Activation: the price reaches trail_price, or entry + trail_points (it moves like a limit order).
            const activation = x.trailPrice ?? t.price + sign * (x.trailPoints as number) * tick;
            push(false, this.roundOrderPrice(activation, buy, false), (_p, raw) => {
              // The best price starts at the exact price reached (the exact open on a gap).
              t.trail.set(x.id, raw);
              return true;
            });
          } else {
            // trail_offset counts whole ticks (0.76 tick behaves as 0: exit at the best price).
            const trailStop = best - sign * Math.trunc(x.trailOffset) * tick;
            // Rounded like a stop order (away from the market): 141.6875 - 0.10 gives 141.58.
            push(true, this.roundOrderPrice(trailStop, buy, true), (p) => fill(p, 'STOP', x.commentTrailing));
          }
        }
      }
    }
    return out;
  }

  /** Price a limit order at `level` needs to fill: `fillLimitsTicks` ticks beyond it (below for a buy). */
  private limitTrigger(level: number, buy: boolean): number {
    const n = this.props.fillLimitsTicks;
    if (!n) return level;
    const k = Math.round(level / this.sym.mintick);
    return this.ticks(buy ? k - n : k + n);
  }

  private canEnter(direction: Direction): boolean {
    const pos = this.positionSize;
    if (pos === 0 || (pos > 0) !== (direction === 'long')) return true;
    const same = this.openTrades.filter((t) => t.direction === direction).length;
    return same < Math.max(1, this.props.pyramiding);
  }

  private fillEntry(o: EntryOrder, price: number, type: OrderType): void {
    if (o.isOrder) return this.fillOrder(o, price, type);
    if (type === 'MARKET' && !this.canEnter(o.direction)) return;
    const buy = o.direction === 'long';
    const pos = this.positionSize;
    // A zero quantity (e.g. cash sizing below one share) only closes an opposite position.
    if (o.qty <= 0 && (pos === 0 || (pos > 0) === buy)) return;
    const reverses = pos !== 0 && (pos > 0) !== buy;
    // The reversal part is fixed at placement: an entry placed against a position that closed before the fill
    // opens its quantity plus that position (pivot-points SPY 15m trade 9: 4 + 8 = 12).
    // It is also added to an entry that pyramids (pivot-points SPY 1h trade 12: 8 + 8 = 16 on an open short).
    // A stop / limit entry keeps the quantity it was placed with (its own plus the position it was placed against):
    // one placed while flat only closes the position opened since (pivot-points SPY 15m trade 74: 3 sold, no short).
    // A market entry closes the position at its fill and opens its own quantity.
    const total = o.qty + o.reverseQty;
    const fixed = reverses && type !== 'MARKET';
    let qty = type === 'MARKET' ? o.qty : !reverses ? total : Math.max(0, total - Math.abs(pos));
    if (qty <= 0 && (pos === 0 || (pos > 0) === buy)) return;
    // Stop / limit entries were checked at placement (see placeEntry): they fill, and the margin call follows on
    // the same tick (pivot-points SPY 1h bar 1533: 9 + 16 bought on a full position, 28 sold by the margin call).
    if (qty > 0 && type === 'MARKET') {
      // Own quantity too large for the equity at the close it was placed on: the order only closes.
      if (!this.ownFits(o)) {
        if (!reverses) return;
        qty = 0;
      }
      // Not enough funds: the order is not filled at all (a reversal keeps the open position).
      if (!this.marketFundsCover(o, (reverses ? Math.abs(pos) : 0) + qty, price)) return;
    }
    let closed = 0;
    if (reverses) {
      const ids = new Set<string>();
      let left = fixed ? Math.min(total, Math.abs(pos)) : Math.abs(pos);
      for (const t of [...this.openTrades]) {
        if (left <= EPS) break;
        const c = Math.min(left, t.qty);
        left -= c;
        closed += c;
        if (c >= t.qty - EPS) ids.add(t.entryId);
        this.closeTradeQty(t, c, price, o.comment, type === 'MARKET');
      }
      // The reversal cancels the exits of the entries it closed: the ones live on a trade, also when an entry of
      // that id is pending again (its next trade has no exit until the exit is called again), and the ones with
      // no pending entry left. An entry with a trade still open keeps its exits (a sell limit entry that closes
      // the first of two `long1` trades: `close long1` fills on the same tick).
      for (const t of this.openTrades) ids.delete(t.entryId);
      for (const [xid, x] of this.exits) {
        if (x.fromEntry !== '' && ids.has(x.fromEntry) && (x.attached || !this.entries.has(x.fromEntry))) this.exits.delete(xid);
      }
    }
    if (qty > 0) this.openTrade({ ...o, qty }, price);
    this.recordFill(o.id, o.comment, buy, true, price, closed + qty, type);
  }

  /** strategy.order fill: closes opposite trades first (FIFO), the rest opens a trade. Reported with entry = null. */
  private fillOrder(o: EntryOrder, price: number, type: OrderType): void {
    const buy = o.direction === 'long';
    let left = o.qty;
    for (const t of [...this.openTrades]) {
      if (left <= 0 || (t.direction === 'long') === buy) continue;
      const q = Math.min(left, t.qty);
      left -= q;
      this.closeTradeQty(t, q, price, o.comment, type === 'MARKET');
    }
    let filled = o.qty;
    if (left > 0) {
      if (this.fundsCover(o.direction, left, Math.max(price, o.sizePrice))) this.openTrade({ ...o, qty: left }, price);
      else filled -= left;
    }
    if (filled > 0) this.recordFill(o.id, o.comment, buy, null, price, filled, type);
  }

  private marginRatio(direction: Direction): number {
    return (direction === 'long' ? this.props.marginLong : this.props.marginShort) / 100;
  }

  /**
   * Margin: a new trade of `qty` in `direction` at `price` fits in the available funds: the equity at the
   * last script run minus the margin of the open trades (none when the fill closes them first). Always
   * true without margin.
   */
  private fundsCover(direction: Direction, qty: number, price: number, closesOpenTrades = false, equity = this.scriptEquity, mark = price): boolean {
    const ratio = this.marginRatio(direction);
    if (ratio <= 0) return true;
    const pv = this.sym.pointValue;
    let used = 0;
    if (!closesOpenTrades) for (const t of this.openTrades) used += t.qty * mark * pv * this.marginRatio(t.direction);
    const available = equity - used;
    return qty * price * pv * ratio <= available;
  }

  /** Margin: the own quantity of market entry `o` fits in the equity at the close it was placed on (no slippage). */
  private ownFits(o: EntryOrder): boolean {
    const ratio = this.marginRatio(o.direction);
    return ratio <= 0 || o.qty * o.placedClose * this.sym.pointValue * ratio <= this.scriptEquity;
  }

  /**
   * Margin: a market entry that fills `fillQty` (its own quantity plus the opposite position it closes) is checked
   * against the state at the last script run, not the state at the fill: the position there plus this fill gives
   * the position to fund. The part already held then counts at that close, the new part at the higher of the
   * fill price and the price at placement (the close with the slippage for a buy, the close for a sell).
   */
  private marketFundsCover(o: EntryOrder, fillQty: number, price: number): boolean {
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
    return held * this.scriptClose * pv * ratio + (Math.abs(after) - held) * checkPrice * pv * ratio <= this.scriptEquity;
  }

  /** Margin call at price p (a point of the intrabar path), Pine's algorithm; it fills at `fill` (default p, see
   *  processBar for the chart open with lower-timeframe bars), or at the next open when `atClose`. */
  private checkMargin(p: number, fill = p, atClose = false): void {
    const call = this.marginCallAt(p, this.props.initialCapital + this.netProfit);
    if (!call) return;
    if (atClose) this.pendingCalls.push(call);
    else this.fillMarginCall(call, fill);
  }

  /**
   * The margin call the funds ask for with the open trades marked at price p, or null. `realized`: the capital
   * plus the net profit counted.
   */
  private marginCallAt(p: number, realized: number): MarginCallOrder | null {
    const pos = this.positionSize;
    if (pos === 0) return null;
    const long = pos > 0;
    const ratio = this.marginRatio(long ? 'long' : 'short');
    if (ratio <= 0) return null;
    const pv = this.sym.pointValue;
    // No call can be sized at a price of 0 (the check after a trade closed at 0, slippage as large as the price).
    if (!(p > 0)) return null;
    // Pine's order of operations (the binary noise decides the calls at 0 available funds, a 100 % long):
    // open profit = MVS - money spent, available = equity - MVS * margin ratio.
    const mvs = Math.abs(pos) * p * pv;
    let spent = 0;
    for (const t of this.openTrades) spent += t.qty * t.price * pv;
    const openProfit = long ? mvs - spent : spent - mvs;
    const equity = realized + openProfit;
    const available = equity - mvs * ratio;
    if (available >= 0) return null;
    const loss = available / ratio;
    const step = this.sym.qtyStep;
    const cover = Math.trunc(Math.abs(loss / (p * pv)) / step) * step;
    return { kind: 'call', seq: ++this.seq, size: cover > 0 ? cover * 4 : step, equity };
  }

  /**
   * A margin call made by the fill of another one waits for the next tick. When that tick is the bar's last one
   * (the close), it fills there but after the script run of the bar: the script sees the position before it, and
   * strategy.cancel_all() cancels it (its number is used). Shorts of 1,349 and 2,592, a call of 3,208 at the high
   * of a bar that closes there: 733 more in a strategy that does not call cancel_all, none in one that does.
   */
  private deferPendingCalls(): void {
    if (!this.pendingCalls.length) return;
    this.deferredCalls.push(...this.pendingCalls);
    this.pendingCalls = [];
  }

  /** Fill the margin calls that waited for the script run of the last bar, at its close (`this.bar` is still it). */
  private fillDeferredCalls(close: number): void {
    if (!this.deferredCalls.length) return;
    const calls = this.deferredCalls;
    this.deferredCalls = [];
    for (const c of calls) this.fillMarginCall(c, close);
  }

  /** Margin calls made by the fill of another one fill at the next tick. */
  private fillPendingCalls(p: number): void {
    if (!this.pendingCalls.length) return;
    const calls = this.pendingCalls;
    this.pendingCalls = [];
    for (const c of calls) this.fillMarginCall(c, p);
  }

  /** Fill a margin call at tick price p: a market order, oldest trade first. */
  private fillMarginCall(call: MarginCallOrder, p: number): void {
    const pos = this.positionSize;
    // No position left for it (the call that made it closed the rest): no order, no number. A call that waited
    // for this tick closes the position it finds, also one on the other side opened since (a call of 4,856 made
    // while short, then two buy limits: 4,856 of the new long sold at the next tick).
    if (pos === 0) return;
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
      const before = this.props.initialCapital + this.netProfit;
      this.closeTradeQty(t, q, fill, 'Margin call', true);
      // The equity after the fill marks the trades left at the tick price, not at the fill price with the
      // slippage (largest drawdown percent of a history with calls filled at 0).
      const event = this.equityEvents[this.equityEvents.length - 1];
      event.marginCall = true;
      event.v = this.props.initialCapital + this.netProfit + this.openProfitAt(p);
      next = this.marginCallAt(fill, before) ?? next;
    }
    if (next) this.pendingCalls.push(next);
    // The trades left open see the fill price (pivot-points SPY 1h bar 8648: the share closed at the next tick
    // counts the 308.62 of the first margin call in its drawdown).
    this.touchTrades(fill, fill, this.openTrades);
    this.recordFill(id, 'Margin call', !long, null, fill, size, 'MARKET');
  }

  /** Returns true when the order filled. */
  private fillClose(o: CloseOrder, price: number): boolean {
    const targets = this.openTrades.filter((t) => o.entryId === null || t.entryId === o.entryId);
    if (targets.length === 0) return false;
    const total = targets.reduce((s, t) => s + t.qty, 0);
    let left = o.qty !== null ? Math.min(o.qty, total) : o.qtyPercent !== null ? this.floorQty((total * o.qtyPercent) / 100) : total;
    const buy = targets[0].direction === 'short';
    const qty = left;
    for (const t of targets) {
      if (left <= 0) break;
      const q = Math.min(left, t.qty);
      left -= q;
      this.closeTradeQty(t, q, price, o.comment, true);
    }
    this.recordFill(o.orderId, o.comment, buy, false, price, qty, 'MARKET');
    return true;
  }

  private openTrade(o: EntryOrder, price: number): void {
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
  private closeTradeQty(t: OpenTrade, qty: number, price: number, signal: string, market = false, byLeg = false): void {
    if (qty <= 0) return;
    // An exit leg takes its quantity from its own entry fill (see the leg fill); any other close from this trade,
    // first from the part a margin call that did not fill left without a leg.
    if (!byLeg) {
      const noLeg = Math.min(t.callQty, qty);
      t.callQty -= noLeg;
      t.lotQty = Math.max(0, t.lotQty - (qty - noLeg));
    }
    const share = qty / t.qty;
    const entryCm = t.entryCommission * share;
    const exitCm = this.commission(qty, price);
    const trade = this.makeTrade(t, qty, price, signal, entryCm, exitCm, false, market);
    this.netProfit += trade.profit + entryCm;
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
    this.equityEvents.push({
      t: 'c',
      v: this.props.initialCapital + this.netProfit + this.openProfitAt(price),
      flat: this.openTrades.length === 0,
      realized: this.props.initialCapital + this.netProfit,
    });
  }

  private makeTrade(t: OpenTrade, qty: number, price: number, signal: string, entryCm: number, exitCm: number, open: boolean, market = false): Trade {
    const sign = t.direction === 'long' ? 1 : -1;
    const pv = this.sym.pointValue;
    const cost = t.price * qty * pv + entryCm;
    const profit = sign * (price - t.price) * qty * pv - entryCm - exitCm;
    // The exit fill price (slippage included) is part of the trade's range: always for a market exit (a trade
    // reversed or margin-called at its fill: pivot-points, rsi-mean-reversion), after prices seen for a price
    // order exit (a stop at the entry open: 0, triple-ema-trend).
    const counted = !open && (market || Number.isFinite(t.high));
    const high = counted ? Math.max(t.high, price) : t.high;
    const low = counted ? Math.min(t.low, price) : t.low;
    const seen = Number.isFinite(high);
    const best = t.direction === 'long' ? high : low;
    const worst = t.direction === 'long' ? low : high;
    // Excursions include the entry commission, floored at 0.
    const favorable = seen ? sign * (best - t.price) : 0;
    const adverse = seen ? -sign * (worst - t.price) : 0;
    const runUp = seen ? Math.max(0, favorable * qty * pv - entryCm) : 0;
    const drawdown = seen ? Math.max(0, adverse * qty * pv + entryCm) : 0;
    return {
      direction: t.direction,
      entryId: t.entryId,
      entry: { signal: t.signal, price: t.price, bar: t.bar, time: this.bars[t.bar].time * 1000 },
      exit: { signal: open ? '' : signal, price, bar: this.bar, time: this.bars[this.bar].time * 1000 },
      open,
      qty,
      profit,
      profitPercent: profit / cost,
      // An open trade reports its entry commission only; its profit deducts the exit commission too.
      commission: open ? entryCm : entryCm + exitCm,
      entryCommission: entryCm,
      runUp,
      runUpPercent: runUp / cost,
      drawdown,
      drawdownPercent: drawdown / cost,
      cumProfit: 0,
      profitPercentOfEquity: 0,
    };
  }

  /** Open trades marked at the last close (exit commission included, like the reference app report). */
  openTradeReports(): Trade[] {
    const close = this.roundPrice(this.bars[this.bar].close);
    return this.openTrades.map((t) => {
      const tr = this.makeTrade(t, t.qty, close, '', t.entryCommission, this.commission(t.qty, close), true);
      tr.cumProfit = this.netProfit + tr.profit;
      tr.profitPercentOfEquity = tr.profit / Math.abs(this.props.initialCapital + this.netProfit);
      return tr;
    });
  }

  openProfitAt(price: number): number {
    let s = 0;
    for (const t of this.openTrades) s += (t.direction === 'long' ? 1 : -1) * (price - t.price) * t.qty * this.sym.pointValue;
    return s;
  }

  /** Record a price reached on the path (equity events, trade excursions). */
  private touch(p: number, raw = p): void {
    this.touchEquity(p);
    this.touchTrades(p, raw, this.openTrades);
  }

  private touchEquity(p: number): void {
    const r = this.roundPrice(p);
    if (this.openTrades.length) {
      this.equityEvents.push({
        t: 'p',
        v: this.props.initialCapital + this.netProfit + this.openProfitAt(r),
        flat: false,
        realized: this.props.initialCapital + this.netProfit,
      });
    }
  }

  private touchTrades(p: number, raw: number, trades: OpenTrade[]): void {
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

  private recordFill(id: string, comment: string, buy: boolean, entry: boolean | null, price: number, qty: number, type: OrderType): void {
    this.filledOrders.push({ bar: this.bar, time: this.bars[this.bar].time * 1000, id, comment, buy, entry, price, qty, type });
    // Pending strategy.exit orders are cancelled when a fill leaves the position flat. An exit still waiting for
    // its entry to fill stays (pivot-points SPY 15m: the exit of a limit entry placed while the opposite position
    // was open); one that was live on the closed position goes, whatever entries are pending (st-greed).
    if (this.openTrades.length === 0) {
      this.displaced = [];
      for (const [id, x] of this.exits) if (x.attached) this.exits.delete(id);
      this.dropOrphanExits();
    }
  }

  // ------------------------------------------------------------ sizing, costs, rounding

  /** Explicit qty: RE10024 when negative, rounded down to the quantity step. */
  private checkQty(q: number, fn: string): number {
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
  private sizingPrice(buy: boolean, orderPrice: number | null, isStop: boolean): number {
    const close = this.roundPrice(this.bars[this.bar].close);
    let base = close;
    if (orderPrice !== null) {
      const higher = buy === isStop; // buy stop / sell limit fill at or above their price
      base = higher ? Math.max(orderPrice, close) : Math.min(orderPrice, close);
    }
    return orderPrice === null || isStop ? this.slip(base, buy) : base;
  }

  private defaultQty(price: number, fn: string): number {
    const p = this.props;
    if (p.defaultQtyType === 'fixed') return this.checkQty(p.defaultQtyValue, fn);
    // Equity without binary noise (65828.48, not 65828.47999999998): on an exact share
    // boundary the reference app's floor behaves like the decimal value (3 cases checked).
    const equity = Number(this.equity.toFixed(10));
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

  private commission(qty: number, price: number): number {
    const p = this.props;
    switch (p.commissionType) {
      case 'percent':
        return (qty * price * this.sym.pointValue * p.commissionValue) / 100;
      case 'cash_per_contract':
        return qty * p.commissionValue;
      case 'cash_per_order':
        return p.commissionValue;
    }
  }

  /** price is on the tick grid; slippage moves it against the trader. */
  private slip(price: number, buy: boolean): number {
    const n = Math.round(price / this.sym.mintick);
    return this.ticks(buy ? n + this.props.slippage : n - this.props.slippage);
  }

  private floorQty(q: number): number {
    const step = this.sym.qtyStep;
    // Plain floor on the binary value, as the reference app (822855.9999... gives 822855).
    return Math.max(0, Math.floor(q / step) * step);
  }

  /** Nearest tick, on the exact binary value (148.045 -> 148.04, 161.145 -> 161.15, as the reference app). */
  roundPrice(p: number): number {
    return this.ticks(Math.round(p / this.sym.mintick));
  }

  /** Order prices are rounded away from the market: buy stop / sell limit up, sell stop / buy limit down. */
  private roundOrderPrice(p: number, buy: boolean, isStop: boolean): number {
    const n = p / this.sym.mintick;
    return this.ticks(buy === isStop ? Math.ceil(n - EPS) : Math.floor(n + EPS));
  }

  /**
   * n ticks as a price: n * mintick, keeping the binary value as the reference app does
   * (35 * 0.01 = 0.35000000000000003; scripts reading position_avg_price see it).
   */
  private ticks(n: number): number {
    return n * this.sym.mintick;
  }
}
