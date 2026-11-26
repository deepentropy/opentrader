/*
 * A symbol's dividends, splits and earnings as scripts read them (`request.dividends`, `request.splits`,
 * `request.earnings`), from the events the chart marks (data/datafeed getEvents). Times as the reference stamps
 * them: dividends and splits at 00:00 UTC of their day; earnings before the open at 00:00 UTC of their day, after
 * the close (or at a time not known) at the end of that UTC day, so that an intraday chart shows them from the next
 * session and never before they were published. Earnings per share are adjusted for the splits after them, as the
 * reference gives them; dividends are as declared.
 */
import type { SymbolEvents } from "oakscriptjs/script";
import type { ChartEvent } from "../../../data/datafeed";

const DAY = 86_400_000;

/** 00:00 UTC (ms) of the calendar day of an event stamped at its exchange's local midnight (UNIX s): the nearest UTC
 *  midnight (local midnight is less than 12 hours from it in the exchanges' zones). */
const utcDay = (sec: number): number => Math.round(sec / 86400) * DAY;

const converted = new WeakMap<ChartEvent[], SymbolEvents>();

export function scriptEvents(list: ChartEvent[]): SymbolEvents {
  let out = converted.get(list);
  if (out) return out;
  const splits = list
    .filter((e) => e.kind === "split" && e.from && e.to && e.from > 0 && e.to > 0)
    .map((e) => ({ time: utcDay(e.time), numerator: e.to!, denominator: e.from! }));
  // Shares per share of the splits after a time.
  const splitFactor = (time: number) => splits.reduce((f, s) => (s.time > time ? f * (s.numerator / s.denominator) : f), 1);
  out = {
    dividends: list
      .filter((e) => e.kind === "dividend" && e.amount != null)
      .map((e) => ({ time: utcDay(e.time), net: e.amount!, gross: e.amount!, payDate: e.payDate == null ? null : utcDay(e.payDate) })),
    splits,
    earnings: list
      .filter((e) => e.kind === "earnings")
      .map((e) => {
        const day = utcDay(e.time);
        const time = e.session === "bmo" ? day : day + DAY - 1;
        return { time, actual: e.eps == null ? null : e.eps / splitFactor(time) };
      }),
  };
  converted.set(list, out);
  return out;
}
