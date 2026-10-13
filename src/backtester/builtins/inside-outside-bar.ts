/** Inside bar and Outside bar strategies (built-in): a market entry in the direction of an inside / outside bar. */
import { compare } from 'oakscriptjs';
import { high, low, strategy } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function insideBody(): void {
  strategy('Inside bar strategy', { overlay: true });

  strategy.eachBar((c) => {
    if (lt(c.high, c.get(high, 1)) && gt(c.low, c.get(low, 1))) {
      if (gt(c.close, c.open)) strategy.entry('InsBarLE', strategy.long, { comment: 'InsBarLE' });
      if (lt(c.close, c.open)) strategy.entry('InsBarSE', strategy.short, { comment: 'InsBarSE' });
    }
  });
}

function outsideBody(): void {
  strategy('Outside bar strategy', { overlay: true });

  strategy.eachBar((c) => {
    if (gt(c.high, c.get(high, 1)) && lt(c.low, c.get(low, 1))) {
      if (gt(c.close, c.open)) strategy.entry('OutBarLE', strategy.long, { comment: 'OutBarLE' });
      if (lt(c.close, c.open)) strategy.entry('OutBarSE', strategy.short, { comment: 'OutBarSE' });
    }
  });
}

export const insideBar: ScriptStrategy = {
  key: 'inside-bar',
  source: { id: 'STD;InSide%1Bar%1Strategy', name: 'Inside bar strategy', author: '' },
  body: insideBody,
};

export const outsideBar: ScriptStrategy = {
  key: 'outside-bar',
  source: { id: 'STD;OutSide%1Bar%1Strategy', name: 'Outside bar strategy', author: '' },
  body: outsideBody,
};
