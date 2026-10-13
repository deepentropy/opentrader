/** Bar up/down strategy (built-in): long on an up bar that opens above the last close, short on a down bar that
 *  opens below it; 10 % of equity; trading stops for the day after the maximum intraday loss. */
import { compare } from 'oakscriptjs';
import { close, input, strategy } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Bar up/down strategy', {
    shorttitle: 'Bar up/dn str',
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 10,
  });

  const maxIdLossPcnt = input.float(1, 'Max intraday loss (%)');

  strategy.eachBar((c) => {
    strategy.risk.max_intraday_loss(maxIdLossPcnt, strategy.percent_of_equity);
    const close1 = c.get(close, 1);
    if (gt(c.close, c.open) && gt(c.open, close1)) strategy.entry('BarUp', strategy.long);
    if (lt(c.close, c.open) && lt(c.open, close1)) strategy.entry('BarDn', strategy.short);
  });
}

export const barUpDn: ScriptStrategy = {
  key: 'bar-up-dn',
  source: { id: 'STD;Bars%1Up%1Dn%1Strategy', name: 'Bar up/down strategy', author: '' },
  body,
};
