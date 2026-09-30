/** Gaussian Channel Strategy (RezzoRedPriest): N-pole Gaussian filter channel, close then reverse. */
import { compare } from 'oakscriptjs';
import { barcolor, color, eachBar, fill, input, nz, plot, strategy, ta, time, timestamp } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';
import { colorNew, colorRgb } from './colors';

const { ge, gt, le, lt } = compare;

/** One f_filt9x(_a, _s, _i) call site: its `var _f` and its history. The sum follows the Pine
 *  expression order (terms of a higher order than _i are 0). */
function filt9x(a: number, i: number): (s: number) => number {
  const x = 1 - a;
  const m2 = i === 9 ? 36 : i === 8 ? 28 : i === 7 ? 21 : i === 6 ? 15 : i === 5 ? 10 : i === 4 ? 6 : i === 3 ? 3 : i === 2 ? 1 : 0;
  const m3 = i === 9 ? 84 : i === 8 ? 56 : i === 7 ? 35 : i === 6 ? 20 : i === 5 ? 10 : i === 4 ? 4 : i === 3 ? 1 : 0;
  const m4 = i === 9 ? 126 : i === 8 ? 70 : i === 7 ? 35 : i === 6 ? 15 : i === 5 ? 5 : i === 4 ? 1 : 0;
  const m5 = i === 9 ? 126 : i === 8 ? 56 : i === 7 ? 21 : i === 6 ? 6 : i === 5 ? 1 : 0;
  const m6 = i === 9 ? 84 : i === 8 ? 28 : i === 7 ? 7 : i === 6 ? 1 : 0;
  const m7 = i === 9 ? 36 : i === 8 ? 8 : i === 7 ? 1 : 0;
  const m8 = i === 9 ? 9 : i === 8 ? 1 : 0;
  const m9 = i === 9 ? 1 : 0;
  const hist: number[] = [];
  const f = (k: number) => nz(hist[hist.length - k] ?? NaN);
  return (s: number) => {
    const v =
      Math.pow(a, i) * nz(s) +
      i * x * f(1) -
      (i >= 2 ? m2 * Math.pow(x, 2) * f(2) : 0) +
      (i >= 3 ? m3 * Math.pow(x, 3) * f(3) : 0) -
      (i >= 4 ? m4 * Math.pow(x, 4) * f(4) : 0) +
      (i >= 5 ? m5 * Math.pow(x, 5) * f(5) : 0) -
      (i >= 6 ? m6 * Math.pow(x, 6) * f(6) : 0) +
      (i >= 7 ? m7 * Math.pow(x, 7) * f(7) : 0) -
      (i >= 8 ? m8 * Math.pow(x, 8) * f(8) : 0) +
      (i === 9 ? m9 * Math.pow(x, 9) * f(9) : 0);
    hist.push(v);
    return v;
  };
}

/** One ta.barssince() call site: counts its own calls (na until it sees a true condition). */
function barssinceSite(): (cond: boolean) => number {
  let count = NaN;
  return (cond) => {
    if (cond) count = 0;
    else if (!Number.isNaN(count)) count++;
    return count;
  };
}

function body(): void {
  strategy('Gaussian Channel Strategy', {
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
    // Pine v6 defaults of the reference app for what the source does not declare (oakscriptjs 0.8.0 has v5 values).
    initial_capital: 100000,
  });

  const startDate = input.time(timestamp('1970-01-01T00:00:00'), 'Start trading date (exchange time)');
  const src = input.source('hlc3', 'Source');
  const N = input.int(4, 'Poles', { minval: 1, maxval: 9 });
  const per = input.int(144, 'Sampling Period', { minval: 2 });
  const mult = input.float(1.414, 'Filtered True Range Multiplier', { minval: 0 });
  const modeLag = input.bool(false, 'Reduced Lag Mode');
  const modeFast = input.bool(false, 'Fast Response Mode');
  const lineOptions = ['Filter (middle)', 'Upper band', 'Lower band'];
  const sigLineLong = input.string('Filter (middle)', 'Long → signal line', { options: lineOptions });
  const sigLineShort = input.string('Filter (middle)', 'Short → signal line', { options: lineOptions });
  const dirLong = input.string('Cross Up', 'Long when price', { options: ['Cross Up', 'Cross Down'] });
  const dirShort = input.string('Cross Down', 'Short when price', { options: ['Cross Up', 'Cross Down'] });
  const tradeLong = input.bool(true, 'Enable LONG-side trades');
  const tradeShort = input.bool(true, 'Enable SHORT-side trades');
  const reverseOnOpp = input.bool(true, 'On opposite signal: reverse (else just exit)');
  const lookback = input.int(3, 'Lookback bars for late entry', { minval: 0 });

  const beta = (1 - Math.cos((4 * Math.asin(1)) / per)) / (Math.pow(1.414, 2 / N) - 1);
  const alpha = -beta + Math.sqrt(beta * beta + 2 * beta);
  const lag = (per - 1) / (2 * N);

  const tr = ta.tr(true);
  // Only the N-pole and 1-pole filters reach the result (_fn, _f1).
  const srcN = filt9x(alpha, N);
  const src1 = filt9x(alpha, 1);
  const trN = filt9x(alpha, N);
  const tr1 = filt9x(alpha, 1);
  const filtValues: number[] = [];
  const filtTrValues: number[] = [];
  eachBar((c) => {
    const s = c.get(src);
    const t = c.get(tr);
    const srcData = modeLag ? s + (s - c.get(src, lag)) : s;
    const trData = modeLag ? t + (t - c.get(tr, lag)) : t;
    const fN = srcN(srcData);
    const f1 = src1(srcData);
    const fTrN = trN(trData);
    const fTr1 = tr1(trData);
    filtValues.push(modeFast ? (fN + f1) / 2 : fN);
    filtTrValues.push(modeFast ? (fTrN + fTr1) / 2 : fTrN);
  });
  const filt = eachBar((c) => filtValues[c.i]!);
  const filtTr = eachBar((c) => filtTrValues[c.i]!);
  const hBand = filt.add(filtTr.mul(mult));
  const lBand = filt.sub(filtTr.mul(mult));
  const lineOf = (choice: string) => (choice === 'Upper band' ? hBand : choice === 'Lower band' ? lBand : filt);
  const sigLineL = lineOf(sigLineLong);
  const sigLineS = lineOf(sigLineShort);
  const longUp = ta.crossover(src, sigLineL);
  const longDown = ta.crossunder(src, sigLineL);
  const shortUp = ta.crossover(src, sigLineS);
  const shortDown = ta.crossunder(src, sigLineS);

  // `a or (b and ta.barssince(x) <= n)`: the operands are evaluated lazily, so each barssince call site
  // only runs on the bars where the left operands let it run.
  const sinceLongUp = barssinceSite();
  const sinceLongDown = barssinceSite();
  const sinceShortUp = barssinceSite();
  const sinceShortDown = barssinceSite();
  strategy.eachBar((c) => {
    const s = c.get(src);
    const sigL = c.get(sigLineL);
    const sigS = c.get(sigLineS);
    const lu = c.get(longUp) === 1;
    const ld = c.get(longDown) === 1;
    const su = c.get(shortUp) === 1;
    const sd = c.get(shortDown) === 1;
    const longCond =
      dirLong === 'Cross Up'
        ? lu || (gt(s, sigL) && le(sinceLongUp(lu), lookback))
        : ld || (lt(s, sigL) && le(sinceLongDown(ld), lookback));
    const shortCond =
      dirShort === 'Cross Up'
        ? su || (gt(s, sigS) && le(sinceShortUp(su), lookback))
        : sd || (lt(s, sigS) && le(sinceShortDown(sd), lookback));
    if (c.get(time) >= startDate) {
      if (longCond) {
        if (lt(strategy.position_size, 0)) strategy.close('Short');
        const pos = strategy.position_size;
        if (tradeLong && (pos === 0 || (reverseOnOpp && le(pos, 0)))) strategy.entry('Long', strategy.long);
      }
      if (shortCond) {
        if (gt(strategy.position_size, 0)) strategy.close('Long');
        const pos = strategy.position_size;
        if (tradeShort && (pos === 0 || (reverseOnOpp && ge(pos, 0)))) strategy.entry('Short', strategy.short);
      }
    }
  });

  const upCol = colorRgb(0, 195, 255);
  const upDarkCol = '#092ae4';
  const dnCol = colorRgb(214, 10, 255);
  const dnDarkCol = colorRgb(135, 0, 153);
  const f = filt.toArray();
  const h = hBand.toArray();
  const l = lBand.toArray();
  const sv = src.toArray();
  const fCol = f.map((v, i) => (gt(v, f[i - 1] ?? NaN) ? upCol : lt(v, f[i - 1] ?? NaN) ? dnCol : color.gray));
  const barCol = sv.map((s, i) => {
    const s1 = sv[i - 1] ?? NaN;
    return gt(s, s1) && gt(s, f[i]!) && lt(s, h[i]!)
      ? upCol
      : gt(s, s1) && ge(s, h[i]!)
        ? colorNew(upCol, 20)
        : le(s, s1) && gt(s, f[i]!)
          ? upDarkCol
          : lt(s, s1) && lt(s, f[i]!) && gt(s, l[i]!)
            ? dnCol
            : lt(s, s1) && le(s, l[i]!)
              ? colorNew(dnCol, 20)
              : ge(s, s1) && lt(s, f[i]!)
                ? dnDarkCol
                : color.gray;
  });
  plot(filt, 'Filter', { color: fCol, linewidth: 3 });
  const hP = plot(hBand, 'Filtered TR High', { color: fCol });
  const lP = plot(lBand, 'Filtered TR Low', { color: fCol });
  fill(hP, lP, { color: fCol.map((c) => colorNew(c, 80)) });
  barcolor(barCol);
}

export const gaussianChannel: ScriptStrategy = {
  key: 'gaussian-channel',
  source: { id: 'PUB;4871abe4dffc4e529cbb66dd0ad31641', name: 'Gaussian Channel Strategy', author: 'RezzoRedPriest' },
  body,
};
