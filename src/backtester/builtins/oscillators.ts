/** RSI strategy and Stochastic slow strategy (built-in): oscillator crosses out of the oversold / overbought zones. */
import { compare } from 'oakscriptjs';
import { close, high, input, low, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

/** RSI strategy: long when the RSI crosses above the oversold level, short when it crosses below the overbought one. */
function rsiBody(): void {
  strategy('RSI strategy', { shorttitle: 'RSI str', overlay: true });

  const length = input.int(14, 'Length');
  const overSold = input.int(30, 'Oversold');
  const overBought = input.int(70, 'Overbought');

  const vrsi = ta.rsi(close, length);
  const co = ta.crossover(vrsi, overSold);
  const cu = ta.crossunder(vrsi, overBought);

  strategy.eachBar((c) => {
    if (!Number.isNaN(c.get(vrsi))) {
      if (c.get(co)) strategy.entry('RsiLE', strategy.long, { comment: 'RsiLE' });
      if (c.get(cu)) strategy.entry('RsiSE', strategy.short, { comment: 'RsiSE' });
    }
  });
}

/** Stochastic slow strategy: %K crossing %D below the oversold level (long) or above the overbought one (short). */
function stochBody(): void {
  strategy('Stochastic slow strategy', { shorttitle: 'Stoch slow str', overlay: true });

  const length = input.int(14, 'Length', { minval: 1 });
  const overBought = input.int(80, 'Overbought');
  const overSold = input.int(20, 'Oversold');
  const smoothK = 3;
  const smoothD = 3;

  const k = ta.sma(ta.stoch(close, high, low, length), smoothK);
  const d = ta.sma(k, smoothD);
  const co = ta.crossover(k, d);
  const cu = ta.crossunder(k, d);

  strategy.eachBar((c) => {
    const kv = c.get(k);
    if (!Number.isNaN(kv) && !Number.isNaN(c.get(d))) {
      if (c.get(co) && lt(kv, overSold)) strategy.entry('StochLE', strategy.long, { comment: 'StochLE' });
      if (c.get(cu) && gt(kv, overBought)) strategy.entry('StochSE', strategy.short, { comment: 'StochSE' });
    }
  });
}

export const rsi: ScriptStrategy = {
  key: 'rsi',
  source: { id: 'STD;RSI%1Strategy', name: 'RSI strategy', author: '' },
  body: rsiBody,
};

export const stochasticSlow: ScriptStrategy = {
  key: 'stochastic-slow',
  source: { id: 'STD;Stochastic%1Slow%1Strategy', name: 'Stochastic slow strategy', author: '' },
  body: stochBody,
};
