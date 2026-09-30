/**
 * Doji Trading Strategy (sudarshan_a2z), Pine v5.
 * Long on a doji above the 60 EMA; strategy.exit with a stop at the 450-bar
 * lowest low and a trailing stop whose activation (1 % of the close) and
 * offset (0.5 % of the close) are given in ticks. 100 % of equity.
 */
import type { StrategyDefinition } from '../run';
import { closeOf, ema, gt, lowest, lowOf, lt, openOf } from '../pine';

export interface DojiInputs {
  emaLength: number;
  tolerancePercent: number;
  slLength: number;
  trailThresholdPercent: number;
  trailOffsetPercent: number;
}

export const dojiStrategy: StrategyDefinition<DojiInputs> = {
  key: 'doji',
  title: 'Doji Trading Strategy',
  source: { id: 'PUB;1b00c5c17d1b48f2a1015fff12ffaa8d', name: 'Doji Trading Strategy', author: 'sudarshan_a2z' },
  properties: { initialCapital: 10000, defaultQtyType: 'percent_of_equity', defaultQtyValue: 100 },
  defaultInputs: { emaLength: 60, tolerancePercent: 0.05, slLength: 450, trailThresholdPercent: 1, trailOffsetPercent: 0.5 },
  inputs: [
    { id: 'emaLength', title: 'EMA Length', type: 'int', group: 'DOJI + EMA Settings' },
    { id: 'tolerancePercent', title: 'Tolerance(%) for DOJI', type: 'float', group: 'DOJI + EMA Settings' },
    { id: 'slLength', title: '# Bars to calculate SL', type: 'int', group: 'Normal Stop Loss' },
    { id: 'trailThresholdPercent', title: 'Trailing theshold (%)', type: 'float', step: 0.5, group: 'Trailing Stop' },
    { id: 'trailOffsetPercent', title: 'Trailing offset (%)', type: 'float', step: 0.5, group: 'Trailing Stop' },
  ],
  setup(bars, inp) {
    const close = closeOf(bars);
    const open = openOf(bars);
    const e = ema(close, inp.emaLength);
    const sl = lowest(lowOf(bars), inp.slLength);
    const tol = inp.tolerancePercent / 100;
    return (i, s) => {
      const o = open[i];
      const c = close[i];
      const doji = (gt(o, c) && lt(o, c * (1 + tol))) || (lt(o, c) && gt(o, c * (1 - tol)));
      if (doji && gt(c, e[i])) s.entry('Long', 'long', { comment: 'Long' });
      s.exit('Stop Exit', {
        fromEntry: 'Long',
        stop: sl[i],
        trailPoints: (inp.trailThresholdPercent * c) / 100,
        trailOffset: (inp.trailOffsetPercent * c) / 100,
        commentLoss: 'Stop Loss',
        commentTrailing: 'Trail Profit',
      });
    };
  },
};
