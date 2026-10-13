/** Keltner channels strategy (built-in): a close beyond a band places a stop entry one tick beyond that bar,
 *  cancelled when the source crosses back over the average or the price reaches the stop. */
import { compare } from 'oakscriptjs';
import { eachBar, high, input, low, nz, strategy, syminfo, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { ge, gt, le, lt } = compare;

function body(): void {
  strategy('Keltner channels strategy', { overlay: true });

  const length = input.int(20, 'length', { minval: 1 });
  const mult = input.float(2.0, 'Multiplier');
  const src = input.source('close', 'Source');
  const exp = input.bool(true, 'Use Exponential MA', { display: 'none' });
  const bandsStyle = input.string('Average True Range', 'Bands Style', {
    options: ['Average True Range', 'True Range', 'Range'],
    display: 'none',
  });
  const atrlength = input.int(10, 'ATR Length', { display: 'none' });

  const ma = exp ? ta.ema(src, length) : ta.sma(src, length);
  const rangema = bandsStyle === 'True Range' ? ta.tr(true) : bandsStyle === 'Average True Range' ? ta.atr(atrlength) : ta.rma(high.sub(low), length);
  const upper = ma.add(rangema.mul(mult));
  const lower = ma.sub(rangema.mul(mult));
  const crossUpper = ta.crossover(src, upper);
  const crossLower = ta.crossunder(src, lower);
  const bprice = eachBar((c) => (c.get(crossUpper) ? c.high + syminfo.mintick : nz(c.prev(), 0)));
  const sprice = eachBar((c) => (c.get(crossLower) ? c.low - syminfo.mintick : nz(c.prev(), 0)));
  const crossBcond = eachBar((c) => (c.get(crossUpper) ? 1 : nz(c.prev(), 0)));
  const crossScond = eachBar((c) => (c.get(crossLower) ? 1 : nz(c.prev(), 0)));

  strategy.eachBar((c) => {
    const s = c.get(src);
    const m = c.get(ma);
    const cancelBcond = c.get(crossBcond) === 1 && (lt(s, m) || ge(c.high, c.get(bprice)));
    const cancelScond = c.get(crossScond) === 1 && (gt(s, m) || le(c.low, c.get(sprice)));
    if (cancelBcond) strategy.cancel('KltChLE');
    if (c.get(crossUpper)) strategy.entry('KltChLE', strategy.long, { stop: c.get(bprice), comment: 'KltChLE' });
    if (cancelScond) strategy.cancel('KltChSE');
    if (c.get(crossLower)) strategy.entry('KltChSE', strategy.short, { stop: c.get(sprice), comment: 'KltChSE' });
  });
}

export const keltnerChannels: ScriptStrategy = {
  key: 'keltner-channels',
  source: { id: 'STD;Keltner%1Channel%1Strategy', name: 'Keltner channels strategy', author: '' },
  body,
};
