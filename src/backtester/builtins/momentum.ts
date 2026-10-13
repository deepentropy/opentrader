/** Momentum strategy (built-in): while the momentum and its change are both positive (negative), a stop entry one
 *  tick beyond the bar's high (low). */
import { compare } from 'oakscriptjs';
import { close, input, strategy, syminfo } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Momentum strategy', { overlay: true });

  const length = input.int(12, 'length');

  const mom0 = close.sub(close.offset(length));
  const mom1 = mom0.sub(mom0.offset(1));

  strategy.eachBar((c) => {
    const m0 = c.get(mom0);
    const m1 = c.get(mom1);
    if (gt(m0, 0) && gt(m1, 0)) strategy.entry('MomLE', strategy.long, { stop: c.high + syminfo.mintick, comment: 'MomLE' });
    else strategy.cancel('MomLE');
    if (lt(m0, 0) && lt(m1, 0)) strategy.entry('MomSE', strategy.short, { stop: c.low - syminfo.mintick, comment: 'MomSE' });
    else strategy.cancel('MomSE');
  });
}

export const momentum: ScriptStrategy = {
  key: 'momentum',
  source: { id: 'STD;Momentum%1Strategy', name: 'Momentum strategy', author: '' },
  body,
};
