/*
 * Texts of the order ticket fields: type titles, units and tips of the quantity and exits, and the one-time tips.
 */
import * as kv from "../../data/kv";
import type { ExitKind, ExitType, QtyType } from "./ticket";

/** Exit type titles: menu rows, and lower case after "Take profit" /
 *  "Stop loss" in the label. */
export const exitTitle = (kind: ExitKind, t: ExitType, ccy: string): string =>
  ({
    price: "Price",
    ticks: "Ticks",
    pricePct: "% price",
    cash: kind === "tp" ? `Reward ${ccy}` : `Risk ${ccy}`,
    balancePct: kind === "tp" ? "Reward % balance" : "Risk % balance",
  })[t];
export const exitLabel = (kind: ExitKind, t: ExitType, ccy: string): string => {
  const title = exitTitle(kind, t, ccy);
  return `${kind === "tp" ? "Take profit" : "Stop loss"} ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
};
/** Short unit after an equivalent value ("75 ticks", "717.87 price"). */
export const exitUnit = (t: ExitType, ccy: string): string =>
  ({ price: "price", ticks: "ticks", pricePct: "% price", cash: ccy, balancePct: "% balance" })[t];
export const exitInfo = (kind: ExitKind, t: ExitType): string | undefined =>
  ({
    price: undefined,
    ticks: "Exit price is equal to the number of ticks from the main order price",
    pricePct: "Exit price is calculated as a percentage of the main order price",
    cash: kind === "tp" ? "Cash amount you will gain if the take profit is executed" : "Cash amount you will lose if the stop loss is executed",
    balancePct:
      kind === "tp" ? "Percentage of equity you will gain if the take profit is executed" : "Percentage of equity you will lose if the stop loss is executed",
  })[t];
/** Quantity type titles: shares for a stock, else units (reference app); the
 *  equivalent reads singular ("3 unit"). */
export const qtyTitle = (t: QtyType, ccy: string, stock = false): string =>
  ({ units: stock ? "Shares" : "Units", riskUsd: `Risk ${ccy}`, riskPct: "Risk % balance" })[t];
export const qtyUnit = (t: QtyType, ccy: string, stock = false): string => ({ units: stock ? "share" : "unit", riskUsd: `${ccy} risk`, riskPct: "% risk" })[t];
export const qtyInfo = (t: QtyType): string | undefined =>
  ({
    units: undefined,
    riskUsd:
      "Order size equivalent to the risk amount in cash, based on the set stop loss price. Changing the risk amount or stop loss price changes the quantity.",
    riskPct:
      "Order size equivalent to the equity percentage based on the set stop loss price. Changing the risk percentage or stop loss price changes the quantity.",
  })[t];
export const NO_MONEY_SL = "Not available when Risk USD or Risk % balance are selected as the quantity type";

/** One-time tips of the quantity / stop loss fields (reference app): each
 *  kind shows at most twice, ever. */
export const TIPS = {
  stopLoss: "Stop loss is activated because the quantity is calculated based on risk",
  riskQty: "The quantity is calculated based on risk because the stop loss was activated. Manage automatic risk in Order settings",
  unitsQty: "The quantity is calculated based on units, instead of risk, because the stop loss was deactivated",
} as const;
type TipKind = keyof typeof TIPS;
const TIP_COUNT_KEY = "ot:order-ticket:tip-count";
/** Show tip `kind` once more if it was shown fewer than twice (counted). */
export function takeTip(kind: TipKind): boolean {
  let counts: Partial<Record<TipKind, number>> = {};
  try {
    counts = JSON.parse(kv.getItem(TIP_COUNT_KEY) ?? "{}") ?? {};
  } catch {
    counts = {};
  }
  const n = counts[kind] ?? 0;
  if (n >= 2) return false;
  kv.setItem(TIP_COUNT_KEY, JSON.stringify({ ...counts, [kind]: n + 1 }));
  return true;
}
