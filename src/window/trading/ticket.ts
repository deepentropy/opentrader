/*
 * Order ticket logic without the UI: the entry price, the validated order
 * request, the place-button line, the default exit prices and the hints of
 * the ticket fields (distance to the market in ticks, risk).
 */
import type { TicketDraft } from "../../data/trading/trading-ui";
import type { OrderRequest, TradingQuote } from "../../data/trading/types";
import { fmtQty, parsePositive, tickerOf } from "./format";

/** Default exit distances in ticks (take profit / stop loss). */
export const TP_TICKS = 75;
export const SL_TICKS = 25;

export type Quote = Pick<TradingQuote, "bid" | "ask" | "last">;

/** The quote an order of `side` would trade at (ask to buy, bid to sell). */
export function quotePrice(q: Quote | null, side: "buy" | "sell"): number | null {
  if (!q) return null;
  return (side === "buy" ? q.ask ?? q.last : q.bid ?? q.last) ?? null;
}

/** The entry price the exits and the order info are measured from. */
export function entryPrice(d: TicketDraft, q: Quote | null): number | null {
  if (d.orderType === "limit" || d.orderType === "stopLimit") return parsePositive(d.limitPrice);
  if (d.orderType === "stop") return parsePositive(d.stopPrice);
  return quotePrice(q, d.side);
}

/** Default take-profit / stop-loss price, `ticks` away from the entry. */
export function exitPrice(d: TicketDraft, q: Quote | null, kind: "tp" | "sl", tick: number, decimals: number): string {
  const e = entryPrice(d, q);
  if (e == null) return "";
  const sign = d.side === "buy" ? 1 : -1;
  const dist = (kind === "tp" ? TP_TICKS : -SL_TICKS) * tick * sign;
  return (e + dist).toFixed(decimals);
}

/** Distance of an exit from the entry, in ticks ("75 ticks"). */
export function exitTicks(d: TicketDraft, q: Quote | null, price: string, tick: number): number | null {
  const e = entryPrice(d, q);
  const p = parsePositive(price);
  if (e == null || p == null || !(tick > 0)) return null;
  return Math.round(Math.abs(p - e) / tick);
}

/** Hint of an order price field: its distance to the market in ticks
 *  ("Ask", "Ask − 2388", "Bid + 12"). */
export function marketHint(d: TicketDraft, q: Quote | null, price: string, tick: number): string {
  const ref = quotePrice(q, d.side);
  const p = parsePositive(price);
  const name = d.side === "buy" ? "Ask" : "Bid";
  if (ref == null || p == null || !(tick > 0)) return name;
  const n = Math.round((p - ref) / tick);
  if (n === 0) return name;
  return `${name} ${n > 0 ? "+" : "−"} ${Math.abs(n)}`;
}

/** Money at risk: the quantity times the distance from the entry to the stop
 *  loss (null without a stop loss). */
export function riskValue(d: TicketDraft, q: Quote | null, pointValue = 1): number | null {
  if (!d.slOn) return null;
  const qty = parsePositive(d.qty);
  const e = entryPrice(d, q);
  const sl = parsePositive(d.stopLoss);
  if (qty == null || e == null || sl == null) return null;
  return qty * Math.abs(e - sl) * pointValue;
}

/** Risk / reward of the exits (both on). */
export function riskReward(d: TicketDraft, q: Quote | null): number | null {
  const e = entryPrice(d, q);
  const tp = parsePositive(d.takeProfit);
  const sl = parsePositive(d.stopLoss);
  if (!d.tpOn || !d.slOn || e == null || tp == null || sl == null || sl === e) return null;
  return Math.abs(tp - e) / Math.abs(e - sl);
}

/** The order to send, or the message of what is missing / wrong. */
export function buildTicket(d: TicketDraft, q: Quote | null): OrderRequest | string {
  const qty = parsePositive(d.qty);
  if (qty == null) return "Enter a quantity";
  const needsLimit = d.orderType === "limit" || d.orderType === "stopLimit";
  const needsStop = d.orderType === "stop" || d.orderType === "stopLimit";
  const limit = needsLimit ? parsePositive(d.limitPrice) : null;
  const stop = needsStop ? parsePositive(d.stopPrice) : null;
  if (needsLimit && limit == null) return "Enter a limit price";
  if (needsStop && stop == null) return "Enter a stop price";
  const tp = d.tpOn ? parsePositive(d.takeProfit) : null;
  const sl = d.slOn ? parsePositive(d.stopLoss) : null;
  if (d.tpOn && tp == null) return "Enter a take profit price";
  if (d.slOn && sl == null) return "Enter a stop loss price";
  const e = entryPrice(d, q);
  if (e != null) {
    const up = d.side === "buy" ? 1 : -1;
    if (tp != null && (tp - e) * up <= 0) return `Take profit must be ${d.side === "buy" ? "above" : "below"} the entry price`;
    if (sl != null && (sl - e) * up >= 0) return `Stop loss must be ${d.side === "buy" ? "below" : "above"} the entry price`;
  }
  return {
    symbol: d.symbol,
    side: d.side,
    type: d.orderType,
    qty,
    limitPrice: limit,
    stopPrice: stop,
    takeProfit: tp,
    stopLoss: sl,
  };
}

/** Second line of the place button: "1 AAPL @ 123.45 LIMIT". */
export function describeTicket(d: TicketDraft, decimals: number): string {
  const qty = fmtQty(parsePositive(d.qty) ?? 0);
  const t = tickerOf(d.symbol);
  const f = (v: number | null) => (v != null ? v.toFixed(decimals) : "—");
  const lp = parsePositive(d.limitPrice);
  const sp = parsePositive(d.stopPrice);
  switch (d.orderType) {
    case "market":
      return `${qty} ${t} MARKET`;
    case "limit":
      return `${qty} ${t} @ ${f(lp)} LIMIT`;
    case "stop":
      return `${qty} ${t} @ ${f(sp)} STOP`;
    case "stopLimit":
      return `${qty} ${t} @ ${f(sp)} STOP ${f(lp)} LIMIT`;
  }
}
