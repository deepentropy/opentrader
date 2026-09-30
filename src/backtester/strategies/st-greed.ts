/**
 * ST_greed_spot_example (Ushel-v-telegu), Pine v5.
 * Grid: a limit entry at the previous close after a false break of the
 * 50-bar low, then up to 9 strategy.order limits 3 % below the average price,
 * each for 1/10 of the equity; one strategy.exit limit 3 % above the average
 * price for all trades. Pyramiding 20, 0.06 % commission.
 */
import type { StrategyDefinition } from '../run';
import { at, closeOf, gt, lowest, lowOf, lt, timeMs } from '../pine';

export interface StGreedInputs {
  /** UNIX ms. */
  start: number;
  finish: number;
  lowPeriod: number;
  depth: number;
  drawdownPercent: number;
  takePercent: number;
}

export const stGreedStrategy: StrategyDefinition<StGreedInputs> = {
  key: 'st-greed',
  title: 'ST_gree_spot_example',
  source: { id: 'PUB;d38c058c844b4634b85ddf13c1487e8e', name: 'ST_greed_spot_example', author: 'Ushel-v-telegu' },
  properties: { initialCapital: 1000, pyramiding: 20, commissionValue: 0.06, defaultQtyType: 'percent_of_equity', defaultQtyValue: 100 },
  defaultInputs: {
    // input.time(timestamp("01 Jan 2001 00:00")) and ("01 Jan 2101 00:00"), as sent by TradingView.
    start: 978307200000,
    finish: 4133980800000,
    lowPeriod: 50,
    depth: 10,
    drawdownPercent: 3,
    takePercent: 3,
  },
  inputs: [
    { id: 'start', title: 'Start date', type: 'time' },
    { id: 'finish', title: 'Finish date', type: 'time' },
    { id: 'lowPeriod', title: 'Period for low', type: 'int' },
    { id: 'depth', title: 'Depth grid', type: 'int' },
    { id: 'drawdownPercent', title: 'Drawdown %', type: 'float' },
    { id: 'takePercent', title: 'Take %', type: 'float' },
  ],
  setup(bars, inp) {
    const close = closeOf(bars);
    const low = lowOf(bars);
    const l = lowest(low, inp.lowPeriod);
    let money = 0;
    let price1 = 0;
    let count = 0;
    let prevPos = NaN;
    return (i, s) => {
      const t = timeMs(bars, i);
      const trig = t > inp.start && t < inp.finish;
      const hl = at(l, i, 6);
      const cond = lt(low[i], hl) && gt(close[i], hl);
      const pos = s.positionSize;
      if (pos === 0 && cond && gt(s.equity, 0)) {
        price1 = at(close, i, 1);
        money = s.equity / inp.depth;
      }
      const vol1 = money / price1;
      if (gt(pos, prevPos)) count += 1;
      if (pos === 0) count = 0;
      const avg = s.positionAvgPrice;
      const pricen = avg * (1 - inp.drawdownPercent / 100);
      const voln = money / pricen;
      const tp = avg * (1 + inp.takePercent / 100);
      if (cond && pos === 0 && gt(s.equity, 0) && trig) s.entry('buy', 'long', { qty: vol1, limit: price1 });
      if (pos !== 0 && gt(s.equity, 0) && trig && count <= inp.depth - 1) s.order('buy', 'long', { qty: voln, limit: pricen });
      if (trig) s.exit('buy', { limit: tp });
      prevPos = pos;
    };
  },
};
