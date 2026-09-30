/** Tomukas Scale-In V2 (Tomukasss): EMA trend filter, liquidity sweep entries scaled in up to 5 times,
 *  ATR take profit from the average price; orders filled on the bar close. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, high, input, low, open, plot, plotshape, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { eq, gt, lt } = compare;

function body(): void {
  strategy('Tomukas Scale-In V2', {
    overlay: true,
    pyramiding: 5,
    process_orders_on_close: true,
  });

  // =====================
  // TREND FILTER
  // =====================
  const ema100 = ta.ema(close, 100);
  const ema200 = ta.ema(close, 200);

  plot(ema100, 'EMA100', { color: color.yellow });
  plot(ema200, 'EMA200', { color: color.orange, linewidth: 2 });

  // =====================
  // LIQUIDITY SWEEP
  // =====================
  const lookback = input.int(20, 'Sweep Lookback');

  const prevLow = ta.lowest(low.offset(1), lookback);
  const prevHigh = ta.highest(high.offset(1), lookback);

  const longSweep = eachBar((c) => {
    const pl = c.get(prevLow);
    return gt(c.get(ema100), c.get(ema200)) && lt(c.get(low), pl) && gt(c.get(close), pl) && gt(c.get(close), c.get(open));
  });
  const shortSweep = eachBar((c) => {
    const ph = c.get(prevHigh);
    return lt(c.get(ema100), c.get(ema200)) && gt(c.get(high), ph) && lt(c.get(close), ph) && lt(c.get(close), c.get(open));
  });

  // =====================
  // SCALE-IN ENGINE
  // =====================
  const q1 = input.float(10, 'Entry 1');
  const q2 = input.float(10, 'Entry 2');
  const q3 = input.float(20, 'Entry 3');
  const q4 = input.float(40, 'Entry 4');
  const q5 = input.float(80, 'Entry 5');

  // =====================
  // TAKE PROFIT ONLY
  // =====================
  const atrLen = input.int(14, 'ATR Length');
  const tpATR = input.float(1.5, 'TP ATR Multiplier');

  const atr = ta.atr(atrLen);

  const buyShapes: number[] = [];
  const sellShapes: number[] = [];
  strategy.eachBar((c) => {
    const ls = c.get(longSweep) === 1;
    const ss = c.get(shortSweep) === 1;

    // FIRST ENTRY
    if (ls && eq(strategy.position_size, 0)) strategy.entry('L1', strategy.long, { qty: q1 });
    if (ss && eq(strategy.position_size, 0)) strategy.entry('S1', strategy.short, { qty: q1 });

    // LONG SCALES
    if (gt(strategy.position_size, 0) && ls && eq(strategy.opentrades, 1)) strategy.entry('L2', strategy.long, { qty: q2 });
    if (gt(strategy.position_size, 0) && ls && eq(strategy.opentrades, 2)) strategy.entry('L3', strategy.long, { qty: q3 });
    if (gt(strategy.position_size, 0) && ls && eq(strategy.opentrades, 3)) strategy.entry('L4', strategy.long, { qty: q4 });
    if (gt(strategy.position_size, 0) && ls && eq(strategy.opentrades, 4)) strategy.entry('L5', strategy.long, { qty: q5 });

    // SHORT SCALES
    if (lt(strategy.position_size, 0) && ss && eq(strategy.opentrades, 1)) strategy.entry('S2', strategy.short, { qty: q2 });
    if (lt(strategy.position_size, 0) && ss && eq(strategy.opentrades, 2)) strategy.entry('S3', strategy.short, { qty: q3 });
    if (lt(strategy.position_size, 0) && ss && eq(strategy.opentrades, 3)) strategy.entry('S4', strategy.short, { qty: q4 });
    if (lt(strategy.position_size, 0) && ss && eq(strategy.opentrades, 4)) strategy.entry('S5', strategy.short, { qty: q5 });

    // TAKE PROFIT ONLY
    const a = c.get(atr);
    const longTP = strategy.position_avg_price + a * tpATR;
    const shortTP = strategy.position_avg_price - a * tpATR;

    if (gt(strategy.position_size, 0)) strategy.exit('TP LONG', { limit: longTP });
    if (lt(strategy.position_size, 0)) strategy.exit('TP SHORT', { limit: shortTP });

    // VISUALS: the conditions read the position size at the bar close, before the orders fill
    const flat = eq(strategy.position_size, 0);
    buyShapes.push(ls && flat ? 1 : 0);
    sellShapes.push(ss && flat ? 1 : 0);
  });

  plotshape(seriesOf(buyShapes), 'BUY', { location: 'belowbar', style: 'triangleup', color: color.lime, size: 'small' });
  plotshape(seriesOf(sellShapes), 'SELL', { location: 'abovebar', style: 'triangledown', color: color.red, size: 'small' });
}

export const tomukasScaleIn: ScriptStrategy = {
  key: 'tomukas-scale-in',
  source: { id: 'PUB;a05472cf5e7f4f6fa597b6c77814fe54', name: 'Tomukas Scale-In V2', author: 'Tomukasss' },
  body,
};
