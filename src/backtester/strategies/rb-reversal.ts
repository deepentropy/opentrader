/**
 * Rob Booker Reversal Tabs Strategy (Powerscooter), Pine v5.
 * Market entries when the MACD line crosses 0 and the full stochastic %K is
 * beyond 30 / 70. Cash sizing (100 per order), pyramiding 5: an entry against
 * the position closes all its trades.
 */
import type { StrategyDefinition } from '../run';
import { closeOf, crossover, crossunder, div, gt, highest, highOf, lowest, lowOf, lt, macd, sma } from '../pine';

export interface RbReversalInputs {
  strategyMode: boolean;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  stochPeriod: number;
  kPeriod: number;
  /** Only feeds %D series the script does not trade on. */
  dPeriod: number;
  overbought: number;
  oversold: number;
}

export const rbReversalStrategy: StrategyDefinition<RbReversalInputs> = {
  key: 'rb-reversal',
  title: 'RB Reversal Tabs Strategy',
  source: { id: 'PUB;8a08021c1b8b402c9d57f276423d58ed', name: 'Rob Booker Reversal Tabs Strategy', author: 'Powerscooter' },
  properties: { defaultQtyType: 'cash', defaultQtyValue: 100, initialCapital: 100, pyramiding: 5 },
  defaultInputs: { strategyMode: true, macdFast: 12, macdSlow: 26, macdSignal: 9, stochPeriod: 70, kPeriod: 30, dPeriod: 30, overbought: 70, oversold: 30 },
  inputs: [
    { id: 'strategyMode', title: 'Strategy Mode', type: 'bool' },
    { id: 'macdFast', title: 'MACD Fast Period', type: 'int' },
    { id: 'macdSlow', title: 'MACD Slow Period', type: 'int' },
    { id: 'macdSignal', title: 'MACD Signal Period', type: 'int' },
    { id: 'stochPeriod', title: 'Stochastic RSI Period', type: 'int' },
    { id: 'kPeriod', title: '%K Period', type: 'int' },
    { id: 'dPeriod', title: '%D Period', type: 'int' },
    { id: 'overbought', title: 'Stochastic Overbought Level', type: 'int' },
    { id: 'oversold', title: 'Stochastic Oversold Level', type: 'int' },
  ],
  setup(bars, inp) {
    const close = closeOf(bars);
    const [line] = macd(close, inp.macdFast, inp.macdSlow, inp.macdSignal);
    const ll = lowest(lowOf(bars), inp.stochPeriod);
    const hh = highest(highOf(bars), inp.stochPeriod);
    const fastK = close.map((c, i) => div(100 * (c - ll[i]), hh[i] - ll[i]));
    const fullK = sma(fastK, inp.kPeriod);
    return (i, s) => {
      if (crossover(line, 0, i) && lt(fullK[i], inp.oversold) && inp.strategyMode) s.entry('Long', 'long');
      if (crossunder(line, 0, i) && gt(fullK[i], inp.overbought) && inp.strategyMode) s.entry('Short', 'short');
    };
  },
};
