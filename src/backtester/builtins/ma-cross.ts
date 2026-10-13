/** Moving average crossover and Two moving averages crossover strategies (built-in). */
import { compare } from 'oakscriptjs';
import { close, eachBar, input, nz, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

/** Moving average crossover: an entry once the close has been above (below) its SMA for `Confirm bars` bars. */
function maCrossBody(): void {
  strategy('Moving average crossover', { overlay: true });

  const length = input.int(9, 'Length');
  const confirmBars = input.int(1, 'Confirm bars');

  const ma = ta.sma(close, length);
  const bcount = eachBar((c) => (gt(c.close, c.get(ma)) ? nz(c.prev(), 0) + 1 : 0));
  const scount = eachBar((c) => (lt(c.close, c.get(ma)) ? nz(c.prev(), 0) + 1 : 0));

  strategy.eachBar((c) => {
    if (c.get(bcount) === confirmBars) strategy.entry('MACrossLE', strategy.long, { comment: 'MACrossLE' });
    if (c.get(scount) === confirmBars) strategy.entry('MACrossSE', strategy.short, { comment: 'MACrossSE' });
  });
}

/** Two moving averages crossover: long when the fast SMA crosses above the slow one, short when it crosses below. */
function ma2CrossBody(): void {
  strategy('Two moving averages crossover', { shorttitle: '2MA cross', overlay: true });

  const fastLength = input.int(9, 'fastLength');
  const slowLength = input.int(18, 'slowLength');

  const mafast = ta.sma(close, fastLength);
  const maslow = ta.sma(close, slowLength);
  const up = ta.crossover(mafast, maslow);
  const down = ta.crossunder(mafast, maslow);

  strategy.eachBar((c) => {
    if (c.get(up)) strategy.entry('MA2CrossLE', strategy.long, { comment: 'MA2CrossLE' });
    if (c.get(down)) strategy.entry('MA2CrossSE', strategy.short, { comment: 'MA2CrossSE' });
  });
}

export const maCross: ScriptStrategy = {
  key: 'ma-cross',
  source: { id: 'STD;MovingAvg%1Cross%1Strategy', name: 'Moving average crossover', author: '' },
  body: maCrossBody,
};

export const ma2Cross: ScriptStrategy = {
  key: 'ma2-cross',
  source: { id: 'STD;MovingAvg%1Cross2%1Strategy', name: 'Two moving averages crossover', author: '' },
  body: ma2CrossBody,
};
