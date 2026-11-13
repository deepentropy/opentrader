/*
 * What profiler mode shows (#312): one row per line that ran, its share of the run time, and for a code block (a
 * loop, an if, a statement with a callback) the time of its own line: the block's time without the rows inside it.
 */
import type { OakProfile } from "../engine-types";
import { numberText } from "../../../i18n/format";

export type ProfileRow = {
  /** First line, last line of a code block. */
  line: number;
  end?: number;
  invocations: number;
  /** µs */
  time: number;
  /** A code block: its time without the rows inside it (µs). */
  lineTime?: number;
  /** Share of the run time (%). */
  percent: number;
};

/** How many of the slowest rows are marked (only when there are more rows than that). */
export const HOT_ROWS = 3;

/** The rows of a profile, by line. Two spans on one line (`if (a) b();`): the outer one, whose time holds the other. */
export function profileRows(profile: OakProfile): ProfileRow[] {
  const byLine = new Map<number, ProfileRow>();
  for (const l of profile.lines) {
    const row: ProfileRow = {
      line: l.lines[0],
      end: l.lines[1],
      invocations: l.invocations,
      time: l.time,
      percent: profile.total > 0 ? (l.time / profile.total) * 100 : 0,
    };
    const had = byLine.get(row.line);
    if (!had || row.time > had.time || (row.end !== undefined && had.end === undefined)) byLine.set(row.line, row);
  }
  const rows = [...byLine.values()].sort((a, b) => a.line - b.line);
  // Each row takes its time out of the innermost block holding it.
  const blocks: ProfileRow[] = [];
  for (const row of rows) {
    while (blocks.length && blocks[blocks.length - 1].end! < row.line) blocks.pop();
    const parent = blocks[blocks.length - 1];
    if (parent) parent.lineTime = Math.max(0, (parent.lineTime ?? parent.time) - row.time);
    if (row.end !== undefined) {
      row.lineTime = row.time;
      blocks.push(row);
    }
  }
  return rows;
}

/** The lines of the slowest rows, slowest first (none when there are no more rows than that). */
export function hotLines(rows: ProfileRow[]): number[] {
  if (rows.length <= HOT_ROWS) return [];
  return [...rows].sort((a, b) => b.percent - a.percent).slice(0, HOT_ROWS).map((r) => r.line);
}

/** A share rounded to one decimal, as shown. */
export const roundPercent = (p: number): number => Math.round(p * 10) / 10;

/** A time in µs as shown: µs below 500 µs, ms below 500 ms, else s (one decimal). */
export function formatProfileTime(us: number): string {
  const n = (v: number) => numberText(v, { maximumFractionDigits: 1 });
  if (us < 500) return `${n(Math.round(us))} µs`;
  const ms = Math.round(us / 100) / 10;
  if (ms < 500) return `${n(ms)} ms`;
  return `${n(Math.round(ms / 100) / 10)} s`;
}
