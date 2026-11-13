/*
 * Sizing of the loads that take a chart to a date (Go to, date-range / time
 * sync, linked tabs): whether it loads a window of past bars around the date
 * or the bars between it and the loaded ones, and which part of a synced range
 * a pane can show at all.
 */

/** Trading days from `fromSec` up to `beforeSec` (the backend sizes history
 *  windows in trading days): weekdays plus a holiday margin. */
export function tradingDaysBetween(fromSec: number, beforeSec: number): number {
  const cal = Math.max(0, (beforeSec - fromSec) / 86400);
  return Math.max(1, Math.ceil((cal * 5) / 7) + 2 + Math.ceil(cal / 36));
}

/** True when a load to [fromSec, toSec] takes a window of past bars around it:
 *  more than `maxPages` history pages (`pageDays` trading days each) lie
 *  between the range and the loaded bars [firstSec, lastSec], before them
 *  (`olderMissing`: the range starts before them and older bars can load) or
 *  after them when they are a window of past bars (`inWindow`). Closer, the
 *  bars in between are loaded instead. */
export function wantsPastWindow(r: {
  fromSec: number;
  toSec: number;
  firstSec: number;
  lastSec: number;
  olderMissing: boolean;
  inWindow: boolean;
  pageDays: number;
  maxPages: number;
}): boolean {
  const far = (days: number) => days / r.pageDays > r.maxPages;
  if (r.inWindow && r.toSec > r.lastSec && far(tradingDaysBetween(r.lastSec, r.toSec))) return true;
  return r.olderMissing && far(tradingDaysBetween(r.fromSec, r.firstSec));
}

/** Start of the part of [fromSec, toSec] a pane can show: a range of more bars
 *  than fit at the least bar spacing (`shownBars`) is shown by its end (the
 *  chart keeps the right edge), so the bars before its last `shownBars` are
 *  never seen. Their trading days at `barsPerDay`, in calendar days with the
 *  weekends and a day of margin. */
export function shownRangeStart(fromSec: number, toSec: number, shownBars: number, barsPerDay: number): number {
  const days = Math.ceil(shownBars / Math.max(1, barsPerDay));
  return Math.max(fromSec, toSec - Math.ceil((days * 7) / 5 + 1) * 86400);
}
