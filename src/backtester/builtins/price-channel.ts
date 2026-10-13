/** Price channel strategy (built-in): stop entries at the highest high and the lowest low of `length` bars. */
import { close, high, input, low, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

function body(): void {
  strategy('Price channel strategy', { overlay: true });

  const length = input.int(20, 'length');

  const hh = ta.highest(high, length);
  const ll = ta.lowest(low, length);

  strategy.eachBar((c) => {
    if (!Number.isNaN(c.get(close, length))) {
      strategy.entry('PChLE', strategy.long, { comment: 'PChLE', stop: c.get(hh) });
      strategy.entry('PChSE', strategy.short, { comment: 'PChSE', stop: c.get(ll) });
    }
  });
}

export const priceChannel: ScriptStrategy = {
  key: 'price-channel',
  source: { id: 'STD;Price%1Channel%1Strategy', name: 'Price channel strategy', author: '' },
  body,
};
