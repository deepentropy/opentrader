/**
 * Close order fills: strategy.close / strategy.close_all and the risk-rule closes, with the close_entries_rule
 * "FIFO" (oldest trades first, the quantity an id holds) and "ANY" (per trade of the id, live closes) rules.
 */
import { TradeLedger } from './ledger';
import { EPS, type CloseOrder, type OpenTrade } from './types';

export abstract class CloseFills extends TradeLedger {
  /** Close the whole position at tick price p (a market order, slippage included). */
  protected closePosition(id: string, p: number): void {
    const order: CloseOrder = { kind: 'close', seq: ++this.seq, orderId: id, entryId: null, qty: null, qtyPercent: null, comment: id };
    this.fillClose(order, this.slip(p, this.positionSize < 0));
  }

  /** Returns true when the order filled. */
  protected fillClose(o: CloseOrder, price: number): boolean {
    if (o.entryId !== null && this.fifo) return this.fillCloseFifo(o, price);
    if (o.entryId !== null && (o.qty !== null || o.qtyPercent !== null)) return this.fillCloseAny(o, price);
    let targets = this.openTrades.filter((t) => o.entryId === null || t.entryId === o.entryId);
    // With the "ANY" rule the position closes entry id by entry id, in the order of each id's first trade (A 600,
    // B 3,000, A 300 open: A 600, A 300, B 3,000).
    if (o.entryId === null && !this.fifo) {
      const first = new Map<string, number>();
      for (const t of targets) if (!first.has(t.entryId)) first.set(t.entryId, t.seq);
      targets = [...targets].sort((a, b) => first.get(a.entryId)! - first.get(b.entryId)! || a.seq - b.seq);
    }
    if (targets.length === 0) return false;
    const total = targets.reduce((s, t) => s + t.qty, 0);
    let left = o.qty !== null ? Math.min(o.qty, total) : o.qtyPercent !== null ? this.floorQty((total * o.qtyPercent) / 100) : total;
    const buy = targets[0].direction === 'short';
    const qty = left;
    this.asOneOrder(qty, () => {
      for (const t of targets) {
        if (left <= 0) break;
        const q = Math.min(left, t.qty);
        left -= q;
        this.closeTradeQty(t, q, price, o.comment, true);
      }
    });
    this.recordFill(o.orderId, o.comment, buy, false, price, qty, 'MARKET', o.alert);
    return true;
  }

  /**
   * strategy.close of an entry id with a quantity, with the close_entries_rule "ANY": the quantity (or percent)
   * counts per trade of that id, one fill each (trades of 3,000 and 2,000, a close of 1,500: 1,500 of each). While
   * it has closed no trade whole it stays live: the next trade of that id is closed by as much when it opens, at its
   * fill price (B 3,000, a close of 1,500, then B 200: the 200 closed at once, a later B 300 stays; a close of
   * 1,500 on B 1,000 is done).
   */
  private fillCloseAny(o: CloseOrder, price: number): boolean {
    const targets = this.openTrades.filter((t) => t.entryId === o.entryId);
    if (targets.length === 0) return false;
    let whole = false;
    for (const t of targets) whole = this.closeOneTrade(o, t, price) || whole;
    if (!whole) this.liveCloses.push(o);
    return true;
  }

  /** Close the quantity of close order `o` from trade t (one fill); true when the trade is closed whole. */
  private closeOneTrade(o: CloseOrder, t: OpenTrade, price: number): boolean {
    const q = o.qty !== null ? Math.min(o.qty, t.qty) : this.floorQty((t.qty * (o.qtyPercent as number)) / 100);
    if (q <= 0) return false;
    const whole = q >= t.qty - EPS;
    this.asOneOrder(q, () => this.closeTradeQty(t, q, price, o.comment, true));
    this.recordFill(o.orderId, o.comment, t.direction === 'short', false, price, q, 'MARKET', o.alert);
    return whole;
  }

  /** A trade of `entryId` just opened at `price`: the live closes of that id close their quantity of it, oldest
   *  first, until it is closed whole. */
  protected applyLiveCloses(entryId: string, price: number): void {
    const t = this.openTrades.filter((u) => u.entryId === entryId).pop();
    if (!t) return;
    for (const o of [...this.liveCloses]) {
      if (o.entryId !== entryId) continue;
      if (this.closeOneTrade(o, t, price)) {
        this.liveCloses = this.liveCloses.filter((x) => x !== o);
        return;
      }
    }
  }

  /**
   * strategy.close of an entry id with the FIFO rule: the quantity is the one the id holds (its own quantity less
   * what orders for that id closed), taken from the oldest trades first, whatever their entry id. Entries A 1,000,
   * B 3,000, C 7,000: a close of 1,500 for B closes A 1,000 and B 500; a close of A then closes 1,000 of B (A still
   * holds 1,000); a close of 2,000 for C closes A 1,000 and B 1,000.
   */
  private fillCloseFifo(o: CloseOrder, price: number): boolean {
    const lots = [...this.openTrades, ...this.displaced].filter((t) => t.entryId === o.entryId && t.lotQty > EPS).sort((a, b) => a.seq - b.seq);
    const held = lots.reduce((s, t) => s + t.lotQty, 0);
    const position = this.openTrades.reduce((s, t) => s + t.qty, 0);
    if (held <= EPS || position <= EPS) return false;
    const want = o.qty !== null ? Math.min(o.qty, held) : o.qtyPercent !== null ? this.floorQty((held * o.qtyPercent) / 100) : held;
    const qty = Math.min(want, position);
    if (qty <= 0) return false;
    const buy = this.openTrades[0].direction === 'short';
    let rest = qty;
    let own = 0;
    this.asOneOrder(qty, () => {
      for (const u of [...this.openTrades]) {
        if (rest <= EPS) break;
        const c = Math.min(rest, u.qty);
        rest -= c;
        if (u.entryId === o.entryId) {
          // Its own trade: the lot goes with it, as for a close by id.
          const before = u.lotQty + u.callQty;
          this.closeTradeQty(u, c, price, o.comment, true);
          own += before - (u.lotQty + u.callQty);
        } else {
          this.closeTradeQty(u, c, price, o.comment, true, true);
          if (!this.openTrades.includes(u) && u.lotQty > EPS && !this.displaced.includes(u)) this.displaced.push(u);
        }
      }
    });
    // The rest of the quantity comes off the id's lots, oldest first.
    let lot = qty - own;
    for (const t of lots) {
      if (lot <= EPS) break;
      const c = Math.min(lot, t.lotQty);
      t.lotQty -= c;
      lot -= c;
    }
    this.displaced = this.displaced.filter((t) => t.lotQty > EPS);
    this.recordFill(o.orderId, o.comment, buy, false, price, qty, 'MARKET', o.alert);
    return true;
  }
}
