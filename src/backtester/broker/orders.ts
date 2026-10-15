/**
 * The script API: strategy.entry / order / close / close_all / exit / cancel / cancel_all and strategy.risk.*,
 * placing orders in the order book (sizing and the checks at placement, the exit legs' fill order).
 */
import type { Direction } from '../types';
import { fillEquity } from './costs';
import { PricePath } from './path';
import {
  EPS,
  StrategyRuntimeError,
  type CloseOptions,
  type CloseOrder,
  type EntryOptions,
  type EntryOrder,
  type ExitOptions,
  type ExitOrder,
  type OpenTrade,
  type RiskRule,
} from './types';

/** Pine na (NaN) or undefined as "not set". */
const val = (v: number | undefined): number | null => (v === undefined || Number.isNaN(v) ? null : v);

export abstract class OrderBook extends PricePath {
  // ------------------------------------------------------------ script API

  entry(id: string, direction: Direction, opts: EntryOptions = {}): void {
    this.placeEntry(id, direction, opts, false, 'strategy.entry');
  }

  /** A strategy.risk.* rule (scripts call it on every bar: the last call holds). */
  risk(r: RiskRule): void {
    if (r.rule === 'allow_entry_in') this.allowEntryIn = r.direction;
    else if (r.rule === 'max_intraday_loss') this.maxIntradayLoss = { value: r.value, type: r.type };
    else this.maxIntradayFills = r.count;
  }

  /** strategy.order: a raw order, not limited by pyramiding; it reduces an opposite position first. */
  order(id: string, direction: Direction, opts: EntryOptions = {}): void {
    this.placeEntry(id, direction, opts, true, 'strategy.order');
  }

  private placeEntry(id: string, direction: Direction, opts: EntryOptions, isOrder: boolean, fn: string): void {
    if (opts.when === false || this.halted) return;
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
    // strategy.risk.allow_entry_in: an entry the other way only closes the position.
    if (!isOrder && this.allowEntryIn !== 'all' && this.allowEntryIn !== direction) qty = 0;
    const prev = this.entries.get(id);
    const pos = this.positionSize;
    // A stop / limit entry is checked when it is placed: the pyramiding limit and the funds for its own quantity
    // at the close (a buy stop of 714,286 at 0.10 placed on a 0.08 close with 71,428.59999999999 fills; a buy limit
    // or a market buy of 714,286 placed on a 0.10 close does not); its fill price is checked when it fills (see
    // ownFitsAt). Once placed it fills whatever the position is by then (pivot-points SPY 1h: a 6th entry at bar
    // 3350, then the margin call; bar 1991: not placed, never filled). One that does not fit and reverses the
    // position only closes it (momentum strategy SPY 4h: a sell stop below the close sized at its price, 100 % of
    // equity, closes the long and opens nothing).
    if (!isOrder && orderPrice !== null) {
      if (!this.canEnter(direction)) return;
      const reverses = pos !== 0 && (pos > 0) !== buy;
      // The open trades count at the current close (SPY 4h bar 869: 16 at 106.02 placed with 78 short at 103.82).
      const close = this.roundPrice(this.bars[this.bar].close);
      if (qty > 0 && !this.fundsCover(direction, qty, close, reverses, this.fundsEquity, close)) {
        // The call replaces the order of that id: an order placed by an earlier call goes too (price channel
        // strategy SPY 15m: a sell stop placed at bar 20, not placeable again at bars 21-25, never fills).
        if (!reverses) {
          this.entries.delete(id);
          return;
        }
        qty = 0;
      }
    }
    // A stop / limit entry is placed against the position expected once the market orders already placed have
    // filled (a market buy of 10 then a sell limit entry of 5 in one script run: 15 sold; the limit entry called
    // first: 5; a close order called before it takes the position out, one called after does not).
    const against = orderPrice === null ? pos : this.expectedPosition();
    const reverseQty = !isOrder && against !== 0 && (against > 0) !== buy ? Math.abs(against) : 0;
    this.entries.set(id, {
      sizePrice,
      placedClose: this.roundPrice(this.bars[this.bar].close),
      // The fill check counts this equity without binary noise (see ownFitsAt).
      placedEquity: fillEquity(this.fundsEquity),
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
      ocaName: opts.ocaName || null,
      ocaType: opts.ocaName ? (opts.ocaType ?? 'none') : 'none',
      limit,
      stop,
      // An empty comment shows the order id (four-wma-tp-sl, mean-reversion-vf).
      comment: opts.comment || id,
      alert: { message: opts.alertMessage ?? '' },
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
    if (opts.when === false || this.halted) return;
    // With the FIFO rule an id keeps the quantity it holds after an older close took its trade (see fillCloseFifo).
    const holds = (t: OpenTrade) => t.entryId === id && (this.openTrades.includes(t) || (this.fifo && t.lotQty > EPS));
    if (!this.openTrades.some(holds) && !this.displaced.some(holds)) return;
    this.closes.push({
      kind: 'close',
      seq: ++this.seq,
      orderId: `Close entry(s) order ${id}`,
      entryId: id,
      qty: opts.qty ?? null,
      qtyPercent: opts.qtyPercent ?? null,
      comment: opts.comment || `Close entry(s) order ${id}`,
      alert: { message: opts.alertMessage ?? '' },
    });
  }

  closeAll(opts: { comment?: string; alertMessage?: string; when?: boolean } = {}): void {
    if (opts.when === false || this.halted) return;
    if (this.openTrades.length === 0) return;
    this.closes.push({
      kind: 'close',
      seq: ++this.seq,
      orderId: 'Close position order',
      entryId: null,
      qty: null,
      qtyPercent: null,
      comment: opts.comment || 'Close position order',
      alert: { message: opts.alertMessage ?? '' },
    });
  }

  exit(id: string, opts: ExitOptions = {}): void {
    if (opts.when === false || this.halted) return;
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
      alerts: {
        profit: { message: opts.alertProfit ?? opts.alertMessage ?? '' },
        loss: { message: opts.alertLoss ?? opts.alertMessage ?? '' },
        trailing: { message: opts.alertTrailing ?? opts.alertMessage ?? '' },
      },
    });
    for (const t of this.openTrades) t.exitsDropped.delete(id);
    // A call with another trail activation (trail_points / trail_price) re-creates the trailing stop of each trade:
    // active from the close on the tick grid when the close is already at the new activation level, else waiting
    // for it (a short at 664.45 with trail_points 198, then 199 / 198 on alternate bars or ATR-based values: no
    // fill; 198 constant, or changed once before the price gets there: the trailing stop fills; a changed
    // trail_offset keeps it; doji SPY 1h bar 6028: a 276.625 close gives 276.63, the stop one tick below 276.62).
    if (prev && (prev.trailPoints !== val(opts.trailPoints) || prev.trailPrice !== val(opts.trailPrice))) {
      const x = this.exits.get(id)!;
      const close = this.roundPrice(this.bars[this.bar].close);
      for (const t of [...this.openTrades, ...this.displaced]) {
        if (!known(t)) continue;
        t.trail.delete(id);
        if (x.trailOffset === null || (x.trailPoints === null && x.trailPrice === null)) continue;
        const sign = t.direction === 'long' ? 1 : -1;
        const level = this.trailActivation(x, t);
        if (sign * (close - level) >= -EPS) t.trail.set(id, close);
      }
    }
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
}
