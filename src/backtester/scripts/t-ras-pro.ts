/** Trend Reversal Alerts Strategy [4H/3M] (sequentialvision): candle body ratio, long only. */
import { compare } from 'oakscriptjs';
import { close, eachBar, input, plot, strategy } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Trend Reversal Alerts Strategy PRO by @nocachy', {
    shorttitle: 'T-RAS-PRO',
    overlay: false,
    // Pine v6 defaults of the reference app for what the source does not declare (oakscriptjs 0.8.0 has v5 values).
    initial_capital: 100000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
  });

  const delta = input.float(1, 'Delta', { minval: 0.01, maxval: 1, step: 0.01 });
  const buyResistance = input.float(0, 'Buy Resistance', { minval: 0, maxval: 10, step: 0.01 });
  const sellResistance = input.float(0, 'Sell Resistance', { minval: -10, maxval: 10, step: 0.01 });

  const resistance = eachBar((c) => {
    const topSource = gt(c.close, c.open) ? c.close : c.open;
    const bottomSource = lt(c.close, c.open) ? c.close : c.open;
    const bodySize = c.high - c.low;
    const spirit = topSource - bottomSource;
    // A doji (spirit 0) gives +/-Infinity: the reference takes the buy of such a bar (SPY 1h bar 12).
    const ratio = bodySize / spirit;
    return gt(c.open, c.close) ? -ratio : ratio;
  });

  const positionSize = strategy.eachBar((c) => {
    const close1 = c.get(close, 1);
    const close2 = c.get(close, 2);
    const r = c.get(resistance);
    const buySignal = gt(close1 * delta, close2) && gt(c.close * delta, close1) && gt(r, buyResistance);
    const sellSignal = lt(close1 * (2 - delta), close2) && lt(c.close * (2 - delta), close1) && lt(r, sellResistance);
    if (buySignal) strategy.entry('buy', strategy.long);
    if (sellSignal) strategy.close('buy');
    return strategy.position_size;
  });
  plot(positionSize, 'Plot');
}

export const tRasPro: ScriptStrategy = {
  key: 't-ras-pro',
  source: { id: 'PUB;YYoXIgjwHL4SJn6Sk9DAudZrqt1DTz23', name: 'Trend Reversal Alerts Strategy [4H/3M]', author: 'sequentialvision' },
  body,
};
