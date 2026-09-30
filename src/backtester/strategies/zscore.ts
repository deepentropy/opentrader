/**
 * Stochastic Z-Score Oscillator Strategy [TradeDots], Pine v5.
 * Enters when the mean of the close z-score (80 bars, unbiased stdev) and a
 * rescaled stochastic crosses +/-2.8, with a 5-bar cool down; closes with
 * strategy.close(qty_percent = 100) when the z-score changes side.
 * 30 % of equity, 0.01 % commission.
 */
import type { StrategyDefinition } from '../run';
import { closeOf, div, gt, highOf, lowOf, lt, sma, stdev, stoch } from '../pine';

export interface ZScoreInputs {
  enableBacktest: boolean;
  rollingWindow: number;
  zThresh: number;
  coolDown: number;
  stochLength: number;
  stochSmoothen: number;
}

export const zscoreStrategy: StrategyDefinition<ZScoreInputs> = {
  key: 'zscore',
  title: 'Stochastic Z-Score Oscillator Strategy [TradeDots]',
  shortTitle: 'TradeDots Stochastic Z-Score',
  source: { id: 'PUB;a66cf454a8564c128a182b92f3cf22fe', name: 'Stochastic Z-Score Oscillator Strategy [TradeDots]', author: 'tradedots' },
  properties: {
    initialCapital: 10000,
    commissionType: 'percent',
    commissionValue: 0.01,
    defaultQtyType: 'percent_of_equity',
    defaultQtyValue: 30,
    pyramiding: 1,
  },
  defaultInputs: { enableBacktest: true, rollingWindow: 80, zThresh: 2.8, coolDown: 5, stochLength: 14, stochSmoothen: 7 },
  inputs: [
    { id: 'enableBacktest', title: 'Enable Backtest', type: 'bool' },
    { id: 'rollingWindow', title: 'Rolling Window', type: 'int', min: 1, step: 1 },
    { id: 'zThresh', title: 'Z-Score Thershhold', type: 'float' },
    { id: 'coolDown', title: 'Signal Cool Down Period', type: 'int', min: 1, step: 1 },
    { id: 'stochLength', title: 'Stochastic Length', type: 'int' },
    { id: 'stochSmoothen', title: 'Stochastic Smoothen', type: 'int' },
  ],
  setup(bars, inp) {
    const close = closeOf(bars);
    const st = sma(stoch(close, highOf(bars), lowOf(bars), inp.stochLength), inp.stochSmoothen).map((v) => (v / 100) * 8 - 4);
    const sd = stdev(close, inp.rollingWindow, false);
    const mean = sma(close, inp.rollingWindow);
    const z = close.map((c, i) => div(c - mean[i], sd[i]));
    let buyCd = inp.coolDown;
    let sellCd = inp.coolDown;
    return (i, s) => {
      const avg = (z[i] + st[i]) / 2;
      if (gt(avg, inp.zThresh)) {
        if (sellCd >= inp.coolDown) {
          if (inp.enableBacktest) s.entry('Sell', 'short', { comment: 'Open Short Position' });
          sellCd = 0;
          buyCd = inp.coolDown;
        } else sellCd += 1;
      }
      if (gt(z[i], 0)) s.close('Buy', { qtyPercent: 100, comment: 'Close all buy orders' });
      else if (lt(avg, -inp.zThresh)) {
        if (buyCd >= inp.coolDown) {
          if (inp.enableBacktest) s.entry('Buy', 'long', { comment: 'Open Long Position' });
          sellCd = inp.coolDown;
          buyCd = 0;
        } else buyCd += 1;
      }
      if (lt(z[i], 0)) s.close('Sell', { qtyPercent: 100, comment: 'Close all sell orders' });
    };
  },
};
