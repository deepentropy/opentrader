/*
 * Texts and prices of the chart trading lines (Bar Replay trading): chip
 * labels, the dialog summaries, tick snapping, the default bracket of a
 * position and the order request a dragged line sends.
 */
import type { OrderRequest, TradingExecution, TradingOrder, TradingPosition } from "../../data/trading/types";

/** Default bracket distances in ticks (the order ticket's). */
export const TP_TICKS = 75;
export const SL_TICKS = 25;

const TYPE_TEXT: Record<TradingOrder["type"], string> = {
  market: "Market",
  limit: "Limit",
  stop: "Stop",
  stopLimit: "Stop Limit",
};

/** Decimals of a price tick (0.01 → 2, 0.25 → 2, 1 → 0). */
export function tickDecimals(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 2;
  const s = String(tick);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

export function fmtPrice(v: number, tick: number): string {
  return v.toFixed(Math.max(2, tickDecimals(tick)));
}

export function fmtQty(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(8)));
}

/** Nearest tick level. */
export function snapToTick(p: number, tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return p;
  return Number((Math.round(p / tick) * tick).toFixed(tickDecimals(tick)));
}

/** The price a line of `o` sits at: the stop of stop orders, else the limit. */
export function orderLinePrice(o: TradingOrder): number | null {
  if (o.kind === "tp") return o.limitPrice;
  if (o.kind === "sl") return o.stopPrice;
  return o.type === "stop" || o.type === "stopLimit" ? o.stopPrice : o.limitPrice;
}

/** Order chip text: "Buy limit", "Sell stop limit"; brackets "TP" / "SL". */
export function orderChipText(o: TradingOrder): string {
  if (o.kind === "tp") return "TP";
  if (o.kind === "sl") return "SL";
  return `${o.side === "buy" ? "Buy" : "Sell"} ${TYPE_TEXT[o.type].toLowerCase()}`;
}

/** Cancel order dialog line: "Buy Limit 1 @ 640.00"; a bracket "TP 1 @ 640.75" /
 *  "SL 1 @ 639.75" (reference app). */
export function orderSummary(o: TradingOrder, tick: number): string {
  const price = orderLinePrice(o);
  const at = price !== null && o.type !== "market" ? ` @ ${fmtPrice(price, tick)}` : "";
  if (o.kind !== "order") return `${o.kind === "tp" ? "TP" : "SL"} ${fmtQty(o.qty)}${at}`;
  return `${o.side === "buy" ? "Buy" : "Sell"} ${TYPE_TEXT[o.type]} ${fmtQty(o.qty)}${at}`;
}

/** Cancel dialog title: "Cancel order", "Cancel take profit order", "Cancel stop loss order". */
export function cancelTitle(o: TradingOrder): string {
  return o.kind === "tp" ? "Cancel take profit order" : o.kind === "sl" ? "Cancel stop loss order" : "Cancel order";
}

/** Close position dialog line: "Long 1 @ 651.42". */
export function positionSummary(p: TradingPosition, tick: number): string {
  return `${p.side === "buy" ? "Long" : "Short"} ${fmtQty(p.qty)} @ ${fmtPrice(p.avgPrice, tick)}`;
}

/** Execution label: "1 @ 651.42". */
export function executionLabel(e: TradingExecution, tick: number): string {
  return `${fmtQty(e.qty)} @ ${fmtPrice(e.price, tick)}`;
}

/** Signed money text: "+12.46 USD" / "−3.10 USD". */
export function fmtPl(v: number, currency: string): string {
  const abs = Math.abs(v).toFixed(2);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${abs} ${currency}`;
}

/** Take profit / stop loss of a position at the ticket's default distance. */
export function defaultBracket(p: TradingPosition, kind: "tp" | "sl", tick: number): number {
  const sign = p.side === "buy" ? 1 : -1;
  const dist = (kind === "tp" ? TP_TICKS : -SL_TICKS) * tick * sign;
  return snapToTick(p.avgPrice + dist, tick);
}

/** The request that keeps order `o` and sets its line price to `price`. */
export function requestWithPrice(o: TradingOrder, price: number | null, patch: Partial<OrderRequest> = {}): OrderRequest {
  const base: OrderRequest = {
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    qty: o.qty,
    limitPrice: o.limitPrice,
    stopPrice: o.stopPrice,
    takeProfit: o.takeProfit,
    stopLoss: o.stopLoss,
  };
  if (price !== null) {
    if (o.type === "stop" || o.type === "stopLimit") base.stopPrice = price;
    else base.limitPrice = price;
  }
  return { ...base, ...patch };
}
