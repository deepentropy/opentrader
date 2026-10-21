/*
 * Paper trading account of one chart in Bar Replay: the reference app runs the
 * replay orders through its strategy broker emulator and shows a strategy
 * report, so this is the backtester's Broker fed with the replayed updates.
 *
 *   - market orders fill at once at the last replayed price (the close of the
 *     last update): bid = ask = that price;
 *   - limit / stop orders, and the take profit / stop loss brackets, are
 *     checked along the path of each later update (open, nearer extreme, other
 *     extreme, close; a gap fills at the open), as strategy orders on a bar;
 *   - a stop-limit order becomes a limit order once an update reaches its stop
 *     price; the limit works from the next update;
 *   - the brackets of an order go to the position when it fills; the position
 *     brackets close the whole position (one-cancels-other);
 *   - commissions are the strategy ones (percent of the value, per contract,
 *     per order); no slippage, no margin.
 *
 * Every command is logged with the update it was given on, so new settings
 * (capital, commission) rebuild the account from the same orders.
 */
import { Broker } from "../../backtester/broker";
import { backtestReport } from "../../backtester/run";
import {
  DEFAULT_PROPERTIES,
  type BacktestReport,
  type Bar,
  type FilledOrder,
  type StrategyProperties,
  type SymbolInfo,
} from "../../backtester/types";
import type { OrderRequest, OrderType, Side, TradingEvent, TradingExecution, TradingOrder, TradingPosition } from "./types";
import { ORDER_LABEL } from "./types";

export type CommissionType = "percent" | "cash_per_contract" | "cash_per_order";

/** "Trading on historical data" settings. `currency` "NONE" = the chart's. */
export type ReplaySettings = {
  initialCapital: number;
  currency: string;
  commissionType: CommissionType;
  commissionValue: number;
};

export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = {
  initialCapital: 1_000_000,
  currency: "NONE",
  commissionType: "percent",
  commissionValue: 0,
};

/** Order comments (the "Order type" column of the list of trades). */
const COMMENT: Record<OrderType, string> = {
  market: "market order",
  limit: "limit order",
  stop: "stop order",
  stopLimit: "stop-limit order",
};
const TP_COMMENT = "Bracket Take Profit";
const SL_COMMENT = "Bracket Stop Loss";

/** A saved account: its first bar, the replayed updates and the commands
 *  given on them (ReplayAccount.snapshot / restore). */
export type ReplayAccountSnapshot = {
  symbol: string;
  sym: SymbolInfo;
  settings: ReplaySettings;
  currency: string;
  bars: Bar[];
  log: { at: number; cmd: unknown }[];
};

type Cmd =
  | { op: "place"; req: OrderRequest }
  | { op: "modify"; id: string; req: OrderRequest }
  | { op: "cancel"; id: string }
  | { op: "close"; qty: number | null }
  | { op: "reverse" }
  | { op: "brackets"; tp: number | null; sl: number | null }
  | { op: "flatten" };

type Working = {
  id: string;
  side: Side;
  type: OrderType;
  qty: number;
  limit: number | null;
  stop: number | null;
  tp: number | null;
  sl: number | null;
  /** Stop-limit: the stop was reached, the limit works. */
  triggered: boolean;
  /** Stop-limit reached on the way with its limit at or beyond the stop: it
   *  fills at the stop, as a stop order (see planStopLimits). */
  asStop: boolean;
};

const POSITION_ID = "position";
/** Broker ids: placed orders, their brackets, the position brackets, closes. */
const orderKey = (id: string) => `O${id}`;
const bracketKey = (id: string) => `B${id}`;
const POS_KEY = "P";

export class ReplayAccount {
  readonly bars: Bar[];
  private broker!: Broker;
  private equity: number[] = [];
  private log: { at: number; cmd: Cmd }[] = [];
  private working = new Map<string, Working>();
  private seq = 0;
  private closeSeq = 0;
  private posTp: number | null = null;
  private posSl: number | null = null;
  /** filledOrders already turned into executions / events. */
  private seen = 0;
  /** Sign of the position the brackets belong to. */
  private posSide = 0;
  private quiet = false;
  private out: TradingEvent[] = [];

  constructor(
    readonly symbol: string,
    readonly sym: SymbolInfo,
    private settingsValue: ReplaySettings,
    /** Account currency (the settings one, else the symbol's). */
    private currencyValue: string,
    /** The last bar shown when the account opens: the first price. */
    first: Bar,
  ) {
    this.bars = [first];
    this.reset();
  }

  get settings(): ReplaySettings {
    return this.settingsValue;
  }

  get currency(): string {
    return this.currencyValue;
  }

  private props(): StrategyProperties {
    const s = this.settingsValue;
    return {
      ...DEFAULT_PROPERTIES,
      initialCapital: s.initialCapital,
      currency: this.currencyValue,
      commissionType: s.commissionType,
      commissionValue: s.commissionValue,
      pyramiding: 1,
      marginLong: 0,
      marginShort: 0,
    };
  }

  private reset() {
    this.broker = new Broker(this.bars, this.props(), this.sym);
    this.equity = new Array(this.bars.length).fill(this.settingsValue.initialCapital);
    this.working.clear();
    this.seq = 0;
    this.closeSeq = 0;
    this.posTp = null;
    this.posSl = null;
    this.posSide = 0;
    this.seen = 0;
  }

  /** New settings: the same orders again from the first update. */
  applySettings(s: ReplaySettings, currency = this.currencyValue) {
    this.settingsValue = s;
    this.currencyValue = currency;
    const bars = this.bars.splice(1);
    const log = this.log;
    this.log = [];
    this.reset();
    this.replayHistory(bars, log);
  }

  /** Run the updates after the first bar and the commands given on them
   *  again, without events (settings changed, saved replay continued). */
  private replayHistory(bars: Bar[], log: { at: number; cmd: Cmd }[]) {
    this.quiet = true;
    try {
      let k = 0;
      const run = (at: number) => {
        while (k < log.length && log[k].at === at) {
          this.log.push(log[k]);
          this.exec(log[k++].cmd);
        }
      };
      run(0);
      for (let i = 0; i < bars.length; i++) {
        this.pushBar(bars[i]);
        run(i + 1);
      }
    } finally {
      this.quiet = false;
      this.out = [];
    }
  }

  /** Everything needed to build the account again ("Save this replay"). */
  snapshot(): ReplayAccountSnapshot {
    return {
      symbol: this.symbol,
      sym: this.sym,
      settings: this.settingsValue,
      currency: this.currencyValue,
      bars: this.bars.slice(),
      log: this.log.slice(),
    };
  }

  /** An account as it was saved (a saved replay continued). */
  static restore(snap: ReplayAccountSnapshot): ReplayAccount {
    const acc = new ReplayAccount(snap.symbol, snap.sym, snap.settings, snap.currency, snap.bars[0]);
    acc.replayHistory(snap.bars.slice(1), snap.log as { at: number; cmd: Cmd }[]);
    return acc;
  }

  // ------------------------------------------------------------ reads

  get last(): number {
    return this.broker.roundPrice(this.bars[this.bars.length - 1].close);
  }

  get lastTime(): number {
    return this.bars[this.bars.length - 1].time;
  }

  get positionQty(): number {
    return this.broker.positionSize;
  }

  get netProfit(): number {
    return this.broker.netProfit;
  }

  get hasExecutions(): boolean {
    return this.broker.filledOrders.length > 0;
  }

  position(): TradingPosition | null {
    const q = this.broker.positionSize;
    if (q === 0) return null;
    return {
      id: POSITION_ID,
      symbol: this.symbol,
      side: q > 0 ? "buy" : "sell",
      qty: Math.abs(q),
      avgPrice: this.broker.positionAvgPrice,
      pl: this.broker.openProfitAt(this.last),
      takeProfit: this.posTp,
      stopLoss: this.posSl,
    };
  }

  /** Working orders with their brackets, then the position brackets. */
  orders(): TradingOrder[] {
    const out: TradingOrder[] = [];
    const exitSide = (s: Side): Side => (s === "buy" ? "sell" : "buy");
    for (const w of this.working.values()) {
      out.push({
        id: w.id,
        symbol: this.symbol,
        side: w.side,
        type: w.type,
        qty: w.qty,
        limitPrice: w.limit,
        stopPrice: w.stop,
        kind: "order",
        parentId: null,
        takeProfit: w.tp,
        stopLoss: w.sl,
        stopTriggered: w.type === "stopLimit" ? w.triggered : undefined,
      });
      if (w.tp !== null) out.push(this.bracket(`${w.id}:tp`, exitSide(w.side), w.qty, "tp", w.tp, w.id));
      if (w.sl !== null) out.push(this.bracket(`${w.id}:sl`, exitSide(w.side), w.qty, "sl", w.sl, w.id));
    }
    const p = this.position();
    if (p) {
      if (this.posTp !== null) out.push(this.bracket(`${POSITION_ID}:tp`, exitSide(p.side), p.qty, "tp", this.posTp, POSITION_ID));
      if (this.posSl !== null) out.push(this.bracket(`${POSITION_ID}:sl`, exitSide(p.side), p.qty, "sl", this.posSl, POSITION_ID));
    }
    return out;
  }

  private bracket(id: string, side: Side, qty: number, kind: "tp" | "sl", price: number, parentId: string): TradingOrder {
    return {
      id,
      symbol: this.symbol,
      side,
      type: kind === "tp" ? "limit" : "stop",
      qty,
      limitPrice: kind === "tp" ? price : null,
      stopPrice: kind === "sl" ? price : null,
      kind,
      parentId,
      takeProfit: null,
      stopLoss: null,
    };
  }

  executions(): TradingExecution[] {
    return this.broker.filledOrders.map((f, i) => ({
      id: String(i + 1),
      symbol: this.symbol,
      side: f.buy ? "buy" : "sell",
      qty: f.qty,
      price: f.price,
      time: f.time / 1000,
    }));
  }

  report(): BacktestReport {
    return backtestReport(this.bars, this.broker, this.equity.slice(), performance.now());
  }

  /** Events since the last call (toasts). */
  takeEvents(): TradingEvent[] {
    const e = this.out;
    this.out = [];
    return e;
  }

  // ------------------------------------------------------------ commands

  place(req: OrderRequest): string | null {
    return this.run({ op: "place", req }) as string | null;
  }
  modify(id: string, req: OrderRequest) {
    this.run({ op: "modify", id, req });
  }
  cancel(id: string) {
    this.run({ op: "cancel", id });
  }
  /** Close the position (`qty` null: all of it). */
  closePosition(qty: number | null = null) {
    this.run({ op: "close", qty });
  }
  reverse() {
    this.run({ op: "reverse" });
  }
  setPositionBrackets(tp: number | null, sl: number | null) {
    this.run({ op: "brackets", tp, sl });
  }
  /** End of the session: orders cancelled, position closed. */
  flatten() {
    this.run({ op: "flatten" });
  }

  private run(cmd: Cmd): unknown {
    this.log.push({ at: this.bars.length - 1, cmd });
    return this.exec(cmd);
  }

  private exec(cmd: Cmd): unknown {
    switch (cmd.op) {
      case "place":
        return this.execPlace(cmd.req);
      case "modify":
        return this.execModify(cmd.id, cmd.req);
      case "cancel":
        return this.execCancel(cmd.id);
      case "close":
        return this.execClose(cmd.qty);
      case "reverse":
        return this.execReverse();
      case "brackets":
        return this.execBrackets(cmd.tp, cmd.sl);
      case "flatten":
        for (const id of [...this.working.keys()]) this.execCancel(id);
        return this.execClose(null);
    }
  }

  private emit(e: Omit<TradingEvent, "symbol">) {
    if (!this.quiet) this.out.push({ ...e, symbol: this.symbol });
  }

  private execPlace(req: OrderRequest): string | null {
    const qty = this.qty(req.qty);
    if (qty <= 0) {
      this.emit({ kind: "rejected", label: ORDER_LABEL[req.type], side: req.side, qty: req.qty, price: null, message: "Invalid quantity" });
      return null;
    }
    const id = String(++this.seq);
    const w: Working = {
      id,
      side: req.side,
      type: req.type,
      qty,
      limit: req.type === "limit" || req.type === "stopLimit" ? this.price(req.limitPrice) : null,
      stop: req.type === "stop" || req.type === "stopLimit" ? this.price(req.stopPrice) : null,
      tp: req.takeProfit !== null ? this.price(req.takeProfit) : null,
      sl: req.stopLoss !== null ? this.price(req.stopLoss) : null,
      triggered: false,
      asStop: false,
    };
    if (req.type === "market") {
      this.working.set(id, w);
      this.emit({ kind: "placed", label: ORDER_LABEL.market, side: w.side, qty, price: null });
      this.submit(w);
      this.fillNow();
      // Not filled (no funds): rejected, not left to fill later.
      if (this.working.has(id)) {
        this.working.delete(id);
        this.broker.cancel(orderKey(id));
        this.broker.cancel(bracketKey(id));
        this.emit({ kind: "rejected", label: ORDER_LABEL.market, side: w.side, qty, price: null });
        return null;
      }
      return id;
    }
    // A stop-limit whose stop is already reached starts as a limit order.
    if (w.type === "stopLimit" && w.stop !== null && (w.side === "buy" ? this.last >= w.stop : this.last <= w.stop)) w.triggered = true;
    this.working.set(id, w);
    this.submit(w);
    this.emit({ kind: "placed", label: ORDER_LABEL[w.type], side: w.side, qty, price: this.orderPrice(w) });
    this.emitBrackets(w, "placed");
    return id;
  }

  private execModify(id: string, req: OrderRequest) {
    const w = this.working.get(id);
    if (!w) return;
    const qty = this.qty(req.qty);
    if (qty <= 0) return;
    w.qty = qty;
    if (w.type === "limit" || w.type === "stopLimit") w.limit = this.price(req.limitPrice ?? w.limit);
    if (w.type === "stop" || w.type === "stopLimit") w.stop = this.price(req.stopPrice ?? w.stop);
    w.tp = req.takeProfit !== null ? this.price(req.takeProfit) : null;
    w.sl = req.stopLoss !== null ? this.price(req.stopLoss) : null;
    this.submit(w);
    this.emit({ kind: "modified", label: ORDER_LABEL[w.type], side: w.side, qty, price: this.orderPrice(w) });
  }

  private execCancel(id: string) {
    // A bracket: "<order id>:tp" / "position:sl"...
    const [parent, leg] = id.split(":");
    if (leg === "tp" || leg === "sl") {
      if (parent === POSITION_ID) {
        this.execBrackets(leg === "tp" ? null : this.posTp, leg === "sl" ? null : this.posSl);
        return;
      }
      const w = this.working.get(parent);
      if (!w) return;
      const price = leg === "tp" ? w.tp : w.sl;
      if (leg === "tp") w.tp = null;
      else w.sl = null;
      this.submitBrackets(w);
      if (price !== null) this.emit({ kind: "cancelled", label: leg === "tp" ? "Take Profit" : "Stop Loss", side: w.side === "buy" ? "sell" : "buy", qty: w.qty, price });
      return;
    }
    const w = this.working.get(id);
    if (!w) return;
    this.working.delete(id);
    this.broker.cancel(orderKey(id));
    this.broker.cancel(bracketKey(id));
    this.emit({ kind: "cancelled", label: ORDER_LABEL[w.type], side: w.side, qty: w.qty, price: this.orderPrice(w) });
    this.emitBrackets(w, "cancelled");
  }

  private execClose(qty: number | null) {
    const pos = this.broker.positionSize;
    if (pos === 0) return;
    const all = Math.abs(pos);
    const q = qty === null ? all : Math.min(this.qty(qty), all);
    if (q <= 0) return;
    const partial = q < all;
    const side: Side = pos > 0 ? "sell" : "buy";
    this.emit({ kind: "placed", label: ORDER_LABEL.market, side, qty: q, price: null });
    this.broker.order(`C${++this.closeSeq}`, side === "buy" ? "long" : "short", {
      qty: q,
      comment: partial ? "Close position (partial)" : "Close position",
    });
    this.fillNow();
  }

  private execReverse() {
    const pos = this.broker.positionSize;
    if (pos === 0) return;
    const side: Side = pos > 0 ? "sell" : "buy";
    this.emit({ kind: "placed", label: ORDER_LABEL.market, side, qty: Math.abs(pos) * 2, price: null });
    this.broker.order(`R${++this.closeSeq}`, side === "buy" ? "long" : "short", {
      qty: Math.abs(pos) * 2,
      comment: "Reverse position order",
    });
    this.fillNow();
  }

  private execBrackets(tp: number | null, sl: number | null) {
    const pos = this.broker.positionSize;
    if (pos === 0) return;
    const side: Side = pos > 0 ? "sell" : "buy";
    const qty = Math.abs(pos);
    const next = { tp: tp !== null ? this.price(tp) : null, sl: sl !== null ? this.price(sl) : null };
    const legs: ["tp" | "sl", number | null, number | null][] = [
      ["tp", this.posTp, next.tp],
      ["sl", this.posSl, next.sl],
    ];
    this.posTp = next.tp;
    this.posSl = next.sl;
    this.submitPositionBrackets();
    for (const [leg, before, after] of legs) {
      const label = leg === "tp" ? "Take Profit" : "Stop Loss";
      if (before === null && after !== null) this.emit({ kind: "placed", label, side, qty, price: after });
      else if (before !== null && after === null) this.emit({ kind: "cancelled", label, side, qty, price: before });
      else if (before !== null && after !== null && before !== after) this.emit({ kind: "modified", label, side, qty, price: after });
    }
  }

  // ------------------------------------------------------------ updates

  /** One replayed update (its own open / high / low / close path). */
  update(bar: Bar) {
    this.pushBar(bar);
  }

  private pushBar(bar: Bar) {
    this.bars.push(bar);
    const i = this.bars.length - 1;
    const later = this.planStopLimits(bar);
    this.broker.processBar(i);
    this.equity.push(this.broker.equity);
    this.settle();
    for (const w of later) {
      if (!this.working.has(w.id)) continue;
      w.triggered = true;
      this.submit(w);
    }
    // A stop-limit sent as a stop and not filled (no funds): a limit order again.
    for (const w of this.working.values()) {
      if (!w.asStop) continue;
      w.asStop = false;
      this.submit(w);
    }
  }

  /**
   * Stop-limit orders this update reaches, filled in the same update as the
   * reference app does (a gap through the stop fills at the open when the limit
   * allows it). Buy (sell mirrored): an open at or beyond the stop starts the
   * limit order at the open; a stop reached on the way with the limit at or
   * beyond it fills at the stop (sent as a stop order); with the limit before
   * the stop, the limit works from the trigger: sent now when the rest of the
   * path (after the stop) reaches it (it fills at its price either way), else
   * after this update. Returns the orders to send after the update.
   */
  private planStopLimits(bar: Bar): Working[] {
    const later: Working[] = [];
    const upFirst = Math.abs(bar.high - bar.open) < Math.abs(bar.low - bar.open);
    for (const w of this.working.values()) {
      if (w.type !== "stopLimit" || w.triggered || w.stop === null || w.limit === null) continue;
      const buy = w.side === "buy";
      const stop = w.stop;
      const limit = w.limit;
      const gapped = buy ? bar.open >= stop : bar.open <= stop;
      const reached = buy ? bar.high >= stop : bar.low <= stop;
      if (!reached) continue;
      if (gapped) {
        w.triggered = true;
        this.submit(w);
        continue;
      }
      if (buy ? limit >= stop : limit <= stop) {
        w.triggered = true;
        w.asStop = true;
        this.submit(w);
        continue;
      }
      // After the stop: the other extreme when the stop's extreme comes first, then the close.
      const stopFirst = buy ? upFirst : !upFirst;
      const after = stopFirst ? (buy ? bar.low : bar.high) : bar.close;
      if (buy ? after <= limit : after >= limit) {
        w.triggered = true;
        this.submit(w);
      } else later.push(w);
    }
    return later;
  }

  /** Fill the market orders just given at the last price. */
  private fillNow() {
    this.broker.processClose(this.bars.length - 1);
    this.equity[this.equity.length - 1] = this.broker.equity;
    this.settle();
  }

  /** Turn the new fills into executions, events and bracket moves. */
  private settle() {
    const fills = this.broker.filledOrders;
    let moved = false;
    for (; this.seen < fills.length; this.seen++) {
      const f = fills[this.seen];
      moved = true;
      this.onFill(f);
    }
    if (!moved) return;
    const pos = this.broker.positionSize;
    if (pos === 0 || this.posSide !== Math.sign(pos)) {
      // Flat or reversed: the position brackets go.
      if (this.posTp !== null || this.posSl !== null) {
        const side: Side = this.posSide > 0 ? "sell" : "buy";
        if (pos !== 0) {
          if (this.posTp !== null) this.emit({ kind: "cancelled", label: "Take Profit", side, qty: Math.abs(pos), price: this.posTp });
          if (this.posSl !== null) this.emit({ kind: "cancelled", label: "Stop Loss", side, qty: Math.abs(pos), price: this.posSl });
        }
        this.posTp = null;
        this.posSl = null;
      }
    }
    this.posSide = Math.sign(pos);
    this.submitPositionBrackets();
  }

  private onFill(f: FilledOrder) {
    const side: Side = f.buy ? "buy" : "sell";
    if (f.id.startsWith("O")) {
      const w = this.working.get(f.id.slice(1));
      if (!w) return;
      this.working.delete(w.id);
      this.broker.cancel(bracketKey(w.id));
      this.emit({ kind: "executed", label: ORDER_LABEL[w.type], side, qty: f.qty, price: w.type === "market" ? null : this.orderPrice(w) });
      // Its brackets go to the position.
      if (w.tp !== null || w.sl !== null) {
        const pos = this.broker.positionSize;
        if (pos !== 0 && Math.sign(pos) === (w.side === "buy" ? 1 : -1)) {
          if (w.tp !== null) this.posTp = w.tp;
          if (w.sl !== null) this.posSl = w.sl;
          this.posSide = Math.sign(pos);
        }
      }
      return;
    }
    if (f.id === POS_KEY || f.id.startsWith("B")) {
      const tp = f.type === "LIMIT";
      this.emit({ kind: "executed", label: tp ? "Take Profit" : "Stop Loss", side, qty: f.qty, price: f.price });
      if (f.id === POS_KEY) {
        this.posTp = null;
        this.posSl = null;
      }
      return;
    }
    // Close / reverse orders: market.
    this.emit({ kind: "executed", label: "Market", side, qty: f.qty, price: null });
  }

  private submit(w: Working) {
    const dir = w.side === "buy" ? "long" : "short";
    const comment = `${w.side === "buy" ? "Buy" : "Sell"} ${COMMENT[w.type]}`;
    if (w.type === "stopLimit" && !w.triggered) {
      // Waits for its stop (see pushBar): nothing at the broker yet.
      this.broker.cancel(orderKey(w.id));
    } else {
      const limit = w.type === "limit" || (w.type === "stopLimit" && !w.asStop) ? w.limit ?? undefined : undefined;
      const stop = w.type === "stop" || w.asStop ? w.stop ?? undefined : undefined;
      this.broker.order(orderKey(w.id), dir, { qty: w.qty, limit, stop, comment });
    }
    this.submitBrackets(w);
  }

  private submitBrackets(w: Working) {
    if (w.tp === null && w.sl === null) {
      this.broker.cancel(bracketKey(w.id));
      return;
    }
    this.broker.exit(bracketKey(w.id), {
      fromEntry: orderKey(w.id),
      limit: w.tp ?? undefined,
      stop: w.sl ?? undefined,
      commentProfit: TP_COMMENT,
      commentLoss: SL_COMMENT,
    });
  }

  private submitPositionBrackets() {
    if (this.broker.positionSize === 0 || (this.posTp === null && this.posSl === null)) {
      this.broker.cancel(POS_KEY);
      return;
    }
    this.broker.exit(POS_KEY, {
      limit: this.posTp ?? undefined,
      stop: this.posSl ?? undefined,
      commentProfit: TP_COMMENT,
      commentLoss: SL_COMMENT,
    });
  }

  private emitBrackets(w: Working, kind: "placed" | "cancelled") {
    const side: Side = w.side === "buy" ? "sell" : "buy";
    if (w.tp !== null) this.emit({ kind, label: "Take Profit", side, qty: w.qty, price: w.tp });
    if (w.sl !== null) this.emit({ kind, label: "Stop Loss", side, qty: w.qty, price: w.sl });
  }

  private orderPrice(w: Working): number | null {
    return w.type === "stop" || w.type === "stopLimit" ? w.stop : w.limit;
  }

  private qty(q: number): number {
    const step = this.sym.qtyStep;
    return Math.floor(q / step + 1e-9) * step;
  }

  private price(p: number | null): number | null {
    return p === null ? null : this.broker.roundPrice(p);
  }
}
