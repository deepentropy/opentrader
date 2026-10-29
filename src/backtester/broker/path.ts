/**
 * The price path of a bar: market orders at a tick, stop / limit orders crossed by a jump (gap) or reached on the
 * way, the active price orders (pending entries and the exit legs of open trades: take profit, stop loss,
 * trailing stop) and their fill order.
 */
import type { OrderType } from '../types';
import { EntryFills } from './entries';
import { EPS, type CloseOrder, type EntryOrder, type ExitOrder, type FillAlert, type MarginCallOrder, type OpenTrade, type PriceOrder } from './types';

/** A point of the bar path where the script may run inside the bar (see Broker.intrabarTick): the open, a path
 *  point before the last one, an order fill on the way between two points, the bar's last point (the script runs at
 *  the close anyway), the fills at the close (process_orders_on_close). */
export type IntrabarPoint = 'open' | 'tick' | 'fill' | 'last' | 'close';

export abstract class PricePath extends EntryFills {
  /** A script run inside the bar placed market orders: they fill at the next point of the path. */
  protected intrabarMarket = false;
  /** Stop / limit entries ("e:<id>") a script run inside the bar placed or changed: they do not fill on the way to
   *  the bar's close (St-Greed), while `lastLeg` is set; exits do. */
  protected intrabarPlaced = new Set<string>();
  protected lastLeg = false;

  /** A point of the path was processed (Broker runs the script there with calc_on_order_fills /
   *  calc_on_every_history_tick). */
  protected intrabarTick(_p: number, _point: IntrabarPoint, _raw?: number): void {}

  /** Market orders a script run inside the bar placed, at the next point `p` of the path. */
  protected fillIntrabarMarket(p: number, _raw?: number): void {
    if (!this.intrabarMarket) return;
    this.intrabarMarket = false;
    this.fillMarketOrders(p, false);
  }

  /** Market orders (market entries and closes) in the order they were placed; margin calls too unless `calls` is
   *  false. */
  protected fillMarketOrders(base: number, calls = true): void {
    const market: (EntryOrder | CloseOrder | MarginCallOrder)[] = calls ? [...this.closes, ...this.pendingCalls] : [...this.closes];
    for (const e of this.entries.values()) if (e.limit === null && e.stop === null) market.push(e);
    market.sort((a, b) => a.seq - b.seq);
    this.closes = [];
    if (calls) this.pendingCalls = [];
    // A close order after a market entry of the same batch does not fill, whether the entry filled or was
    // rejected (strategy.order then strategy.close: bb-mean-reversion; a rejected reversal then strategy.close:
    // rsi-volume-macd-ema).
    let afterEntry = false;
    for (const o of market) {
      if (o.kind === 'call') {
        this.fillMarginCall(o, base);
      } else if (o.kind === 'entry') {
        this.entries.delete(o.id);
        // An entry the pyramiding limit stops is no order: a close after it fills (EMA Cross RSI ADX, an entry
        // called again on a short opened inside the bar, then its stop-out close).
        if (!o.isOrder && !this.canEnter(o.direction)) continue;
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
  protected fillAt(p: number, raw = p, reached = false): void {
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
  protected walk(from: number, to: number): void {
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
          // The funds are checked at the fill price of an entry the path reaches; a margin call found there fills
          // at the next tick and is sized there (a buy stop of 1,552,120 at 0.22 with a capital of 341,466.40: the
          // open profit against the 0.22000000000000003 average price is below 0, one share sold at the 0.24 high,
          // 190 probes; channel breakout SPY 4h bar 1214: a sell stop reversal at 101.71, 56 shares bought back at
          // 102.47, the call those funds ask for, not the 60 of the fill price).
          if (o.entry) {
            const call = this.marginCallAt(price, this.marginRealized());
            if (call) this.pendingCalls.push({ ...call, sizeAtFill: true });
          }
          this.fillAt(cur, cur, true);
          this.intrabarTick(o.level, 'fill');
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
      if (this.lastLeg && this.intrabarPlaced.has(`e:${e.id}`)) continue;
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
        entry: true,
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
        const fill = (price: number, type: OrderType, comment: string, alert?: FillAlert) => {
          // The leg closes its quantity from the oldest trades first (FIFO), not from its own trade; with the
          // close_entries_rule "ANY" from its own trade (an exit for B, entries A 1,000 and B 3,000: B 3,000).
          const from = this.fifo ? [...this.openTrades] : this.openTrades.filter((u) => u === t);
          let rest = Math.min(q, from.reduce((a, u) => a + u.qty, 0));
          const filled = rest;
          t.exitsDone.add(x.id);
          t.trail.delete(x.id);
          this.asOneOrder(filled, () => {
            for (const u of from) {
              if (rest <= 0) break;
              const c = Math.min(rest, u.qty);
              this.closeTradeQty(u, c, price, comment, false, true);
              if (!this.openTrades.includes(u) && u.lotQty > EPS && u !== t) this.displaced.push(u);
              rest -= c;
            }
          });
          t.lotQty = Math.max(0, t.lotQty - filled);
          if (!this.openTrades.includes(t) && t.lotQty > EPS && !this.displaced.includes(t)) this.displaced.push(t);
          this.recordFill(x.id, comment, buy, false, price, filled, type, alert);
          return true;
        };
        const push = (isStop: boolean, level: number, f: (p: number, raw: number) => boolean, trigger = level) => {
          // A leg is as old as its exit call or its entry fill, the later of the two: the exits of entries
          // filled after the call fill in entry order (pivot-points SPY 1h bar 699).
          if (Number.isFinite(level)) out.push({ seq: Math.max(x.legSeq, t.fillSeq), buy, isStop, level, trigger, fill: f });
        };
        if (limit !== null) {
          const level = this.roundOrderPrice(limit, buy, false);
          push(false, level, (p) => fill(p, 'LIMIT', x.commentProfit, x.alerts?.profit), this.limitTrigger(level, buy));
        }
        if (stop !== null) push(true, this.roundOrderPrice(stop, buy, true), (p) => fill(p, 'STOP', x.commentLoss, x.alerts?.loss));
        if (x.trailOffset !== null && (x.trailPoints !== null || x.trailPrice !== null)) {
          const level = this.trailActivation(x, t);
          // An activation level of 0 counts as reached, at 0, a price the trade then counts as reached (a short at
          // 0.10 with trail_points 10: the trailing stop fills at the entry, run-up = the whole entry value; 9 or
          // 11: never).
          if (level === 0 && !t.trail.has(x.id)) {
            t.trail.set(x.id, 0);
            t.low = Math.min(t.low, 0);
            t.high = Math.max(t.high, 0);
          }
          const best = t.trail.get(x.id);
          if (best === undefined) {
            push(false, level, (_p, raw) => {
              // The best price starts at the exact price reached (the exact open on a gap), the level at most when
              // only the price on the tick grid reaches it (a short at 0.13 activated at 0.11 by a 0.113839 open:
              // offset 0 fills at 0.11 there, offset 1 tick at 0.12 on the next bar).
              t.trail.set(x.id, sign > 0 ? Math.max(raw, level) : Math.min(raw, level));
              return true;
            });
          } else {
            // trail_offset counts whole ticks (0.76 tick behaves as 0: exit at the best price).
            const trailStop = best - sign * Math.trunc(x.trailOffset) * tick;
            // Rounded like a stop order (away from the market): 141.6875 - 0.10 gives 141.58.
            push(true, this.roundOrderPrice(trailStop, buy, true), (p) => fill(p, 'STOP', x.commentTrailing, x.alerts?.trailing));
          }
        }
      }
    }
    return out;
  }

  /**
   * Trailing stop activation level of exit `x` for trade `t`: trail_price, or the entry price plus trail_points,
   * rounded like a limit order; a level below 0 rounds toward 0 (a short at 0.10 with trail_points 10.53: activated
   * at 0, see priceOrders; 11: never).
   */
  protected trailActivation(x: ExitOrder, t: OpenTrade): number {
    const sign = t.direction === 'long' ? 1 : -1;
    const activation = x.trailPrice ?? t.price + sign * (x.trailPoints as number) * this.sym.mintick;
    if (activation < 0) return this.ticks(Math.trunc(activation / this.sym.mintick)) || 0;
    return this.roundOrderPrice(activation, t.direction === 'short', false);
  }

  /** Legs of exit `id` still to fill: open trades, and trades another leg closed that keep their own leg. */
  protected activeLegs(id: string): OpenTrade[] {
    return (this.legOrder.get(id) ?? []).filter(
      (t) => !t.exitsDone.has(id) && !t.exitsDropped.has(id) && t.lotQty > EPS && (this.openTrades.includes(t) || this.displaced.includes(t)),
    );
  }
}
