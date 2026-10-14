/*
 * Test fixtures of the Strategy Tester helpers: a trade and a report with
 * only the fields the helpers read.
 */
import type { BacktestReport, Trade } from "../../../backtester/types";

export const DAY_MS = 86_400_000;
export const ms = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

type TradeInit = Partial<Omit<Trade, "entry" | "exit">> & { entry?: Partial<Trade["entry"]>; exit?: Partial<Trade["exit"]> };

export function trade(t: TradeInit = {}): Trade {
  const { entry, exit, ...rest } = t;
  return {
    direction: "long",
    entryId: "L",
    open: false,
    qty: 1,
    profit: 0,
    profitPercent: 0,
    commission: 0,
    entryCommission: 0,
    runUp: 0,
    runUpPercent: 0,
    drawdown: 0,
    drawdownPercent: 0,
    cumProfit: 0,
    profitPercentOfEquity: 0,
    ...rest,
    entry: { signal: "L", price: 100, bar: 0, time: ms(2026, 1, 5), ...entry },
    exit: { signal: "X", price: 100, bar: 1, time: ms(2026, 1, 6), ...exit },
  };
}

export function report(trades: Trade[], o: { capital?: number; netProfit?: number; netProfitPercent?: number; openPL?: number; buyHold?: number[]; range?: { from: number; to: number } } = {}): BacktestReport {
  return {
    currency: "USD",
    properties: { initialCapital: o.capital ?? 10_000 },
    trades,
    filledOrders: [],
    performance: { all: { netProfit: o.netProfit ?? 0, netProfitPercent: o.netProfitPercent ?? 0 }, openPL: o.openPL ?? 0 },
    equity: [],
    buyHold: o.buyHold ?? [],
    range: o.range ?? { from: 0, to: 0 },
    elapsedMs: 0,
  } as unknown as BacktestReport;
}
