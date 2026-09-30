/** Futures Trading Hours RSI Strategy (TheFuturesPlaybook): RSI crosses in a time window, close all at the window end. */
import { compare } from 'oakscriptjs';
import { bgcolor, close, color, dayofweek, hour, input, minute, strategy, ta, time } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { ge, gt, le, lt } = compare;

const MONDAY = 2; // dayofweek.monday
const FRIDAY = 6; // dayofweek.friday

function body(): void {
  strategy('Futures Trading Hours RSI Strategy', {
    overlay: true,
  });

  const length = input.int(14, 'RSI Length');
  const overSold = input.int(30, 'RSI Oversold Level');
  const overBought = input.int(70, 'RSI Overbought Level');

  const price = close;
  const vrsi = ta.rsi(price, length);

  // Time filter: the source's hours, in the chart's exchange time zone (offset 0).
  const startHour = 8;
  const startMinute = 30;
  const endHour = 15;
  const endMinute = 0;
  const timezoneOffset = 0;
  const adjustedTime = time.add(timezoneOffset * 60 * 60 * 1000);
  const adjustedHour = hour(adjustedTime);
  const adjustedMinute = minute(adjustedTime);
  const dow = dayofweek(time);

  const co = ta.crossover(vrsi, overSold);
  const cu = ta.crossunder(vrsi, overBought);

  const longShading: Array<string | undefined> = [];
  const shortShading: Array<string | undefined> = [];
  strategy.eachBar((c) => {
    const h = c.get(adjustedHour);
    const m = c.get(adjustedMinute);
    const d = c.get(dow);
    const weekdayFilter = ge(d, MONDAY) && le(d, FRIDAY);
    const inSession = (h > startHour || (h === startHour && m >= startMinute)) && (h < endHour || (h === endHour && m < endMinute));
    const r = c.get(vrsi);
    if (!Number.isNaN(r) && inSession && weekdayFilter) {
      if (c.get(co) === 1) strategy.entry('RsiLE', strategy.long, { comment: 'RsiLE' });
      if (c.get(cu) === 1) strategy.entry('RsiSE', strategy.short, { comment: 'RsiSE' });
    }
    if (weekdayFilter && (h > endHour || (h === endHour && m >= endMinute))) {
      strategy.close_all({ comment: 'Close All by 15:00 CT' });
    }
    const pos = strategy.position_size;
    longShading.push(gt(pos, 0) ? color.new(color.green, 90) : undefined);
    shortShading.push(lt(pos, 0) ? color.new(color.red, 90) : undefined);
  });

  bgcolor(longShading, { title: 'Long Position Shading' });
  bgcolor(shortShading, { title: 'Short Position Shading' });
}

export const futuresHoursRsi: ScriptStrategy = {
  key: 'futures-hours-rsi',
  source: { id: 'PUB;6c096abb02cb4848bfb3f9287246707a', name: 'Futures Trading Hours RSI Strategy', author: 'TheFuturesPlaybook' },
  body,
};
