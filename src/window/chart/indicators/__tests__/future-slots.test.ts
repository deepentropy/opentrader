// Drawing points on whole bars across intervals (issue #74): the cases measured on the reference app with SPY in
// October 2026 (5 minute / 1 hour / 4 hour / daily, regular and extended hours, points before the first loaded bar).
import { describe, expect, it } from "vitest";
import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { makeCoords, type FutureAxis } from "lightweight-charts-drawing/runtime/coords";
import type { OHLC } from "lightweight-charts-drawing/core/coords";
import { SessionSpec } from "../../../../data/session/spec";
import { localToUtc } from "../../../../data/session/zone";
import { sessionFutureAxis } from "../future-slots";

const NY = "America/New_York";
const HOLIDAYS = "20260907,20261126,20261225";
const rth = new SessionSpec(NY, "0930-1600", HOLIDAYS);
const eth = new SessionSpec(NY, "0400-2000", HOLIDAYS);
const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000;
/** New York wall time -> epoch seconds. */
const ny = (y: number, m: number, d: number, hh = 0, mm = 0) => localToUtc(NY, dayOf(y, m, d), hh * 60 + mm);

/** Bars of `step` seconds (0 = daily at local midnight) on `spec` from `from` (a bar open) to the 14/10/2026 close. */
function bars(spec: SessionSpec, step: number, from: number): OHLC[] {
  const out: OHLC[] = [];
  for (let day = dayOf(2026, 7, 1); day <= dayOf(2026, 10, 14); day++) {
    if (step === 0) {
      const t = localToUtc(NY, day, 0);
      if (spec.isTradingDay(day) && t >= from) out.push({ time: t as Time, open: 1, high: 1, low: 1, close: 1 });
      continue;
    }
    for (const s of spec.dayIntervals(day)) {
      for (let t = s.start; t < s.end; t += step) if (t >= from) out.push({ time: t as Time, open: 1, high: 1, low: 1, close: 1 });
    }
  }
  return out;
}

const SP = 10; // px per bar
function coordsOn(raw: OHLC[], interval: string, spec: SessionSpec) {
  const L = raw.length - 1;
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (t: Time) => {
        const i = raw.findIndex((b) => b.time === t);
        return i < 0 ? null : i * SP;
      },
      coordinateToTime: (x: number) => {
        const i = Math.round(x / SP);
        return i >= 0 && i <= L ? raw[i].time : null;
      },
      coordinateToLogical: (x: number) => x / SP,
      logicalToCoordinate: (l: number) => (Number.isInteger(l) ? l * SP : 0),
    }),
  } as unknown as IChartApi;
  const axis = sessionFutureAxis(interval, spec, rth) as FutureAxis;
  const c = makeCoords(chart, {} as ISeriesApi<SeriesType>, () => raw, undefined, undefined, () => axis);
  /** Open time of the bar a time is drawn on. */
  const barOf = (t: number) => {
    const i = c.timeToBarIndex(t as Time);
    return i == null ? null : (c.barIndexToTime(i) as number);
  };
  return { c, barOf };
}

describe("a time between two bars is drawn on the bar that holds it", () => {
  const d5 = coordsOn(bars(rth, 300, ny(2026, 10, 9, 10, 30)), "5", rth);
  const h1 = coordsOn(bars(rth, 3600, ny(2026, 8, 14, 10, 30)), "60", rth);
  const h4 = coordsOn(bars(rth, 4 * 3600, 0), "240", rth);
  const m15 = coordsOn(bars(rth, 900, 0), "15", rth);
  const d1 = coordsOn(bars(rth, 0, 0), "1D", rth);

  it("5 minute points 12/10 10:45 and 14:50 on 1 hour, 4 hour, 15 minute and daily charts", () => {
    const a = ny(2026, 10, 12, 10, 45);
    const b = ny(2026, 10, 12, 14, 50);
    expect([h1.barOf(a), h1.barOf(b)]).toEqual([ny(2026, 10, 12, 10, 30), ny(2026, 10, 12, 14, 30)]);
    expect([h4.barOf(a), h4.barOf(b)]).toEqual([ny(2026, 10, 12, 9, 30), ny(2026, 10, 12, 13, 30)]);
    expect([m15.barOf(a), m15.barOf(b)]).toEqual([ny(2026, 10, 12, 10, 45), ny(2026, 10, 12, 14, 45)]);
    expect([d1.barOf(a), d1.barOf(b)]).toEqual([ny(2026, 10, 12), ny(2026, 10, 12)]);
    // drawn on the bar's x, back on the 5 minute chart on its own bar
    expect(h1.c.timeToX(a as Time)).toBe(h1.c.timeToX(ny(2026, 10, 12, 10, 30) as Time));
    expect([d5.barOf(a), d5.barOf(b)]).toEqual([a, b]);
  });

  it("40 % and 60 % into a 5 minute bar", () => {
    const bar = ny(2026, 10, 13, 15, 0);
    expect(d5.barOf(bar + 120)).toBe(bar);
    expect(d5.barOf(bar + 180)).toBe(bar);
  });

  it("a point drawn on a daily bar goes to the first bar of its day (regular and extended hours)", () => {
    const day = ny(2026, 10, 12);
    expect(h1.barOf(day)).toBe(ny(2026, 10, 12, 9, 30));
    expect(d5.barOf(day)).toBe(ny(2026, 10, 12, 9, 30));
    const e5 = coordsOn(bars(eth, 300, ny(2026, 10, 9, 4, 0)), "5", eth);
    expect(e5.barOf(day)).toBe(ny(2026, 10, 12, 9, 30));
    expect(d1.barOf(day)).toBe(day);
  });

  it("extended-hours points: a pre-market time is on the previous daily bar, a gap time on the bar before the gap", () => {
    const pre = ny(2026, 10, 14, 5, 0);
    const post = ny(2026, 10, 13, 18, 0);
    expect([d1.barOf(pre), d1.barOf(post)]).toEqual([ny(2026, 10, 13), ny(2026, 10, 13)]);
    expect([d5.barOf(pre), d5.barOf(post)]).toEqual([ny(2026, 10, 13, 15, 55), ny(2026, 10, 13, 15, 55)]);
    expect([h1.barOf(pre), h1.barOf(post)]).toEqual([ny(2026, 10, 13, 15, 30), ny(2026, 10, 13, 15, 30)]);
    const eDaily = coordsOn(bars(eth, 0, 0), "1D", eth);
    expect(eDaily.barOf(pre)).toBe(ny(2026, 10, 13));
  });

  it("before the first loaded bar: bars of the trading calendar (daily point 22/07 on 1 hour = -120, on 5 minutes = -4380)", () => {
    const p = ny(2026, 7, 22);
    expect(h1.c.timeToBarIndex(p as Time)).toBe(-120);
    expect(d5.c.timeToBarIndex(p as Time)).toBe(-4380);
    expect(h1.c.barIndexToTime(-120)).toBe(ny(2026, 7, 22, 9, 30));
    expect(d5.c.barIndexToTime(-4380)).toBe(ny(2026, 7, 22, 9, 30));
    expect(h1.c.timeToX(p as Time)).toBe(-120 * SP);
    // x left of the first bar -> the open time of that bar and back
    expect(h1.c.xToTime(-3 * SP)).toBe(ny(2026, 8, 13, 14, 30));
    expect(h1.c.timeToBarIndex(ny(2026, 8, 13, 14, 30) as Time)).toBe(-3);
    // a time inside an earlier bar is on that bar
    expect(h1.c.timeToBarIndex(ny(2026, 8, 13, 15, 29) as Time)).toBe(-3);
    // a daily chart counts trading days (Labor Day skipped)
    const dd = coordsOn(bars(rth, 0, ny(2026, 9, 9)), "1D", rth);
    expect(dd.c.timeToBarIndex(ny(2026, 9, 4, 11, 0) as Time)).toBe(-2);
    expect(dd.c.barIndexToTime(-2)).toBe(ny(2026, 9, 4));
  });
});
