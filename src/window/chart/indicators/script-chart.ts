/*
 * The chart context OakScript scripts see (oakscriptjs ChartContext): chart
 * timeframe (timeframe.period), exchange time zone and session of the bars
 * (time(tf, session), session.*, calendar, timeframe.change...), tickerid.
 * Time zone and sessions are the charted symbol's own (data/session); until
 * they resolve the script gets the library defaults. Reactive: read inside an
 * effect, the context updates once the symbol's session arrives.
 */
import type { ChartContext } from "oakscriptjs/script";
import { cachedSymbolSessions, type SessionId } from "../../../data/session";

export function scriptChartContext(symbol: string | undefined, interval: string | undefined, session: SessionId | undefined): ChartContext {
  const extended = session === "ETH";
  const ctx: ChartContext = {
    timeframe: interval ?? "1D",
    tickerid: symbol || undefined,
    sessionType: extended ? "extended" : "regular",
  };
  const sessions = symbol ? cachedSymbolSessions(symbol) : null;
  if (sessions) {
    ctx.timezone = sessions.timeZone;
    ctx.session = extended ? sessions.extendedSpec : sessions.regularSpec;
    ctx.regularSession = sessions.regularSpec;
    ctx.mintick = sessions.mintick;
  }
  return ctx;
}
