/** Consecutive up/down strategy (built-in): long after N closes up in a row, short after N closes down. */
import { compare } from 'oakscriptjs';
import { close, eachBar, input, nz, strategy } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Consecutive up/down strategy', { shorttitle: 'Consecutive up/dn str', overlay: true });

  const consecutiveBarsUp = input.int(3, 'Consecutive bars up');
  const consecutiveBarsDown = input.int(3, 'Consecutive bars down');

  const ups = eachBar((c) => (gt(c.close, c.get(close, 1)) ? nz(c.prev(), 0) + 1 : 0));
  const dns = eachBar((c) => (lt(c.close, c.get(close, 1)) ? nz(c.prev(), 0) + 1 : 0));

  strategy.eachBar((c) => {
    if (c.get(ups) >= consecutiveBarsUp) strategy.entry('ConsUpLE', strategy.long, { comment: 'ConsUpLE' });
    // The original's short entry carries the long entry's comment.
    if (c.get(dns) >= consecutiveBarsDown) strategy.entry('ConsDnSE', strategy.short, { comment: 'ConsUpLE' });
  });
}

export const consecutiveUpDown: ScriptStrategy = {
  key: 'consecutive-up-down',
  source: { id: 'STD;Consecutive%1Ups%1Downs%1Strategy', name: 'Consecutive up/down strategy', author: '' },
  body,
};
