/**
 * Cumulative RSI Strategy (TradeAutomation), Pine v5.
 * Long only: buy when the 3-bar sum of RSI(3) crosses over 60, close when it
 * crosses over 282. Orders fill at the bar close (process_orders_on_close),
 * 110 % of equity, 0.0035 per share commission, 1 tick slippage.
 */
import type { StrategyDefinition } from '../run';
import { closeOf, crossover, ema, gt, rsi, sum, timeMs, timestamp } from '../pine';

export interface CumulativeRsiInputs {
  rsiLength: number;
  cumLength: number;
  overbought: number;
  oversold: number;
  trendFilter: boolean;
  emaLength: number;
  /** Day / month / year of the date range, in the exchange time zone (timestamp(syminfo.timezone, ...)). */
  startDate: number;
  startMonth: number;
  startYear: number;
  endDate: number;
  endMonth: number;
  endYear: number;
}

export const cumulativeRsiStrategy: StrategyDefinition<CumulativeRsiInputs> = {
  key: 'cumulative-rsi',
  title: 'Cumulative RSI Strategy',
  shortTitle: 'CRSI Strategy',
  source: { id: 'PUB;5e81e3bfb1444999a5df30536656fb75', name: 'Cumulative RSI Strategy', author: 'TradeAutomation' },
  properties: {
    processOrdersOnClose: true,
    commissionType: 'cash_per_contract',
    commissionValue: 0.0035,
    slippage: 1,
    marginLong: 75,
    initialCapital: 25000,
    defaultQtyType: 'percent_of_equity',
    defaultQtyValue: 110,
  },
  defaultInputs: {
    rsiLength: 3,
    cumLength: 3,
    overbought: 94,
    oversold: 20,
    trendFilter: false,
    emaLength: 100,
    startDate: 1,
    startMonth: 1,
    startYear: 2010,
    endDate: 1,
    endMonth: 1,
    endYear: 2099,
  },
  // The script's "Oversold Level" input sets the upper (sell) level and "Overbought Level" the lower one.
  inputs: [
    { id: 'rsiLength', title: 'RSI Length', type: 'int', min: 1 },
    { id: 'cumLength', title: 'RSI Cumulation Length', type: 'int' },
    { id: 'overbought', title: 'Oversold Level', type: 'int' },
    { id: 'oversold', title: 'Overbought Level', type: 'int' },
    { id: 'trendFilter', title: 'Only Trade When Price is Above EMA?', type: 'bool' },
    { id: 'emaLength', title: 'EMA Length', type: 'int' },
    { id: 'startDate', title: 'Start Date', type: 'int', min: 1, max: 31 },
    { id: 'startMonth', title: 'Start Month', type: 'int', min: 1, max: 12 },
    { id: 'startYear', title: 'Start Year', type: 'int', min: 1950, max: 2100 },
    { id: 'endDate', title: 'End Date', type: 'int', min: 1, max: 31 },
    { id: 'endMonth', title: 'End Month', type: 'int', min: 1, max: 12 },
    { id: 'endYear', title: 'End Year', type: 'int', min: 1950, max: 2100 },
  ],
  plots(bars, inp) {
    return { plot_0: ema(closeOf(bars), inp.emaLength) };
  },
  setup(bars, inp, sym) {
    const close = closeOf(bars);
    const start = timestamp(sym.timezone, inp.startYear, inp.startMonth, inp.startDate);
    const end = timestamp(sym.timezone, inp.endYear, inp.endMonth, inp.endDate);
    const cumRsi = sum(rsi(close, inp.rsiLength), inp.cumLength);
    const ob = 100 * inp.cumLength * inp.overbought * 0.01;
    const os = 100 * inp.cumLength * inp.oversold * 0.01;
    const trendLong = ema(close, inp.emaLength).map((e, i) => gt(close[i], e));
    // The crossovers are called inside `if InDateRange`: their history starts
    // on the first bar where the block runs, so they are false on that bar.
    let first = true;
    return (i, s) => {
      const t = timeMs(bars, i);
      const inRange = t >= start && t < end;
      if (inRange) {
        const buy = crossover(cumRsi, os, i, first);
        const sell = crossover(cumRsi, ob, i, first);
        first = false;
        s.entry('Long', 'long', { when: buy && (!inp.trendFilter || trendLong[i]), comment: 'Buy' });
        s.close('Long', { when: sell, comment: 'Sell' });
      } else {
        s.closeAll();
      }
    };
  },
};
