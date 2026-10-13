/**
 * Technical ratings strategy (built-in): long when the chosen rating (`calcRatingAll()` of the TechnicalRating
 * library, from the indicator library's Technical Ratings port) is above 0.5, short when it is below -0.5; every
 * trade has a stop loss of 3 ATR and a trailing stop activated at 5 ATR with a 2 ATR offset.
 */
import { compare } from 'oakscriptjs';
import type { calculateTechnicalRatingsStandard } from 'lightweight-charts-indicators';
import { close, high, input, low, open, strategy, syminfo, ta, time, timeframe, volume } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

const STRONG_BOUND = 0.5;

/** The indicator library's Technical Ratings, given by the host before a run (the backtest worker loads the library on
 *  demand: it is large and only this strategy needs it). */
let ratingsOf: typeof calculateTechnicalRatingsStandard | null = null;
export function provideTechnicalRatings(fn: typeof calculateTechnicalRatingsStandard): void {
  ratingsOf = fn;
}
export const TECHNICAL_RATINGS_KEY = 'technical-ratings';

function body(): void {
  strategy('Technical ratings strategy', {
    shorttitle: 'Technicals str',
    overlay: true,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 5,
  });

  const res = input.timeframe('', 'Indicator Timeframe');
  const ratingSignal = input.string('All', 'Rating is based on', { options: ['MAs', 'Oscillators', 'All'] });

  // request.security(syminfo.tickerid, res, rating.calcRatingAll()): the rating plot of the Technical Ratings
  // indicator with the same timeframe and rating, on the confirmed history.
  const times = time.toArray();
  const opens = open.toArray();
  const highs = high.toArray();
  const lows = low.toArray();
  const closes = close.toArray();
  const volumes = volume.toArray();
  const bars = times.map((t, i) => ({ time: t / 1000, open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] }));
  if (bars.length && !ratingsOf) throw new Error('Technical ratings strategy: the indicator library is not loaded.');
  const ratings = bars.length && ratingsOf
    ? ratingsOf(
        bars,
        {
          timeframe: res,
          ratingSignal: ratingSignal as 'MAs' | 'Oscillators' | 'All',
          plotConfirmed: false,
          // No table: the strategy reads the rating only.
          useMtf1: false,
          useMtf2: false,
          useMtf3: false,
          useMtf4: false,
          useMtf5: false,
        },
        { timeframe: timeframe.period, timezone: syminfo.timezone, tickerid: syminfo.tickerid, lastBarConfirmed: true },
      )
    : undefined;
  const plot = ratings ? (Object.values(ratings.plots)[0] as { time: number; value?: number }[]) : [];
  const tradeSignal = bars.map((_, i) => plot[i]?.value ?? NaN);
  const atr = ta.atr(14);

  strategy.eachBar((c) => {
    const signal = tradeSignal[c.i];
    if (gt(signal, STRONG_BOUND)) strategy.entry('long', strategy.long);
    if (lt(signal, -STRONG_BOUND)) strategy.entry('short', strategy.short);
    const dynSLpoints = (factor: number) => (factor * c.get(atr)) / syminfo.mintick;
    strategy.exit('sl/tp', { loss: dynSLpoints(3), trail_points: dynSLpoints(5), trail_offset: dynSLpoints(2) });
  });
}

export const technicalRatings: ScriptStrategy = {
  key: TECHNICAL_RATINGS_KEY,
  source: { id: 'STD;Technical%1Ratings%1Strategy', name: 'Technical ratings strategy', author: '' },
  body,
};
