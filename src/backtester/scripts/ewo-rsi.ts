/** EWO, RSI advanced Signals Strategy - Exhaustion Filter (Pridarasx): MFI, breakout barrier, reversal entries. */
import { compare } from 'oakscriptjs';
import { close, color, high, hl2, hlc3, input, plot, plotshape, seriesOf, strategy, ta, volume } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('EWO,RSI advanced Signals Strategy - Exhaustion Filter[Pridarasx]', {
    overlay: true,
    initial_capital: 10000,
    currency: 'USD',
  });

  const ewoFast = input.int(5, 'EWO Fast');
  const ewoSlow = input.int(34, 'EWO Slow');
  const rsiLen = input.int(14, 'RSI Length');
  const mfiLen = input.int(14, 'MFI Length');
  const volMaLen = input.int(20, 'Volume MA Length');
  const lookbackLen = input.int(10, 'Breakout Lookback Bars', {
    tooltip: 'Requires price to break the highest high of this many bars before buying to avoid falling knives.',
  });
  const rsiOversold = input.int(30, 'Exhaustion RSI Level', { tooltip: 'The deep oversold level that triggers a potential trend reset zone.' });
  // Alert inputs: a backtest sends no alerts.
  const alerts = { group: 'Alert Settings' };
  input.bool(true, 'Alert: Pre-Buy Signal', alerts);
  input.bool(true, 'Alert: BUY NOW Signal', alerts);
  input.bool(true, 'Alert: Pre-Sell Signal', alerts);
  input.bool(true, 'Alert: SELL NOW Signal', alerts);
  input.bool(true, 'Alert: Strategy Entry', alerts);
  input.bool(true, 'Alert: Strategy Exit', alerts);

  const ewo = ta.sma(hl2, ewoFast).sub(ta.sma(hl2, ewoSlow));
  const rsi = ta.rsi(close, rsiLen);
  const mfi = ta.mfi(hlc3, mfiLen);
  const volMa = ta.sma(volume, volMaLen);
  const barrier = ta.highest(high, lookbackLen);
  const rsiUp = ta.crossover(rsi, 40);
  const rsiDown = ta.crossunder(rsi, 60);

  let oversoldZone = false;
  let lastSignal = 0; // 1 = Buy, -1 = Sell
  const barrierPlot: number[] = [];
  const preBuy: number[] = [];
  const preSell: number[] = [];
  const buySignals: number[] = [];
  const sellSignals: number[] = [];
  strategy.eachBar((c) => {
    const r = c.get(rsi);
    const e = c.get(ewo);
    const e1 = c.get(ewo, 1);
    const volOk = gt(c.volume, c.get(volMa) * 0.8);
    if (lt(r, rsiOversold)) oversoldZone = true;
    const breakoutBarrier = c.get(barrier, 1);
    const priceBreakingOut = gt(c.close, breakoutBarrier);
    const rawBuy = c.get(rsiUp) === 1 && gt(c.get(mfi), 30) && gt(e, e1) && volOk && (priceBreakingOut || oversoldZone);
    const rawSell = c.get(rsiDown) === 1 && lt(c.get(mfi), 70) && lt(e, e1) && volOk;
    if (rawBuy) oversoldZone = false;
    let buySignal = false;
    let sellSignal = false;
    if (rawBuy && lastSignal !== 1) {
      buySignal = true;
      lastSignal = 1;
    }
    if (rawSell && lastSignal !== -1) {
      sellSignal = true;
      lastSignal = -1;
    }
    if (buySignal) strategy.entry('Long', strategy.long);
    if (sellSignal) strategy.entry('Short', strategy.short);

    barrierPlot.push(priceBreakingOut ? NaN : breakoutBarrier);
    preBuy.push(lt(r, 40) && gt(e, e1) && lt(e, 0) ? 1 : 0);
    preSell.push(gt(r, 60) && lt(e, e1) && gt(e, 0) ? 1 : 0);
    buySignals.push(buySignal ? 1 : 0);
    sellSignals.push(sellSignal ? 1 : 0);
  });

  plot(seriesOf(barrierPlot), 'Breakout Barrier', { color: color.purple, style: 'linebr' });
  plotshape(seriesOf(preBuy), 'Pre-Buy', { style: 'triangleup', location: 'belowbar', color: color.blue, size: 'small', text: 'Pre-Buy' });
  plotshape(seriesOf(buySignals), 'BUY NOW', { style: 'labelup', location: 'belowbar', color: color.green, textcolor: color.white, size: 'normal', text: 'BUY' });
  plotshape(seriesOf(preSell), 'Pre-Sell', { style: 'triangledown', location: 'abovebar', color: color.orange, size: 'small', text: 'Pre-Sell' });
  plotshape(seriesOf(sellSignals), 'SELL NOW', { style: 'labeldown', location: 'abovebar', color: color.red, textcolor: color.white, size: 'normal', text: 'SELL' });
}

export const ewoRsi: ScriptStrategy = {
  key: 'ewo-rsi',
  source: { id: 'PUB;0fed071b69f742cab6345d74feae8b3b', name: 'EWO,RSI advanced Signals Strategy - Exhaustion Filter', author: 'Pridarasx' },
  body,
};
