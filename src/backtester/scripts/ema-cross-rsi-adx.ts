/** EMA Cross + RSI + ADX - Autotrade Strategy V2 (varuns_back): fixed quantity, stop loss from the signal close. */
import { compare } from 'oakscriptjs';
import { close, color, input, plot, plotshape, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';
import { colorNew } from './colors';

const { ge, gt, le, lt } = compare;

function body(): void {
  strategy('EMA Cross + RSI + ADX - Strategy V2', {
    overlay: true,
    initial_capital: 1000,
    default_qty_value: 10,
    default_qty_type: strategy.fixed,
    commission_type: strategy.commission.percent,
    commission_value: 0.075,
  });

  const emaFast = input.int(9, 'Fast EMA', { minval: 1 });
  const emaSlow = input.int(21, 'Slow EMA', { minval: 1 });
  const rsiLength = input.int(14, 'RSI Length', { minval: 1 });
  const rsiLong = input.int(55, 'RSI Long Threshold', { minval: 1, maxval: 100 });
  const rsiShort = input.int(40, 'RSI Short Threshold', { minval: 1, maxval: 100 });
  const slPercent = input.float(2.0, 'Stop Loss %', { minval: 0.1, maxval: 10 });
  const useAdx = input.bool(true, 'Use ADX Filter');
  const adxLength = input.int(14, 'ADX Length', { minval: 1 });
  const adxThreshold = input.float(0, 'ADX Threshold', { minval: 0, maxval: 100 });

  const ema9 = ta.ema(close, emaFast);
  const ema21 = ta.ema(close, emaSlow);
  const rsi = ta.rsi(close, rsiLength);
  const [, , adx] = ta.dmi(adxLength, adxLength);
  const bullCross = ta.crossover(ema9, ema21);
  const bearCross = ta.crossunder(ema9, ema21);

  let longSL = NaN;
  let shortSL = NaN;
  const longSLPlot: number[] = [];
  const shortSLPlot: number[] = [];
  const longEntries: number[] = [];
  const shortEntries: number[] = [];
  const longStops: number[] = [];
  const shortStops: number[] = [];
  strategy.eachBar((c) => {
    const bull = c.get(bullCross) === 1;
    const bear = c.get(bearCross) === 1;
    const r = c.get(rsi);
    const adxOk = useAdx ? gt(c.get(adx), adxThreshold) : true;
    const longCondition = bull && gt(r, rsiLong) && adxOk;
    const shortCondition = bear && lt(r, rsiShort) && adxOk;
    if (longCondition) longSL = c.close * (1 - slPercent / 100);
    if (shortCondition) shortSL = c.close * (1 + slPercent / 100);
    const pos = strategy.position_size;
    const closeLongCondition = bear && gt(pos, 0);
    const closeShortCondition = bull && lt(pos, 0);
    const longSLHit = gt(pos, 0) && !Number.isNaN(longSL) && le(c.low, longSL);
    const shortSLHit = lt(pos, 0) && !Number.isNaN(shortSL) && ge(c.high, shortSL);

    if (longCondition) strategy.entry('LONG', strategy.long);
    if (shortCondition) strategy.entry('SHORT', strategy.short);
    if (closeLongCondition) {
      strategy.close('LONG', { comment: 'Opposite Cross' });
      longSL = NaN;
    }
    if (closeShortCondition) {
      strategy.close('SHORT', { comment: 'Opposite Cross' });
      shortSL = NaN;
    }
    if (longSLHit) {
      strategy.close('LONG', { comment: 'SL Hit' });
      longSL = NaN;
    }
    if (shortSLHit) {
      strategy.close('SHORT', { comment: 'SL Hit' });
      shortSL = NaN;
    }

    longSLPlot.push(gt(pos, 0) ? longSL : NaN);
    shortSLPlot.push(lt(pos, 0) ? shortSL : NaN);
    longEntries.push(longCondition ? 1 : 0);
    shortEntries.push(shortCondition ? 1 : 0);
    longStops.push(longSLHit ? 1 : 0);
    shortStops.push(shortSLHit ? 1 : 0);
  });

  plot(ema9, 'EMA 9', { color: color.blue, linewidth: 2 });
  plot(ema21, 'EMA 21', { color: color.red, linewidth: 2 });
  plot(seriesOf(longSLPlot), 'Long SL', { color: color.orange, linewidth: 2, style: 'linebr' });
  plot(seriesOf(shortSLPlot), 'Short SL', { color: color.orange, linewidth: 2, style: 'linebr' });
  plotshape(seriesOf(longEntries), 'Long Entry', { style: 'triangleup', location: 'belowbar', color: colorNew(color.green, 0), size: 'large' });
  plotshape(seriesOf(shortEntries), 'Short Entry', { style: 'triangledown', location: 'abovebar', color: colorNew(color.red, 0), size: 'large' });
  plotshape(seriesOf(longStops), 'Long SL Hit', { style: 'xcross', location: 'belowbar', color: colorNew(color.orange, 0), size: 'normal' });
  plotshape(seriesOf(shortStops), 'Short SL Hit', { style: 'xcross', location: 'abovebar', color: colorNew(color.orange, 0), size: 'normal' });
}

export const emaCrossRsiAdx: ScriptStrategy = {
  key: 'ema-cross-rsi-adx',
  source: { id: 'PUB;ab48700c1a8d4c4d96f6c9421e79a2c1', name: 'EMA Cross + RSI + ADX - Autotrade Strategy V2', author: 'varuns_back' },
  body,
};
