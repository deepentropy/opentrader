/**
 * Lucky13ema - Filtered v2 (TraderTed420), Pine v5.
 * Candle closing back across the 13 EMA with a volume spike and on the right
 * side of the session VWAP (or crossing it); exits with a trailing stop
 * (trail_points = trail_offset = 10 ticks) or, without trailing, take profit /
 * stop loss in ticks. 100 % of equity.
 */
import type { StrategyDefinition } from '../run';
import { at, closeOf, crossover, crossunder, ema, ge, gt, hlc3Of, le, lt, openOf, sma, volumeOf, vwap } from '../pine';

export interface Lucky13Inputs {
  useFilters: boolean;
  volMult: number;
  emaLength: number;
  profitTarget: number;
  stopLoss: number;
  useTrailing: boolean;
  trailOffset: number;
  useVwapCross: boolean;
}

export const lucky13emaStrategy: StrategyDefinition<Lucky13Inputs> = {
  key: 'lucky13ema',
  title: 'Lucky13ema - Filtered v2',
  source: { id: 'PUB;7fab10c4bd7a49baa1e84658a3398ddb', name: 'Lucky13ema', author: 'TraderTed420' },
  properties: { initialCapital: 30000, defaultQtyType: 'percent_of_equity', defaultQtyValue: 100, pyramiding: 0 },
  defaultInputs: { useFilters: true, volMult: 1.2, emaLength: 13, profitTarget: 2, stopLoss: 1, useTrailing: true, trailOffset: 10, useVwapCross: false },
  inputs: [
    { id: 'useFilters', title: 'Use Filters', type: 'bool' },
    { id: 'volMult', title: 'Volume Multiplier', type: 'float' },
    { id: 'emaLength', title: 'EMA Length', type: 'int' },
    { id: 'profitTarget', title: 'Profit Target %', type: 'float', min: 0.1 },
    { id: 'stopLoss', title: 'Stop Loss %', type: 'float', min: 0.1 },
    { id: 'useTrailing', title: 'Use Trailing Stop', type: 'bool' },
    { id: 'trailOffset', title: 'Trail Offset (points)', type: 'float', min: 1 },
    { id: 'useVwapCross', title: 'Require VWAP Cross for Entries', type: 'bool' },
  ],
  setup(bars, inp, sym) {
    const close = closeOf(bars);
    const open = openOf(bars);
    const volume = volumeOf(bars);
    const e = ema(close, inp.emaLength);
    const vw = vwap(bars, hlc3Of(bars), sym.timezone);
    const volSma = sma(volume, 20);
    return (i, s) => {
      const volOk = gt(volume[i], volSma[i] * inp.volMult);
      const buyCond = gt(close[i], open[i]) && gt(close[i], e[i]) && le(at(close, i, 1), at(e, i, 1));
      const sellCond = lt(close[i], open[i]) && lt(close[i], e[i]) && ge(at(close, i, 1), at(e, i, 1));
      const vwapLongOk = !inp.useFilters || gt(close[i], vw[i]);
      const vwapShortOk = !inp.useFilters || lt(close[i], vw[i]);
      const buy = buyCond && volOk && (inp.useVwapCross ? crossover(close, vw, i) : vwapLongOk);
      const sell = sellCond && volOk && (inp.useVwapCross ? crossunder(close, vw, i) : vwapShortOk);
      if (buy && s.positionSize <= 0) s.entry('Long', 'long');
      if (sell && s.positionSize >= 0) s.entry('Short', 'short');
      if (inp.useTrailing) {
        s.exit('Exit Long', { fromEntry: 'Long', trailPoints: inp.trailOffset, trailOffset: inp.trailOffset });
        s.exit('Exit Short', { fromEntry: 'Short', trailPoints: inp.trailOffset, trailOffset: inp.trailOffset });
      } else {
        s.exit('Exit Long', { fromEntry: 'Long', profit: inp.profitTarget, loss: inp.stopLoss });
        s.exit('Exit Short', { fromEntry: 'Short', profit: inp.profitTarget, loss: inp.stopLoss });
      }
    };
  },
};
