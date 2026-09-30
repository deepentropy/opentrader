/** Buy&Sell Bullish Engulfing (thequantscience): limit entry, exits when the equity crosses a target. */
import { callsite, compare } from 'oakscriptjs';
import { bgcolor, close, color, eachBar, input, open, plotshape, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';
import { colorNew, colorRgb } from './colors';

const { ge, gt, le, lt } = compare;

function body(): void {
  strategy('Buy&Sell Bullish Engulfing Strategy [The Quant Science]', {
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
    pyramiding: 1,
    currency: 'USDT',
    initial_capital: 10000,
    commission_type: strategy.commission.percent,
    commission_value: 0.07,
    process_orders_on_close: true,
    close_entries_rule: 'ANY',
  });

  const profit = input.float(2.0, 'Target profit [%]', { minval: 0, step: 0.1 });
  const stoploss = input.float(2.0, 'Stop Loss [%]', { minval: 0, step: 0.1 });
  const ordersSize = input.float(30.0, 'Position Order Size [%]', { minval: 0.1, maxval: 100, step: 0.1 });
  const showBg = input.bool(true, 'Highlight Pattern Background');
  const colorBull = input.color(colorRgb(59, 255, 69), 'Color: Bullish Signal');
  const colorBg = input.color(colorNew(colorRgb(59, 255, 69), 85), 'Background Color Pattern');

  const equityTrades = strategy.initial_capital;

  const trendRule1 = 'SMA50';
  const trendRule2 = 'SMA50, SMA200';
  const trendRule = input.string(trendRule1, 'Detect Trends Based On', { options: [trendRule1, trendRule2, 'No detection'] });
  const sma50 = trendRule !== 'No detection' ? ta.sma(close, 50) : undefined;
  const sma200 = trendRule === trendRule2 ? ta.sma(close, 200) : undefined;

  const cLen = 14;
  const cBody = eachBar((c) => Math.max(c.close, c.open) - Math.min(c.close, c.open));
  const cBodyAvg = ta.ema(cBody, cLen);

  let equity = 0;
  let oPrice = 0;
  let cExit = 0;
  let cStopl = 0;
  const tpCross = callsite.crossover();
  const slCross = callsite.crossunder();
  const signals: number[] = [];
  strategy.eachBar((c) => {
    const qtyOrder = (equityTrades * ordersSize) / 100 / c.close;
    let downTrend = true;
    if (trendRule === trendRule1) {
      downTrend = lt(c.close, c.get(sma50!));
    } else if (trendRule === trendRule2) {
      const s50 = c.get(sma50!);
      downTrend = lt(c.close, s50) && lt(s50, c.get(sma200!));
    }
    const bodyNow = c.get(cBody);
    const bodyPrev = c.get(cBody, 1);
    const open1 = c.get(open, 1);
    const close1 = c.get(close, 1);
    const longBody = gt(bodyNow, c.get(cBodyAvg));
    const whiteBody = lt(c.open, c.close);
    const blackBodyPrev = gt(open1, close1);
    const smallBodyPrev = lt(bodyPrev, c.get(cBodyAvg, 1));
    const engulfing =
      downTrend &&
      whiteBody &&
      longBody &&
      blackBodyPrev &&
      smallBodyPrev &&
      ge(c.close, open1) &&
      le(c.open, close1) &&
      (gt(c.close, open1) || lt(c.open, close1));

    const noTrade = strategy.opentrades === 0;
    if (engulfing && noTrade) {
      equity = strategy.equity;
      oPrice = c.close;
      cExit = equity + (equity * profit) / 100;
      cStopl = equity - (equity * stoploss) / 100;
      strategy.entry('#ENTRY', strategy.long, { qty: qtyOrder, limit: oPrice });
    }
    if (tpCross(strategy.equity, cExit)) strategy.exit('#TP', { from_entry: '#ENTRY', limit: c.close });
    if (slCross(strategy.equity, cStopl)) strategy.exit('#SL', { from_entry: '#ENTRY', limit: c.close });
    signals.push(engulfing && noTrade ? 1 : 0);
  });

  const signal = seriesOf(signals);
  plotshape(signal, 'Bullish Engulfing Detection', { style: 'triangledown', location: 'abovebar', color: colorBull, size: 'tiny', text: 'BULLISH ENGULFING', textcolor: colorBull });
  if (showBg) bgcolor(color.when(signal, colorBg));
}

export const bullishEngulfing: ScriptStrategy = {
  key: 'bullish-engulfing',
  source: { id: 'PUB;5567e83af3be4e7087b78cd9ffb1a5df', name: 'Buy&Sell Bullish Engulfing - The Quant Science', author: 'thequantscience' },
  body,
};
