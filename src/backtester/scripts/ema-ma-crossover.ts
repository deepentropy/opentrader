/** EMA & MA Crossover Strategy (HPotter): SMA of the previous close against its EMA, always in the market. */
import { compare } from 'oakscriptjs';
import { barcolor, close, color, eachBar, input, nz, plot, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('EMA & MA Crossover Strategy', {
    shorttitle: 'EMA&MA',
    overlay: true,
  });

  const lengthMA = input.int(10, 'LengthMA', { minval: 1 });
  const lengthEMA = input.int(10, 'LengthEMA', { minval: 1 });

  const xMA = ta.sma(close.offset(1), lengthMA);
  const xEMA = ta.ema(xMA.offset(1), lengthEMA);
  const pos = eachBar((c) => {
    const e = c.get(xEMA);
    const m = c.get(xMA);
    return lt(e, m) ? 1 : gt(e, m) ? -1 : nz(c.prev(), 0);
  });
  barcolor(pos.toArray().map((p) => (p === -1 ? color.red : p === 1 ? color.green : color.blue)));

  strategy.eachBar((c) => {
    const p = c.get(pos);
    if (p === 1) strategy.entry('Long', strategy.long);
    if (p === -1) strategy.entry('Short', strategy.short);
    if (p === 0) strategy.close_all({ comment: 'Exit' });
  });

  plot(xMA, 'MA', { color: color.red });
  plot(xEMA, 'EMA', { color: color.blue });
}

export const emaMaCrossover: ScriptStrategy = {
  key: 'ema-ma-crossover',
  source: { id: 'PUB;1e00594006994049a40bf9ee0d165ab6', name: 'EMA & MA Crossover Strategy', author: 'HPotter' },
  body,
};
