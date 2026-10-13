/** Supertrend strategy (built-in): long when the Supertrend direction turns up, short when it turns down. */
import { compare } from 'oakscriptjs';
import { input, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Supertrend strategy', {
    shorttitle: 'Supertrend str',
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 15,
  });

  const atrPeriod = input.int(10, 'ATR Length');
  const factor = input.float(3.0, 'Factor', { step: 0.01 });

  const [, direction] = ta.supertrend(factor, atrPeriod);
  const change = ta.change(direction);

  strategy.eachBar((c) => {
    if (lt(c.get(change), 0)) strategy.entry('My Long Entry Id', strategy.long);
    if (gt(c.get(change), 0)) strategy.entry('My Short Entry Id', strategy.short);
  });
}

export const supertrend: ScriptStrategy = {
  key: 'supertrend',
  source: { id: 'STD;Supertrend%Strategy', name: 'Supertrend strategy', author: '' },
  body,
};
