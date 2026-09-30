/** Bollinger Bands Mean Reversion using RSI (thechadyogi): strategy.order sized from the net profit, stacked positions. */
import { compare } from 'oakscriptjs';
import { close, fill, input, math, plot, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, le, lt } = compare;

function body(): void {
  strategy('Peri Bollinger Mean Reversion V2', {
    overlay: true,
    // Pine v6 defaults of the reference app for what the source does not declare (oakscriptjs 0.8.0 has v5 values).
    initial_capital: 100000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
  });

  const source = input.source('close', 'Source');
  const length = input.int(20, 'BB Length', { minval: 1 });
  const mult = input.float(2.0, 'BB Multiplier', { minval: 0.001, maxval: 50.0 });
  const rsiOversold = input.int(30, 'RSI Oversold Level', { minval: 1, maxval: 50 });
  const rsiOverbought = input.int(70, 'RSI Overbought Level', { minval: 50, maxval: 99 });

  const basis = ta.sma(source, length);
  const dev = ta.stdev(source, length).mul(mult);
  const upper = basis.add(dev);
  const lower = basis.sub(dev);
  const strength = ta.rsi(close, 14);

  plot(basis, 'Middle BB');
  const p1 = plot(upper, 'Upper BB');
  const p2 = plot(lower, 'Lower BB');
  fill(p1, p2);

  strategy.eachBar((c) => {
    const amount = 0.1 * (strategy.initial_capital + strategy.netprofit);
    const units = math.floor(amount / c.close);
    const rsi = c.get(strength);
    const up = c.get(upper);
    const lo = c.get(lower);
    if (lt(c.close, lo) && lt(rsi, rsiOversold) && lt(strategy.position_size, units * 5)) {
      strategy.order('Long', strategy.long, { qty: units });
    }
    if (gt(c.close, up) && gt(rsi, 50) && gt(strategy.position_size, 0)) strategy.close('Long', { comment: 'Close Long' });
    if (gt(c.close, up) && gt(rsi, rsiOverbought) && gt(strategy.position_size, -units * 5)) {
      strategy.order('Short', strategy.short, { qty: units });
    }
    if (lt(strategy.position_size, 0) && le(c.close, c.get(basis))) strategy.close('Short', { comment: 'Close Short' });
  });
}

export const bbMeanReversion: ScriptStrategy = {
  key: 'bb-mean-reversion',
  source: { id: 'PUB;99f259d6c6cd40bcbd24b4efb48e7765', name: 'Bollinger Bands Mean Reversion using RSI [Krishna Peri]', author: 'thechadyogi' },
  body,
};
