/**
 * Trade records of the report: a closed part of a trade (or an open trade marked at the close) with its profit,
 * commissions and excursions (run-up / drawdown).
 */
import type { Bar, SymbolInfo, Trade } from '../types';
import type { OpenTrade } from './types';

/**
 * Record of `qty` of trade t closed at `price` on bar `bar` (an open trade marked there when `open`). `market`: a
 * market exit (close, reversal, strategy.order, margin call).
 */
export function makeTrade(
  t: OpenTrade,
  qty: number,
  price: number,
  signal: string,
  entryCm: number,
  exitCm: number,
  open: boolean,
  market: boolean,
  sym: SymbolInfo,
  bars: readonly Bar[],
  bar: number,
): Trade {
  const sign = t.direction === 'long' ? 1 : -1;
  const pv = sym.pointValue;
  const cost = t.price * qty * pv + entryCm;
  const profit = sign * (price - t.price) * qty * pv - entryCm - exitCm;
  // The exit fill price (slippage included) is part of the trade's range: always for a market exit (a trade
  // reversed or margin-called at its fill: pivot-points, rsi-mean-reversion), after prices seen for a price
  // order exit (a stop at the entry open: 0, triple-ema-trend).
  const counted = !open && (market || Number.isFinite(t.high));
  const high = counted ? Math.max(t.high, price) : t.high;
  const low = counted ? Math.min(t.low, price) : t.low;
  const seen = Number.isFinite(high);
  const best = t.direction === 'long' ? high : low;
  const worst = t.direction === 'long' ? low : high;
  // Excursions include the entry commission, floored at 0.
  const favorable = seen ? sign * (best - t.price) : 0;
  const adverse = seen ? -sign * (worst - t.price) : 0;
  const runUp = seen ? Math.max(0, favorable * qty * pv - entryCm) : 0;
  const drawdown = seen ? Math.max(0, adverse * qty * pv + entryCm) : 0;
  return {
    direction: t.direction,
    entryId: t.entryId,
    entry: { signal: t.signal, price: t.price, bar: t.bar, time: bars[t.bar].time * 1000 },
    exit: { signal: open ? '' : signal, price, bar, time: bars[bar].time * 1000 },
    open,
    qty,
    profit,
    profitPercent: profit / cost,
    // An open trade reports its entry commission only; its profit deducts the exit commission too.
    commission: open ? entryCm : entryCm + exitCm,
    entryCommission: entryCm,
    runUp,
    runUpPercent: runUp / cost,
    drawdown,
    drawdownPercent: drawdown / cost,
    cumProfit: 0,
    profitPercentOfEquity: 0,
  };
}
