/*
 * The Logs panel's filters (#323, #325): the levels shown, the search text and the start date (the toolbar's clock:
 * the messages from a date and time on, picked in the chart's time zone as the messages' times are shown).
 */
import type { LogEntry, LogLevel } from "oakscriptjs/script";
import { utcToWall, wallTimeToUtc, type WallDate, type WallTime } from "../../chart/day-key";

export type LogFilters = {
  levels: Record<LogLevel, boolean>;
  /** Text the message contains (any case); empty: all. */
  query: string;
  /** UNIX seconds of the first message time shown; null: from the first message. */
  from: number | null;
};

export function filterLogs(all: readonly LogEntry[], f: LogFilters): LogEntry[] {
  const q = f.query.trim().toLowerCase();
  return all.filter((e) => f.levels[e.level] && (f.from === null || e.time >= f.from) && (!q || e.message.toLowerCase().includes(q)));
}

/** Now in `timeZone`, down to the minute: where the start date dialog opens, and the latest start it takes. */
export function startDateNow(nowMs: number, timeZone: string): WallTime {
  return utcToWall(timeZone, Math.floor(nowMs / 60_000) * 60);
}

/** UNIX seconds of a start date picked in `timeZone` (`minutes` after midnight). */
export function startDateSeconds(date: WallDate, minutes: number, timeZone: string): number {
  return wallTimeToUtc(timeZone, date.y, date.m, date.d, Math.floor(minutes / 60), minutes % 60);
}
