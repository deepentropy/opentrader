/** Volatility expansion-close strategy (built-in): stop entries at the close plus / minus a multiple of the average
 *  true range. */
import { close, input, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

function body(): void {
  strategy('Volatility expansion-close strategy', { shorttitle: 'Volatility exp-close str', overlay: true });

  const length = input.int(5, 'Length');
  const numATRs = input.float(0.75, 'ATR Mult');

  const atrs = ta.sma(ta.tr(), length).mul(numATRs);

  strategy.eachBar((c) => {
    if (!Number.isNaN(c.get(close, length))) {
      strategy.entry('VltClsLE', strategy.long, { stop: c.close + c.get(atrs), comment: 'VltClsLE' });
      strategy.entry('VltClsSE', strategy.short, { stop: c.close - c.get(atrs), comment: 'VltClsSE' });
    }
  });
}

export const voltyExpanClose: ScriptStrategy = {
  key: 'volty-expan-close',
  source: { id: 'STD;Volty%1Expan%1Close%1Strategy', name: 'Volatility expansion-close strategy', author: '' },
  body,
};
