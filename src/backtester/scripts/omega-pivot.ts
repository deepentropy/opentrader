/** Pivot Strategy [OmegaTools] (OmegaTools): pivot point level crosses, pivot level stop / target, close at each reset. */
import { compare } from 'oakscriptjs';
import { close as closeSeries, color, eachBar, input, plot, seriesOf, strategy, timeframe } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { ge, gt, le, lt } = compare;

/** Pivot levels [P, R1, S1, R2, S2, R3, S3] of a period from its high, low and close, and the next period's open. */
function pivotLevels(type: string, h: number, l: number, c: number, o: number): number[] {
  const r = h - l;
  switch (type) {
    case 'Traditional': {
      const p = (h + l + c) / 3;
      return [p, p * 2 - l, p * 2 - h, p + r, p - r, p * 2 + (h - 2 * l), p * 2 - (2 * h - l)];
    }
    case 'Fibonacci': {
      const p = (h + l + c) / 3;
      return [p, p + 0.382 * r, p - 0.382 * r, p + 0.618 * r, p - 0.618 * r, p + r, p - r];
    }
    case 'Woodie': {
      const p = (h + l + o * 2) / 4;
      return [p, p * 2 - l, p * 2 - h, p + r, p - r, h + 2 * (p - l), l - 2 * (h - p)];
    }
    case 'Classic': {
      const p = (h + l + c) / 3;
      return [p, p * 2 - l, p * 2 - h, p + r, p - r, p + 2 * r, p - 2 * r];
    }
    case 'Camarilla': {
      const p = (h + l + c) / 3;
      return [p, c + (1.1 * r) / 12, c - (1.1 * r) / 12, c + (1.1 * r) / 6, c - (1.1 * r) / 6, c + (1.1 * r) / 4, c - (1.1 * r) / 4];
    }
    default:
      return [NaN, NaN, NaN, NaN, NaN, NaN, NaN];
  }
}

function body(): void {
  strategy('Pivot Strategy [OmegaTools]', { overlay: true, fill_orders_on_standard_ohlc: true });

  const typ = input.string('Woodie', 'Type', { options: ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'Camarilla'] });
  const reset = timeframe.change(input.timeframe('1D', 'Reset'));
  const strat = { group: 'Strategy' };
  const entry = input.string('M', 'Entry', { options: ['M', 'SR1', 'SR2', 'SR3'], inline: 'entry', ...strat });
  const entry2 = input.string('TF', '', { options: ['TF', 'MR'], inline: 'entry', ...strat });
  const stoploss = input.string('SR1', 'Stop Loss', { options: ['None', 'M', 'SR1', 'SR2', 'SR3'], ...strat });
  const takeprofit = input.string('SR3', 'Take Profit', { options: ['None', 'M', 'SR1', 'SR2', 'SR3'], ...strat });
  const maxtrades = input.int(1, 'Max trades per day', strat);

  const upc = input.color('#2962ff', 'Colors', { inline: 'col' });
  const dnc = input.color('#e91e63', '', { inline: 'col' });

  // ta.pivot_point_levels(typ, reset) (developing = false): on each anchor bar, the levels of the period that
  // ended on the previous bar (its high, low and close; the open of the new period for Woodie).
  let periodHigh = NaN;
  let periodLow = NaN;
  let levels = [NaN, NaN, NaN, NaN, NaN, NaN, NaN];
  const levelValues: number[][] = [[], [], [], [], [], [], []];
  eachBar((c) => {
    if (c.get(reset) === 1) {
      levels = pivotLevels(typ, periodHigh, periodLow, c.get(closeSeries, 1), c.open);
      periodHigh = c.high;
      periodLow = c.low;
    } else {
      periodHigh = Number.isNaN(periodHigh) ? c.high : Math.max(periodHigh, c.high);
      periodLow = Number.isNaN(periodLow) ? c.low : Math.min(periodLow, c.low);
    }
    levels.forEach((v, k) => levelValues[k]!.push(v));
  });
  const [p0, r1, s1, r2, s2, r3, s3] = levelValues.map((v) => seriesOf(v));

  const resets = reset.toArray();
  const shown = (s: typeof p0) => seriesOf(s!.toArray().map((v, i) => (resets[i] === 1 ? NaN : v)));
  const plotOpts = (col: string) => ({ color: col, linewidth: 1, style: plot.style_linebr, display: 'pane' as const });
  plot(shown(p0), 'Pivot M', plotOpts(color.from_gradient(0, -1, 1, upc, dnc)));
  plot(shown(r1), 'Pivot R1', plotOpts(dnc));
  plot(shown(s1), 'Pivot S1', plotOpts(upc));
  plot(shown(r2), 'Pivot R2', plotOpts(dnc));
  plot(shown(s2), 'Pivot S2', plotOpts(upc));
  plot(shown(r3), 'Pivot R3', plotOpts(dnc));
  plot(shown(s3), 'Pivot S3', plotOpts(upc));

  const longLevel = (sel: string, i: number): number =>
    sel === 'M' ? levelValues[0]![i]! : sel === 'SR1' ? levelValues[1]![i]! : sel === 'SR2' ? levelValues[3]![i]! : sel === 'SR3' ? levelValues[5]![i]! : NaN;
  const shortLevel = (sel: string, i: number): number =>
    sel === 'M' ? levelValues[0]![i]! : sel === 'SR1' ? levelValues[2]![i]! : sel === 'SR2' ? levelValues[4]![i]! : sel === 'SR3' ? levelValues[6]![i]! : NaN;

  let tradesToday = 0;
  strategy.eachBar((c) => {
    const i = c.i;
    const entryLongLevel = longLevel(entry, i);
    const entryShortLevel = shortLevel(entry, i);
    const close1 = c.get(closeSeries, 1);
    const longSignal =
      entry2 === 'TF'
        ? lt(close1, entryLongLevel) && ge(c.close, entryLongLevel)
        : gt(close1, entryShortLevel) && le(c.low, entryShortLevel);
    const shortSignal =
      entry2 === 'TF'
        ? gt(close1, entryShortLevel) && le(c.close, entryShortLevel)
        : lt(close1, entryLongLevel) && ge(c.high, entryLongLevel);

    if (c.get(reset) === 1) {
      tradesToday = 0;
      strategy.close_all({ comment: 'Pivot Reset' });
    }

    const canTrade = tradesToday < maxtrades;
    if (canTrade) {
      if (longSignal && !shortSignal && le(strategy.position_size, 0)) {
        strategy.entry('Long', strategy.long);
        tradesToday += 1;
      } else if (shortSignal && !longSignal && ge(strategy.position_size, 0)) {
        strategy.entry('Short', strategy.short);
        tradesToday += 1;
      }
    }

    const longSLraw = stoploss === 'None' ? NaN : shortLevel(stoploss, i);
    const longTPraw = takeprofit === 'None' ? NaN : longLevel(takeprofit, i);
    const shortSLraw = stoploss === 'None' ? NaN : longLevel(stoploss, i);
    const shortTPraw = takeprofit === 'None' ? NaN : shortLevel(takeprofit, i);

    const pos = strategy.position_size;
    const avg = strategy.position_avg_price;
    const longSL = gt(pos, 0) && !Number.isNaN(longSLraw) && lt(longSLraw, avg) ? longSLraw : NaN;
    const longTP = gt(pos, 0) && !Number.isNaN(longTPraw) && gt(longTPraw, avg) ? longTPraw : NaN;
    const shortSL = lt(pos, 0) && !Number.isNaN(shortSLraw) && gt(shortSLraw, avg) ? shortSLraw : NaN;
    const shortTP = lt(pos, 0) && !Number.isNaN(shortTPraw) && lt(shortTPraw, avg) ? shortTPraw : NaN;

    strategy.exit('Long Exit', { from_entry: 'Long', stop: longSL, limit: longTP });
    strategy.exit('Short Exit', { from_entry: 'Short', stop: shortSL, limit: shortTP });
  });
}

export const omegaPivot: ScriptStrategy = {
  key: 'omega-pivot',
  source: { id: 'PUB;20ffe245feed438a9907300e5b828bfe', name: 'Pivot Strategy [OmegaTools]', author: 'OmegaTools' },
  body,
};
