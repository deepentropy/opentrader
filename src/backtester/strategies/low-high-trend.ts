/**
 * Low-High-Trend Strategy (TradeAutomation), Pine v5.
 * Long only: buy when the close crosses over the prior 20-bar lowest close
 * above the 200 EMA; sell when the close crosses over the average entry
 * price + 8 %. Orders fill at the bar close (process_orders_on_close), 100 %
 * of equity, 1 per order commission, 1 tick slippage.
 */
import type { StrategyDefinition } from '../run';
import { at, closeOf, crossover, crossunder, ema, gt, highest, lowest, timeMs } from '../pine';

export interface LowHighTrendInputs {
  /** UNIX ms. */
  startTime: number;
  endTime: number;
  lowLookback: number;
  highLookback: number;
  takeProfit: boolean;
  takeProfitPercent: number;
  trendFilter: boolean;
  emaLength: number;
}

export const lowHighTrendStrategy: StrategyDefinition<LowHighTrendInputs> = {
  key: 'low-high-trend',
  title: 'Low-High-Trend Strategy',
  shortTitle: 'Low-High-Trend Strategy',
  source: { id: 'PUB;dd584b3bd41d4b1e9f0a2fa336d08ac9', name: 'Low-High-Trend Strategy', author: 'TradeAutomation' },
  properties: {
    processOrdersOnClose: true,
    commissionType: 'cash_per_order',
    commissionValue: 1,
    slippage: 1,
    initialCapital: 100_000_000,
    marginLong: 50,
    marginShort: 50,
    defaultQtyType: 'percent_of_equity',
    defaultQtyValue: 100,
  },
  defaultInputs: {
    startTime: Date.UTC(2000, 0, 1, 5),
    endTime: Date.UTC(2099, 0, 1),
    lowLookback: 20,
    highLookback: 10,
    takeProfit: true,
    takeProfitPercent: 8,
    trendFilter: true,
    emaLength: 200,
  },
  inputs: [
    { id: 'startTime', title: 'Start Time', type: 'time' },
    { id: 'endTime', title: 'End Time', type: 'time' },
    { id: 'lowLookback', title: 'Lowest Price Lookback', type: 'int', tooltip: 'The strategy will BUY when the price crosses over the lowest it has been in the last X amount of bars' },
    { id: 'highLookback', title: 'Highest Price Lookback', type: 'int', tooltip: 'If Take-Profit is not checked, the strategy will SELL when the price crosses under the highest it has been in the last X amount of bars' },
    { id: 'takeProfit', title: 'Sell with Take-Profit % intead of highest price cross?', type: 'bool' },
    { id: 'takeProfitPercent', title: 'Take Profit %', type: 'float', step: 0.25 },
    { id: 'trendFilter', title: 'Only buy when price is above EMA trend?', type: 'bool' },
    { id: 'emaLength', title: 'EMA Length', type: 'int' },
  ],
  plots(bars, inp) {
    const close = closeOf(bars);
    const lo = lowest(close, inp.lowLookback);
    const hi = highest(close, inp.highLookback);
    return {
      plot_0: hi.map((_, i) => at(hi, i, 1)),
      plot_1: lo.map((_, i) => at(lo, i, 1)),
      plot_2: ema(close, inp.emaLength),
    };
  },
  setup(bars, inp) {
    const close = closeOf(bars);
    const lo = lowest(close, inp.lowLookback);
    const hi = highest(close, inp.highLookback);
    const low = lo.map((_, i) => at(lo, i, 1));
    const high = hi.map((_, i) => at(hi, i, 1));
    const trend = ema(close, inp.emaLength);
    // Take-profit level at each bar close (na when flat), kept for crossover history.
    const tpLevel: number[] = [];
    let first = true;
    return (i, s) => {
      tpLevel[i] = s.positionAvgPrice * (1 + 0.01 * inp.takeProfitPercent);
      const takeProfit = crossover(close, tpLevel, i);
      const t = timeMs(bars, i);
      const inRange = t >= inp.startTime && t <= inp.endTime;
      if (inRange) {
        // ta.crossover / ta.crossunder called inside `if`: false on the first bar the block runs.
        const buy = crossover(close, low, i, first);
        const sell = crossunder(close, high, i, first);
        first = false;
        s.entry('Long', 'long', { when: buy && (!inp.trendFilter || gt(close[i], trend[i])) });
        s.close('Long', { when: inp.takeProfit ? takeProfit : sell });
      } else {
        s.closeAll();
      }
    };
  },
};
