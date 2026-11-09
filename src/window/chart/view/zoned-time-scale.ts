/*
 * The chart's time scale with its year / month / day / hour ticks placed in
 * the zone each bar's label is read in (#270). The chart library weighs every
 * bar by its UTC date: a daily bar stamped at an exchange midnight before
 * 00:00 UTC (Kolkata, Tokyo, London in summer) carries the previous UTC date,
 * so the month tick landed one bar after the first session of the month, and
 * a round-the-clock symbol in New York got its day ticks at 20:00. Here the weights
 * come from the bar's local wall time in that zone, the labels' zone
 * (barTimeZone), so a tick and its text agree.
 */
import { defaultHorzScaleBehavior, type TimeScalePoint } from "lightweight-charts";
import { zoneOffsetFinder } from "../../../data/session";

/** Where a chart reads its bar times. */
export type TickZone = {
  /** Zone the label of bar time `sec` is read in. */
  zoneOf: (sec: number) => string;
  /** Real time of a point (a price-based type's brick has a synthetic one). */
  realTime: (t: number) => number;
  /** Changes when `zoneOf` would answer differently (time zone, interval, exchange zone). */
  key: () => string;
};

// The library's tick weights (TickMarkWeight), which its tick formatter maps to labels.
const YEAR = 70;
const MONTH = 60;
const DAY = 50;
const H = 3600_000;
const INTRADAY: readonly [number, number][] = [
  [1000, 10],
  [60_000, 20],
  [300_000, 21],
  [1_800_000, 22],
  [H, 30],
  [3 * H, 31],
  [6 * H, 32],
  [12 * H, 33],
];

/** Weight of a bar from its local wall time and the previous bar's (ms, read as UTC). */
export function tickWeight(cur: number, prev: number): number {
  const c = new Date(cur);
  const p = new Date(prev);
  if (c.getUTCFullYear() !== p.getUTCFullYear()) return YEAR;
  if (c.getUTCMonth() !== p.getUTCMonth()) return MONTH;
  if (c.getUTCDate() !== p.getUTCDate()) return DAY;
  for (let i = INTRADAY.length - 1; i >= 0; i--) {
    const d = INTRADAY[i][0];
    if (Math.floor(prev / d) !== Math.floor(cur / d)) return INTRADAY[i][1];
  }
  return 0;
}

type Point = { timeWeight: number; readonly originalTime: unknown };

/** The time scale of a chart (createChartEx). `stale()`: the weights were
 *  given in another zone than the chart's current one. */
export function zonedTimeScale(zone: TickZone) {
  const Base = defaultHorzScaleBehavior();
  let weighedKey: string | null = null;
  const behavior = new (class extends Base {
    override fillWeightsForPoints(sortedTimePoints: readonly TimeScalePoint[], startIndex: number): void {
      const points = sortedTimePoints as unknown as Point[];
      if (points.length === 0) return;
      if (startIndex === 0) weighedKey = zone.key();
      const local = (p: Point) => {
        const sec = zone.realTime(p.originalTime as number);
        return (sec + zoneOffsetFinder(zone.zoneOf(sec))(sec)) * 1000;
      };
      let prev = startIndex === 0 ? null : local(points[startIndex - 1]);
      let first: number | null = null;
      for (let i = startIndex; i < points.length; i++) {
        const cur = local(points[i]);
        if (first === null) first = cur;
        if (prev !== null) points[i].timeWeight = tickWeight(cur, prev);
        prev = cur;
      }
      // The first bar's weight: as if the bar before it were the average spacing back.
      if (startIndex === 0 && points.length > 1 && first !== null && prev !== null) {
        const avg = Math.ceil((prev - first) / (points.length - 1) / 1000) * 1000;
        points[0].timeWeight = tickWeight(first, first - avg);
      }
    }
  })();
  return { behavior, stale: () => weighedKey !== null && weighedKey !== zone.key() };
}
