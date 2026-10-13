/**
 * Rob Booker — ADX breakout (built-in): while the ADX is below its lower level, a close crossing the box of the last
 * `boxLookBack` bars' high / low enters with a market order, exited at a profit target and a stop loss sized on the
 * box width. The original is a version 1 script: one contract, no margin.
 */
import { callsite, compare } from 'oakscriptjs';
import { bgcolor, color, eachBar, fixnan, high, input, low, plot, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { eq, gt, lt } = compare;

function body(): void {
  strategy('Rob Booker — ADX breakout', {
    shorttitle: 'RB ADX breakout',
    overlay: true,
    default_qty_type: strategy.fixed,
    default_qty_value: 1,
    margin_long: 0,
    margin_short: 0,
  });

  const adxSmoothPeriod = input.int(14, 'ADX Smoothing Period');
  const adxPeriod = input.int(14, 'ADX Period');
  const adxLowerLevel = input.int(18, 'ADX Lower Level');
  const profitTargetMultiple = input.int(1, 'Profit Target Box Width Multiple');
  const stopLossMultiple = input.float(0.5, 'Stop Loss Box Width Multiple');
  const boxLookBack = input.int(20, 'BreakoutBox Lookback Period');
  const enableDirection = input.int(0, 'Both(0), Long(1), Short(-1)');

  // dirmov(len): an na move compares false, so the first bar's directional movement is 0.
  const up = ta.change(high);
  const down = ta.change(low).mul(-1);
  const truerange = ta.rma(ta.tr(), adxSmoothPeriod);
  const plusDM = eachBar((c) => {
    const u = c.get(up);
    return gt(u, c.get(down)) && gt(u, 0) ? u : 0;
  });
  const minusDM = eachBar((c) => {
    const d = c.get(down);
    return gt(d, c.get(up)) && gt(d, 0) ? d : 0;
  });
  const plus = fixnan(ta.rma(plusDM, adxSmoothPeriod).mul(100).div(truerange));
  const minus = fixnan(ta.rma(minusDM, adxSmoothPeriod).mul(100).div(truerange));
  const ratio = eachBar((c) => {
    const p = c.get(plus);
    const m = c.get(minus);
    const sum = p + m;
    return Math.abs(p - m) / (eq(sum, 0) ? 1 : sum);
  });
  const sig = ta.rma(ratio, adxPeriod).mul(100);
  const hh = ta.highest(high, boxLookBack);
  const ll = ta.lowest(low, boxLookBack);

  const upperLevels: number[] = [];
  const lowerLevels: number[] = [];
  const stopLosses: number[] = [];
  const profitTargets: number[] = [];
  // cross(): the close on the other side of the level than on the last bar it was not equal to it (a close equal
  // to the level on the bar before counts as a cross only when the close was on the other side before that).
  const crossUpper = callsite.cross();
  const crossLower = callsite.cross();

  strategy.eachBar((c) => {
    const i = c.i;
    const isADXLow = lt(c.get(sig), adxLowerLevel);
    const flat = strategy.position_size === 0;
    const boxUpperLevel = flat ? c.get(hh, 1) : (upperLevels[i - 1] ?? NaN);
    const boxLowerLevel = flat ? c.get(ll, 1) : (lowerLevels[i - 1] ?? NaN);
    upperLevels[i] = boxUpperLevel;
    lowerLevels[i] = boxLowerLevel;
    const boxWidth = boxUpperLevel - boxLowerLevel;
    const pos = strategy.position_size;
    const avg = strategy.position_avg_price;
    const profitTarget = pos > 0 ? avg + profitTargetMultiple * boxWidth : pos < 0 ? avg - profitTargetMultiple * boxWidth : NaN;
    const stopLoss = pos > 0 ? avg - stopLossMultiple * boxWidth : pos < 0 ? avg + stopLossMultiple * boxWidth : NaN;
    stopLosses[i] = stopLoss;
    profitTargets[i] = profitTarget;

    // Called on every bar (version 1: no lazy evaluation of `and`).
    const crossesUpper = crossUpper(c.close, boxUpperLevel);
    const crossesLower = crossLower(c.close, boxLowerLevel);
    const isBuyValid = flat && crossesUpper && isADXLow;
    const isSellValid = flat && crossesLower && isADXLow;

    const entryLong = isBuyValid && strategy.opentrades === 0 && (enableDirection === 1 || enableDirection === 0);
    if (entryLong) strategy.order('open_long', strategy.long);
    strategy.exit('close_long', { from_entry: 'open_long', stop: stopLoss, limit: profitTarget });

    const entryShort = isSellValid && strategy.opentrades === 0 && (enableDirection === -1 || enableDirection === 0);
    if (entryShort) strategy.order('open_short', strategy.short);
    strategy.exit('close_short', { from_entry: 'open_short', stop: stopLoss, limit: profitTarget });
  });

  const isADXLowAll = sig.toArray().map((v) => lt(v, adxLowerLevel));
  // Version 1 colours and transparencies.
  plot(seriesOf(upperLevels), 'Box Upper Level', { color: color.new('#000000', 35) });
  plot(seriesOf(lowerLevels), 'Box Lower Level', { color: color.new('#000000', 35) });
  bgcolor(isADXLowAll.map((low) => (low ? color.new('#800080', 90) : undefined)));
  plot(seriesOf(stopLosses), 'StopLossLine', { color: color.new('#FF0000', 35), linewidth: 2 });
  plot(seriesOf(profitTargets), 'ProfitTargetLine', { color: color.new('#0000FF', 35), linewidth: 2 });
}

export const rbAdxBreakout: ScriptStrategy = {
  key: 'rb-adx-breakout',
  source: { id: 'STD;Rob%1Booker%1ADX%1Breakout%1Strategy', name: 'Rob Booker — ADX breakout', author: '' },
  body,
};
