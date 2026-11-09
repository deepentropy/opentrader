import { describe, expect, it } from "vitest";
import type { TimeScalePoint } from "lightweight-charts";
import { zonedTimeScale } from "../view/zoned-time-scale";
import { barTimeZone } from "../view/helpers";

const points = (times: number[]) => times.map((t) => ({ timeWeight: 0, originalTime: t, time: {} }) as unknown as TimeScalePoint);
const weigh = (times: number[], tz: string, intraday: boolean, exchange: string) => {
  const ts = zonedTimeScale({ zoneOf: (sec) => barTimeZone(tz, intraday, sec, exchange), realTime: (t) => t, key: () => tz });
  const p = points(times);
  ts.behavior.fillWeightsForPoints(p, 0);
  return p.map((x) => x.timeWeight);
};
const utc = (s: string) => Date.parse(s) / 1000;

describe("zoned time scale (#270)", () => {
  it("gives the month tick to the first session of the month on daily bars east of UTC", () => {
    // Kolkata midnights: 18:30 UTC the day before.
    const days = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"].map((d) => utc(`${d}T00:00:00+05:30`));
    const w = weigh(days, "America/New_York", false, "Asia/Kolkata");
    expect(w.slice(1)).toEqual([50, 60, 50]);
  });

  it("keeps weekly bars at UTC midnight in UTC", () => {
    const weeks = ["2025-12-22", "2025-12-29", "2026-01-05"].map((d) => utc(`${d}T00:00:00Z`));
    expect(weigh(weeks, "America/New_York", false, "America/New_York").slice(1)).toEqual([50, 70]);
  });

  it("puts intraday day ticks at the chart zone's midnight", () => {
    // Hourly bars of a round-the-clock symbol around New York midnight (04:00 UTC in summer).
    const hours = [2, 3, 4, 5].map((h) => utc(`2026-07-02T0${h}:00:00Z`));
    expect(weigh(hours, "America/New_York", true, "UTC").slice(1)).toEqual([30, 50, 30]);
    expect(weigh(hours, "UTC", true, "UTC").slice(1)).toEqual([31, 30, 30]);
  });

  it("reports stale weights when the zone changes", () => {
    let tz = "UTC";
    const ts = zonedTimeScale({ zoneOf: () => tz, realTime: (t) => t, key: () => tz });
    expect(ts.stale()).toBe(false);
    ts.behavior.fillWeightsForPoints(points([0, 3600]), 0);
    expect(ts.stale()).toBe(false);
    tz = "Asia/Tokyo";
    expect(ts.stale()).toBe(true);
  });
});
