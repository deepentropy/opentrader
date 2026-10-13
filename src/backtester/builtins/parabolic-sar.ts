/** Parabolic SAR strategy (built-in): a stop entry against the trend at the next bar's SAR, the other side cancelled. */
import { compare } from 'oakscriptjs';
import { barstate, close, high, input, low, plot, seriesOf, strategy } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Parabolic SAR strategy', { overlay: true });

  const start = input.float(0.02, 'start');
  const increment = input.float(0.02, 'increment');
  const maximum = input.float(0.2, 'maximum');

  const sarValues: number[] = [];
  const nextValues: number[] = [];
  let uptrend = false;
  let EP = NaN;
  let SAR = NaN;
  let AF = start;
  let nextBarSAR = NaN;

  strategy.eachBar((c) => {
    const i = c.i;
    if (i > 0) {
      let firstTrendBar = false;
      SAR = nextBarSAR;
      if (i === 1) {
        let prevSAR: number;
        let prevEP: number;
        if (gt(c.close, c.get(close, 1))) {
          uptrend = true;
          EP = c.high;
          prevSAR = c.get(low, 1);
          prevEP = c.high;
        } else {
          uptrend = false;
          EP = c.low;
          prevSAR = c.get(high, 1);
          prevEP = c.low;
        }
        firstTrendBar = true;
        SAR = prevSAR + start * (prevEP - prevSAR);
      }
      if (uptrend) {
        if (gt(SAR, c.low)) {
          firstTrendBar = true;
          uptrend = false;
          SAR = Math.max(EP, c.high);
          EP = c.low;
          AF = start;
        }
      } else if (lt(SAR, c.high)) {
        firstTrendBar = true;
        uptrend = true;
        SAR = Math.min(EP, c.low);
        EP = c.high;
        AF = start;
      }
      if (!firstTrendBar) {
        if (uptrend) {
          if (gt(c.high, EP)) {
            EP = c.high;
            AF = Math.min(AF + increment, maximum);
          }
        } else if (lt(c.low, EP)) {
          EP = c.low;
          AF = Math.min(AF + increment, maximum);
        }
      }
      if (uptrend) {
        SAR = Math.min(SAR, c.get(low, 1));
        if (i > 1) SAR = Math.min(SAR, c.get(low, 2));
      } else {
        SAR = Math.max(SAR, c.get(high, 1));
        if (i > 1) SAR = Math.max(SAR, c.get(high, 2));
      }
      nextBarSAR = SAR + AF * (EP - SAR);
      if (c.get(barstate.isconfirmed)) {
        if (uptrend) {
          strategy.entry('ParSE', strategy.short, { stop: nextBarSAR, comment: 'ParSE' });
          strategy.cancel('ParLE');
        } else {
          strategy.entry('ParLE', strategy.long, { stop: nextBarSAR, comment: 'ParLE' });
          strategy.cancel('ParSE');
        }
      }
    }
    sarValues[i] = SAR;
    nextValues[i] = nextBarSAR;
  });

  plot(seriesOf(sarValues), 'SAR', { style: 'cross', linewidth: 3, color: '#FF9800' });
  plot(seriesOf(nextValues), 'Next bar SAR', { style: 'cross', linewidth: 3, color: '#00BCD4' });
}

export const parabolicSar: ScriptStrategy = {
  key: 'parabolic-sar',
  source: { id: 'STD;Parabolic%1SAR%1Strategy', name: 'Parabolic SAR strategy', author: '' },
  body,
};
