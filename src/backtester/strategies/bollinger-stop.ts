/**
 * Bollinger Stop Strategy (ROBO_Trading), Pine v5.
 * Stop entries at the bands, re-placed at every bar: buy stop at the upper
 * band, sell stop at the lower band. 100 % of equity, 0.1 % commission.
 */
import type { StrategyDefinition } from '../run';
import { gt, sma, sourceOf, stdev, timeMs } from '../pine';

export interface BollingerStopInputs {
  long: boolean;
  short: boolean;
  length: number;
  mult: number;
  source: string;
  /** Plot options only (OpenTrader does not draw strategy plots). */
  showBands: boolean;
  showOffset: boolean;
  /** UNIX ms. */
  startTime: number;
  finalTime: number;
}

export const bollingerStopStrategy: StrategyDefinition<BollingerStopInputs> = {
  key: 'bollinger-stop',
  title: 'Bollinger Stop Strategy',
  shortTitle: 'BBStop',
  source: { id: 'PUB;2061d5d6fd7e4eed84ac7e157f450e85', name: 'Bollinger Stop Strategy', author: 'ROBO_Trading' },
  properties: {
    defaultQtyType: 'percent_of_equity',
    initialCapital: 10000,
    defaultQtyValue: 100,
    commissionValue: 0.1,
  },
  defaultInputs: {
    long: true,
    short: true,
    length: 20,
    mult: 2,
    source: 'close',
    showBands: true,
    showOffset: true,
    startTime: Date.UTC(2000, 0, 1),
    finalTime: Date.UTC(2099, 11, 31, 23, 59),
  },
  inputs: [
    { id: 'long', title: 'long', type: 'bool' },
    { id: 'short', title: 'short', type: 'bool' },
    { id: 'length', title: 'length', type: 'int', min: 1 },
    { id: 'mult', title: 'mult', type: 'float', min: 0.001, max: 50 },
    { id: 'source', title: 'source', type: 'source' },
    { id: 'showBands', title: 'Show Bollinger Bands', type: 'bool' },
    { id: 'showOffset', title: 'Show Offset', type: 'bool' },
    { id: 'startTime', title: 'Start Time', type: 'time', inline: 'time1' },
    { id: 'finalTime', title: 'Final Time', type: 'time', inline: 'time1' },
  ],
  plots(bars, inp) {
    const basis = sma(sourceOf(bars, inp.source), inp.length);
    const dev = stdev(sourceOf(bars, inp.source), inp.length).map((d) => d * inp.mult);
    return {
      plot_0: basis,
      plot_2: basis.map((b, i) => b + dev[i]),
      plot_4: basis.map((b, i) => b - dev[i]),
    };
  },
  setup(bars, inp) {
    const close = sourceOf(bars, inp.source);
    const basis = sma(close, inp.length);
    const dev = stdev(close, inp.length).map((d) => d * inp.mult);
    return (i, s) => {
      const upper = basis[i] + dev[i];
      const lower = basis[i] - dev[i];
      const t = timeMs(bars, i);
      const truetime = t > inp.startTime && t < inp.finalTime;
      if (gt(basis[i], 0) && truetime) {
        if (inp.long) s.entry('Long', 'long', { stop: upper });
        if (inp.short) s.entry('Short', 'short', { stop: lower });
        if (!inp.long) s.exit('Exit', { fromEntry: 'Short', stop: upper });
        if (!inp.short) s.exit('Exit', { fromEntry: 'Long', stop: lower });
      }
      if (t > inp.finalTime) s.closeAll();
    };
  },
};
