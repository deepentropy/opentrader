/**
 * Entry fills: strategy.entry (pyramiding, reversal part fixed at placement, funds checks at the fill, exits
 * cancelled by a reversal) and strategy.order (nets against the position), with OCA groups.
 */
import type { Direction, OrderType } from '../types';
import { MarginBook } from './margin';
import { EPS, type EntryOrder } from './types';

export abstract class EntryFills extends MarginBook {
  protected canEnter(direction: Direction): boolean {
    const pos = this.positionSize;
    if (pos === 0 || (pos > 0) !== (direction === 'long')) return true;
    const same = this.openTrades.filter((t) => t.direction === direction).length;
    return same < Math.max(1, this.props.pyramiding);
  }

  protected fillEntry(o: EntryOrder, price: number, type: OrderType): void {
    if (o.isOrder) return this.fillOrder(o, price, type);
    if (type === 'MARKET' && !this.canEnter(o.direction)) return;
    const buy = o.direction === 'long';
    const pos = this.positionSize;
    // A zero quantity (e.g. cash sizing below one share) only closes an opposite position, or opens the reversal
    // part fixed at placement when that position has closed before the fill (volatility expansion-close AAPL 1D bar
    // 1124: a buy stop that does not fit, placed against a short of 1 that a margin call waiting for the close
    // takes out: 1 bought at bar 1125).
    if (o.qty + o.reverseQty <= 0 && (pos === 0 || (pos > 0) === buy)) return;
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
    // A stop / limit entry whose own quantity, at its fill price, is more than the equity when it was placed is
    // not filled, also when it reverses the position (momentum strategy SPY 4h bar 186: a buy stop of 700 sized at
    // 145.61, the open gaps to 146.56; bar 226: a buy stop against a short of 609, the short stays open). The
    // equity since then does not count (Keltner channels strategy SPY 15m bar 2436: a buy stop placed 4 bars
    // earlier against a short that lost meanwhile fills).
    if (type !== 'MARKET' && o.qty > 0 && !this.ownFitsAt(o, price)) return;
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
    const closing = reverses ? (fixed ? Math.min(total, Math.abs(pos)) : Math.abs(pos)) : 0;
    const prevOrderQty = this.orderFillQty;
    this.orderFillQty = closing + qty;
    if (reverses) {
      const ids = new Set<string>();
      let left = closing;
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
      // An exit for every entry (no from_entry) live on the trades the reversal closed goes too (technical ratings
      // SPY 5m bar 18858: the long opened by the reversal has no stop loss before the next strategy.exit call).
      const allClosed = this.openTrades.length === 0;
      for (const [xid, x] of this.exits) {
        if (x.fromEntry !== '' && ids.has(x.fromEntry) && (x.attached || !this.entries.has(x.fromEntry))) this.exits.delete(xid);
        else if (x.fromEntry === '' && allClosed && (x.attached || this.entries.size === 0)) this.exits.delete(xid);
      }
    }
    if (qty > 0) this.openTrade({ ...o, qty }, price);
    this.orderFillQty = prevOrderQty;
    this.recordFill(o.id, o.comment, buy, true, price, closed + qty, type);
    this.applyOca(o, closed + qty);
    if (qty > 0 && !this.fifo && this.liveCloses.length) this.applyLiveCloses(o.id, price);
  }

  /** OCA group of filled order `o` (`filled` = its fill quantity): the other orders of the group are cancelled
   *  (cancel) or lowered by that quantity (reduce, cancelled at 0). */
  private applyOca(o: EntryOrder, filled: number): void {
    if (o.ocaName === null || o.ocaType === 'none') return;
    for (const [id, e] of this.entries) {
      if (e === o || e.ocaName !== o.ocaName) continue;
      if (o.ocaType === 'cancel') this.entries.delete(id);
      else if (e.qty - filled > EPS) e.qty -= filled;
      else this.entries.delete(id);
    }
  }

  /** strategy.order fill: closes opposite trades first (FIFO), the rest opens a trade. Reported with entry = null. */
  private fillOrder(o: EntryOrder, price: number, type: OrderType): void {
    const buy = o.direction === 'long';
    let left = o.qty;
    let filled = o.qty;
    this.asOneOrder(o.qty, () => {
      for (const t of [...this.openTrades]) {
        if (left <= 0 || (t.direction === 'long') === buy) continue;
        const q = Math.min(left, t.qty);
        left -= q;
        this.closeTradeQty(t, q, price, o.comment, type === 'MARKET');
      }
      if (left > 0) {
        if (this.fundsCover(o.direction, left, Math.max(price, o.sizePrice))) this.openTrade({ ...o, qty: left }, price);
        else filled -= left;
      }
    });
    if (filled > 0) {
      this.recordFill(o.id, o.comment, buy, null, price, filled, type);
      this.applyOca(o, filled);
    }
  }
}
