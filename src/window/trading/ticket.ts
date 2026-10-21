/*
 * Order ticket logic without the UI: the entry price, the validated order
 * request, the place-button line, the default exit prices and the hints of
 * the ticket fields (distance to the market in ticks, risk).
 */
import type { ExitFieldType, OrderPreset, TicketDraft } from "../../data/trading/trading-ui";
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

/** What an order price field is measured from: the ask (buy) / bid (sell),
 *  or the stop price for the limit price of a stop limit order. */
export function priceBase(d: TicketDraft, q: Quote | null, field: PriceField): { name: "Ask" | "Bid" | "Stop"; price: number | null } {
  if (field === "limitPrice" && d.orderType === "stopLimit") return { name: "Stop", price: parsePositive(d.stopPrice) };
  return { name: d.side === "buy" ? "Ask" : "Bid", price: quotePrice(q, d.side) };
}

/** Hint of an order price field: its distance to its base in ticks
 *  ("Ask", "Ask − 2388", "Bid + 12", "Stop + 5"). */
export function marketHint(d: TicketDraft, q: Quote | null, price: string, tick: number, field: PriceField = "limitPrice"): string {
  const { name, price: ref } = priceBase(d, q, field);
  const p = parsePositive(price);
  if (ref == null || p == null || !(tick > 0)) return name;
  const n = Math.round((p - ref) / tick);
  if (n === 0) return name;
  return `${name} ${n > 0 ? "+" : "−"} ${Math.abs(n)}`;
}

// ── Field types (reference: the label menu picks the type typed, the right
// drop-down the equivalent shown, ⇄ swaps them) ─────────────────────────────

export type PriceField = "limitPrice" | "stopPrice";
/** An order price typed as a price or as an offset in ticks from its base. */
export type PriceMode = "price" | "offset";
/** Quantity typed in units, or as the money / balance percentage at risk
 *  down to the stop loss. */
export type QtyType = "units" | "riskUsd" | "riskPct";
/** Exit typed as a price, ticks from the entry, % of the entry price, money
 *  won / lost, or % of the balance won / lost. */
export type ExitType = ExitFieldType;
export type ExitKind = "tp" | "sl";

export const EXIT_TYPES: ExitType[] = ["price", "ticks", "pricePct", "cash", "balancePct"];
export const QTY_TYPES: QtyType[] = ["units", "riskUsd", "riskPct"];

/** Prices, balance and point value the conversions need. */
export type TicketCtx = { tick: number; decimals: number; balance: number | null; pointValue?: number };

/** The field types of a draft (defaults: prices, units). */
export function fieldTypes(d: TicketDraft) {
  return {
    limitMode: d.limitMode ?? "price",
    stopMode: d.stopMode ?? "price",
    qtyType: d.qtyType ?? "units",
    qtyEquiv: d.qtyEquiv ?? (d.qtyType && d.qtyType !== "units" ? "units" : "riskUsd"),
    tpType: d.tpType ?? "price",
    tpEquiv: d.tpEquiv ?? (d.tpType && d.tpType !== "price" ? "price" : "ticks"),
    slType: d.slType ?? "price",
    slEquiv: d.slEquiv ?? (d.slType && d.slType !== "price" ? "price" : "ticks"),
  };
}

/** A signed number typed in an offset field ("" = 0, null when invalid). */
export function parseSigned(s: string | undefined): number | null {
  const t = String(s ?? "").replace(/−/g, "-").trim();
  if (t === "") return 0;
  return /^[-+]?[0-9]*\.?[0-9]+$/.test(t) ? Number(t) : null;
}

const round = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);
const isRiskQty = (t: QtyType) => t !== "units";
const isMoneyExit = (t: ExitType) => t === "cash" || t === "balancePct";

/** Price distance of an exit typed as `v` in `type` (null when unknown). */
export function exitDistance(type: ExitType, v: number, entry: number, qty: number | null, c: TicketCtx): number | null {
  const pv = c.pointValue ?? 1;
  switch (type) {
    case "price":
      return Math.abs(v - entry);
    case "ticks":
      return v * c.tick;
    case "pricePct":
      return (entry * v) / 100;
    case "cash":
      return qty ? v / (qty * pv) : null;
    case "balancePct":
      return qty && c.balance ? (c.balance * v) / 100 / (qty * pv) : null;
  }
}

/** Exit price from its typed value: on the profit side of the entry for a
 *  take profit, the loss side for a stop loss; rounded to the tick. */
export function exitFromValue(kind: ExitKind, side: "buy" | "sell", type: ExitType, v: number, entry: number, qty: number | null, c: TicketCtx): number | null {
  if (type === "price") return v;
  const dist = exitDistance(type, v, entry, qty, c);
  if (dist == null || !Number.isFinite(dist)) return null;
  const sign = (kind === "tp" ? 1 : -1) * (side === "buy" ? 1 : -1);
  return round(entry + sign * dist, c.tick);
}

/** An exit price in `type` (ticks, % price, money, % balance; null when unknown). */
export function exitValueIn(type: ExitType, price: number, entry: number, qty: number | null, c: TicketCtx): number | null {
  const dist = Math.abs(price - entry);
  const pv = c.pointValue ?? 1;
  switch (type) {
    case "price":
      return price;
    case "ticks":
      return c.tick > 0 ? Math.round(dist / c.tick) : null;
    case "pricePct":
      return entry ? (dist / entry) * 100 : null;
    case "cash":
      return qty != null ? dist * qty * pv : null;
    case "balancePct":
      return qty != null && c.balance ? ((dist * qty * pv) / c.balance) * 100 : null;
  }
}

/** A value as typed / shown: prices to the tick, ticks whole, the rest to 0.01. */
export function fmtTypeValue(type: ExitType | QtyType, v: number, decimals: number): string {
  if (type === "price") return v.toFixed(decimals);
  if (type === "ticks" || type === "units") return String(Math.round(v));
  return v.toFixed(2);
}

/** Units for the money at risk down to the stop loss (rounded down). */
export function unitsForRisk(cash: number, entry: number, sl: number, pointValue = 1): number | null {
  const per = Math.abs(entry - sl) * pointValue;
  if (!(per > 0) || !(cash > 0)) return null;
  return Math.floor(cash / per + 1e-9);
}

/** The draft with every field turned into what the order uses: offsets into
 *  prices, a risk into units, exits typed in ticks / % / money into prices.
 *  The ticket shows, validates and sends this. */
export function resolveDraft(d: TicketDraft, q: Quote | null, c: TicketCtx): TicketDraft {
  const t = fieldTypes(d);
  const r: TicketDraft = { ...d };
  const fx = (v: number | null) => (v != null && Number.isFinite(v) ? v.toFixed(c.decimals) : "");
  const usesStop = d.orderType === "stop" || d.orderType === "stopLimit";
  const usesLimit = d.orderType === "limit" || d.orderType === "stopLimit";
  if (usesStop && t.stopMode === "offset") {
    const base = priceBase(r, q, "stopPrice").price;
    const n = parseSigned(d.stopOffset);
    r.stopPrice = base != null && n != null ? fx(base + n * c.tick) : "";
  }
  if (usesLimit && t.limitMode === "offset") {
    const base = priceBase(r, q, "limitPrice").price;
    const n = parseSigned(d.limitOffset);
    r.limitPrice = base != null && n != null ? fx(base + n * c.tick) : "";
  }
  const entry = entryPrice(r, q);
  const exit = (kind: ExitKind, qty: number | null): string => {
    const on = kind === "tp" ? d.tpOn : d.slOn;
    const type = kind === "tp" ? t.tpType : t.slType;
    if (!on || type === "price") return kind === "tp" ? d.takeProfit : d.stopLoss;
    const v = parsePositive(kind === "tp" ? d.tpValue ?? "" : d.slValue ?? "");
    if (v == null || entry == null) return "";
    return fx(exitFromValue(kind, d.side, type, v, entry, qty, c));
  };
  // The stop loss first: a risk quantity is measured to it.
  r.stopLoss = exit("sl", isRiskQty(t.qtyType) ? null : parsePositive(d.qty));
  if (isRiskQty(t.qtyType)) {
    const risk = parsePositive(d.risk ?? "");
    const sl = parsePositive(r.stopLoss);
    const cash = risk == null ? null : t.qtyType === "riskUsd" ? risk : c.balance ? (c.balance * risk) / 100 : null;
    const units = d.slOn && cash != null && entry != null && sl != null ? unitsForRisk(cash, entry, sl, c.pointValue) : null;
    r.qty = units != null ? String(units) : "";
  }
  r.takeProfit = exit("tp", parsePositive(r.qty));
  return r;
}

/** Value of a quantity type for a resolved draft (units, money or % balance
 *  at risk; null without a stop loss). */
export function qtyValueIn(type: QtyType, r: TicketDraft, q: Quote | null, c: TicketCtx): number | null {
  if (type === "units") return parsePositive(r.qty);
  const cash = riskValue(r, q, c.pointValue);
  if (cash == null) return null;
  if (type === "riskUsd") return cash;
  return c.balance ? (cash / c.balance) * 100 : null;
}

/** The exit types a field can be typed in: no money exit for a stop loss
 *  while the quantity is a risk (the risk is measured to the stop loss). */
export function exitTypeDisabled(kind: ExitKind, type: ExitType, qtyType: QtyType): boolean {
  return kind === "sl" && isMoneyExit(type) && isRiskQty(qtyType);
}

/** "Sell Bid – 5", "Buy Ask + 5" (order preset offsets). */
export function presetPriceText(name: string, n: number): string {
  if (n > 0) return `${name} + ${n}`;
  if (n < 0) return `${name} – ${Math.abs(n)}`;
  return name;
}

/** Offset in ticks of an order price from its base (0 when unknown). */
export function priceOffset(d: TicketDraft, q: Quote | null, field: PriceField, tick: number): number {
  const base = priceBase(d, q, field).price;
  const p = parsePositive(field === "limitPrice" ? d.limitPrice : d.stopPrice);
  return base != null && p != null && tick > 0 ? Math.round((p - base) / tick) : 0;
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

/** The ticket fields a preset sets on draft `d`: its order type, its
 *  offsets for this side (in the price fields, whichever way they are typed)
 *  and its exits; without a stop loss the quantity is in units again. */
export function presetFields(p: OrderPreset, d: TicketDraft, q: Quote | null, tick: number, decimals: number): Partial<TicketDraft> {
  const buy = d.side === "buy";
  const t = fieldTypes(d);
  const fx = (v: number | null) => (v != null && Number.isFinite(v) ? v.toFixed(decimals) : "");
  const f: Partial<TicketDraft> = { orderType: p.orderType };
  const off = (buy ? p.buyPrice : p.sellPrice) ?? 0;
  const at = (base: number | null, n: number) => (base != null ? fx(base + n * tick) : "");
  if (p.orderType === "limit") Object.assign(f, { limitPrice: at(quotePrice(q, d.side), off), limitOffset: off ? String(off) : "" });
  if (p.orderType === "stop" || p.orderType === "stopLimit") Object.assign(f, { stopPrice: at(quotePrice(q, d.side), off), stopOffset: off ? String(off) : "" });
  if (p.orderType === "stopLimit") {
    const loff = (buy ? p.stopBuyLimitPrice : p.stopSellLimitPrice) ?? 0;
    Object.assign(f, { limitPrice: at(parsePositive(f.stopPrice ?? ""), loff), limitOffset: loff ? String(loff) : "" });
  }
  const exit = (kind: ExitKind, v: number | undefined, type: ExitType | undefined): Partial<TicketDraft> => {
    if (!v) return kind === "tp" ? { tpOn: false, takeProfit: "", tpValue: "" } : { slOn: false, stopLoss: "", slValue: "" };
    const ty = type ?? "ticks";
    const cur = kind === "tp" ? t.tpEquiv : t.slEquiv;
    const eq = cur === ty ? "price" : cur;
    return kind === "tp" ? { tpOn: true, tpType: ty, tpEquiv: eq, tpValue: String(v) } : { slOn: true, slType: ty, slEquiv: eq, slValue: String(v) };
  };
  Object.assign(f, exit("tp", p.tpPrice, p.tpPriceType), exit("sl", p.slPrice, p.slPriceType));
  if (!p.slPrice && t.qtyType !== "units") Object.assign(f, { qtyType: "units", qtyEquiv: t.qtyType });
  return f;
}
