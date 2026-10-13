/** Pivot extension and Pivot reversal strategies (built-in). */
import { compare } from 'oakscriptjs';
import { eachBar, input, nz, strategy, syminfo, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

/** Pivot extension: a market entry when a pivot low (long) or pivot high (short) is confirmed. */
function extensionBody(): void {
  strategy('Pivot extension strategy', { overlay: true });

  const leftBars = input.int(4, 'Pivot Lookback Left');
  const rightBars = input.int(2, 'Pivot Lookback Right');

  const ph = ta.pivothigh(leftBars, rightBars);
  const pl = ta.pivotlow(leftBars, rightBars);

  strategy.eachBar((c) => {
    if (!Number.isNaN(c.get(pl))) strategy.entry('PivExtLE', strategy.long, { comment: 'PivExtLE' });
    if (!Number.isNaN(c.get(ph))) strategy.entry('PivExtSE', strategy.short, { comment: 'PivExtSE' });
  });
}

/** Pivot reversal: a stop entry one tick beyond the last pivot high (long) / pivot low (short) until the price
 *  passes it. */
function reversalBody(): void {
  strategy('Pivot reversal strategy', { overlay: true });

  const leftBars = input.int(4, 'Pivot Lookback Left');
  const rightBars = input.int(2, 'Pivot Lookback Right');

  const swh = ta.pivothigh(leftBars, rightBars);
  const swl = ta.pivotlow(leftBars, rightBars);
  const hprice = eachBar((c) => (Number.isNaN(c.get(swh)) ? nz(c.prev(), 0) : c.get(swh)));
  const le = eachBar((c) => {
    if (!Number.isNaN(c.get(swh))) return 1;
    const prev = nz(c.prev(), 0);
    return prev === 1 && gt(c.high, c.get(hprice)) ? 0 : prev;
  });
  const lprice = eachBar((c) => (Number.isNaN(c.get(swl)) ? nz(c.prev(), 0) : c.get(swl)));
  const se = eachBar((c) => {
    if (!Number.isNaN(c.get(swl))) return 1;
    const prev = nz(c.prev(), 0);
    return prev === 1 && lt(c.low, c.get(lprice)) ? 0 : prev;
  });

  strategy.eachBar((c) => {
    if (c.get(le) === 1) strategy.entry('PivRevLE', strategy.long, { comment: 'PivRevLE', stop: c.get(hprice) + syminfo.mintick });
    if (c.get(se) === 1) strategy.entry('PivRevSE', strategy.short, { comment: 'PivRevSE', stop: c.get(lprice) - syminfo.mintick });
  });
}

export const pivotExtension: ScriptStrategy = {
  key: 'pivot-extension',
  source: { id: 'STD;Pivot%1Extension%1Strategy', name: 'Pivot extension strategy', author: '' },
  body: extensionBody,
};

export const pivotReversal: ScriptStrategy = {
  key: 'pivot-reversal',
  source: { id: 'STD;Pivot%1Reversal%1Strategy', name: 'Pivot reversal strategy', author: '' },
  body: reversalBody,
};
