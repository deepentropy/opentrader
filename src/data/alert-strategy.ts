/*
 * Alerts on a strategy: its order fills.
 *
 * A strategy's alert fires once per order fill (its conditions "Order fills
 * only" and "Order fills and alert() function calls"), with the strategy's
 * position after the fill. The fills come from the strategy's report on the
 * alert's symbol, interval and session (the backtest the chart runs, on the
 * live bars); a fill is new when the report did not have it before.
 */
import type { BacktestReport, FilledOrder } from "../backtester/types";
import type { StrategyFillValues } from "./alert-placeholders";

/** One order fill of a report, with the strategy's position before and after it. `key` names the fill among the
 *  fills of any later report of the same strategy (bar time, order, side, size, price, rank among equal fills). */
export type StrategyFillEvent = { fill: FilledOrder; key: string; values: StrategyFillValues };

/** A size without the float noise of the sums (0.1 + 0.2). */
const clean = (v: number): number => Number(v.toPrecision(12));

/** The fills of `report` in order, each with the position it leaves. */
export function strategyFillEvents(report: BacktestReport | null | undefined): StrategyFillEvent[] {
  if (!report) return [];
  let position = 0;
  const seen = new Map<string, number>();
  return report.filledOrders.map((fill) => {
    const prev = position;
    position = clean(position + (fill.buy ? fill.qty : -fill.qty));
    const base = `${fill.time}|${fill.id}|${fill.buy ? "b" : "s"}|${fill.qty}|${fill.price}|${fill.type}`;
    const rank = (seen.get(base) ?? 0) + 1;
    seen.set(base, rank);
    const values: StrategyFillValues = {
      action: fill.buy ? "buy" : "sell",
      contracts: fill.qty,
      price: fill.price,
      id: fill.id,
      // An order without a comment gives its id, as shown (the reference's fires)
      comment: fill.comment,
      alertMessage: fill.alertMessage ?? "",
      positionSize: position,
      prevPositionSize: prev,
    };
    return { fill, key: `${base}|${rank}`, values };
  });
}

/** What a strategy alert has fired so far: the fills it has seen (by key), from the time it started. */
export type StrategyAlertState = { since: number; seen: Set<string> };

/**
 * The fills of `report` to fire: the ones not seen before, on a bar that opens at `since` (UNIX ms) or later. A first
 * reading (`state` null) fires none: the fills of the bars before the alert are history. Returns the next state.
 */
export function newStrategyFills(
  state: StrategyAlertState | null,
  report: BacktestReport,
  sinceMs: number,
): { fire: StrategyFillEvent[]; state: StrategyAlertState } {
  const events = strategyFillEvents(report);
  if (!state) return { fire: [], state: { since: sinceMs, seen: new Set(events.map((e) => e.key)) } };
  const fire = events.filter((e) => e.fill.time >= state.since && !state.seen.has(e.key));
  const seen = new Set(state.seen);
  for (const e of fire) seen.add(e.key);
  // Keys of the fills before the alert's first bar are not needed any more.
  for (const e of events) if (e.fill.time < state.since) seen.delete(e.key);
  return { fire, state: { since: state.since, seen } };
}

/** The fills of `report` on bars that open between `fromMs` (inclusive) and `toMs` (exclusive), for the replay of the
 *  bars missed while the app was not running. */
export function strategyFillsBetween(report: BacktestReport | null | undefined, fromMs: number, toMs: number): StrategyFillEvent[] {
  return strategyFillEvents(report).filter((e) => e.fill.time >= fromMs && e.fill.time < toMs);
}
