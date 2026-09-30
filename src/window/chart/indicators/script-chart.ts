/*
 * The chart context OakScript scripts see (oakscriptjs ChartContext): chart
 * timeframe (timeframe.period), exchange time zone and session of the bars
 * (time(tf, session), session.*, calendar, timeframe.change...), tickerid.
 */
import type { ChartContext } from "oakscriptjs/script";
import type { SessionId } from "../../../data/datafeed";

/** US equity sessions in exchange time (the datafeed's RTH / ETH bars). */
const REGULAR_SESSION = "0930-1600";
const EXTENDED_SESSION = "0400-2000";

export function scriptChartContext(symbol: string | undefined, interval: string | undefined, session: SessionId | undefined): ChartContext {
  const extended = session === "ETH";
  return {
    timeframe: interval ?? "1D",
    timezone: "America/New_York",
    tickerid: symbol || undefined,
    sessionType: extended ? "extended" : "regular",
    session: extended ? EXTENDED_SESSION : REGULAR_SESSION,
    regularSession: REGULAR_SESSION,
  };
}
