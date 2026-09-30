/** UT Bot v2 (QuantNomad): ATR trailing stop, reversal entries. */
import { compare } from 'oakscriptjs';
import { barcolor, color, eachBar, input, nz, plot, plotshape, strategy, ta, time, timestamp } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';
import { colorNew } from './colors';

const { gt, lt } = compare;

function body(): void {
  strategy('UT Bot v2 — ATR Trailing Stop', {
    shorttitle: 'UT Bot v2',
    overlay: true,
    // Pine v6 defaults of the reference app for what the source does not declare (oakscriptjs 0.8.0 has v5 values).
    initial_capital: 100000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
  });

  const mult = input.float(1, 'Multipier', { minval: 0.1, step: 0.1 });
  const atrLen = input.int(10, 'ATR Period', { minval: 1 });
  const source = input.source('close', 'Source');
  const useDateFilter = input.bool(true, 'Use Backtest Date Range');
  const startTime = input.time(timestamp('2020-01-01 00:00'), 'Start Date');
  const endTime = input.time(timestamp('2030-01-01 00:00'), 'End Date');
  const showSignals = input.bool(true, 'Show Buy/Sell Signals');
  const colorBars = input.bool(false, 'Color Bars by Trend');
  const showTsl = input.bool(true, 'Show Trailing Stop Line');

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

  // barstate.isconfirmed: every bar of a backtest is a closed bar.
  const buy = ta.crossover(source, tslPrice);
  const sell = ta.crossover(tslPrice, source);

  const bullColor = colorNew(color.green, 0);
  const bearColor = colorNew(color.red, 0);
  const tslColor: string[] = [];
  const buys = buy.toArray();
  const sells = sell.toArray();
  for (let i = 0; i < buys.length; i++) {
    tslColor.push(sells[i] ? bearColor : buys[i] ? bullColor : (tslColor[i - 1] ?? bullColor));
  }
  if (colorBars) barcolor(tslColor);
  if (showTsl) plot(tslPrice, 'Plot', { color: tslColor, linewidth: 2 });
  if (showSignals) {
    plotshape(buy, 'Buy', { text: 'Buy', style: 'labelup', location: 'belowbar', color: bullColor, textcolor: colorNew(color.white, 0), size: 'tiny' });
    plotshape(sell, 'Sell', { text: 'Sell', style: 'labeldown', location: 'abovebar', color: bearColor, textcolor: colorNew(color.white, 0), size: 'tiny' });
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
