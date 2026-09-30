/**
 * Trend Catcher Strategy (faytterro), Pine v5.
 * Market entry when the 10-bar range / sum of bar ranges crosses 50, with a
 * take profit + stop loss bracket on 50 % of the entry (strategy.exit
 * qty_percent), rest closed when the 5-bar SMA turns. 100 % of equity.
 */
import type { StrategyDefinition } from '../run';
import { at, closeOf, crossover, gt, highest, highOf, lowest, lowOf, lt, sma, timeMs } from '../pine';

export interface TrendCatcherInputs {
  /** UNIX ms. */
  startDate: number;
  endDate: number;
  len: number;
  tp: number;
  sl: number;
  maLen: number;
  limit: number;
  qtyBalance: number;
}

export const trendCatcherStrategy: StrategyDefinition<TrendCatcherInputs> = {
  key: 'trend-catcher',
  title: 'Trend Catcher Strategy',
  source: { id: 'PUB;a4ebe8c3501b4d96811d60108e650c13', name: 'Trend Catcher Strategy', author: 'faytterro' },
  properties: { defaultQtyType: 'percent_of_equity', defaultQtyValue: 100 },
  defaultInputs: {
    startDate: Date.UTC(2022, 0, 1),
    endDate: Date.UTC(2030, 0, 1),
    len: 10,
    tp: 2.5,
    sl: 2.5,
    maLen: 5,
    limit: 50,
    qtyBalance: 50,
  },
  inputs: [
    { id: 'startDate', title: 'Start Date', type: 'time', group: 'TRADING WINDOW', tooltip: 'Use this to set the date and time when strategy will start placing trades. Set this to a time just after the last candle when activating auto trading.' },
    { id: 'endDate', title: 'End Date', type: 'time', group: 'TRADING WINDOW', tooltip: 'Use this to set the date and time when strategy will stop placing trades.' },
    { id: 'len', title: 'len', type: 'int' },
    { id: 'tp', title: 'tp', type: 'float', step: 0.1 },
    { id: 'sl', title: 'sl', type: 'float', step: 0.1 },
    { id: 'maLen', title: 'malen', type: 'int' },
    { id: 'limit', title: 'limit', type: 'int' },
    { id: 'qtyBalance', title: 'qty_balance', type: 'int', max: 100 },
  ],
  plots(bars, inp) {
    return { plot_0: sma(closeOf(bars), inp.maLen) };
  },
  setup(bars, inp) {
    const close = closeOf(bars);
    const high = highOf(bars);
    const low = lowOf(bars);
    const ma = sma(close, inp.maLen);
    const hh = highest(high, inp.len);
    const ll = lowest(low, inp.len);
    const frs = bars.map((_, i) => {
      let s = 0;
      for (let k = 0; k < inp.len; k++) s += at(high, i, k) - at(low, i, k);
      return (100 * (hh[i] - ll[i])) / s;
    });
    return (i, s) => {
      const t = timeMs(bars, i);
      const inWindow = t >= inp.startDate && t < inp.endDate;
      const maUp = gt(ma[i], at(ma, i, 1));
      const maDown = lt(ma[i], at(ma, i, 1));
      const cross = crossover(frs, inp.limit, i);
      const c = close[i];
      if (cross && maUp && inWindow) {
        s.entry('My Long Entry Id', 'long');
        s.exit('exit long', {
          fromEntry: 'My Long Entry Id',
          qtyPercent: inp.qtyBalance,
          limit: (c * (100 + inp.tp)) / 100,
          stop: (c * (100 - inp.sl)) / 100,
        });
      }
      if (cross && maDown && inWindow) {
        s.entry('My Short Entry Id', 'short');
        s.exit('exit short', {
          fromEntry: 'My Short Entry Id',
          qtyPercent: inp.qtyBalance,
          limit: (c * (100 - inp.tp)) / 100,
          stop: (c * (100 + inp.sl)) / 100,
        });
      }
      if (maDown) s.close('My Long Entry Id');
      if (maUp) s.close('My Short Entry Id');
    };
  },
};
