/** Four WMA Strategy with TP and SL (rosedenvy): two MA crosses, exit bracket from the average price. */
import { compare } from 'oakscriptjs';
import type { Series } from 'oakscriptjs';
import { close, color, input, plot, strategy, ta, volume } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { lt } = compare;

function ma(source: Series, length: number, type: string): Series {
  switch (type) {
    case 'SMA':
      return ta.sma(source, length);
    case 'EMA':
      return ta.ema(source, length);
    case 'WMA':
      return ta.wma(source, length);
    case 'VWMA':
      return ta.vwma(source, length, volume);
    default:
      return ta.rma(source, length);
  }
}

function body(): void {
  strategy('Four MA Strategy with TP and SL', {
    shorttitle: '4MA TP/SL',
    overlay: true,
  });

  const longM1 = input.int(10, 'Long MA1');
  const longM2 = input.int(20, 'Long MA2');
  const shortM1 = input.int(30, 'Short MA1');
  const shortM2 = input.int(40, 'Short MA2');
  const maTypeInput = input.string('WMA', 'Moving Average Type', { options: ['SMA', 'EMA', 'WMA', 'VWMA', 'RMA'] });
  const tpSlActive = input.bool(true, 'Enable TP and SL');
  const tpPercent = input.float(1.0, 'Take Profit %') / 100;
  const slPercent = input.float(1.0, 'Stop Loss %') / 100;
  const direction = input.string('Both', 'Trade Direction', { options: ['Long Only', 'Short Only', 'Both'] });
  const enableAltExit = input.bool(false, 'Enable Alternate Exit Condition');
  const altExitMaChoice = input.string('Long MA1', 'MA for Alternate Exit', {
    options: ['Long MA1', 'Long MA2', 'Short MA1', 'Short MA2'],
  });

  const longMA1 = ma(close, longM1, maTypeInput);
  const longMA2 = ma(close, longM2, maTypeInput);
  const shortMA1 = ma(close, shortM1, maTypeInput);
  const shortMA2 = ma(close, shortM2, maTypeInput);

  const altExitMa =
    altExitMaChoice === 'Long MA1'
      ? longMA1
      : altExitMaChoice === 'Long MA2'
        ? longMA2
        : altExitMaChoice === 'Short MA1'
          ? shortMA1
          : shortMA2;

  const longCondition = ta.crossover(longMA1, longMA2);
  const longExitCondition = ta.crossunder(longMA1, longMA2);
  const shortCondition = ta.crossunder(shortMA1, shortMA2);
  const shortExitCondition = ta.crossover(shortMA1, shortMA2);

  strategy.eachBar((c) => {
    const priceCrossAltExit = lt(c.close, c.get(altExitMa));
    if (direction === 'Both' || direction === 'Long Only') {
      if (c.get(longCondition) === 1) strategy.entry('Long', strategy.long, { comment: '' });
      if (tpSlActive) {
        const avg = strategy.position_avg_price;
        strategy.exit('Long TP/SL', { from_entry: 'Long', limit: avg * (1 + tpPercent), stop: avg * (1 - slPercent) });
      }
      if (c.get(longExitCondition) === 1 || (enableAltExit && priceCrossAltExit)) strategy.close('Long', { comment: '' });
    }
    if (direction === 'Both' || direction === 'Short Only') {
      if (c.get(shortCondition) === 1) strategy.entry('Short', strategy.short, { comment: 'Short entry' });
      if (tpSlActive) {
        const avg = strategy.position_avg_price;
        strategy.exit('Short TP/SL', { from_entry: 'Short', limit: avg * (1 - tpPercent), stop: avg * (1 + slPercent) });
      }
      if (c.get(shortExitCondition) === 1 || (enableAltExit && priceCrossAltExit)) {
        strategy.close('Short', { comment: 'Short Exit' });
      }
    }
  });

  plot(longMA1, 'Long MA1', { color: color.blue });
  plot(longMA2, 'Long MA2', { color: color.orange });
  plot(shortMA1, 'Short MA1', { color: color.red });
  plot(shortMA2, 'Short MA2', { color: color.purple });
}

export const fourWmaTpSl: ScriptStrategy = {
  key: 'four-wma-tp-sl',
  source: { id: 'PUB;e0d7d8e8c78f4fed8098915d24e52560', name: 'Four WMA Strategy with TP and SL', author: 'rosedenvy' },
  body,
};
