/** Bollinger Bands strategy and Bollinger Bands strategy directed (built-in): a close crossing back inside a band
 *  places a stop entry at that band, the two entries in one OCA group; the directed one allows one side only. */
import { close, input, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

function run(direction: number | null): void {
  const length = input.int(20, 'length', { minval: 1 });
  const mult = input.float(2.0, 'mult', { minval: 0.001, maxval: 50 });
  const dir = direction === null ? 0 : input.int(0, 'Strategy Direction', { minval: -1, maxval: 1 });

  const basis = ta.sma(close, length);
  const dev = ta.stdev(close, length).mul(mult);
  const upper = basis.add(dev);
  const lower = basis.sub(dev);
  const buyEntry = ta.crossover(close, lower);
  const sellEntry = ta.crossunder(close, upper);

  strategy.eachBar((c) => {
    if (direction !== null) {
      strategy.risk.allow_entry_in(dir === 0 ? strategy.direction.all : dir < 0 ? strategy.direction.short : strategy.direction.long);
    }
    if (c.get(buyEntry)) {
      strategy.entry('BBandLE', strategy.long, { stop: c.get(lower), oca_name: 'BollingerBands', oca_type: strategy.oca.cancel, comment: 'BBandLE' });
    } else strategy.cancel('BBandLE');
    if (c.get(sellEntry)) {
      strategy.entry('BBandSE', strategy.short, { stop: c.get(upper), oca_name: 'BollingerBands', oca_type: strategy.oca.cancel, comment: 'BBandSE' });
    } else strategy.cancel('BBandSE');
  });
}

function bandsBody(): void {
  strategy('Bollinger Bands strategy', { shorttitle: 'Bollinger Bands str', overlay: true });
  run(null);
}

function directedBody(): void {
  strategy('Bollinger Bands strategy directed', { shorttitle: 'Bollinger Bands str directed', overlay: true });
  run(0);
}

export const bollingerBands: ScriptStrategy = {
  key: 'bollinger-bands',
  source: { id: 'STD;Bollinger%1Bands%1Strategy', name: 'Bollinger Bands strategy', author: '' },
  body: bandsBody,
};

export const bollingerBandsDirected: ScriptStrategy = {
  key: 'bollinger-bands-directed',
  source: { id: 'STD;Bollinger%1Band%1Directed%1Strategy', name: 'Bollinger Bands strategy directed', author: '' },
  body: directedBody,
};
