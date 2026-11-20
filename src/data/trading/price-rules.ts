/*
 * Order price rules (#370), checked as the reference app checks an order price, in the order ticket and on a
 * dragged order line:
 * - the price is a whole number of ticks;
 * - a stop (and the stop of a stop limit) sits beyond the market: a buy stop at or above the ask, a sell stop at or
 *   below the bid; it would trigger at once otherwise (unless the broker takes stops on either side);
 * - a limit may cross the market (a marketable limit), unless it is more than half the market price away or the
 *   broker refuses any crossing limit;
 * - no price above 100 times the market.
 * The limit of a stop limit is only checked for the tick: it may sit on either side of its stop.
 */
import { localNumber } from "../../i18n/format";
import { translate, translateWith } from "../../i18n/translator";
import type { TradingCapabilities } from "./capabilities";
import type { OrderType, Side } from "./types";

export type PriceRules = Pick<TradingCapabilities, "stopOrdersBothSides" | "stopLimitOrdersBothSides" | "strictLimitPrice">;

/** An order price to check: the limit or the stop price of an order of `type` and `side`. */
export type OrderPrice = { type: OrderType; side: Side; field: "limit" | "stop"; price: number };

/** `price` is a whole number of ticks (to a millionth of a tick: prices are decimals). */
export function onTick(price: number, tick: number): boolean {
  if (!(tick > 0)) return true;
  const n = price / tick;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

/** `p` on the wrong side of `market` (ask to buy, bid to sell) for its order type, or too far from it. */
export function badSide(p: OrderPrice, market: number, rules: PriceRules): boolean {
  if (p.price < 0 || p.price > market * 100) return true;
  const buy = p.side === "buy";
  if (p.type === "limit") {
    const crosses = buy ? p.price > market : p.price < market;
    return crosses && (Math.abs(p.price - market) > market / 2 || rules.strictLimitPrice);
  }
  const stop = (p.type === "stop" && !rules.stopOrdersBothSides) || (p.type === "stopLimit" && p.field === "stop" && !rules.stopLimitOrdersBothSides);
  return stop && (buy ? p.price < market : p.price > market);
}

/** What is wrong with an order price, null when it is valid. `market`: the ask to buy, the bid to sell (unknown:
 *  only the tick is checked). */
export function orderPriceError(p: OrderPrice, market: number | null, tick: number, rules: PriceRules): string | null {
  if (!onTick(p.price, tick)) return translateWith("The price must be a multiple of {0}", localNumber(String(Number(tick.toPrecision(12)))));
  if (market != null && market > 0 && badSide(p, market, rules)) return translate("This price is not valid for this order type");
  return null;
}

/** The limit price a stop limit starts with: one tick beyond its stop (above to buy, below to sell). */
export function stopLimitPrice(stop: number, side: Side, tick: number): number {
  return stop + (side === "buy" ? tick : -tick);
}
