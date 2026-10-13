/** Channel breakout strategy (built-in): stop entries one tick beyond the highest high / lowest low of `length` bars. */
import { close, high, input, low, strategy, syminfo, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

function body(): void {
  strategy('Channel breakout strategy', { shorttitle: 'Channel break str', overlay: true });

  const length = input.int(5, 'Length', { minval: 1, maxval: 1000 });

  const upBound = ta.highest(high, length);
  const downBound = ta.lowest(low, length);

  strategy.eachBar((c) => {
    if (!Number.isNaN(c.get(close, length))) {
      strategy.entry('ChBrkLE', strategy.long, { stop: c.get(upBound) + syminfo.mintick, comment: 'ChBrkLE' });
    }
    strategy.entry('ChBrkSE', strategy.short, { stop: c.get(downBound) - syminfo.mintick, comment: 'ChBrkSE' });
  });
}

export const channelBreakout: ScriptStrategy = {
  key: 'channel-breakout',
  source: { id: 'STD;Channel%1BreakOut%1Strategy', name: 'Channel breakout strategy', author: '' },
  body,
};
