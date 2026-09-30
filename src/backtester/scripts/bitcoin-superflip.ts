/** Bitcoin SuperFlip | Supertrend EMA Trend-Following Strategy (blitz_locked): supertrend flips above / below an EMA. */
import { compare } from 'oakscriptjs';
import { barcolor, bgcolor, close, color, fill, input, plot, plotshape, seriesOf, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('BTCUSD Supertrend + EMA Trend Filter (1H)', {
    overlay: true,
    initial_capital: 10000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 25,
    commission_type: strategy.commission.percent,
    commission_value: 0.075,
    slippage: 1,
  });

  const gStrategy = '════════ Strategy Settings ════════';
  const gAdx = '════════ ADX Filter ════════';
  const gVisual = '════════ Visual Settings ════════';
  const atrPeriod = input.int(10, 'Supertrend ATR Length', { group: gStrategy });
  const factor = input.float(1.8, 'Supertrend Factor', { step: 0.1, group: gStrategy });
  const emaLen = input.int(200, 'EMA Trend Filter Length', { group: gStrategy });
  const enableSL = input.bool(false, 'Enable Stop Loss', { group: gStrategy });
  const enableTP = input.bool(false, 'Enable Take Profit', { group: gStrategy });
  const slPct = input.float(4.0, 'Stop Loss %', { step: 0.1, group: gStrategy }) / 100;
  const tpPct = input.float(8.0, 'Take Profit %', { step: 0.1, group: gStrategy }) / 100;
  const enableADX = input.bool(false, 'Enable ADX Filter', {
    group: gAdx,
    tooltip: 'Only take signals when ADX is above the threshold, filtering out low-conviction/choppy conditions.',
  });
  const adxLen = input.int(14, 'ADX Length', { minval: 1, group: gAdx });
  const adxSmooth = input.int(14, 'ADX Smoothing', { minval: 1, group: gAdx });
  const adxThresh = input.float(20.0, 'ADX Threshold', { step: 1.0, group: gAdx });
  const showFill = input.bool(true, 'Show Gradient Fill', { group: gVisual });
  const showMarkers = input.bool(true, 'Show Flip Markers', { group: gVisual });
  const colorPreset = input.string('Custom', 'Color Preset', { options: ['Classic', 'Aqua', 'Cosmic', 'Cyber', 'Neon', 'Custom'], group: gVisual });
  const bullishInput = input.color('#00ffaa', 'Bullish Color', { group: gVisual });
  const bearishInput = input.color('#ff0000', 'Bearish Color', { group: gVisual });
  const showCandles = input.bool(false, 'Enable Bar Coloring', { group: gVisual });
  const barTrans = input.int(0, 'Bar Color Transparency', { minval: 0, maxval: 100, group: gVisual });
  const showBgcolor = input.bool(false, 'Enable Background Coloring', { group: gVisual });
  const bgTrans = input.int(90, 'Background Color Transparency', { minval: 0, maxval: 100, group: gVisual });

  const presets: Record<string, [string, string]> = {
    Classic: ['#00ff00', '#ff0000'],
    Aqua: ['#00d4ff', '#ff8c00'],
    Cosmic: ['#49ffce', '#9932cc'],
    Cyber: ['#00cccc', '#ff6600'],
    Neon: ['#ffff00', '#ff00ff'],
    Custom: [bullishInput, bearishInput],
  };
  const [bullishColor, bearishColor] = presets[colorPreset] ?? [bullishInput, bearishInput];

  const [supertrend, direction] = ta.supertrend(factor, atrPeriod);
  const trendEMA = ta.ema(close, emaLen);
  const dirChange = ta.change(direction);
  const bullFlip = dirChange.lt(0);
  const bearFlip = dirChange.gt(0);
  const [, , adx] = ta.dmi(adxLen, adxSmooth);

  const longSignals: number[] = [];
  const shortSignals: number[] = [];
  strategy.eachBar((c) => {
    const bull = c.get(bullFlip) === 1;
    const bear = c.get(bearFlip) === 1;
    const adxOK = !enableADX || gt(c.get(adx), adxThresh);
    const longCondition = bull && gt(c.close, c.get(trendEMA)) && adxOK;
    const shortCondition = bear && lt(c.close, c.get(trendEMA)) && adxOK;
    if (longCondition) strategy.entry('Long', strategy.long);
    if (shortCondition) strategy.entry('Short', strategy.short);
    if (bear) strategy.close('Long');
    if (bull) strategy.close('Short');
    if (gt(strategy.position_size, 0)) {
      const entryPrice = strategy.position_avg_price;
      if (enableSL) {
        strategy.exit('Long SL/TP', { from_entry: 'Long', stop: entryPrice * (1 - slPct), limit: enableTP ? entryPrice * (1 + tpPct) : NaN });
      }
    }
    if (lt(strategy.position_size, 0)) {
      const entryPrice = strategy.position_avg_price;
      if (enableSL) {
        strategy.exit('Short SL/TP', { from_entry: 'Short', stop: entryPrice * (1 + slPct), limit: enableTP ? entryPrice * (1 - tpPct) : NaN });
      }
    }
    longSignals.push(longCondition ? 1 : 0);
    shortSignals.push(shortCondition ? 1 : 0);
  });

  const dir = direction.toArray();
  const st = supertrend.toArray();
  const cl = close.toArray();
  const trendColor = dir.map((d) => (lt(d, 0) ? bullishColor : bearishColor));
  const stUp = dir.map((d, i) => (lt(d, 0) ? st[i]! : NaN));
  const stDn = dir.map((d, i) => (gt(d, 0) ? st[i]! : NaN));
  plot(seriesOf(stUp), 'Glow Up', { color: color.new(bullishColor, 70), linewidth: 6, style: 'linebr' });
  plot(seriesOf(stDn), 'Glow Down', { color: color.new(bearishColor, 70), linewidth: 6, style: 'linebr' });
  const pStUp = plot(seriesOf(stUp), 'Bullish Supertrend', { color: bullishColor, linewidth: 2, style: 'linebr' });
  const pStDn = plot(seriesOf(stDn), 'Bearish Supertrend', { color: bearishColor, linewidth: 2, style: 'linebr' });
  plot(trendEMA, 'EMA Trend Filter', { color: color.new(color.orange, 20), linewidth: 1 });
  const pPrice = plot(close, 'Price Anchor', { display: 'none' });
  const grad = (line: number[], k: number) =>
    seriesOf(line.map((v, i) => (showFill && !Number.isNaN(v) ? v + ((cl[i]! - v) / 4.0) * k : NaN)));
  const pG1u = plot(grad(stUp, 1), 'Plot', { display: 'none' });
  const pG2u = plot(grad(stUp, 2), 'Plot', { display: 'none' });
  const pG3u = plot(grad(stUp, 3), 'Plot', { display: 'none' });
  const pG1d = plot(grad(stDn, 1), 'Plot', { display: 'none' });
  const pG2d = plot(grad(stDn, 2), 'Plot', { display: 'none' });
  const pG3d = plot(grad(stDn, 3), 'Plot', { display: 'none' });
  const fillColor = (base: string, transp: number) => (showFill ? color.new(base, transp) : null);
  fill(pStUp, pG1u, fillColor(bullishColor, 65), 'Up Gradient 1');
  fill(pG1u, pG2u, fillColor(bullishColor, 78), 'Up Gradient 2');
  fill(pG2u, pG3u, fillColor(bullishColor, 88), 'Up Gradient 3');
  fill(pG3u, pPrice, fillColor(bullishColor, 95), 'Up Gradient 4');
  fill(pStDn, pG1d, fillColor(bearishColor, 65), 'Down Gradient 1');
  fill(pG1d, pG2d, fillColor(bearishColor, 78), 'Down Gradient 2');
  fill(pG2d, pG3d, fillColor(bearishColor, 88), 'Down Gradient 3');
  fill(pG3d, pPrice, fillColor(bearishColor, 95), 'Down Gradient 4');
  const flipAt = (flips: number[]) => seriesOf(flips.map((f, i) => (showMarkers && f === 1 ? st[i]! : NaN)));
  plotshape(flipAt(bullFlip.toArray()), 'Bullish Flip', { style: 'triangleup', location: 'belowbar', color: bullishColor, size: 'small' });
  plotshape(flipAt(bearFlip.toArray()), 'Bearish Flip', { style: 'triangledown', location: 'abovebar', color: bearishColor, size: 'small' });
  plotshape(seriesOf(longSignals), 'Long Entry', { style: 'circle', location: 'belowbar', color: color.new(bullishColor, 0), size: 'tiny' });
  plotshape(seriesOf(shortSignals), 'Short Entry', { style: 'circle', location: 'abovebar', color: color.new(bearishColor, 0), size: 'tiny' });
  if (showCandles) barcolor(trendColor.map((c) => color.new(c, barTrans)), { title: 'Trend Bar Color' });
  if (showBgcolor) bgcolor(trendColor.map((c) => color.new(c, bgTrans)), { title: 'Trend Background Color' });
}

export const bitcoinSuperflip: ScriptStrategy = {
  key: 'bitcoin-superflip',
  source: { id: 'PUB;caca248edd1a4bc7aa8857c730cb421f', name: 'Bitcoin SuperFlip | Supertrend EMA Trend-Following Strategy', author: 'blitz_locked' },
  body,
};
