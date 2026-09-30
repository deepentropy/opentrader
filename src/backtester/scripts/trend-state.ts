/** Trend State Strategy (Zomzi): ALMA-smoothed step filter, long only. */
import { compare } from 'oakscriptjs';
import { barcolor, close, color, eachBar, fill, high, hl2, input, low, nz, open, plot, plotshape, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';
import { colorNew } from './colors';

const { gt, lt } = compare;

function body(): void {
  strategy('Trend State Strategy', {
    shorttitle: 'TSS_Strat',
    overlay: true,
    initial_capital: 1000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
  });

  const srcType = input.string('Custom', 'Source Type', { options: ['Close', 'HL2', 'HLC3', 'OHLC4', 'OCC3', 'HLCC4', 'Custom'] });
  const src =
    srcType === 'Close'
      ? close
      : srcType === 'HL2'
        ? high.add(low).div(2)
        : srcType === 'HLC3'
          ? high.add(low).add(close).div(3)
          : srcType === 'OHLC4'
            ? open.add(high).add(low).add(close).div(4)
            : srcType === 'HLCC4'
              ? high.add(low).add(close.mul(2)).div(4)
              : srcType === 'OCC3'
                ? open.add(close.mul(2)).div(3)
                : open.add(high.mul(2)).add(low.mul(2)).add(close.mul(2)).div(7);

  const length = input.int(5, 'Sensitivity Length', { minval: 1 });
  const multiplier = input.float(2, 'Range Multiplier', { minval: 0.1, step: 0.025 });
  const offset = input.float(0.5, 'Offset', { minval: 0.5, step: 0.025 });
  const sigma = input.float(1, 'Sigma', { minval: 1, step: 0.025 });
  const confirmClose = input.bool(true, 'Confirm Signals On Bar Close');
  const bullColor = input.color('#00FFAA', 'Bullish Color');
  const bearColor = input.color('#FF0000', 'Bearish Color');
  const showGlow = input.bool(true, 'Show Line Glow');
  const showRibbon = input.bool(true, 'Show Gradient Ribbon');
  const showLabels = input.bool(true, 'Show Bullish/Bearish Labels');
  const labelDist = input.float(1.0, 'Label Vertical Distance', { minval: 0, maxval: 5, step: 0.1 });
  const paintCandles = input.bool(true, 'Color Candles');

  // Adaptive range
  const movement = eachBar((c) => Math.abs(c.get(src) - c.get(src, 1)));
  const adaptiveRange = ta.alma(movement, length, offset, sigma).mul(multiplier);

  // Step filter
  const filter = eachBar((c) => {
    const s = c.get(src);
    const ar = c.get(adaptiveRange);
    const prevFilter = nz(c.prev(), s);
    const upper = prevFilter + ar;
    const lower = prevFilter - ar;
    return gt(s, upper) ? s - ar : lt(s, lower) ? s + ar : prevFilter;
  });

  // Trend state
  const trend = eachBar((c) => {
    const f = c.get(filter);
    const f1 = c.get(filter, 1);
    return gt(f, f1) ? 1 : lt(f, f1) ? -1 : nz(c.prev(), 0);
  });

  const bullSignal = eachBar((c) => {
    const t = c.get(trend);
    return confirmClose ? c.get(trend, 1) === 1 && nz(c.get(trend, 2)) !== 1 : t === 1 && nz(c.get(trend, 1)) !== 1;
  });
  const bearSignal = eachBar((c) => {
    const t = c.get(trend);
    return confirmClose ? c.get(trend, 1) === -1 && nz(c.get(trend, 2)) !== -1 : t === -1 && nz(c.get(trend, 1)) !== -1;
  });

  strategy.eachBar((c) => {
    if (c.get(bullSignal) === 1) strategy.entry('Long', strategy.long);
    if (c.get(bearSignal) === 1) strategy.close('Long');
  });

  // Visualization
  const trendValues = trend.toArray();
  const trendColor = trendValues.map((t) => (t === 1 ? bullColor : t === -1 ? bearColor : color.gray));
  plot(showGlow ? filter : eachBar(() => NaN), 'Trend Line Glow', { color: trendColor.map((c) => colorNew(c, 82)), linewidth: 7 });
  const filterPlot = plot(filter, 'Trend State Line', { color: trendColor, linewidth: 3 });
  const pricePlot = plot(hl2, 'Price Midpoint', { display: 'none' });
  const ribbonColor = trendColor.map((c) => (showRibbon ? colorNew(c, 20) : undefined));
  fill(filterPlot, pricePlot, hl2, filter, null, ribbonColor, 'Trend State Ribbon');

  const bulls = bullSignal.toArray();
  const bears = bearSignal.toArray();
  const f = filter.toArray();
  const ar = adaptiveRange.toArray();
  const bullPos = f.map((_, i) =>
    showLabels && bulls[i] ? (confirmClose ? (f[i - 1] ?? NaN) - (ar[i - 1] ?? NaN) * labelDist : f[i]! - ar[i]! * labelDist) : NaN,
  );
  const bearPos = f.map((_, i) =>
    showLabels && bears[i] ? (confirmClose ? (f[i - 1] ?? NaN) + (ar[i - 1] ?? NaN) * labelDist : f[i]! + ar[i]! * labelDist) : NaN,
  );
  const labelOffset = confirmClose ? -1 : 0;
  plotshape(seriesOf(bullPos), 'Bullish Signal', { style: 'labelup', location: 'absolute', color: bullColor, text: 'BUY', textcolor: color.white, size: 'tiny', offset: labelOffset });
  plotshape(seriesOf(bearPos), 'Bearish Signal', { style: 'labeldown', location: 'absolute', color: bearColor, text: 'SELL', textcolor: color.white, size: 'tiny', offset: labelOffset });
  if (paintCandles) barcolor(trendColor, { title: 'Trend Candles' });
}

export const trendState: ScriptStrategy = {
  key: 'trend-state',
  source: { id: 'PUB;bb0edf6228ce481e895ed7c3ab3881b4', name: 'Trend State Strategy', author: 'Zomzi' },
  body,
};
