/** Crossing Moving Averages with ADX Filter (BangtheClose): moving average bias with an ADX filter, always in the market. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, high, input, low, plot, strategy, ta, type Series } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { ge, gt, lt, le } = compare;

function body(): void {
  strategy('Crossing Moving Averages with ADX Filter)', {
    overlay: true,
    pyramiding: 0,
  });

  const fastLen = input.int(20, 'Fast MA Length');
  const slowLen = input.int(120, 'Slow MA Length');
  const maType = input.string('SMA', 'Moving Average Type', { options: ['SMA', 'EMA', 'WMA', 'LMA'] });
  const useADX = input.bool(true, 'Enable ADX Filter');
  const adxLen = input.int(14, 'ADX Length');
  const adxThreshold = input.float(20.0, 'ADX Threshold');

  const ma = (src: Series, len: number): Series =>
    maType === 'SMA' ? ta.sma(src, len) : maType === 'EMA' ? ta.ema(src, len) : maType === 'WMA' ? ta.wma(src, len) : ta.rma(src, len);
  const fastMA = ma(close, fastLen);
  const slowMA = ma(close, slowLen);

  const plusDM = eachBar((c) => {
    const upMove = c.high - c.get(high, 1);
    const downMove = c.get(low, 1) - c.low;
    return gt(upMove, downMove) && gt(upMove, 0) ? upMove : 0.0;
  });
  const minusDM = eachBar((c) => {
    const upMove = c.high - c.get(high, 1);
    const downMove = c.get(low, 1) - c.low;
    return gt(downMove, upMove) && gt(downMove, 0) ? downMove : 0.0;
  });
  const trur = ta.rma(ta.tr(true), adxLen);
  const plusDI = ta.rma(plusDM, adxLen).mul(100).div(trur);
  const minusDI = ta.rma(minusDM, adxLen).mul(100).div(trur);
  const dx = eachBar((c) => {
    const p = c.get(plusDI);
    const m = c.get(minusDI);
    const sum = p + m;
    return sum !== 0 ? (100 * Math.abs(p - m)) / sum : NaN; // x / 0 is na
  });
  const adx = ta.rma(dx, adxLen);

  strategy.eachBar((c) => {
    const f = c.get(fastMA);
    const s = c.get(slowMA);
    const adxOK = !useADX || ge(c.get(adx), adxThreshold);
    const pos = strategy.position_size;
    if (gt(f, s) && adxOK && le(pos, 0)) strategy.entry('Long', strategy.long);
    if (lt(f, s) && adxOK && ge(pos, 0)) strategy.entry('Short', strategy.short);
  });

  plot(fastMA, 'Fast MA', { color: color.blue, linewidth: 1 });
  plot(slowMA, 'Slow MA', { color: color.orange, linewidth: 3 });
}

export const crossingMaAdx: ScriptStrategy = {
  key: 'crossing-ma-adx',
  source: { id: 'PUB;d62cba5b86ab48c9a7ed1782a9728beb', name: 'Crossing Moving Averages with ADX Filter', author: 'BangtheClose' },
  body,
};
