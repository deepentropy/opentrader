/*
 * Metrics the Strategy Tester shows that are not fields of the report. Each
 * formula was checked against the numbers TradingView 3.4.1 displayed for a
 * captured report (research/backtester/design, Supertrend strategy on
 * BATS:BE 1D, 30/09/2026). Metrics whose formula could not be matched are
 * not shown (see the design doc "Open").
 */
import type { BacktestReport, Trade } from "../../backtester/types";

const closedTrades = (r: BacktestReport) => r.trades.filter((t) => !t.open);

/** Total PnL = net profit + open PnL (133,192.13 = 129,974.00 + 3,218.13). */
export function totalPnl(r: BacktestReport): number {
  return r.performance.all.netProfit + r.performance.openPL;
}

/** PnL of every trade (open ones included) grouped by entry signal or side;
 *  the first row is the total. Matched: +152,119.50 / −18,927.37. */
export type PnlRow = { label: string; pnl: number; profitSum: number; lossSum: number; commission: number };

export function pnlBy(r: BacktestReport, by: "signal" | "side"): PnlRow[] {
  const rows = new Map<string, PnlRow>();
  const add = (label: string, t: Trade) => {
    let row = rows.get(label);
    if (!row) rows.set(label, (row = { label, pnl: 0, profitSum: 0, lossSum: 0, commission: 0 }));
    row.pnl += t.profit;
    if (t.profit >= 0) row.profitSum += t.profit;
    else row.lossSum -= t.profit;
    row.commission += t.commission;
  };
  for (const t of r.trades) {
    add(by === "signal" ? "All signals" : "Both sides", t);
    add(by === "signal" ? t.entry.signal : t.direction === "long" ? "Longs" : "Shorts", t);
  }
  const order = by === "side" ? ["Both sides", "Longs", "Shorts"] : null;
  const list = [...rows.values()];
  return order ? order.map((l) => rows.get(l)).filter((x): x is PnlRow => !!x) : list;
}

/** Win / loss streaks over closed trades in exit order (7 / 5, 2.5 / 1.9). */
export function streaks(r: BacktestReport): { longestWin: number; longestLoss: number; avgWin: number | null; avgLoss: number | null } {
  const seq = closedTrades(r)
    .slice()
    .sort((a, b) => a.exit.time - b.exit.time)
    .map((t) => Math.sign(t.profit));
  const runs: [number, number][] = [];
  for (const s of seq) {
    const last = runs[runs.length - 1];
    if (last && last[0] === s) last[1]++;
    else runs.push([s, 1]);
  }
  const win = runs.filter(([s]) => s > 0).map(([, n]) => n);
  const loss = runs.filter(([s]) => s < 0).map(([, n]) => n);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { longestWin: Math.max(0, ...win), longestLoss: Math.max(0, ...loss), avgWin: avg(win), avgLoss: avg(loss) };
}

/** CAGR from the net profit over the testing period, 365-day years (+10.71%). */
export function cagr(r: BacktestReport): number | null {
  const years = (r.range.to - r.range.from) / 86_400_000 / 365;
  if (years <= 0) return null;
  return Math.pow(1 + r.performance.all.netProfitPercent, 1 / years) - 1;
}

/**
 * Outliers: closed trades whose return is more than 2 standard deviations
 * from the mean return (the 3 trades above 106.07% gave Outliers PnL
 * 112,407.28 and "Average profit" 21.63% without them). Population and
 * sample deviation gave the same split on the captured report.
 */
export function outliers(r: BacktestReport): { pnl: number; trades: Trade[] } {
  const closed = closedTrades(r);
  if (closed.length < 2) return { pnl: 0, trades: [] };
  const rets = closed.map((t) => t.profitPercent);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const out = closed.filter((t) => Math.abs(t.profitPercent - mean) > 2 * sd);
  return { pnl: out.reduce((a, t) => a + t.profit, 0), trades: out };
}

/** Best entry month by win rate (February, 80.00% winners). */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function bestMonth(r: BacktestReport): { month: string; winRate: number } | null {
  const stats = Array.from({ length: 12 }, () => ({ win: 0, n: 0 }));
  for (const t of closedTrades(r)) {
    const m = new Date(t.entry.time).getUTCMonth();
    stats[m].n++;
    if (t.profit > 0) stats[m].win++;
  }
  let best: { month: string; winRate: number } | null = null;
  stats.forEach((s, m) => {
    if (!s.n) return;
    const rate = s.win / s.n;
    if (!best || rate > best.winRate) best = { month: MONTHS[m], winRate: rate };
  });
  return best;
}

/** Winners / losers / breakevens among closed trades (27 / 21 / 0). */
export function distribution(r: BacktestReport): { total: number; winners: number; losers: number; breakevens: number } {
  const c = closedTrades(r);
  const winners = c.filter((t) => t.profit > 0).length;
  const losers = c.filter((t) => t.profit < 0).length;
  return { total: c.length, winners, losers, breakevens: c.length - winners - losers };
}

/** Cumulative PnL curve: one point per trade at its exit time (the open trade
 *  at the last bar), starting at 0. TradingView's last point = Total PnL
 *  (133,192.12 on the captured report). */
export function equityPoints(r: BacktestReport): { time: number; value: number; buyHold: number }[] {
  const pts: { time: number; value: number; buyHold: number }[] = [];
  const trades = r.trades;
  if (!trades.length) return pts;
  pts.push({ time: trades[0].entry.time / 1000, value: 0, buyHold: 0 });
  for (const t of trades) {
    const time = t.exit.time / 1000;
    const p = { time, value: t.cumProfit, buyHold: r.buyHold[t.exit.bar] ?? 0 };
    // Several records can close on one bar (partial exits): keep the last.
    if (pts[pts.length - 1].time >= time) pts[pts.length - 1] = p;
    else pts.push(p);
  }
  return pts;
}
