/**
 * Centered RSI +/-50 Cross Strategy (FUD2009), Pine v6.
 * 5 contracts on centered RSI crosses of -50 / +50; strategy.exit take profit
 * 31 ticks, stop loss 1.5 x ATR used as ticks (fractional); optional
 * trailing stop (trail_points / trail_offset in ticks).
 */
import type { StrategyDefinition } from '../run';
import { atr, crossover, crossunder, rsi, sourceOf } from '../pine';

export interface CenteredRsiInputs {
  rsiLength: number;
  src: string;
  atrLength: number;
  atrMult: number;
  contracts: number;
  tpPoints: number;
  useTrail: boolean;
  trailStart: number;
  trailDistance: number;
}

export const centeredRsiStrategy: StrategyDefinition<CenteredRsiInputs> = {
  key: 'centered-rsi',
  title: 'Centered RSI +/-50 Cross Strategy',
  source: { id: 'PUB;346cf6257d4b43bdb34a2a1a87702dbc', name: 'Centered RSI +/-50 Cross Strategy', author: 'FUD2009' },
  properties: { initialCapital: 50000 },
  defaultInputs: { rsiLength: 14, src: 'close', atrLength: 14, atrMult: 1.5, contracts: 5, tpPoints: 31, useTrail: false, trailStart: 10, trailDistance: 8 },
  inputs: [
    { id: 'rsiLength', title: 'RSI Length', type: 'int' },
    { id: 'src', title: 'Source', type: 'source' },
    { id: 'atrLength', title: 'ATR Length', type: 'int' },
    { id: 'atrMult', title: 'ATR Multiplier', type: 'float', min: 0.5, max: 5, step: 0.25 },
    { id: 'contracts', title: 'Contracts', type: 'int', min: 1, max: 50 },
    { id: 'tpPoints', title: 'Take Profit (Points)', type: 'float', min: 5, max: 200, step: 1 },
    { id: 'useTrail', title: 'Use Trailing Stop?', type: 'bool' },
    { id: 'trailStart', title: 'Trail Start (Points)', type: 'float', min: 1, max: 200, step: 1 },
    { id: 'trailDistance', title: 'Trail Distance (Points)', type: 'float', min: 1, max: 200, step: 1 },
  ],
  setup(bars, inp) {
    const crsi = rsi(sourceOf(bars, inp.src), inp.rsiLength).map((r) => (r - 50) * 2);
    const a = atr(bars, inp.atrLength);
    return (i, s) => {
      const sl = a[i] * inp.atrMult;
      if (crossover(crsi, -50, i)) s.entry('Long', 'long', { qty: inp.contracts });
      if (crossunder(crsi, 50, i)) s.entry('Short', 'short', { qty: inp.contracts });
      const trail = inp.useTrail ? { trailPoints: inp.trailDistance, trailOffset: inp.trailStart } : {};
      s.exit('Long Exit', { fromEntry: 'Long', profit: inp.tpPoints, loss: sl, ...trail });
      s.exit('Short Exit', { fromEntry: 'Short', profit: inp.tpPoints, loss: sl, ...trail });
    };
  },
};
