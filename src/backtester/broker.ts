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
 *   - trade excursions count the prices after the fill only (the close for a
 *     fill at the close) and include the entry commission;
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
 *   - after an entry fill on a bar, only entries in the same direction can
 *     still fill on it;
 *   - an entry placed against a position keeps that reversal part when the
 *     position closes before the fill by exit orders (a close order takes it
 *     out);
 *   - exits reserve the trade quantity in creation order; qty_percent counts
 *     on the filled entry quantity; a reversal cancels the exits of the
 *     entries it closed;
 *   - the legs of one strategy.exit fill in hash order of their entry ids
 *     (updateLegOrder) and close the oldest trades first (FIFO).
 *
 * Margin (margin_long / margin_short above 0, the Pine v6 default of 100;
 * rules matched on .tmp/oakscript-strategies):
 *   - an entry fills only if the margin of its new trade (qty * the higher of
 *     the sizing and fill prices * margin %) fits in the equity at the last
 *     script run minus the margin of the trades it does not close; else it is
 *     not filled at all (not resized, a reversal keeps the open position). An
 *     entry that fills after a close order of the same bar is checked at its
 *     sizing price only;
 *   - margin calls are checked at each point of the intrabar path (open,
 *     high / low, close) with Pine's documented formula: when the available
 *     funds are below 0, 4 times the quantity that covers the loss (at least
 *     one quantity step) is closed at that price, oldest trade first (order
 *     "Margin call <n>").
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
  /** Quantity of each exit bracket, fixed when the bracket first applies. */
  exitQty: Map<string, number>;
  /** Trailing stops of this trade: best price since activation, per exit id. */
  trail: Map<string, number>;
  /** Exit id whose leg closed this trade (FIFO): the trade's own leg of that exit stays active. */
  closedByExit?: string;
  /** Quantity filled at the entry (qty_percent base; margin calls and partial exits reduce `qty`). */
  filledQty: number;
}

/** A stop / limit order on the path, `level` on the tick grid. */
interface PriceOrder {
  seq: number;
  buy: boolean;
  isStop: boolean;
  level: number;
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
  /** Entry event: the trade was opened from flat. */
  first?: boolean;
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
  private tradeSeq = 0;
  /** Bar and direction of the last entry-order fill (see priceOrders). */
  private entryFillBar = -1;
  private entryFillDirection: Direction = 'long';
  /** Fill order of the per-trade legs of each exit id (see updateLegOrder). */
  private legOrder = new Map<string, OpenTrade[]>();
  /** Margin call events so far (order ids "Margin call <n>"). */
  private marginCalls = 0;
  /** Equity at the last script run (the bar close before the fills): the funds an entry fill is checked against. */
  private scriptEquity = 0;

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
    const qty = explicit !== null ? this.checkQty(explicit, fn) : this.defaultQty(sizePrice, fn);
    const prev = this.entries.get(id);
    const pos = this.positionSize;
    this.entries.set(id, {
      sizePrice,
      reverseQty: !isOrder && pos !== 0 && (pos > 0) !== buy ? Math.abs(pos) : 0,
      kind: 'entry',
      isOrder,
      seq: prev?.seq ?? ++this.seq,
      id,
      direction,
      qty,
      limit,
      stop,
      // An empty comment shows the order id (four-wma-tp-sl, mean-reversion-vf).
      comment: opts.comment || id,
    });
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
    const prev = this.exits.get(id);
    const comment = opts.comment || id;
    this.exits.set(id, {
      kind: 'exit',
      seq: prev?.seq ?? ++this.seq,
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
      (t) => !t.exitsDone.has(id) && (this.openTrades.includes(t) || (t.closedByExit === id && t.exitQty.has(id))),
    );
  }

  cancel(id: string): void {
    this.entries.delete(id);
    this.exits.delete(id);
  }

  cancelAll(): void {
    this.entries.clear();
    this.exits.clear();
  }

  // ------------------------------------------------------------ emulation

  /** Fill the orders placed before bar `i` along bar i's price path. */
  processBar(i: number): void {
    this.scriptEquity = i > 0 ? this.equity : this.props.initialCapital;
    this.bar = i;
    this.dropOrphanExits();
    const b = this.bars[i];
    // Orders are checked on the bar prices rounded to the tick.
    const open = this.roundPrice(b.open);
    const high = this.roundPrice(b.high);
    const low = this.roundPrice(b.low);
    // The open reaches the trades still open after the market fills: a trade closed at the open sees
    // its fill price only (slippage included), a trade opened at the open sees the prices after it.
    const held = [...this.openTrades];
    this.touchEquity(open);
    this.fillMarketOrders(open);
    this.touchTrades(open, b.open, held.filter((t) => this.openTrades.includes(t)));
    const upFirst = Math.abs(b.high - b.open) < Math.abs(b.low - b.open);
    const close = this.roundPrice(b.close);
    // [price on the tick grid, exact price] (trailing stops follow the exact price).
    const path: [number, number][] = upFirst ? [[high, b.high], [low, b.low], [close, b.close]] : [[low, b.low], [high, b.high], [close, b.close]];
    let cur = open;
    this.fillAt(cur, b.open);
    this.checkMargin(open);
    for (const [to, raw] of path) {
      this.walk(cur, to);
      cur = to;
      this.touch(to, raw);
      this.checkMargin(to);
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
    this.touch(close, this.bars[i].close);
    this.fillMarketOrders(close);
    this.fillAt(close, this.bars[i].close);
    // Trades filled at this close see the close as their first price after the fill.
    this.touch(close, this.bars[i].close);
    this.checkMargin(close);
  }

  /** Market orders (market entries and closes) in the order they were placed. */
  private fillMarketOrders(base: number): void {
    const market: (EntryOrder | CloseOrder)[] = [...this.closes];
    for (const e of this.entries.values()) if (e.limit === null && e.stop === null) market.push(e);
    market.sort((a, b) => a.seq - b.seq);
    this.closes = [];
    // An entry that fills after a close order of the same batch is not checked against the funds
    // (the reference fills it, then margin-calls it: gaussian-channel, 5 cases).
    // A close order after a market entry of the same batch does not fill, whether the entry filled or was
    // rejected (strategy.order then strategy.close: bb-mean-reversion; a rejected reversal then strategy.close:
    // rsi-volume-macd-ema).
    let afterClose = false;
    let afterEntry = false;
    for (const o of market) {
      if (o.kind === 'entry') {
        this.entries.delete(o.id);
        this.fillEntry(o, this.slip(base, o.direction === 'long'), 'MARKET', afterClose);
        afterEntry = true;
      } else if (!afterEntry) {
        afterClose ||= this.fillClose(o, this.slip(base, this.positionSize < 0));
      }
    }
  }

  /** Fill every price order already crossed at price p (gaps, new brackets). p was touched by the caller. */
  private fillAt(p: number, raw = p): void {
    const market = this.roundPrice(p);
    for (let guard = 0; guard < 1000; guard++) {
      const hit = this.priceOrders()
        .filter((o) => (o.buy === o.isStop ? p >= o.level - EPS : p <= o.level + EPS))
        // Several orders crossed at once (gap): the one closest to the price fills first
        // (the reference app: a 0.26 sell limit before a 0.24 one on a 0.31 open).
        .sort((a, b) => Math.abs(p - a.level) - Math.abs(p - b.level) || a.seq - b.seq);
      let filled = false;
      for (const o of hit) {
        const price = o.isStop ? this.slip(market, o.buy) : market;
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
          return up ? o.level > cur + EPS && o.level <= to + EPS : o.level < cur - EPS && o.level >= to - EPS;
        })
        .sort((a, b) => (up ? a.level - b.level : b.level - a.level) || a.seq - b.seq);
      let filled = false;
      for (const o of hit) {
        const price = o.isStop ? this.slip(o.level, o.buy) : o.level;
        this.touch(o.level);
        if (o.fill(price, o.level)) {
          cur = o.level;
          filled = true;
          this.fillAt(cur);
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
      // After an entry fill on this bar, only entries in the same direction can fill on it: several pyramiding
      // limit entries fill on one bar (pivot-points SPY 4h bar 29), an opposite stop entry does not (bollinger-stop).
      if (!e.isOrder && this.entryFillBar === this.bar && e.direction !== this.entryFillDirection) continue;
      const buy = e.direction === 'long';
      const isStop = e.stop !== null;
      out.push({
        seq: e.seq,
        buy,
        isStop,
        level: this.roundOrderPrice((isStop ? e.stop : e.limit) as number, buy, isStop),
        fill: (price) => {
          if (!e.isOrder && !this.canEnter(e.direction)) return false;
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
      const legTrades = [...order, ...this.openTrades.filter((t) => !order.includes(t))];
      for (const t of legTrades) {
        if (x.fromEntry !== '' && x.fromEntry !== t.entryId) continue;
        if (t.exitsDone.has(x.id)) continue;
        let qty = t.exitQty.get(x.id);
        if (qty === undefined) {
          // qty_percent counts on the quantity filled at the entry.
          qty = x.qty !== null ? x.qty : x.qtyPercent !== null ? this.floorQty((t.filledQty * x.qtyPercent) / 100) : t.qty;
          t.exitQty.set(x.id, qty);
        }
        if (this.openTrades.includes(t)) {
          const taken = reserved.get(t) ?? 0;
          qty = Math.min(qty, t.qty - taken);
          reserved.set(t, taken + Math.max(qty, 0));
        }
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
            if (c >= u.qty - EPS) u.closedByExit = x.id;
            this.closeTradeQty(u, c, price, comment);
            rest -= c;
          }
          this.recordFill(x.id, comment, buy, false, price, filled, type);
          return true;
        };
        const push = (isStop: boolean, level: number, f: (p: number, raw: number) => boolean) => {
          if (Number.isFinite(level)) out.push({ seq: x.seq, buy, isStop, level, fill: f });
        };
        if (limit !== null) push(false, this.roundOrderPrice(limit, buy, false), (p) => fill(p, 'LIMIT', x.commentProfit));
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

  private canEnter(direction: Direction): boolean {
    const pos = this.positionSize;
    if (pos === 0 || (pos > 0) !== (direction === 'long')) return true;
    const same = this.openTrades.filter((t) => t.direction === direction).length;
    return same < Math.max(1, this.props.pyramiding);
  }

  private fillEntry(o: EntryOrder, price: number, type: OrderType, afterClose = false): void {
    if (o.isOrder) return this.fillOrder(o, price, type);
    if (!this.canEnter(o.direction)) return;
    const buy = o.direction === 'long';
    const pos = this.positionSize;
    // A zero quantity (e.g. cash sizing below one share) only closes an opposite position.
    if (o.qty <= 0 && (pos === 0 || (pos > 0) === buy)) return;
    const reverses = pos !== 0 && (pos > 0) !== buy;
    // The reversal part is fixed at placement: an entry placed against a position that closed before the fill
    // opens its quantity plus that position (pivot-points SPY 15m trade 9: 4 + 8 = 12).
    const qty = pos === 0 ? o.qty + o.reverseQty : o.qty;
    if (qty <= 0 && (pos === 0 || (pos > 0) === buy)) return;
    // Not enough funds for the new trade: the order is not filled (a reversal keeps the open position).
    // Funds: the new trade at the higher of the sizing and fill prices (at the sizing price only after a close
    // order of the same bar).
    const checkPrice = afterClose ? o.sizePrice : Math.max(price, o.sizePrice);
    if (qty > 0 && !this.fundsCover(o.direction, qty, checkPrice, reverses)) return;
    this.entryFillBar = this.bar;
    this.entryFillDirection = o.direction;
    let closed = 0;
    if (reverses) {
      const ids = new Set<string>();
      for (const t of [...this.openTrades]) {
        closed += t.qty;
        ids.add(t.entryId);
        this.closeTradeQty(t, t.qty, price, o.comment, type === 'MARKET');
      }
      // The reversal cancels the exits of the entries it closed (no pending entry left for them).
      for (const [xid, x] of this.exits) {
        if (x.fromEntry !== '' && ids.has(x.fromEntry) && !this.entries.has(x.fromEntry)) this.exits.delete(xid);
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
  private fundsCover(direction: Direction, qty: number, price: number, closesOpenTrades = false): boolean {
    const ratio = this.marginRatio(direction);
    if (ratio <= 0) return true;
    const pv = this.sym.pointValue;
    let used = 0;
    if (!closesOpenTrades) for (const t of this.openTrades) used += t.qty * price * pv * this.marginRatio(t.direction);
    const available = this.scriptEquity - used;
    return qty * price * pv * ratio <= available;
  }

  /** Margin call at price p (a point of the intrabar path), Pine's algorithm. */
  private checkMargin(p: number): void {
    const pos = this.positionSize;
    if (pos === 0) return;
    const long = pos > 0;
    const ratio = this.marginRatio(long ? 'long' : 'short');
    if (ratio <= 0) return;
    const pv = this.sym.pointValue;
    // Pine's order of operations (the binary noise decides the calls at 0 available funds, a 100 % long):
    // open profit = MVS - money spent, available = equity - MVS * margin ratio.
    const mvs = Math.abs(pos) * p * pv;
    let spent = 0;
    for (const t of this.openTrades) spent += t.qty * t.price * pv;
    const openProfit = long ? mvs - spent : spent - mvs;
    const equity = this.props.initialCapital + this.netProfit + openProfit;
    const available = equity - mvs * ratio;
    if (available >= 0) return;
    const loss = available / ratio;
    const step = this.sym.qtyStep;
    const cover = Math.trunc(Math.abs(loss / (p * pv)) / step) * step;
    const size = Math.min(Math.abs(pos), cover > 0 ? cover * 4 : step);
    let left = size;
    for (const t of [...this.openTrades]) {
      if (left <= 0) break;
      const q = Math.min(left, t.qty);
      left -= q;
      this.closeTradeQty(t, q, p, 'Margin call', true);
      this.equityEvents[this.equityEvents.length - 1].marginCall = true;
    }
    this.recordFill(`Margin call ${this.marginCalls++}`, 'Margin call', !long, null, p, size, 'MARKET');
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
    // A close order also takes the closed quantity out of the reversal part of pending opposite entries
    // (close then entry on one bar opens the entry quantity only: gaussian-channel); exit orders do not.
    for (const e of this.entries.values()) {
      if (e.reverseQty > 0 && (e.direction === 'long') === buy) e.reverseQty = Math.max(0, e.reverseQty - qty);
    }
    return true;
  }

  private openTrade(o: EntryOrder, price: number): void {
    const entryCommission = this.commission(o.qty, price);
    // Entry commission is realized at the fill (it counts in net profit while the trade is open).
    this.netProfit -= entryCommission;
    this.commissionPaid += entryCommission;
    const t: OpenTrade = {
      seq: ++this.tradeSeq,
      entryId: o.id,
      direction: o.direction,
      qty: o.qty,
      filledQty: o.qty,
      price,
      bar: this.bar,
      signal: o.comment,
      entryCommission,
      // Excursions count the prices after the fill only.
      high: -Infinity,
      low: Infinity,
      exitsDone: new Set(),
      exitQty: new Map(),
      trail: new Map(),
    };
    this.openTrades.push(t);
    this.equityEvents.push({
      t: 'e',
      v: this.props.initialCapital + this.netProfit + this.openProfitAt(price),
      flat: false,
      realized: this.props.initialCapital + this.netProfit,
      first: this.openTrades.length === 1,
    });
    const long = this.openTrades.filter((x) => x.direction === 'long').reduce((s, x) => s + x.qty, 0);
    const short = this.openTrades.filter((x) => x.direction === 'short').reduce((s, x) => s + x.qty, 0);
    this.maxContractsHeld.long = Math.max(this.maxContractsHeld.long, long);
    this.maxContractsHeld.short = Math.max(this.maxContractsHeld.short, short);
    this.maxContractsHeld.all = Math.max(this.maxContractsHeld.all, long + short);
  }

  /** Close `qty` of trade t at `price`; a partial close splits the trade. */
  /** `market`: a market exit (close, reversal, strategy.order, margin call); see makeTrade. */
  private closeTradeQty(t: OpenTrade, qty: number, price: number, signal: string, market = false): void {
    if (qty <= 0) return;
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
    t.entryCommission -= entryCm;
    t.qty -= qty;
    if (t.qty <= EPS) this.openTrades = this.openTrades.filter((x) => x !== t);
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
    // Pending strategy.exit orders are cancelled when a fill leaves the position flat.
    if (this.openTrades.length === 0) this.exits.clear();
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
