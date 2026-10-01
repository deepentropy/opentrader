/*
 * Fast local-calendar-day keys for per-bar day-rollover scans (session
 * breaks, previous-day close). The zone offset comes from the shared
 * per-zone finder (data/session/zone.ts): one Intl call per 15-minute UTC
 * slot, then one Map lookup + arithmetic per bar.
 */
import { zoneOffsetFinder as offsetFinder } from "../../data/session/zone";

/** Returns `dayKey(sec)`: the day number (days since 1970-01-01) of the local
 *  calendar date of UNIX-seconds `sec` in `timeZone`. Two times share a key iff
 *  they fall on the same local date, so it is a drop-in for comparing
 *  `Intl.DateTimeFormat` date strings. */
export function dayKeyer(timeZone: string): (sec: number) => number {
  const offsetFor = offsetFinder(timeZone);
  return (sec: number) => Math.floor((sec + offsetFor(sec)) / 86400);
}

/** A calendar date as picked in a dialog (month 0-based), read in a chart's
 *  time zone by the receiver. */
export type WallDate = { y: number; m: number; d: number };

/** A calendar date + time of day (minutes after midnight). */
export type WallTime = WallDate & { minutes: number };

/** Wall-clock date and time of UNIX-seconds `sec` in `timeZone`. */
export function utcToWall(timeZone: string, sec: number): WallTime {
  const local = sec + offsetFinder(timeZone)(sec);
  const d = new Date(local * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** UNIX seconds of a wall-clock time in `timeZone` (month 0-based). A time
 *  skipped by a DST jump resolves one offset step later. */
export function wallTimeToUtc(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const offsetFor = offsetFinder(timeZone);
  const wall = Date.UTC(y, mo, d, h, mi) / 1000;
  const guess = wall - offsetFor(wall);
  return wall - offsetFor(guess);
}

/** Returns `minuteOfDay(sec)`: minutes since local midnight in `timeZone`. */
export function minuteOfDayer(timeZone: string): (sec: number) => number {
  const offsetFor = offsetFinder(timeZone);
  return (sec: number) => {
    const local = sec + offsetFor(sec);
    return Math.floor((((local % 86400) + 86400) % 86400) / 60);
  };
}
