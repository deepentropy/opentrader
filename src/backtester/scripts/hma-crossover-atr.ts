/** HMA Crossover + ATR + Curvature (Long & Short) (emilio_sforza): HMA cross with an acceleration filter,
 *  risk-sized entries and a trailing stop in ticks. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, input, plotshape, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('HMA Crossover + ATR + Curvature (Long & Short)', {
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 100,
  });

  // === Inputs ===
  const fastLength = input.int(15, 'Fast HMA Period');
  const slowLength = input.int(34, 'Slow HMA Period');
  const atrLength = input.int(14, 'ATR Period');
  const riskPercent = input.float(1.0, 'Risk per Trade (%)', { minval: 0.1, maxval: 10 });
  const atrMult = input.float(1.5, 'Stop Loss ATR Multiplier');
  const trailMult = input.float(1.0, 'Trailing Stop ATR Multiplier');
  const curvThresh = input.float(0.0, 'Curvature Threshold (Min Acceleration)', { step: 0.01 });

  // === Calculations ===
  const fastHMA = ta.hma(close, fastLength);
  const slowHMA = ta.hma(close, slowLength);
  const atr = ta.atr(atrLength);

  // Curvature: approximate second derivative (acceleration)
  const curv = ta.change(ta.change(fastHMA));

  // Entry Conditions
  const crossUp = ta.crossover(fastHMA, slowHMA);
  const crossDown = ta.crossunder(fastHMA, slowHMA);
  const bullish = eachBar((c) => c.get(crossUp) === 1 && gt(c.get(curv), curvThresh));
  const bearish = eachBar((c) => c.get(crossDown) === 1 && lt(c.get(curv), -curvThresh));

  // === Strategy Logic ===
  strategy.eachBar((c) => {
    // Risk Management
    const a = c.get(atr);
    const stopLoss = a * atrMult;
    const trailStop = a * trailMult;
    const capital = strategy.equity;
    const riskCapital = capital * (riskPercent / 100);
    const qty = riskCapital / stopLoss;

    if (c.get(bullish) === 1) {
      strategy.entry('Long', strategy.long, { qty });
      strategy.exit('Long Trail Stop', { from_entry: 'Long', trail_points: trailStop, trail_offset: trailStop });
    }
    if (c.get(bearish) === 1) {
      strategy.entry('Short', strategy.short, { qty });
      strategy.exit('Short Trail Stop', { from_entry: 'Short', trail_points: trailStop, trail_offset: trailStop });
    }
  });

  plotshape(bullish, 'Buy', { location: 'belowbar', color: color.green, style: 'labelup', text: 'BUY' });
  plotshape(bearish, 'Sell', { location: 'abovebar', color: color.red, style: 'labeldown', text: 'SELL' });
}

export const hmaCrossoverAtr: ScriptStrategy = {
  key: 'hma-crossover-atr',
  source: { id: 'PUB;fa6a8c6fb0ae44ab8e23e945d1adbf5f', name: 'HMA Crossover + ATR + Curvature (Long & Short)', author: 'emilio_sforza' },
  body,
};
