/** Bollinger + RSI, Double Strategy (by ChartArt) v1.1: a stop entry at the band when the close crosses back inside it
 *  and RSI crosses 50 on the same bar; each entry reverses the other (Pine v2 source, its defaults: 100,000, 1 contract
 *  per order, no margin). The community's Backtests post of it opens here. */
import { close, input, plot, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

function body(): void {
  strategy('Bollinger + RSI, Double Strategy (by ChartArt) v1.1', {
    shorttitle: 'CA_-_RSI_Bol_Strat_1.1',
    overlay: true,
    initial_capital: 100000,
    default_qty_type: strategy.fixed,
    default_qty_value: 1,
    margin_long: 0,
    margin_short: 0,
  });

  const rsiLength = input.int(6, 'RSI Period Length');
  const bbLength = input.int(200, 'Bollinger Period Length', { minval: 1 });

  const vrsi = ta.rsi(close, rsiLength);
  const basis = ta.sma(close, bbLength);
  const dev = ta.stdev(close, bbLength).mul(2);
  const upper = basis.add(dev);
  const lower = basis.sub(dev);
  const rsiUp = ta.crossover(vrsi, 50);
  const priceUp = ta.crossover(close, lower);
  const rsiDown = ta.crossunder(vrsi, 50);
  const priceDown = ta.crossunder(close, upper);

  plot(basis, 'Basis');
  plot(upper, 'Upper');
  plot(lower, 'Lower');

  strategy.eachBar((c) => {
    if (Number.isNaN(c.get(vrsi))) return;
    if (c.get(rsiUp) && c.get(priceUp)) strategy.entry('RSI_BB_L', strategy.long, { stop: c.get(lower) });
    else strategy.cancel('RSI_BB_L');
    if (c.get(rsiDown) && c.get(priceDown)) strategy.entry('RSI_BB_S', strategy.short, { stop: c.get(upper) });
    else strategy.cancel('RSI_BB_S');
  });
}

export const chartartBbRsi: ScriptStrategy = {
  key: 'chartart-bb-rsi',
  source: { id: 'PUB;2187', name: 'Bollinger + RSI, Double Strategy (by ChartArt) v1.1', author: 'ChartArt' },
  body,
};
