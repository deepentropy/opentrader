/**
 * Strategy Tester metrics, computed like TradingView's reportData.performance.
 * Percent fields are fractions (0.25 = 25 %), as in the TradingView report.
 *
 * Rules matched on TradingView reports (research/backtester):
 *   - the entry commission of an open trade is already paid: it counts in
 *     net profit, gross loss and commission paid;
 *   - bars in trade count both the entry and the exit bar;
 *   - largest win / loss percent is the largest trade percent, not the
 *     percent of the largest trade;
 *   - max drawdown / run-up use the equity marked to market at each price
 *     reached after a fill (Broker.equityEvents). The peak is the realized
 *     equity after each trade close (partial closes too); the trough is the
 *     realized equity when the position becomes flat or after the entry
 *     commission of a trade opened from flat. Checked on 56 runs (7 datasets,
 *     5 m to 1 W): drawdown 56 / 56, run-up 55 / 56.
 */
import type { EquityEvent } from './broker';
import type { Bar, Direction, Performance, SidePerformance, Trade } from './types';

function side(trades: Trade[], open: Trade[], initialCapital: number, maxContracts: number): SidePerformance {
  const wins = trades.filter((t) => t.profit > 0);
  const losses = trades.filter((t) => t.profit < 0);
  const sum = (xs: Trade[], f: (t: Trade) => number) => xs.reduce((s, t) => s + f(t), 0);
  const avg = (xs: Trade[], f: (t: Trade) => number) => (xs.length ? sum(xs, f) / xs.length : null);
  const max = (xs: Trade[], f: (t: Trade) => number) => (xs.length ? Math.max(...xs.map(f)) : null);
  const openCommission = sum(open, (t) => t.commission);
  const grossProfit = sum(wins, (t) => t.profit);
  const grossLoss = -sum(losses, (t) => t.profit) + openCommission;
  const netProfit = grossProfit - grossLoss;
  const bars = (t: Trade) => t.exit.bar - t.entry.bar + 1;
  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  return {
    netProfit,
    netProfitPercent: netProfit / initialCapital,
    grossProfit,
    grossProfitPercent: grossProfit / initialCapital,
    grossLoss,
    grossLossPercent: grossLoss / initialCapital,
    grossProfitWC: trades.reduce((s, t) => s + Math.max(0, t.profit + t.commission), 0),
    grossLossWC: -trades.reduce((s, t) => s + Math.min(0, t.profit + t.commission), 0),
    commissionPaid: sum(trades, (t) => t.commission) + openCommission,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalTrades: trades.length,
    totalOpenTrades: open.length,
    numberOfWiningTrades: wins.length,
    numberOfLosingTrades: losses.length,
    percentProfitable: trades.length ? wins.length / trades.length : null,
    avgTrade: trades.length ? netProfit / trades.length : null,
    avgTradePercent: avg(trades, (t) => t.profitPercent),
    avgWinTrade: avgWin,
    avgWinTradePercent: avg(wins, (t) => t.profitPercent),
    avgLosTrade: avgLoss,
    avgLosTradePercent: avg(losses, (t) => -t.profitPercent),
    // TradingView: null without losing trades, 0 with losses but no wins.
    ratioAvgWinAvgLoss: avgLoss ? (avgWin ?? 0) / avgLoss : null,
    largestWinTrade: max(wins, (t) => t.profit),
    largestWinTradePercent: max(wins, (t) => t.profitPercent),
    largestLosTrade: max(losses, (t) => -t.profit),
    largestLosTradePercent: max(losses, (t) => -t.profitPercent),
    avgBarsInTrade: avg(trades, bars) ?? 0,
    avgBarsInWinTrade: avg(wins, bars) ?? 0,
    avgBarsInLossTrade: avg(losses, bars) ?? 0,
    maxContractsHeld: maxContracts,
  };
}

/** Max drawdown / run-up from the broker's equity events. */
function equityExtremes(events: EquityEvent[], initialCapital: number) {
  let peak = initialCapital;
  let trough = initialCapital;
  const r = { dd: 0, ddPct: 0, ru: 0, ruPct: 0 };
  // Percent = the largest ratio (drawdown / peak, run-up / equity reached), not the ratio at the largest amount.
  const low = (v: number) => {
    const dd = peak - v;
    if (dd > r.dd) r.dd = dd;
    if (peak > 0 && dd / peak > r.ddPct) r.ddPct = dd / peak;
  };
  const high = (v: number) => {
    const ru = v - trough;
    if (ru > r.ru) r.ru = ru;
    if (v > 0 && ru / v > r.ruPct) r.ruPct = ru / v;
  };
  for (const e of events) {
    if (e.t !== 'e') {
      low(e.v);
      high(e.v);
    }
    if (e.t === 'c') peak = Math.max(peak, e.realized);
    if ((e.t === 'c' && e.flat) || (e.t === 'e' && e.first)) trough = Math.min(trough, e.realized);
  }
  return r;
}

export function computePerformance(
  bars: Bar[],
  closed: Trade[],
  open: Trade[],
  initialCapital: number,
  maxContracts: { all: number; long: number; short: number },
  /** Open trades' price move at the last close, without commission. */
  openPL: number,
  events: EquityEvent[],
): Performance {
  const by = (d: Direction) => (t: Trade) => t.direction === d;
  const all = side(closed, open, initialCapital, maxContracts.all);
  const ext = equityExtremes(events, initialCapital);
  // Buy & hold: whole shares bought with the initial capital at the first entry price.
  const first = closed[0] ?? open[0];
  let buyHoldReturn = 0;
  let buyHoldGainPercent: number | null = null;
  if (first) {
    const p0 = first.entry.price;
    const p1 = bars[bars.length - 1].close;
    buyHoldReturn = Math.floor(initialCapital / p0) * (p1 - p0);
    buyHoldGainPercent = (p1 - p0) / p0;
  }
  return {
    all,
    long: side(closed.filter(by('long')), open.filter(by('long')), initialCapital, maxContracts.long),
    short: side(closed.filter(by('short')), open.filter(by('short')), initialCapital, maxContracts.short),
    openPL,
    openPLPercent: openPL / (initialCapital + all.netProfit),
    maxStrategyDrawDown: ext.dd,
    maxStrategyDrawDownPercent: ext.ddPct,
    maxStrategyRunUp: ext.ru,
    maxStrategyRunUpPercent: ext.ruPct,
    buyHoldReturn,
    // TradingView: the percent fields are null without trades.
    buyHoldReturnPercent: first ? buyHoldReturn / initialCapital : null,
    buyHoldGainPercent,
  };
}
