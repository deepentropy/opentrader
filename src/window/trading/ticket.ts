/*
 * Order ticket logic without the UI: the entry price, the validated ticket
 * sent to the broker, the place-button line and the default exit prices.
 */
import type { OrderTicket as Ticket } from "../../bindings";
import type { TicketDraft } from "../../data/trading-ui";
import { fmtQty, parsePositive, tickerOf } from "./format";

/** Default exit distances in ticks (take profit / stop loss). */
export const TP_TICKS = 75;
export const SL_TICKS = 25;

export type Quote = { bid: number | null; ask: number | null; last: number | null };

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

/** The ticket to send, or the message of what is missing / wrong. */
export function buildTicket(d: TicketDraft, q: Quote | null): Ticket | string {
  const qty = parsePositive(d.qty);
  if (qty == null) return "Enter a quantity";
  const needsLimit = d.orderType === "limit" || d.orderType === "stopLimit";
  const needsStop = d.orderType === "stop" || d.orderType === "stopLimit";
  const limit = needsLimit ? parsePositive(d.limitPrice) : null;
  const stop = needsStop ? parsePositive(d.stopPrice) : null;
  if (needsLimit && limit == null) return "Enter a limit price";
  if (needsStop && stop == null) return "Enter a stop price";
  const exits = !d.editing;
  const tp = exits && d.tpOn ? parsePositive(d.takeProfit) : null;
  const sl = exits && d.slOn ? parsePositive(d.stopLoss) : null;
  if (exits && d.tpOn && tp == null) return "Enter a take profit price";
  if (exits && d.slOn && sl == null) return "Enter a stop loss price";
  const e = entryPrice(d, q);
  if (e != null) {
    const up = d.side === "buy" ? 1 : -1;
    if (tp != null && (tp - e) * up <= 0) return `Take profit must be ${d.side === "buy" ? "above" : "below"} the entry price`;
    if (sl != null && (sl - e) * up >= 0) return `Stop loss must be ${d.side === "buy" ? "below" : "above"} the entry price`;
  }
  return {
    symbol: d.symbol,
    side: d.side,
    orderType: d.orderType,
    qty,
    limitPrice: limit,
    stopPrice: stop,
    duration: d.duration,
    outsideRth: d.outsideRth,
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
