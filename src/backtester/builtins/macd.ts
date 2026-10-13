/** MACD strategy (built-in): long when the MACD histogram crosses above 0, short when it crosses below. */
import { close, input, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

function body(): void {
  strategy('MACD strategy', { overlay: true });

  const fastLength = input.int(12, 'Fast length');
  const slowlength = input.int(26, 'Slow length');
  const MACDLength = input.int(9, 'MACD length');

  const MACD = ta.ema(close, fastLength).sub(ta.ema(close, slowlength));
  const aMACD = ta.ema(MACD, MACDLength);
  const delta = MACD.sub(aMACD);
  const up = ta.crossover(delta, 0);
  const down = ta.crossunder(delta, 0);

  strategy.eachBar((c) => {
    if (c.get(up)) strategy.entry('MacdLE', strategy.long, { comment: 'MacdLE' });
    if (c.get(down)) strategy.entry('MacdSE', strategy.short, { comment: 'MacdSE' });
  });
}

export const macd: ScriptStrategy = {
  key: 'macd',
  source: { id: 'STD;MACD%1Strategy', name: 'MACD strategy', author: '' },
  body,
};
