/**
 * AlphaTrend Strategy (KivancOzbilgic), Pine v5.
 * Market entries on AlphaTrend / AlphaTrend[2] crosses; an entry against the
 * position reverses it. 1 contract, no costs.
 */
import type { StrategyDefinition } from '../run';
import type { Bar } from '../types';
import { at, crossover, crossunder, ge, gt, hlc3Of, lt, mfi, nz, rsi, sma, sourceOf, tr, type Num } from '../pine';

export interface AlphaTrendInputs {
  coeff: number;
  period: number;
  src: string;
  /** Plot shapes only (OpenTrader does not draw strategy plots). */
  showSignals: boolean;
  noVolumeData: boolean;
}

function alphaTrend(bars: Bar[], inp: AlphaTrendInputs): Num {
  const atr = sma(tr(bars), inp.period);
  const momentum = inp.noVolumeData ? rsi(sourceOf(bars, inp.src), inp.period) : mfi(bars, hlc3Of(bars), inp.period);
  const out = new Array<number>(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    const upT = bars[i].low - atr[i] * inp.coeff;
    const downT = bars[i].high + atr[i] * inp.coeff;
    const prev = nz(at(out, i, 1));
    out[i] = ge(momentum[i], 50) ? (lt(upT, prev) ? prev : upT) : gt(downT, prev) ? prev : downT;
  }
  return out;
}

export const alphatrendStrategy: StrategyDefinition<AlphaTrendInputs> = {
  key: 'alphatrend',
  title: 'AlphaTrend Strategy',
  shortTitle: 'ATSt',
  source: { id: 'PUB;5c59f45a445140a78edb61d9692ab2e5', name: 'AlphaTrend Strategy', author: 'KivancOzbilgic' },
  properties: {},
  defaultInputs: { coeff: 1, period: 14, src: 'close', showSignals: false, noVolumeData: false },
  inputs: [
    { id: 'coeff', title: 'Multiplier', type: 'float', step: 0.1 },
    { id: 'period', title: 'Common Period', type: 'int' },
    { id: 'src', title: 'src', type: 'source' },
    { id: 'showSignals', title: 'Show Signals?', type: 'bool' },
    { id: 'noVolumeData', title: 'Change calculation (no volume data)?', type: 'bool' },
  ],
  plots(bars, inputs) {
    const at0 = alphaTrend(bars, inputs);
    return { plot_0: at0, plot_1: at0.map((_, i) => at(at0, i, 2)) };
  },
  setup(bars, inputs) {
    const a = alphaTrend(bars, inputs);
    const a2 = a.map((_, i) => at(a, i, 2));
    return (i, s) => {
      if (crossover(a, a2, i)) s.entry('Long', 'long');
      if (crossunder(a, a2, i)) s.entry('Short', 'short');
    };
  },
};
