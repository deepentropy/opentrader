/** RSI Mean Reversion (kparicharak92615): RSI crosses back out of the extreme zones, close then reverse. */
import { compare } from 'oakscriptjs';
import { barstate, bgcolor, close, color, high, input, low, plotshape, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('RSI Mean Reversion', {
    shorttitle: 'RSI MR',
    overlay: true,
    initial_capital: 200000,
    default_qty_type: strategy.fixed,
    default_qty_value: 2,
    commission_type: strategy.commission.cash_per_order,
    commission_value: 40,
  });

  const rsiGroup = { group: 'RSI Settings' };
  const rsiLength = input.int(3, 'RSI Period', { minval: 1, maxval: 50, ...rsiGroup });
  const oversold = input.int(40, 'Oversold Level', { minval: 5, maxval: 49, ...rsiGroup });
  const overbought = input.int(70, 'Overbought Level', { minval: 51, maxval: 95, ...rsiGroup });

  const stratGroup = { group: 'Strategy' };
  const tradeDirection = input.string('Both', 'Trade Direction', { options: ['Long Only', 'Short Only', 'Both'], ...stratGroup });
  const awaitBarConfirmation = input.bool(true, 'Await Bar Confirmation', stratGroup);

  const visualGroup = { group: 'Visuals' };
  const showSignals = input.bool(true, 'Show Buy/Sell Labels', visualGroup);
  const showRSIPanel = input.bool(true, 'Show RSI Background Shading', visualGroup);

  const rsi = ta.rsi(close, rsiLength);
  const longSignal = ta.crossover(rsi, oversold);
  const shortSignal = ta.crossunder(rsi, overbought);

  const longColor = color.green;
  const shortColor = color.red;
  const rsiValues = rsi.toArray();
  bgcolor(
    rsiValues.map((r) => (showRSIPanel && lt(r, oversold) ? color.new(longColor, 90) : undefined)),
    { title: 'Oversold Zone' },
  );
  bgcolor(
    rsiValues.map((r) => (showRSIPanel && gt(r, overbought) ? color.new(shortColor, 90) : undefined)),
    { title: 'Overbought Zone' },
  );

  plotshape(longSignal.and(showSignals ? 1 : 0).iff(low, NaN), 'Buy Signal', {
    text: 'Buy',
    location: 'belowbar',
    style: 'labelup',
    size: 'small',
    color: longColor,
    textcolor: color.white,
  });
  plotshape(shortSignal.and(showSignals ? 1 : 0).iff(high, NaN), 'Sell Signal', {
    text: 'Sell',
    location: 'abovebar',
    style: 'labeldown',
    size: 'small',
    color: shortColor,
    textcolor: color.white,
  });

  const confirmed = awaitBarConfirmation ? barstate.isconfirmed : null;
  const canLong = tradeDirection === 'Long Only' || tradeDirection === 'Both';
  const canShort = tradeDirection === 'Short Only' || tradeDirection === 'Both';

  strategy.eachBar((c) => {
    const wait = confirmed === null || c.get(confirmed) === 1;
    if (c.get(longSignal) === 1 && wait) {
      if (canShort) strategy.close('Short');
      if (canLong) strategy.entry('Long', strategy.long);
    }
    if (c.get(shortSignal) === 1 && wait) {
      if (canLong) strategy.close('Long');
      if (canShort) strategy.entry('Short', strategy.short);
    }
  });
}

export const rsiMeanReversion: ScriptStrategy = {
  key: 'rsi-mean-reversion',
  source: { id: 'PUB;b4b90c5e98224e1b82bb49cc03919f16', name: 'RSI Mean Reversion', author: 'kparicharak92615' },
  body,
};
