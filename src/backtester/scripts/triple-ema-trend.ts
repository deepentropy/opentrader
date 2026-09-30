/** Turtle Strategy - Triple EMA Trend with ADX and ATR (cyatophilum): exit bracket from ATR levels. */
import { callsite, compare } from 'oakscriptjs';
import {
  close,
  color,
  eachBar,
  fixnan,
  high,
  hline,
  input,
  low,
  plot,
  plotshape,
  seriesOf,
  strategy,
  ta,
  time,
  timestamp,
} from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { eq, gt, lt } = compare;

function body(): void {
  strategy('Triple EMA Trend', {
    overlay: false,
    fill_orders_on_standard_ohlc: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 5,
    commission_type: strategy.commission.percent,
    commission_value: 0.075,
  });

  const trendGroup = { group: 'Trend Conditions' };
  const adxLen = input.int(14, 'ADX Length', trendGroup);
  const adxThresh = input.float(43.0, 'ADX Threshold', trendGroup);
  const emaGroup = { group: 'EMA Conditions' };
  const emaFastLen = input.int(30, 'EMA Fast Length', emaGroup);
  const emaMidLen = input.int(46, 'EMA Mid Length', emaGroup);
  const emaSlowLen = input.int(80, 'EMA Slow Length', emaGroup);
  const riskGroup = { group: 'Risk Management' };
  const atrLen = input.int(14, 'ATR Length', riskGroup);
  const slMult = input.float(1.8, 'Stop Loss ATR Multiplier', riskGroup);
  const tpMult = input.float(3.3, 'Take Profit ATR Multiplier', riskGroup);
  const backtestGroup = { group: 'Backtesting' };
  const startDate = input.time(timestamp('01 Jan 2021 00:00 +0300'), 'Start Date', backtestGroup);
  const endDate = input.time(timestamp('20 Jul 2030 00:00 +0300'), 'End Date', backtestGroup);
  const enableLongs = input.bool(true, 'Go Long', backtestGroup);
  const enableShorts = input.bool(false, 'Go Short', backtestGroup);

  // dirmov(len) / adx(dilen, adxlen)
  const up = ta.change(high);
  const down = ta.change(low).neg();
  const plusDM = eachBar((c) => {
    const u = c.get(up);
    const d = c.get(down);
    return Number.isNaN(u) ? NaN : gt(u, d) && gt(u, 0) ? u : 0;
  });
  const minusDM = eachBar((c) => {
    const u = c.get(up);
    const d = c.get(down);
    return Number.isNaN(d) ? NaN : gt(d, u) && gt(d, 0) ? d : 0;
  });
  const truerange = ta.rma(ta.tr(), adxLen);
  const plus = fixnan(ta.rma(plusDM, adxLen).mul(100).div(truerange));
  const minus = fixnan(ta.rma(minusDM, adxLen).mul(100).div(truerange));
  const ratio = eachBar((c) => {
    const p = c.get(plus);
    const m = c.get(minus);
    const sum = p + m;
    return Math.abs(p - m) / (eq(sum, 0) ? 1 : sum);
  });
  const adx = ta.rma(ratio, adxLen).mul(100);

  const emaFast = ta.ema(close, emaFastLen);
  const emaMid = ta.ema(close, emaMidLen);
  const emaSlow = ta.ema(close, emaSlowLen);
  const atr = ta.atr(atrLen);

  let isLong = false;
  let isShort = false;
  let entryPrice = NaN;
  let stoplossPrice = NaN;
  let takeprofitPrice = NaN;
  const crossoverTP = callsite.crossover();
  const crossunderSL = callsite.crossunder();
  const crossunderTP = callsite.crossunder();
  const crossoverSL = callsite.crossover();
  const tpPlot: number[] = [];
  const slPlot: number[] = [];
  const longEntries: number[] = [];
  const shortEntries: number[] = [];
  strategy.eachBar((c) => {
    let stoplossHit = false;
    let takeprofitHit = false;
    const a = c.get(adx);
    const f = c.get(emaFast);
    const m = c.get(emaMid);
    const s = c.get(emaSlow);
    const longCondition = gt(a, adxThresh) && gt(f, m) && gt(m, s) && gt(c.close, f);
    const shortCondition = gt(a, adxThresh) && lt(f, m) && lt(m, s) && lt(c.close, f);
    const entryLong = longCondition && !(isLong || isShort);
    const entryShort = shortCondition && !(isLong || isShort);
    isLong = entryLong ? true : isLong;
    isShort = entryShort ? true : isShort;
    const newTrade = entryLong || entryShort;

    const tpUp = crossoverTP(c.high, takeprofitPrice);
    const slDown = crossunderSL(c.low, stoplossPrice);
    const tpDown = crossunderTP(c.low, takeprofitPrice);
    const slUp = crossoverSL(c.high, stoplossPrice);

    if (newTrade) {
      entryPrice = c.close;
      const atrValue = c.get(atr);
      if (isLong) {
        stoplossPrice = entryPrice - slMult * atrValue;
        takeprofitPrice = entryPrice + tpMult * atrValue;
      }
      if (isShort) {
        stoplossPrice = entryPrice + slMult * atrValue;
        takeprofitPrice = entryPrice - tpMult * atrValue;
      }
    } else {
      if (isLong) {
        if (tpUp) takeprofitHit = true;
        else if (slDown) stoplossHit = true;
      }
      if (isShort) {
        if (tpDown) takeprofitHit = true;
        else if (slUp) stoplossHit = true;
      }
      if (takeprofitHit || stoplossHit) {
        isLong = false;
        isShort = false;
      }
    }

    const t = c.get(time);
    if (t > startDate && t < endDate) {
      if (entryLong && enableLongs) {
        strategy.entry('Long Entry', strategy.long);
        strategy.exit('Exit Long', { from_entry: 'Long Entry', limit: takeprofitPrice, stop: stoplossPrice });
      }
      if (entryShort && enableShorts) {
        strategy.entry('Short Entry', strategy.short);
        strategy.exit('Exit Short', { from_entry: 'Short Entry', limit: takeprofitPrice, stop: stoplossPrice });
      }
    }

    tpPlot.push(isLong || isShort ? takeprofitPrice : NaN);
    slPlot.push(isLong || isShort ? stoplossPrice : NaN);
    longEntries.push(entryLong ? 1 : 0);
    shortEntries.push(entryShort ? 1 : 0);
  });

  plot(adx, 'ADX', { color: color.red });
  hline(adxThresh, 'ADX Threshold', { color: color.white });
  plot(emaFast, 'EMA Fast', { color: color.blue });
  plot(emaMid, 'EMA Mid', { color: color.white, linewidth: 2 });
  plot(emaSlow, 'EMA Slow', { color: color.yellow, linewidth: 3 });
  plot(seriesOf(tpPlot), 'TP Price', { color: color.lime, linewidth: 1, style: 'linebr' });
  plot(seriesOf(slPlot), 'SL Price', { color: color.red, linewidth: 1, style: 'linebr' });
  plotshape(seriesOf(longEntries), 'Long Entry', { style: 'labelup', location: 'belowbar', color: color.lime, text: 'Long', textcolor: color.black });
  plotshape(seriesOf(shortEntries), 'Short Entry', { style: 'labeldown', location: 'abovebar', color: color.red, text: 'Short', textcolor: color.white });
}

export const tripleEmaTrend: ScriptStrategy = {
  key: 'triple-ema-trend',
  source: { id: 'PUB;3b01ba9f8cac4c92b8995eab91448e66', name: 'Turtle Strategy - Triple EMA Trend with ADX and ATR', author: 'cyatophilum' },
  body,
};
