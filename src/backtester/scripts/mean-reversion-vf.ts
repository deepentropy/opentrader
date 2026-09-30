/** Mean Reversion V-F (fullmax): up to 5 long orders at deviation levels below a moving average,
 *  sized in cash units, one take profit from the average price. */
import { compare } from 'oakscriptjs';
import { close, color, fill, input, plot, seriesOf, strategy, syminfo, ta } from 'oakscriptjs/script';
import type { Series } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { eq, gt, lt } = compare;

function body(): void {
  strategy('Mean Reversion V-F', { overlay: true });

  const buy = input.string('', 'webhook for buy');
  const exitbuy = input.string('', 'webhook for exit buy');

  //input variables
  const STK = input.bool(false, 'Use for Stocks- how many Stocks in units level');
  const PLotD = input.bool(false, 'Plot Dynamic level');

  const deviation = input.float(1.3, 'Deviation Increment (%)', { minval: 0.01, maxval: 100, step: 0.1 }) / 100;
  const deviation1 = input.float(7.5, 'Deviation Increment1 (%)', { minval: 0.01, maxval: 100, step: 0.1 }) / 100;
  const deviation2 = input.float(13.3, 'Deviation Increment2 (%)', { minval: 0.01, maxval: 100, step: 0.1 }) / 100;
  const deviation3 = input.float(21.1, 'Deviation Increment3 (%)', { minval: 0.01, maxval: 100, step: 0.1 }) / 100;
  const deviation4 = input.float(33.7, 'Deviation Increment4 (%)', { minval: 0.01, maxval: 100, step: 0.1 }) / 100;
  const unitsLevel1 = input.float(50, 'Level 1 (units in cash)', { maxval: 10000 });
  const unitsLevel2 = input.float(100, 'Level 2 (units in cash)', { maxval: 10000 });
  const unitsLevel3 = input.float(200, 'Level 3 (units in cash)', { maxval: 10000 });
  const unitsLevel4 = input.float(400, 'Level 4 (units in cash)', { maxval: 10000 });
  const unitsLevel5 = input.float(600, 'Level 5 (units in cash)', { maxval: 10000 });

  //moving average
  const maType = input.string('WMA', 'MA type', { options: ['WMA', 'SMA', 'RMA', 'EMA', 'HMA'] });
  const maLength = input.int(20, 'MA length', { minval: 2 });

  let ma: Series;
  switch (maType) {
    case 'EMA':
      ma = ta.ema(close, maLength);
      break;
    case 'SMA':
      ma = ta.sma(close, maLength);
      break;
    case 'RMA':
      ma = ta.rma(close, maLength);
      break;
    case 'WMA':
      ma = ta.wma(close, maLength);
      break;
    case 'HMA':
      ma = ta.hma(close, maLength);
      break;
    default:
      throw new Error('No matching MA type found.');
  }

  //banding calculations can be change
  const L1 = ma.mul(1 - deviation);
  const L2 = ma.mul(1 - deviation1);
  const L3 = ma.mul(1 - deviation2);
  const L4 = ma.mul(1 - deviation3);
  const L5 = ma.mul(1 - deviation4);

  //// take Profit
  const take_profit1 = input.float(1.67, 'Target Take Profit (%)', { step: 0.01, minval: 0.0 }) / 100;

  /// trailing take profit % or hull
  const takeProfitTrailingEnabled = input.bool(false, 'Enable Trailing', {
    tooltip:
      'Enable or disable the trailing for take profit. WARNING! This feature will repaint. Make sure you use it with "Bar Magnifier" and "Deep Backtesting" for realistic backtest results',
  });
  const trailingTakeProfitDistancePerc =
    input.float(1.0, '  Trailing Distance %', {
      minval: 0.01,
      maxval: 100,
      step: 0.01,
      tooltip: 'The distance as a percentage of the take profit price to keep from the high price after the target is reached when trailing.',
    }) / 100;

  /////////// set static levels: s2..s5 keep their previous value (na until set)
  let s2 = NaN;
  let s3 = NaN;
  let s4 = NaN;
  let s5 = NaN;
  const tpPlot: number[] = [];
  const avgPlot: number[] = [];
  const st2Plot: number[] = [];
  const st3Plot: number[] = [];
  const st4Plot: number[] = [];
  const st5Plot: number[] = [];
  strategy.eachBar((c) => {
    const take_profit_level1 = strategy.position_avg_price * (1 + take_profit1);
    tpPlot.push(take_profit_level1);
    avgPlot.push(strategy.position_avg_price);

    // LOGIC
    const longTrailingTakeProfitStepTicks = (take_profit_level1 * trailingTakeProfitDistancePerc) / syminfo.mintick;
    //////exit
    if (gt(strategy.position_size, 0)) {
      strategy.exit('B-ALL', {
        limit: takeProfitTrailingEnabled ? NaN : take_profit_level1,
        comment: exitbuy,
        trail_price: takeProfitTrailingEnabled ? take_profit_level1 : NaN,
        trail_offset: takeProfitTrailingEnabled ? longTrailingTakeProfitStepTicks : NaN,
      });
    }

    //mode
    const cl = c.close;
    if (lt(cl, c.get(L1)) && eq(strategy.opentrades, 0)) {
      strategy.order('B1', strategy.long, { qty: STK ? unitsLevel1 : unitsLevel1 / cl, comment: buy });
      s2 = c.get(L2);
    }
    if (lt(cl, s2) && eq(strategy.opentrades, 1)) {
      strategy.order('B2', strategy.long, { qty: STK ? unitsLevel2 : unitsLevel2 / cl, comment: buy });
      s3 = c.get(L3);
    }
    if (lt(cl, s3) && eq(strategy.opentrades, 2)) {
      strategy.order('B3', strategy.long, { qty: STK ? unitsLevel3 : unitsLevel3 / cl, comment: buy });
      s4 = c.get(L4);
    }
    if (lt(cl, s4) && eq(strategy.opentrades, 3)) {
      strategy.order('B4', strategy.long, { qty: STK ? unitsLevel4 : unitsLevel4 / cl, comment: buy });
      s5 = c.get(L5);
    }
    if (lt(cl, s5) && eq(strategy.opentrades, 4)) {
      strategy.order('B5', strategy.long, { qty: STK ? unitsLevel5 : unitsLevel5 / cl, comment: buy });
    }

    const n = strategy.opentrades;
    st2Plot.push(gt(n, 0) ? s2 : NaN);
    st3Plot.push(gt(n, 1) ? s3 : NaN);
    st4Plot.push(gt(n, 2) ? s4 : NaN);
    st5Plot.push(gt(n, 3) ? s5 : NaN);
  });

  plot(seriesOf(tpPlot), 'Plot', { style: 'linebr', linewidth: 2, color: color.green });
  plot(seriesOf(avgPlot), 'Plot', { style: 'linebr', linewidth: 2, color: color.black });

  //plot dynamics level's
  const nas = ma.mul(NaN);
  const l_ma = plot(ma, 'Plot', { color: color.new(color.red, 0), linewidth: 3 }); //moving average center line
  const l_b1 = plot(PLotD ? L1 : nas, 'Plot', { color: color.new(color.red, 0), linewidth: 1 }); //level b1
  const l_b2 = plot(PLotD ? L2 : nas, 'Plot', { color: color.new(color.black, 0), linewidth: 1 }); //level b2
  const l_b3 = plot(PLotD ? L3 : nas, 'Plot', { color: color.new(color.black, 0), linewidth: 1 }); //level b3
  const l_b4 = plot(PLotD ? L4 : nas, 'Plot', { color: color.new(color.black, 0), linewidth: 1 }); //level b4
  const l_b5 = plot(PLotD ? L5 : nas, 'Plot', { color: color.new(color.black, 0), linewidth: 1 }); //level b5

  fill(l_ma, l_b1, { color: color.new(color.gray, 50) });
  fill(l_b1, l_b2, { color: color.new(color.orange, 90) });
  fill(l_b2, l_b3, { color: color.new(color.orange, 70) });
  fill(l_b3, l_b4, { color: color.new(color.orange, 50) });
  fill(l_b4, l_b5, { color: color.new(color.orange, 30) });

  // plot statics level's
  const st2 = plot(seriesOf(st2Plot), 'Long 2 SLayer', { style: 'linebr' });
  const st3 = plot(seriesOf(st3Plot), 'Long 3 SLayer', { style: 'linebr' });
  const st4 = plot(seriesOf(st4Plot), 'Long 4 SLayer', { style: 'linebr' });
  const st5 = plot(seriesOf(st5Plot), 'Long 5 SLayer', { style: 'linebr' });
  const bot = input.color(color.blue);
  fill(st2, st3, color.new(bot, 90));
  fill(st3, st4, color.new(bot, 80));
  fill(st4, st5, color.new(bot, 70));
}

export const meanReversionVf: ScriptStrategy = {
  key: 'mean-reversion-vf',
  source: { id: 'PUB;96fd7d46211c4736ac3fe58e8bd3ed4f', name: 'Mean Reversion V-F', author: 'fullmax' },
  body,
};
