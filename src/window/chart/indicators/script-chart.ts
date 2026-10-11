/*
 * The chart context studies see: the oakscriptjs ChartContext of OakScript
 * scripts, which is also the optional third argument of the library
 * indicators' calculate(). Chart timeframe (timeframe.period), exchange time
 * zone and session of the bars (time(tf, session), session.*, calendar,
 * timeframe.change...), tickerid, price grid and the chart background.
 * Time zone, sessions and price grid are the charted symbol's own
 * (data/session); until they resolve the study gets the library defaults.
 * Reactive: read inside an effect, the context updates once the symbol's
 * session arrives.
 */
import type { ChartContext } from "oakscriptjs/script";
import { DEFAULT_SYMBOL } from "../../../backtester/types";
import { cachedSymbolSessions, type SessionId } from "../../../data/session";

/** `backgroundColor`: the chart background (script `chart.bg_color`). */
export type StudyChart = ChartContext & { backgroundColor?: string };

export function scriptChartContext(
  symbol: string | undefined,
  interval: string | undefined,
  session: SessionId | string | undefined,
  backgroundColor?: string,
): StudyChart {
  const extended = session === "ETH";
  const ctx: StudyChart = {
    timeframe: interval ?? "1D",
    tickerid: symbol || undefined,
    sessionType: extended ? "extended" : "regular",
    // Whole shares, one currency unit per point (the strategies' symbol).
    pointvalue: DEFAULT_SYMBOL.pointValue,
    mincontract: DEFAULT_SYMBOL.qtyStep,
  };
  if (backgroundColor) ctx.backgroundColor = backgroundColor;
  const sessions = symbol ? cachedSymbolSessions(symbol) : null;
  if (sessions) {
    ctx.timezone = sessions.timeZone;
    ctx.session = extended ? sessions.extendedSpec : sessions.regularSpec;
    ctx.regularSession = sessions.regularSpec;
    ctx.mintick = sessions.mintick;
    ctx.minmove = sessions.minmove;
    ctx.pricescale = sessions.pricescale;
  }
  return ctx;
}
