/*
 * DOM (depth of market) ladder of the order ticket's DOM tab: one row per
 * price tick around the market (reference app 3.4.1). Rows are price
 * indexes (price / tick); the top row's index scrolls. The replay broker
 * quotes one level (bid = ask = the last price) with no size, so the bid /
 * ask size cells stay empty and the totals read "-".
 *
 * Colours: prices at or above the best ask read as asks (red), at or below
 * the best bid as bids (blue). Auto-centre: when the best ask comes within 3
 * rows of the top or the best bid within 3 rows of the bottom, the ladder
 * re-centres on the market after 2 s (dynamic mode: on every update).
 */
import type { OrderType, Side, TradingOrder } from "../../data/trading/types";

/** Row height (px). */
export const DOM_ROW_H = 20;
/** Auto-centre delay (ms). */
export const DOM_CENTER_DELAY = 2000;

/** Price index of `price` on a `tick` grid. */
export function priceIndex(price: number, tick: number): number {
  return Math.round(price / tick);
}

/** Price of index `i` (rounded to the tick's decimals). */
export function indexPrice(i: number, tick: number, decimals: number): number {
  return Number((i * tick).toFixed(decimals));
}

/** Best bid / ask and last as indexes (NaN = none). */
export type DomMarket = { bid: number; ask: number; last: number };

/** Index the ladder centres on: between the best bid and ask, else either,
 *  else the last price. */
export function centerIndex(m: DomMarket): number {
  let a = m.ask;
  let b = m.bid;
  if (!Number.isFinite(a)) a = b;
  if (!Number.isFinite(b)) b = a;
  const mid = Math.floor((a + b) / 2);
  return Number.isFinite(mid) ? mid : m.last;
}

/** Top row index once centred on the market. */
export function centeredTop(m: DomMarket, height: number): number {
  return centerIndex(m) + Math.floor(height / 2);
}

/** The market is within 3 rows of the top / bottom edge (and the ladder is
 *  not centred already): a re-centre is due. */
export function needsCenter(top: number, height: number, m: DomMarket): boolean {
  if (!Number.isFinite(top)) return true;
  const bottom = top - (height - 1);
  let low = Number.isFinite(m.bid) ? m.bid : Number.isFinite(m.ask) ? m.ask : m.last;
  let high = m.ask;
  if (!Number.isFinite(high)) {
    if (Number.isFinite(m.bid)) high = m.bid;
    else low = m.last;
  }
  return (high + 3 > top || low - 3 < bottom) && top !== centeredTop(m, height);
}

/** Price colour of a row: "ask" at or above the best ask, "bid" at or below
 *  the best bid. */
export function priceSide(i: number, m: DomMarket): "ask" | "bid" | null {
  if (i >= m.ask) return "ask";
  if (i <= m.bid) return "bid";
  return null;
}

/** The hover label of a size cell is tinted ("active"): limit mode above the
 *  best bid (buy) / below the best ask (sell); stop mode the other way. */
export function labelActive(side: Side, i: number, m: DomMarket, stopMode: boolean): boolean {
  const inside = side === "buy" ? i > m.bid : i < m.ask;
  return stopMode ? !inside : inside;
}

/** One order mark on a row. */
export type DomOrderMark = {
  order: TradingOrder;
  field: "limitPrice" | "stopPrice";
  side: Side;
  /** "limit" | "stop" | "stoplimit" (colour). */
  type: "limit" | "stop" | "stoplimit" | "market";
  typeText: string;
  qty: number;
  /** Not working yet: a bracket of a pending order, the limit of a
   *  stop-limit before its stop. */
  inactive: boolean;
};

const isBracket = (o: TradingOrder) => o.kind === "tp" || o.kind === "sl";

/** The order marks per row index. */
export function orderMarks(orders: TradingOrder[], tick: number): Map<number, DomOrderMark[]> {
  const out = new Map<number, DomOrderMark[]>();
  const ids = new Set(orders.filter((o) => o.kind === "order").map((o) => o.id));
  const add = (i: number, m: DomOrderMark) => out.set(i, [...(out.get(i) ?? []), m]);
  for (const o of orders) {
    const pending = isBracket(o) && o.parentId !== null && ids.has(o.parentId);
    const base = { order: o, side: o.side, qty: o.qty };
    const type: DomOrderMark["type"] = o.type === "stopLimit" ? "stoplimit" : o.type;
    const typeText =
      o.type === "market" ? "Market" : o.type === "limit" ? (isBracket(o) ? "TakeProfit" : "Limit") : o.type === "stop" ? (isBracket(o) ? "StopLoss" : "Stop") : "Stop Limit";
    if (o.stopPrice !== null && !(o.type === "stopLimit" && o.stopTriggered))
      add(priceIndex(o.stopPrice, tick), { ...base, field: "stopPrice", type, typeText, inactive: pending });
    if (o.limitPrice !== null)
      add(priceIndex(o.limitPrice, tick), {
        ...base,
        field: "limitPrice",
        type,
        typeText,
        inactive: pending || (o.type === "stopLimit" && !o.stopTriggered),
      });
  }
  return out;
}

/** Working / inactive order counts and the working quantity of a side
 *  (the counters by the "Cancel all buy / sell orders" buttons). */
export function sideCounts(orders: TradingOrder[], side: Side): { active: number; inactive: number; qty: number } {
  const ids = new Set(orders.filter((o) => o.kind === "order").map((o) => o.id));
  let active = 0;
  let inactive = 0;
  let qty = 0;
  for (const o of orders) {
    if (o.side !== side) continue;
    if (isBracket(o) && o.parentId !== null && ids.has(o.parentId)) inactive++;
    else {
      active++;
      qty += o.qty;
    }
  }
  return { active, inactive, qty };
}

/** The counter text ("" when no order) and its tooltip. */
export function countText(c: { active: number; inactive: number; qty: number }): { text: string; title: string } {
  if (!c.active && !c.inactive) return { text: "", title: "" };
  const a = `${c.active} active order${c.active === 1 ? "" : "s"} x ${c.qty}`;
  const i = c.inactive ? `, ${c.inactive} inactive order${c.inactive === 1 ? "" : "s"}` : "";
  return { text: String(c.active), title: a + i };
}

/** The order a click on a size cell places: limit, or stop with Ctrl / Cmd. */
export function clickOrderType(mod: boolean): OrderType {
  return mod ? "stop" : "limit";
}

/** Context menu of a size cell: stop, limit, stop-limit (limit one tick
 *  past the stop) and market, as "Buy 1 QQQ @ 717.00 Limit". */
export function contextItems(
  side: Side,
  price: number,
  qtyText: string,
  ticker: string,
  tick: number,
  fmt: (p: number) => string,
): { label: string; type: OrderType; price: number | null; limit: number | null }[] {
  const s = side === "buy" ? "Buy" : "Sell";
  const head = `${s} ${qtyText} ${ticker} @`;
  const limit = Number((price + (side === "buy" ? tick : -tick)).toFixed(10));
  return [
    { label: `${head} ${fmt(price)} Stop`, type: "stop", price, limit: null },
    { label: `${head} ${fmt(price)} Limit`, type: "limit", price, limit: null },
    { label: `${head} ${fmt(price)} Stop ${fmt(limit)} Limit`, type: "stopLimit", price, limit },
    { label: `${head} Market`, type: "market", price: null, limit: null },
  ];
}

/** Wheel scroll: rows accumulate per 100 px of wheel delta. */
export function wheelRows(acc: number, deltaPx: number): { rows: number; rest: number } {
  const v = acc - deltaPx / 100;
  const rows = Math.trunc(v);
  return { rows, rest: v - rows };
}
