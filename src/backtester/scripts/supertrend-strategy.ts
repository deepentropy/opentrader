/** SuperTrend STRATEGY (holdon_to_profits): SMA of the true range, long only, date window. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, input, nz, plot, plotshape, seriesOf, strategy, ta, time, timestamp } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('SuperTrend STRATEGY', {
    overlay: true,
    initial_capital: 10000000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
    commission_type: strategy.commission.percent,
    commission_value: 0.015,
    currency: 'NONE',
    process_orders_on_close: true,
  });

  const periods = input.int(10, 'ATR Period');
  const src = input.source('hl2', 'Source');
  const multiplier = input.float(8.5, 'ATR Multiplier', { step: 0.1 });

  const atrVal = ta.sma(ta.tr(), periods);
  const ups: number[] = [];
  const dns: number[] = [];
  const trend = eachBar((c) => {
    const i = c.i;
    const s = c.get(src);
    const atr = c.get(atrVal);
    const close1 = c.get(close, 1);
    let up = s - multiplier * atr;
    const up1 = nz(ups[i - 1] ?? NaN, up);
    up = gt(close1, up1) ? Math.max(up, up1) : up;
    let dn = s + multiplier * atr;
    const dn1 = nz(dns[i - 1] ?? NaN, dn);
    dn = lt(close1, dn1) ? Math.min(dn, dn1) : dn;
    ups.push(up);
    dns.push(dn);
    let t = 1;
    t = nz(c.prev(), t);
    t = t === -1 && gt(c.close, dn1) ? 1 : t === 1 && lt(c.close, up1) ? -1 : t;
    return t;
  });
  const trends = trend.toArray();
  const upPlot = trends.map((t, i) => (t === 1 ? ups[i]! : NaN));
  const dnPlot = trends.map((t, i) => (t === 1 ? NaN : dns[i]!));
  const buySignal = trends.map((t, i) => (t === 1 && trends[i - 1] === -1 ? 1 : 0));
  const sellSignal = trends.map((t, i) => (t === -1 && trends[i - 1] === 1 ? 1 : 0));
  plot(seriesOf(upPlot), 'Up Trend', { style: 'linebr', linewidth: 2, color: color.green });
  plot(seriesOf(dnPlot), 'Down Trend', { style: 'linebr', linewidth: 2, color: color.red });
  plotshape(seriesOf(buySignal.map((b, i) => (b ? ups[i]! : NaN))), 'Buy', { text: 'Buy', location: 'absolute', style: 'labelup', size: 'tiny', color: color.green, textcolor: color.white });
  plotshape(seriesOf(sellSignal.map((s, i) => (s ? dns[i]! : NaN))), 'Close', { text: 'Close', location: 'absolute', style: 'labeldown', size: 'tiny', color: color.black, textcolor: color.white });

  const fromMonth = input.int(1, 'From Month', { minval: 1, maxval: 12 });
  const fromDay = input.int(1, 'From Day', { minval: 1, maxval: 31 });
  const fromYear = input.int(2020, 'From Year', { minval: 999 });
  const toMonth = input.int(1, 'To Month', { minval: 1, maxval: 12 });
  const toDay = input.int(1, 'To Day', { minval: 1, maxval: 31 });
  const toYear = input.int(9999, 'To Year', { minval: 999 });
  const start = timestamp(fromYear, fromMonth, fromDay, 0, 0);
  const finish = timestamp(toYear, toMonth, toDay, 23, 59);

  strategy.eachBar((c) => {
    const t = c.get(time);
    const inWindow = t >= start && t <= finish;
    if (buySignal[c.i] && inWindow) strategy.entry('BUY', strategy.long);
    if (sellSignal[c.i] && inWindow) strategy.close('BUY');
  });
}

export const supertrendStrategy: ScriptStrategy = {
  key: 'supertrend-strategy',
  source: { id: 'PUB;d6fba11d365a42f89f44000bc678d087', name: 'SuperTrend STRATEGY', author: 'holdon_to_profits' },
  body,
};
