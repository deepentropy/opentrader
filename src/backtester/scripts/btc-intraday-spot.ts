/** BTC Intraday Advanced Spot PRO V6 (rogernina): EMA cross + RSI entries, half out at TP1, TP2, break even stop. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, input, plot, plotshape, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('BTC Intraday Advanced Spot PRO V6', {
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
    calc_on_every_tick: true,
  });

  const emaFastLen = input.int(21, 'EMA Rapide');
  const emaSlowLen = input.int(50, 'EMA Lente');
  const rsiLen = input.int(14, 'RSI Length');
  const rsiBuy = input.int(55, 'RSI Seuil Buy');
  const rsiSell = input.int(45, 'RSI Seuil Sell');

  const slPerc = input.float(0.5, 'Stop Loss %') / 100;
  const tp1Perc = input.float(0.7, 'Take Profit 1 %') / 100;
  const tp2Perc = input.float(1.5, 'Take Profit 2 %') / 100;
  const useBE = input.bool(true, 'Activer Break Even');

  const emaFast = ta.ema(close, emaFastLen);
  const emaSlow = ta.ema(close, emaSlowLen);
  const rsiVal = ta.rsi(close, rsiLen);

  const crossUp = ta.crossover(emaFast, emaSlow);
  const crossDown = ta.crossunder(emaFast, emaSlow);
  const longCondition = eachBar((c) => c.get(crossUp) === 1 && gt(c.get(rsiVal), rsiBuy));
  const shortCondition = eachBar((c) => c.get(crossDown) === 1 && lt(c.get(rsiVal), rsiSell));

  strategy.eachBar((c) => {
    const avg = strategy.position_avg_price;
    const longSL = avg * (1 - slPerc);
    const longTP1 = avg * (1 + tp1Perc);
    const longTP2 = avg * (1 + tp2Perc);
    const shortSL = avg * (1 + slPerc);
    const shortTP1 = avg * (1 - tp1Perc);
    const shortTP2 = avg * (1 - tp2Perc);

    if (c.get(longCondition) === 1) strategy.entry('BUY', strategy.long);
    if (c.get(shortCondition) === 1) strategy.entry('SELL', strategy.short);

    if (gt(strategy.position_size, 0)) {
      strategy.exit('TP1 Long', { from_entry: 'BUY', qty_percent: 50, limit: longTP1, stop: longSL });
      strategy.exit('TP2 Long', { from_entry: 'BUY', limit: longTP2 });
      if (useBE && gt(c.close, longTP1)) strategy.exit('BE Long', { from_entry: 'BUY', stop: strategy.position_avg_price });
    }

    if (lt(strategy.position_size, 0)) {
      strategy.exit('TP1 Short', { from_entry: 'SELL', qty_percent: 50, limit: shortTP1, stop: shortSL });
      strategy.exit('TP2 Short', { from_entry: 'SELL', limit: shortTP2 });
      if (useBE && lt(c.close, shortTP1)) strategy.exit('BE Short', { from_entry: 'SELL', stop: strategy.position_avg_price });
    }
  });

  plot(emaFast, 'EMA 21', { color: color.orange });
  plot(emaSlow, 'EMA 50', { color: color.blue });
  plotshape(longCondition, 'Signal BUY', { location: 'belowbar', color: color.green, style: 'labelup', text: 'BUY' });
  plotshape(shortCondition, 'Signal SELL', { location: 'abovebar', color: color.red, style: 'labeldown', text: 'SELL' });
}

export const btcIntradaySpot: ScriptStrategy = {
  key: 'btc-intraday-spot',
  source: { id: 'PUB;170aee6f2e5149f2ad7c7488cf84e199', name: 'BTC Intraday Advanced Spot PRO V6', author: 'rogernina' },
  body,
};
