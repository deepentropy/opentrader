/*
 * DOM (depth of market) ladder of the order ticket's DOM tab: one row per
 * price tick around the market (reference app 3.4.1). Rows are price
 * indexes (price / tick); the top row's index scrolls. A broker that sends
 * its order book (#372) fills the bid / ask size cells, their meters and the
 * totals, and its best levels mark the bid and ask. The replay broker quotes
 * one level (bid = ask = the last price) with no size: the size cells stay
 * empty, the best bid / ask meters full, and the totals read "-".
 *
 * With a book (#374): a price step groups the levels and the orders on rows
 * of several ticks (a level goes to the row at or above its price), and the
 * "Show prices" settings hide the rows without size around the book and in
 * the spread. The ladder then scrolls in rows: a row number maps to the price
 * index it shows (`rowIndex`), skipping the hidden ones.
 *
 * Colours: prices at or above the best ask read as asks (red), at or below
 * the best bid as bids (blue). Auto-centre: when the best ask comes within 3
 * rows of the top or the best bid within 3 rows of the bottom, the ladder
 * re-centres on the market after 2 s (dynamic mode: on every update).
 */
import type { DepthBook } from "../../data/trading/depth-book";
import type { OrderType, Side, TradingOrder } from "../../data/trading/types";
import { translatePlural, translateWith } from "../../i18n/translator";

/** Row height (px). */
export const DOM_ROW_H = 20;
/** Auto-centre delay (ms). */
export const DOM_CENTER_DELAY = 2000;

/** The price steps offered, in ticks (the first is the default). */
export const DOM_STEPS = [1, 2, 5, 10, 20, 50, 100];

/** Price index of `price` on a grid of `step` ticks: rounded to the tick, then
 *  up to the step (away from 0). */
export function priceIndex(price: number, tick: number, step = 1): number {
  const i = Math.round(price / tick);
  if (step === 1) return i;
  const r = i / step;
  return r < 0 ? Math.floor(r) : Math.ceil(r);
}

/** Price of index `i` (rounded to the tick's decimals). */
export function indexPrice(i: number, tick: number, decimals: number): number {
  return Number((i * tick).toFixed(decimals));
}

/** Best bid / ask and last as indexes (NaN = none). */
export type DomMarket = { bid: number; ask: number; last: number };

/** An order book on the ladder's rows: quantity per price index (levels that
 *  fall on one row add up), the totals, the largest level (the meters' full
 *  width) and the best bid / ask indexes (NaN without that side). */
export type DomDepth = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  totalBid: number;
  totalAsk: number;
  max: number;
  bestBid: number;
  bestAsk: number;
  /** The lowest bid and the highest ask (NaN without that side). */
  worstBid: number;
  worstAsk: number;
};

export function depthRows(book: DepthBook, tick: number, step = 1): DomDepth {
  const side = (levels: Map<number, number>) => {
    const out = new Map<number, number>();
    let total = 0;
    for (const [price, qty] of levels) {
      const i = priceIndex(price, tick, step);
      out.set(i, (out.get(i) ?? 0) + qty);
      total += qty;
    }
    return { out, total };
  };
  const b = side(book.bids);
  const a = side(book.asks);
  let max = 0;
  for (const q of b.out.values()) max = Math.max(max, q);
  for (const q of a.out.values()) max = Math.max(max, q);
  return {
    bids: b.out,
    asks: a.out,
    totalBid: b.total,
    totalAsk: a.total,
    max,
    bestBid: b.out.size ? Math.max(...b.out.keys()) : NaN,
    bestAsk: a.out.size ? Math.min(...a.out.keys()) : NaN,
    worstBid: b.out.size ? Math.min(...b.out.keys()) : NaN,
    worstAsk: a.out.size ? Math.max(...a.out.keys()) : NaN,
  };
}

/** Rows shown of a stretch of the ladder: its price indexes, highest first. */
export type DomZone = number[];
/** The stretches of the ladder that show some of their rows only, top
 *  first; the rows outside them all show. */
export type DomRows = { zones: DomZone[]; spreadHidden: boolean };

const desc = (xs: Iterable<number>) => [...new Set(xs)].filter(Number.isFinite).sort((a, b) => b - a);

/** The rows the "Show prices" settings hide (#374), as the reference app
 *  does. Without zero volume prices: inside each side of the book (best to
 *  worst level) only the rows with size or orders show. Without the prices
 *  between the best bid / ask: the spread's rows go (a crossed book keeps
 *  them). Nothing is hidden before the book has two levels. */
export function domRows(d: DomDepth | null, orderIndexes: Iterable<number>, prices: { zeroVolume: boolean; spread: boolean }): DomRows {
  const none = { zones: [], spreadHidden: false };
  if (!d || new Set([...d.bids.keys(), ...d.asks.keys()]).size < 2) return none;
  const spread = prices.spread || !(d.bestBid < d.bestAsk);
  if (prices.zeroVolume && spread) return none;
  if (!spread && prices.zeroVolume) return { zones: [desc([d.bestAsk, d.bestBid])], spreadHidden: true };
  const orders = desc(orderIndexes);
  const askZone = desc([...d.asks.keys(), ...orders.filter((i) => i <= d.worstAsk && i >= d.bestAsk)]);
  const bidZone = desc([...d.bids.keys(), ...orders.filter((i) => i <= d.bestBid && i >= d.worstBid)]);
  if (spread) return { zones: [askZone, bidZone].filter((z) => z.length), spreadHidden: false };
  return { zones: [desc([...askZone, ...bidZone])], spreadHidden: true };
}

/** The price index shown on row number `v` (row numbers go down the ladder
 *  like prices; outside the zones a row is its price index, shifted by the
 *  rows hidden above). */
export function rowIndex(zones: DomZone[], v: number): number {
  let hidden = 0;
  for (const z of zones) {
    if (!z.length) continue;
    const r = z[0] - (v - hidden);
    if (r < 0) return v - hidden;
    if (r < z.length) return z[r];
    hidden += z[0] - z[z.length - 1] - (z.length - 1);
  }
  return v - hidden;
}

/** The row number of price index `i` (a hidden price: the row of the next
 *  shown price under it). */
export function rowOf(zones: DomZone[], i: number): number {
  if (!Number.isFinite(i)) return i;
  let hidden = 0;
  for (const z of zones) {
    if (!z.length) continue;
    if (i > z[0]) return i + hidden;
    if (i >= z[z.length - 1]) {
      const r = z.findIndex((x) => x <= i);
      return z[0] + hidden - r;
    }
    hidden += z[0] - z[z.length - 1] - (z.length - 1);
  }
  return i + hidden;
}

/** Top row number once centred on the market: on the middle of the spread,
 *  or on the best ask when the spread's rows are hidden. */
export function centeredRow(m: DomMarket, rows: DomRows, height: number): number {
  const at = rows.spreadHidden && Number.isFinite(m.ask) ? m.ask : centerIndex(m);
  return rowOf(rows.zones, at) + Math.floor(height / 2);
}

/** The market as row numbers. */
export function marketRows(m: DomMarket, zones: DomZone[]): DomMarket {
  return { bid: rowOf(zones, m.bid), ask: rowOf(zones, m.ask), last: rowOf(zones, m.last) };
}

/** A size cell's meter, 0..1 of the cell: its quantity over the largest
 *  level's. */
export function meterShare(qty: number | undefined, max: number): number {
  if (!qty || !(max > 0)) return 0;
  return Math.min(Math.max(qty / max, 0), 1);
}

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
 *  not centred already, on `target`): a re-centre is due. */
export function needsCenter(top: number, height: number, m: DomMarket, target = centeredTop(m, height)): boolean {
  if (!Number.isFinite(top)) return true;
  const bottom = top - (height - 1);
  let low = Number.isFinite(m.bid) ? m.bid : Number.isFinite(m.ask) ? m.ask : m.last;
  let high = m.ask;
  if (!Number.isFinite(high)) {
    if (Number.isFinite(m.bid)) high = m.bid;
    else low = m.last;
  }
  return (high + 3 > top || low - 3 < bottom) && top !== target;
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
export function orderMarks(orders: TradingOrder[], tick: number, step = 1): Map<number, DomOrderMark[]> {
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
      add(priceIndex(o.stopPrice, tick, step), { ...base, field: "stopPrice", type, typeText, inactive: pending });
    if (o.limitPrice !== null)
      add(priceIndex(o.limitPrice, tick, step), {
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
  const a = translatePlural(c.active, { one: "{0} active order x {1}", other: "{0} active orders x {1}" }, c.active, c.qty);
  const title = c.inactive ? translatePlural(c.inactive, { one: "{0}, {1} inactive order", other: "{0}, {1} inactive orders" }, a, c.inactive) : a;
  return { text: String(c.active), title };
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
  const buy = side === "buy";
  const limit = Number((price + (buy ? tick : -tick)).toFixed(10));
  const [at, lim] = [fmt(price), fmt(limit)];
  return [
    { label: translateWith(buy ? "Buy {0} {1} @ {2} Stop" : "Sell {0} {1} @ {2} Stop", qtyText, ticker, at), type: "stop", price, limit: null },
    { label: translateWith(buy ? "Buy {0} {1} @ {2} Limit" : "Sell {0} {1} @ {2} Limit", qtyText, ticker, at), type: "limit", price, limit: null },
    { label: translateWith(buy ? "Buy {0} {1} @ {2} Stop {3} Limit" : "Sell {0} {1} @ {2} Stop {3} Limit", qtyText, ticker, at, lim), type: "stopLimit", price, limit },
    { label: translateWith(buy ? "Buy {0} {1} @ Market" : "Sell {0} {1} @ Market", qtyText, ticker), type: "market", price: null, limit: null },
  ];
}

/** Wheel scroll: rows accumulate per 100 px of wheel delta. */
export function wheelRows(acc: number, deltaPx: number): { rows: number; rest: number } {
  const v = acc - deltaPx / 100;
  const rows = Math.trunc(v);
  return { rows, rest: v - rows };
}
