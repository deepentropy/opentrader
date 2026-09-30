/** Fibonacci Cloud | Multi-Timeframe Fibonacci Scanner (blitz_locked): Fibonacci level confluence of 3 lookbacks,
 *  EMA trend filter, percent stop and R:R target. */
import { compare } from 'oakscriptjs';
import { bgcolor, close, color, fill, high, input, low, plot, plotshape, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { Series } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { ge, gt, le, lt } = compare;

function body(): void {
  strategy('Fib Confluence Scanner', {
    overlay: true,
    initial_capital: 10000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
    commission_type: strategy.commission.percent,
    commission_value: 0.05,
  });

  const lookbacks = { group: 'Fibonacci Lookbacks' };
  const lenA = input.int(20, 'Lookback A (short)', { minval: 2, ...lookbacks });
  const lenB = input.int(50, 'Lookback B (medium)', { minval: 2, ...lookbacks });
  const lenC = input.int(100, 'Lookback C (long)', { minval: 2, ...lookbacks });

  const confluenceGroup = { group: 'Confluence Settings' };
  const tolerancePct = input.float(0.5, 'Confluence Tolerance (%)', { minval: 0.01, step: 0.01, ...confluenceGroup }) / 100;
  const minConfluence = input.int(1, 'Minimum Confluent Levels', { minval: 1, maxval: 15, ...confluenceGroup });

  const trendGroup = { group: 'Trend Filter' };
  const useTrendFilter = input.bool(true, 'Use EMA Trend Filter', trendGroup);
  const trendLen = input.int(50, 'Trend EMA Length', { minval: 1, ...trendGroup });

  const rsiGroup = { group: 'RSI Filter' };
  const useRsiFilter = input.bool(false, 'Use RSI Momentum Filter', rsiGroup);
  const rsiLen = input.int(14, 'RSI Length', { minval: 1, ...rsiGroup });
  const rsiLongMin = input.int(45, 'RSI Min for Longs', { minval: 0, maxval: 100, ...rsiGroup });
  const rsiShortMax = input.int(55, 'RSI Max for Shorts', { minval: 0, maxval: 100, ...rsiGroup });

  const tradeGroup = { group: 'Trade Management' };
  const tradeDirection = input.string('Both', 'Trade Direction', { options: ['Both', 'Long Only', 'Short Only'], ...tradeGroup });
  const slPct = input.float(1.5, 'Stop Loss (%)', { minval: 0.1, step: 0.1, ...tradeGroup }) / 100;
  const tpRR = input.float(2.0, 'Take Profit R:R', { minval: 0.1, step: 0.1, ...tradeGroup });
  const oneTradeAtTime = input.bool(true, 'Only One Position At A Time', tradeGroup);

  const displayGroup = { group: 'Display' };
  const showBg = input.bool(true, 'Confluence background', displayGroup);
  const showMarks = input.bool(true, 'Entry markers', displayGroup);

  // Alert message inputs: declared as in the source; alerts are not part of a backtest.
  const alertsGroup = { group: 'Alerts' };
  input.string('Open Long', 'Alert: Open Long', alertsGroup);
  input.string('Open Short', 'Alert: Open Short', alertsGroup);
  input.string('Close Long', 'Alert: Close Long', alertsGroup);
  input.string('Close Short', 'Alert: Close Short', alertsGroup);

  const fibLevels = (len: number): Series[] => {
    const hi = ta.highest(high, len);
    const lo = ta.lowest(low, len);
    const rng = hi.sub(lo);
    return [0.236, 0.382, 0.5, 0.618, 0.786].map((r) => hi.sub(rng.mul(r)));
  };
  const levelsA = fibLevels(lenA);
  const levelsB = fibLevels(lenB);
  const levelsC = fibLevels(lenC);
  const b500 = levelsB[2]!;
  // Pine order of the sum: a236..a786, b236..b786, c236..c786.
  const levels = [...levelsA, ...levelsB, ...levelsC].map((s) => s.toArray());

  const emaTrend = ta.ema(close, trendLen);
  const rsiVal = ta.rsi(close, rsiLen);

  const closes = close.toArray();
  const emas = emaTrend.toArray();
  const count: number[] = closes.map((cl, i) => {
    let n = 0;
    for (const lv of levels) n += le(Math.abs(cl - lv[i]!) / cl, tolerancePct) ? 1 : 0;
    return n;
  });
  const trendUpArr = closes.map((cl, i) => gt(cl, emas[i]!));

  const longAllowed = tradeDirection !== 'Short Only';
  const shortAllowed = tradeDirection !== 'Long Only';

  const longMarks: number[] = [];
  const shortMarks: number[] = [];
  strategy.eachBar((c) => {
    const confluence = count[c.i]! >= minConfluence;
    const e = c.get(emaTrend);
    const trendUp = gt(c.close, e);
    const trendDn = lt(c.close, e);
    const r = c.get(rsiVal);
    const rsiLongOK = !useRsiFilter || ge(r, rsiLongMin);
    const rsiShortOK = !useRsiFilter || le(r, rsiShortMax);
    const positionFree = oneTradeAtTime ? strategy.position_size === 0 : true;

    const longCondition = confluence && (!useTrendFilter || trendUp) && rsiLongOK && longAllowed && positionFree;
    const shortCondition = confluence && (!useTrendFilter || trendDn) && rsiShortOK && shortAllowed && positionFree;
    longMarks.push(showMarks && longCondition ? 1 : 0);
    shortMarks.push(showMarks && shortCondition ? 1 : 0);

    if (longCondition) strategy.entry('Long', strategy.long);
    if (shortCondition) strategy.entry('Short', strategy.short);

    const avg = strategy.position_avg_price;
    const longStop = avg * (1 - slPct);
    const longTP = avg * (1 + slPct * tpRR);
    const shortStop = avg * (1 + slPct);
    const shortTP = avg * (1 - slPct * tpRR);

    if (gt(strategy.position_size, 0)) strategy.exit('Exit Long', { from_entry: 'Long', stop: longStop, limit: longTP });
    if (lt(strategy.position_size, 0)) strategy.exit('Exit Short', { from_entry: 'Short', stop: shortStop, limit: shortTP });
  });

  const colUp = color.new('#26a69a', 0);
  const colDown = color.new('#ef5350', 0);
  const colMid = color.new(color.gray, 40);
  const trendCol = trendUpArr.map((up) => (up ? colUp : colDown));

  const pMid = plot(useTrendFilter ? emaTrend : seriesOf(closes.map(() => NaN)), 'Trend EMA', { color: colMid, linewidth: 1 });
  const pFast = plot(b500, 'Fib 0.5 (medium)', { color: trendCol, linewidth: 2 });
  fill(pFast, pMid, { color: trendUpArr.map((up) => color.new(up ? colUp : colDown, 88)), title: 'Trend fill' });

  bgcolor(
    count.map((n) => (showBg && n >= minConfluence ? color.new(n >= minConfluence + 1 ? colUp : colMid, 90) : undefined)),
    { title: 'Confluence background' },
  );

  plotshape(seriesOf(longMarks), 'Long', { style: 'triangleup', location: 'belowbar', color: colUp, size: 'small' });
  plotshape(seriesOf(shortMarks), 'Short', { style: 'triangledown', location: 'abovebar', color: colDown, size: 'small' });
}

export const fibonacciCloud: ScriptStrategy = {
  key: 'fibonacci-cloud',
  source: { id: 'PUB;2ddbd72522674b9e9d8ca0c4ae79b54b', name: 'Fibonacci Cloud | Multi-Timeframe Fibonacci Scanner', author: 'blitz_locked' },
  body,
};
