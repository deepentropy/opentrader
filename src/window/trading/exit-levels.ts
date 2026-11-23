/*
 * Exit levels in the order ticket (#330): an order or a position's exits as several levels, each a part of its
 * quantity with its own take profit and stop loss (reference: "Add level", the "Exit levels" page, Protected size).
 * The ticket keeps them as typed text; this turns them into the order's levels and the figures the ticket shows.
 */
import { translate, translateWith } from "../../i18n/translator";
import type { ExitLevel, Side } from "../../data/trading/types";
import { withNewLevel } from "../chart/trading-lines-model";
import { parsePositive } from "./format";
import { SL_TICKS, TP_TICKS } from "./ticket";

/** A level as typed: its quantity in units and its take profit / stop loss prices. */
export type DraftLevel = { qty: string; tp: string; sl: string };

/** The levels typed, as the order sends them; a text when one doesn't read (each level takes both exits, as on the
 *  reference's paper broker), or when together they protect more than the order's quantity. */
export function levelsOf(list: DraftLevel[], qty: number | null, entry: number | null, side: Side): ExitLevel[] | string {
  const out: ExitLevel[] = [];
  const up = side === "buy" ? 1 : -1;
  for (const [i, l] of list.entries()) {
    const q = parsePositive(l.qty);
    const tp = parsePositive(l.tp);
    const sl = parsePositive(l.sl);
    if (q == null || tp == null || sl == null) return translateWith("Level {0}: enter its quantity, take profit and stop loss", i + 1);
    if (entry != null && ((tp - entry) * up <= 0 || (sl - entry) * up >= 0)) {
      return translateWith("Level {0}: the take profit and the stop loss must be on each side of the entry price", i + 1);
    }
    out.push({ qty: q, takeProfit: tp, stopLoss: sl });
  }
  if (qty != null && out.reduce((a, l) => a + l.qty, 0) > qty + 1e-9) return translate("The levels protect more than the order's quantity");
  return out;
}

/** "Protected size": the share of the quantity the levels cover, in %. */
export function protectedPct(list: DraftLevel[], qty: number | null): number | null {
  if (qty == null) return null;
  return (list.reduce((a, l) => a + (parsePositive(l.qty) ?? 0), 0) / qty) * 100;
}

/** Risk / Reward of the levels together: what the take profits make over what the stop losses lose. */
export function levelsRiskReward(list: DraftLevel[], entry: number | null): number | null {
  if (entry == null) return null;
  let reward = 0;
  let risk = 0;
  for (const l of list) {
    const q = parsePositive(l.qty) ?? 0;
    const tp = parsePositive(l.tp);
    const sl = parsePositive(l.sl);
    if (tp == null || sl == null) return null;
    reward += q * Math.abs(tp - entry);
    risk += q * Math.abs(entry - sl);
  }
  return risk > 0 ? reward / risk : null;
}

/** The levels with one more (reference "Add level"): the exits as the first level when there are no levels yet, the
 *  new one at the default distances (75 / 25 ticks) on the part of the quantity left, else on half of the largest
 *  level. Null when no part of the quantity is left to give it. */
export function addDraftLevel(
  list: DraftLevel[],
  first: { tp: number | null; sl: number | null },
  qty: number,
  entry: number,
  side: Side,
  tick: number,
  step: number,
  decimals: number,
): DraftLevel[] | null {
  const up = side === "buy" ? 1 : -1;
  const tp = entry + up * TP_TICKS * tick;
  const sl = entry - up * SL_TICKS * tick;
  const current = list.length
    ? { exitLevels: list.map((l) => ({ qty: parsePositive(l.qty) ?? 0, takeProfit: parsePositive(l.tp), stopLoss: parsePositive(l.sl) })), takeProfit: null, stopLoss: null }
    : { takeProfit: first.tp ?? tp, stopLoss: first.sl ?? sl };
  const next = withNewLevel(qty, current, { takeProfit: tp, stopLoss: sl }, step);
  return next ? next.map(toDraft(decimals)) : null;
}

/** A level as the ticket shows it. */
export const toDraft =
  (decimals: number) =>
  (l: ExitLevel): DraftLevel => ({
    qty: String(Number(l.qty.toFixed(10))),
    tp: l.takeProfit != null ? l.takeProfit.toFixed(decimals) : "",
    sl: l.stopLoss != null ? l.stopLoss.toFixed(decimals) : "",
  });
