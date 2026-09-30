/** Aurora KAMA | KAMA Adaptive Trend Strategy (blitz_locked): KAMA rising / falling persistence with an SMA
 *  trend filter, entry cooldown, fixed stop and delayed trailing stop. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, fill, input, math, na, plot, plotshape, seriesOf, strategy, syminfo, ta } from 'oakscriptjs/script';
import type { Series } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { eq, ge, gt, le, lt, ne } = compare;

/** Kaufman's Adaptive Moving Average: one kama() call site (its `var float result`). */
function kama(source: Series, len: number, fLen: number, sLen: number): Series {
  const diff = eachBar((c) => Math.abs(c.get(source) - c.get(source, 1)));
  const volatilitySum = math.sum(diff, len);
  const fastSC = 2.0 / (fLen + 1);
  const slowSC = 2.0 / (sLen + 1);
  return eachBar((c) => {
    const src = c.get(source);
    const change = Math.abs(src - c.get(source, len));
    const volatility = c.get(volatilitySum);
    const er = ne(volatility, 0) ? change / volatility : 0.0;
    const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
    const prev = c.prev();
    return na(prev) ? src : prev + sc * (src - prev);
  });
}

function body(): void {
  strategy('Aurora KAMA Trend', {
    shorttitle: 'Aurora-KAMA',
    overlay: true,
    initial_capital: 10000,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 25,
    commission_type: strategy.commission.percent,
    commission_value: 0.05,
    slippage: 1,
    pyramiding: 1,
    calc_on_order_fills: false,
    max_labels_count: 500,
  });

  //#region --- Inputs ---
  const G1 = { group: 'KAMA Settings' };
  const src = input.source('close', 'Source', G1);
  const kamaLen = input.int(10, 'Efficiency Ratio Length', { minval: 2, ...G1 });
  const fastLen = input.int(2, 'Fast EMA Length', { minval: 1, ...G1 });
  const slowLen = input.int(30, 'Slow EMA Length', { minval: 1, ...G1 });

  const G2 = { group: 'Trend Confirmation' };
  const risingLen = input.int(3, 'KAMA Rising Persistence (bars)', { minval: 1, ...G2 });
  const fallingLen = input.int(3, 'KAMA Falling Persistence (bars)', { minval: 1, ...G2 });
  const useSmaFilter = input.bool(true, 'Use Long-Term Trend Filter', G2);
  const smaLen = input.int(200, 'Trend Filter SMA Length', G2);

  const G3 = { group: 'Trade Management' };
  const direction = input.string('Long and Short', 'Trade Direction', { options: ['Long', 'Short', 'Long and Short'], ...G3 });
  const barsBetween = input.int(5, 'Minimum Bars Between Entries', { minval: 0, ...G3 });

  const G4 = { group: 'Risk Management' };
  const useStop = input.bool(true, 'Use Fixed Stop Loss %', G4);
  const stopPct = input.float(4.0, 'Stop Loss %', { minval: 0.1, ...G4 });
  const useTrail = input.bool(true, 'Use Delayed Trailing Stop', G4);
  const trailPct = input.float(6.0, 'Trailing Stop %', { minval: 0.1, ...G4 });
  const trailDelay = input.int(5, 'Delay Trailing by N Bars', { minval: 0, ...G4 });
  //#endregion

  //#region --- KAMA calculation ---
  const kamaVal = kama(src, kamaLen, fastLen, slowLen);
  const trendSma = ta.sma(close, smaLen);
  //#endregion

  //#region --- Signal logic ---
  const kamaRising = ta.rising(kamaVal, risingLen);
  const kamaFalling = ta.falling(kamaVal, fallingLen);

  const allowLong = direction === 'Long' || direction === 'Long and Short';
  const allowShort = direction === 'Short' || direction === 'Long and Short';

  let lastTradeBar = NaN;
  let prevPositionSize = NaN;
  const longEntries: number[] = [];
  const shortEntries: number[] = [];
  const closedFromLongs: number[] = [];
  const closedFromShorts: number[] = [];
  strategy.eachBar((c) => {
    const cl = c.close;
    const sma = c.get(trendSma);
    const rising = c.get(kamaRising) === 1;
    const falling = c.get(kamaFalling) === 1;
    const longTrendOk = !useSmaFilter || gt(cl, sma);
    const shortTrendOk = !useSmaFilter || lt(cl, sma);
    const cooldownOk = na(lastTradeBar) || c.i - lastTradeBar >= barsBetween;

    const longSignal = rising && longTrendOk && allowLong && cooldownOk;
    const shortSignal = falling && shortTrendOk && allowShort && cooldownOk;

    //#region --- Orders ---
    let longEntry = false;
    let shortEntry = false;

    if (longSignal && le(strategy.position_size, 0)) {
      strategy.close('Short');
      strategy.entry('Long', strategy.long);
      lastTradeBar = c.i;
      longEntry = true;
    }

    if (shortSignal && ge(strategy.position_size, 0)) {
      strategy.close('Long');
      strategy.entry('Short', strategy.short);
      lastTradeBar = c.i;
      shortEntry = true;
    }

    // --- Risk management: stop loss + delayed trailing stop ---
    const inPosition = gt(strategy.opentrades, 0);
    const barsInPosition = inPosition ? c.i - (strategy.opentrade(0)?.entry_bar_index ?? NaN) : 0;
    const trailArmed = inPosition && ge(barsInPosition, trailDelay);

    const avg = strategy.position_avg_price;
    const stopDist = (avg * stopPct) / 100;
    const trailDist = (avg * trailPct) / 100;

    if (gt(strategy.position_size, 0)) {
      strategy.exit('Exit Long', {
        from_entry: 'Long',
        stop: useStop ? avg - stopDist : NaN,
        trail_points: useTrail && trailArmed ? trailDist / syminfo.mintick : NaN,
        trail_offset: useTrail && trailArmed ? trailDist / syminfo.mintick : NaN,
      });
    }

    if (lt(strategy.position_size, 0)) {
      strategy.exit('Exit Short', {
        from_entry: 'Short',
        stop: useStop ? avg + stopDist : NaN,
        trail_points: useTrail && trailArmed ? trailDist / syminfo.mintick : NaN,
        trail_offset: useTrail && trailArmed ? trailDist / syminfo.mintick : NaN,
      });
    }

    // --- Close markers ---
    const pos = strategy.position_size;
    const posJustClosed = ne(prevPositionSize, 0) && eq(pos, 0);
    const wasShort = lt(prevPositionSize, 0);
    const wasLong = gt(prevPositionSize, 0);
    prevPositionSize = pos;
    //#endregion

    longEntries.push(longEntry ? 1 : 0);
    shortEntries.push(shortEntry ? 1 : 0);
    closedFromLongs.push(posJustClosed && wasLong ? 1 : 0);
    closedFromShorts.push(posJustClosed && wasShort ? 1 : 0);
  });
  //#endregion

  //#region --- Visuals ---
  // KAMA line, colored by trend direction, with a red/green glow filling the gap between KAMA and price.
  const risingArr = kamaRising.toArray();
  const fallingArr = kamaFalling.toArray();
  const kamaColor = risingArr.map((r, i) => (r === 1 ? '#00e676' : fallingArr[i] === 1 ? '#ff5252' : color.gray));

  const plotKama = plot(kamaVal, 'KAMA', { color: kamaColor, linewidth: 2 });
  const plotClose = plot(close, 'Close', { display: 'none' });

  const glowTop = eachBar((c) => Math.max(c.get(kamaVal), c.close));
  const glowBottom = eachBar((c) => Math.min(c.get(kamaVal), c.close));
  fill(plotKama, plotClose, glowTop, kamaVal, color.new('#00e676', 80), color.new('#00e676', 60), 'Bullish Glow');
  fill(plotKama, plotClose, kamaVal, glowBottom, color.new('#ff5252', 60), color.new('#ff5252', 80), 'Bearish Glow');

  // Long-term trend SMA rendered as a layered glow, colored gold when rising and amber when falling.
  const smaSlope = ta.change(trendSma, 5).toArray();
  const smaCoreColor = smaSlope.map((s) => (gt(s, 0) ? '#ffd600' : lt(s, 0) ? '#ff9100' : '#ffe082'));
  const smaPlot = useSmaFilter ? trendSma : trendSma.mul(NaN);
  const withAlpha = (transp: number) => smaCoreColor.map((col) => color.new(col, transp));

  plot(smaPlot, 'SMA Glow Outer', { color: withAlpha(88), linewidth: 6 });
  plot(smaPlot, 'SMA Glow Mid', { color: withAlpha(72), linewidth: 4 });
  plot(smaPlot, 'SMA Glow Inner', { color: withAlpha(45), linewidth: 2 });
  plot(smaPlot, 'SMA Core', { color: smaCoreColor, linewidth: 1 });

  // Entry markers: triangles at long/short entries. Exit markers: gray X's where a position was closed.
  plotshape(seriesOf(longEntries), 'Buy', { style: 'triangleup', location: 'belowbar', color: '#00e676', size: 'tiny' });
  plotshape(seriesOf(shortEntries), 'Sell', { style: 'triangledown', location: 'abovebar', color: '#ff5252', size: 'tiny' });
  plotshape(seriesOf(closedFromLongs), 'Exit Long', { style: 'xcross', location: 'abovebar', color: color.new(color.gray, 20), size: 'tiny' });
  plotshape(seriesOf(closedFromShorts), 'Exit Short', { style: 'xcross', location: 'belowbar', color: color.new(color.gray, 20), size: 'tiny' });
  //#endregion
}

export const auroraKama: ScriptStrategy = {
  key: 'aurora-kama',
  source: { id: 'PUB;426d44d5850b4168b7bfb48e03e8e0d6', name: 'Aurora KAMA | KAMA Adaptive Trend Strategy', author: 'blitz_locked' },
  body,
};
