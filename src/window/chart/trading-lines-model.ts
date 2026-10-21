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

/** Order chip text: "Buy limit", "Sell stop limit"; brackets "Take profit" /
 *  "Stop loss" (reference app). */
export function orderChipText(o: TradingOrder): string {
  if (o.kind === "tp") return "Take profit";
  if (o.kind === "sl") return "Stop loss";
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

/** Take profit / stop loss of a working order at the ticket's default
 *  distance from its price (buy: above / below). */
export function defaultOrderBracket(o: TradingOrder, kind: "tp" | "sl", tick: number): number | null {
  const price = orderLinePrice(o);
  if (price === null) return null;
  const sign = o.side === "buy" ? 1 : -1;
  const dist = (kind === "tp" ? TP_TICKS : -SL_TICKS) * tick * sign;
  return snapToTick(price + dist, tick);
}

/** A price label on the axis: its line's y, and whether it cannot move (the
 *  series' last price label). */
export type AxisItem = { y: number; fixed?: boolean };

/**
 * Label positions on the price axis that do not overlap (`h` px each), the
 * way the reference app lays out its labels: touching labels form a stack, in
 * price order, centred on their lines, or around a fixed label (which keeps
 * its place). Returns the y of each item, in the input order.
 */
export function stackLabels(items: AxisItem[], h: number): number[] {
  // At the same price a label goes above the fixed one (the position over the last price).
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.y - b.y || (a.fixed ? 1 : 0) - (b.fixed ? 1 : 0));
  type Cluster = { members: typeof order; top: number };
  const place = (c: Cluster) => {
    const k = c.members.findIndex((m) => m.fixed);
    if (k >= 0) c.top = c.members[k].y - k * h;
    else c.top = c.members.reduce((s, m) => s + m.y, 0) / c.members.length - ((c.members.length - 1) * h) / 2;
  };
  let clusters: Cluster[] = order.map((m) => ({ members: [m], top: m.y }));
  for (let guard = 0; guard < items.length + 1; guard++) {
    let merged = false;
    const next: Cluster[] = [];
    for (const c of clusters) {
      const prev = next[next.length - 1];
      if (prev && prev.top + prev.members.length * h > c.top + 1e-9) {
        prev.members.push(...c.members);
        place(prev);
        merged = true;
      } else next.push(c);
    }
    clusters = next;
    if (!merged) break;
  }
  const out = new Array<number>(items.length);
  for (const c of clusters) c.members.forEach((m, k) => (out[m.i] = c.top + k * h));
  return out;
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
