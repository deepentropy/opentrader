/**
 * I11L - Meanreverter 4h (I11L), Pine v5.
 * Buys when RSI(40) drops 5 % below its 10-bar SMA, adding (pyramiding 3)
 * only below the average price minus the summed ATR; exits every trade with a
 * limit at the close (strategy.exit without from_entry) when RSI recovers.
 * Cash sizing (10,000 per order).
 */
import type { StrategyDefinition } from '../run';
import { atr, closeOf, gt, lt, rsi, sma, sum } from '../pine';

export interface MeanreverterInputs {
  frequency: number;
  rsiFrequency: number;
  buyZoneDistance: number;
  avgDownATRSum: number;
  useAbsoluteRSIBarrier: boolean;
}

export const meanreverterStrategy: StrategyDefinition<MeanreverterInputs> = {
  key: 'meanreverter',
  title: 'I11L - Meanreverter 4h',
  source: { id: 'PUB;aacf5baee6ed442ba2348164233d1014', name: 'I11L - Meanreverter 4h', author: 'I11L' },
  properties: { pyramiding: 3, defaultQtyValue: 10000, initialCapital: 10000, defaultQtyType: 'cash' },
  defaultInputs: { frequency: 10, rsiFrequency: 40, buyZoneDistance: 5, avgDownATRSum: 3, useAbsoluteRSIBarrier: true },
  inputs: [
    { id: 'frequency', title: 'frequency', type: 'int' },
    { id: 'rsiFrequency', title: 'rsiFrequency', type: 'int' },
    { id: 'buyZoneDistance', title: 'buyZoneDistance', type: 'int' },
    { id: 'avgDownATRSum', title: 'avgDownATRSum', type: 'int' },
    { id: 'useAbsoluteRSIBarrier', title: 'useAbsoluteRSIBarrier', type: 'bool' },
  ],
  setup(bars, inp) {
    const close = closeOf(bars);
    const barrier = 50;
    const r = rsi(close, inp.rsiFrequency);
    const slow = sma(r, inp.frequency);
    const atrSum = sum(atr(bars, 20), inp.avgDownATRSum);
    return (i, s) => {
      const n = s.openTradesCount;
      const addDown = gt(s.positionAvgPrice - atrSum[i] * n, close[i]) || n === 0;
      const isBuy = lt(r[i], slow[i] * (1 - inp.buyZoneDistance / 100)) && addDown;
      const isClose = gt(r[i], slow[i]) && (gt(r[i], barrier) || !inp.useAbsoluteRSIBarrier);
      if (isBuy) s.entry('Buy', 'long', { comment: `#${n + 1}` });
      if (isClose) s.exit('Close', { limit: close[i] });
    };
  },
};
