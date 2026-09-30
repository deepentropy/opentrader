/** UT Bot v2 (QuantNomad): ATR trailing stop, reversal entries. */
import { compare } from 'oakscriptjs';
import { barcolor, barstate, color, eachBar, input, nz, plot, plotshape, strategy, ta, time, timestamp } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('UT Bot v2 — ATR Trailing Stop', {
    shorttitle: 'UT Bot v2',
    overlay: true,
  });

  const mult = input.float(1, 'Multipier', {
    minval: 0.1,
    step: 0.1,
    tooltip: 'Controls the distance of the trailing stop. Higher values create wider stops and fewer trend flips.',
    group: 'Config',
  });
  const atrLen = input.int(10, 'ATR Period', { minval: 1, tooltip: 'Number of bars used to calculate ATR volatility.', group: 'Config' });
  const source = input.source('close', 'Source', { tooltip: 'Price source used for trailing stop calculations.', group: 'Config' });
  const range = { group: 'Backtesting Range' };
  const useDateFilter = input.bool(true, 'Use Backtest Date Range', range);
  const startTime = input.time(timestamp('2020-01-01 00:00'), 'Start Date', range);
  const endTime = input.time(timestamp('2030-01-01 00:00'), 'End Date', range);
  const display = { group: 'Display' };
  const showSignals = input.bool(true, 'Show Buy/Sell Signals', display);
  const colorBars = input.bool(false, 'Color Bars by Trend', display);
  const showTsl = input.bool(true, 'Show Trailing Stop Line', display);

  const slValue = ta.atr(atrLen).mul(mult);
  const tslPrice = eachBar((c) => {
    const src = c.get(source);
    const src1 = c.get(source, 1);
    const prev = c.prev();
    const sl = c.get(slValue);
    if (gt(src, prev) && gt(src1, prev)) return Math.max(nz(prev), src - sl);
    if (lt(src, prev) && lt(src1, prev)) return Math.min(nz(prev), src + sl);
    return gt(src, prev) ? src - sl : src + sl;
  });

  const buy = ta.crossover(source, tslPrice).and(barstate.isconfirmed);
  const sell = ta.crossover(tslPrice, source).and(barstate.isconfirmed);

  const bullColor = color.new(color.green, 0);
  const bearColor = color.new(color.red, 0);
  const tslColor: string[] = [];
  const buys = buy.toArray();
  const sells = sell.toArray();
  for (let i = 0; i < buys.length; i++) {
    tslColor.push(sells[i] ? bearColor : buys[i] ? bullColor : (tslColor[i - 1] ?? bullColor));
  }
  if (colorBars) barcolor(tslColor);
  if (showTsl) plot(tslPrice, 'Plot', { color: tslColor, linewidth: 2 });
  if (showSignals) {
    plotshape(buy, 'Buy', { text: 'Buy', style: 'labelup', location: 'belowbar', color: bullColor, textcolor: color.new(color.white, 0), size: 'tiny' });
    plotshape(sell, 'Sell', { text: 'Sell', style: 'labeldown', location: 'abovebar', color: bearColor, textcolor: color.new(color.white, 0), size: 'tiny' });
  }

  strategy.eachBar((c) => {
    const t = c.get(time);
    const inDateRange = !useDateFilter || (t >= startTime && t <= endTime);
    if (c.get(buy) === 1 && inDateRange) strategy.entry('Long', strategy.long);
    if (c.get(sell) === 1 && inDateRange) strategy.entry('Short', strategy.short);
  });
}

export const utBotV2: ScriptStrategy = {
  key: 'ut-bot-v2',
  source: { id: 'PUB;d51b224c4a994fa2bbe7165b17e46741', name: 'UT Bot v2 - ATR Trailing Stop', author: 'QuantNomad' },
  body,
};
