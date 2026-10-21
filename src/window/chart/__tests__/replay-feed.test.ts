import { describe, expect, it } from "vitest";
import type { Time } from "lightweight-charts";
import { ReplayFeed, lastAtOrBefore } from "../replay-feed";
import type { OHLC } from "../chart-types";
import { autoUpdateInterval, clampDelay, fallbackUpdateInterval, updateIntervals } from "../../../data/replay";

const bar = (time: number, o: number, h: number, l: number, c: number, v = 10): OHLC => ({ time: time as Time, open: o, high: h, low: l, close: c, volume: v });

const D = 86400;
// Three daily bars and their hourly sub-bars (3 per day).
const days = [bar(0, 10, 13, 9, 12, 30), bar(D, 12, 15, 11, 14, 30), bar(2 * D, 14, 16, 13, 13, 30)];
const hours = (day: number, rows: [number, number, number, number][]) =>
  rows.map(([o, h, l, c], i) => bar(day * D + 34200 + i * 3600, o, h, l, c));

describe("lastAtOrBefore", () => {
  it("finds the bar a time falls in", () => {
    expect(lastAtOrBefore(days, -1)).toBe(-1);
    expect(lastAtOrBefore(days, 0)).toBe(0);
    expect(lastAtOrBefore(days, D - 1)).toBe(0);
    expect(lastAtOrBefore(days, 5 * D)).toBe(2);
  });
});

describe("ReplayFeed on the chart interval", () => {
  it("cuts before the clicked bar and reveals one bar per update", () => {
    const f = new ReplayFeed(days.slice(), D - 1, false);
    expect(f.shown.map((b) => b.time)).toEqual([0]);
    expect(f.nextTime()).toBe(D);
    const ch = f.advanceTo(D);
    expect(ch).toEqual([{ bar: days[1], appended: true }]);
    expect(f.nextTime()).toBe(2 * D);
    f.advanceTo(2 * D);
    expect(f.nextTime()).toBeNull();
  });
});

describe("ReplayFeed on sub-bars", () => {
  const subs = [
    ...hours(1, [[12, 13, 11, 12.5], [12.5, 15, 12, 14.5], [14.5, 14.8, 13.5, 14]]),
    ...hours(2, [[14, 16, 14, 15], [15, 15.5, 13, 13.5], [13.5, 14, 13, 13]]),
  ];

  it("forms the bar from its sub-bars, then closes it with the real values", () => {
    const f = new ReplayFeed(days.slice(), D - 1, true);
    f.seed(subs, D - 1);
    f.subDone = true;
    let t = f.nextTime()!;
    expect(t).toBe(D + 34200);
    let ch = f.advanceTo(t);
    expect(ch).toHaveLength(1);
    expect(ch[0].appended).toBe(true);
    expect(ch[0].bar).toMatchObject({ time: D, open: 12, high: 13, low: 11, close: 12.5, volume: 10 });
    t = f.nextTime()!;
    ch = f.advanceTo(t);
    expect(ch[0]).toMatchObject({ appended: false, bar: { open: 12, high: 15, low: 11, close: 14.5, volume: 20 } });
    f.advanceTo(f.nextTime()!);
    // Next day: the forming day takes its real values, the new one opens.
    ch = f.advanceTo(f.nextTime()!);
    expect(ch.map((c) => c.appended)).toEqual([false, true]);
    expect(ch[0].bar).toBe(days[1]);
    expect(ch[1].bar).toMatchObject({ time: 2 * D, open: 14, close: 15 });
    f.advanceTo(f.nextTime()!);
    f.advanceTo(f.nextTime()!);
    expect(f.nextTime()).toBeNull();
    expect(f.shown).toHaveLength(3);
  });

  it("rebuilds the bar the replay time falls in from its sub-bars so far", () => {
    const point = D + 34200 + 3600; // after the second hour of day 1
    const f = new ReplayFeed(days.slice(), point, true);
    f.seed(subs, point);
    expect(f.shown).toHaveLength(2);
    expect(f.shown[1]).toMatchObject({ time: D, open: 12, high: 15, low: 11, close: 14.5, volume: 20 });
    expect(f.nextTime()).toBe(D + 34200 + 7200);
  });

  it("hides a bar that has not started at the replay time", () => {
    const point = D + 100; // day 1 opened (stamp), first hour not yet
    const f = new ReplayFeed(days.slice(), point, true);
    f.seed(subs, point);
    expect(f.shown).toHaveLength(1);
    expect(f.nextTime()).toBe(D + 34200);
  });

  it("waits for more sub-bars, and shows whole bars with none", () => {
    const f = new ReplayFeed(days.slice(), D - 1, true);
    f.seed([], D - 1);
    expect(f.nextTime()).toBeUndefined();
    f.subDone = true;
    expect(f.nextTime()).toBe(D);
    expect(f.advanceTo(D)).toEqual([{ bar: days[1], appended: true }]);
  });

  it("shows a bar with no sub-bar of its own whole before the next sub-bar", () => {
    const f = new ReplayFeed(days.slice(), D - 1, true);
    f.seed(hours(2, [[14, 16, 14, 15]]), D - 1);
    expect(f.nextTime()).toBe(D);
    expect(f.advanceTo(D)).toEqual([{ bar: days[1], appended: true }]);
    expect(f.nextTime()).toBe(2 * D + 34200);
  });

  it("asks for newer chart bars when its window ends", () => {
    const f = new ReplayFeed(days.slice(0, 2), D - 1, false);
    f.fullOpen = true;
    expect(f.nextTime()).toBe(D);
    f.advanceTo(D);
    expect(f.needs()).toBe("full");
    expect(f.nextTime()).toBeUndefined();
    f.appendFull([days[2]]);
    expect(f.nextTime()).toBe(2 * D);
    f.advanceTo(2 * D);
    f.fullOpen = false;
    expect(f.nextTime()).toBeNull();
  });

  it("loads chart bars before sub-bars past its window", () => {
    const f = new ReplayFeed(days.slice(0, 2), D - 1, true);
    f.fullOpen = true;
    f.seed(hours(2, [[14, 16, 14, 15]]), D - 1);
    f.subDone = true;
    // The sub-bar of day 2 needs day 2's chart bar first.
    expect(f.needs()).toBe("full");
    f.appendFull([days[2]]);
    f.fullOpen = false;
    expect(f.nextTime()).toBe(D);
  });

  it("keeps older bars loaded during the replay", () => {
    const f = new ReplayFeed(days.slice(1), D - 1 + D, false);
    f.prepend([days[0]]);
    expect(f.shown.map((b) => b.time)).toEqual([0, D]);
    expect(f.nextTime()).toBe(2 * D);
  });
});

describe("update intervals", () => {
  it("follows the chart interval", () => {
    expect(updateIntervals(["1"])).toEqual(["1S", "1"]);
    expect(updateIntervals(["5"])).toEqual(["1S", "1", "5"]);
    expect(updateIntervals(["60"])).toEqual(["1S", "1", "3", "5", "10", "15", "30", "60"]);
    expect(updateIntervals(["1D"])).toEqual(["60", "120", "180", "240", "1D"]);
    expect(updateIntervals(["1W"])).toEqual(["1D"]);
    expect(updateIntervals(["1M"])).toEqual(["1D"]);
    expect(updateIntervals(["10S"])).toEqual(["1S", "5S", "10S"]);
  });
  it("divides every chart of the replay", () => {
    expect(updateIntervals(["15", "5"])).toEqual(["1S", "1", "5"]);
  });
  it("drops the intervals without data at the replay point", () => {
    expect(updateIntervals(["1D"], (id) => id === "1D")).toEqual(["1D"]);
  });
  it("Auto is the coarsest", () => {
    expect(autoUpdateInterval(["1S", "1", "5"], "5")).toBe("5");
    expect(autoUpdateInterval([], "1W")).toBe("1D");
  });
  it("replaces a fixed interval no longer offered", () => {
    expect(fallbackUpdateInterval(["1S", "1"], "5")).toBe("1");
    expect(fallbackUpdateInterval(["1S", "1", "5"], "5")).toBe("5");
  });
  it("clamps speeds", () => {
    expect(clampDelay(1000)).toBe(1000);
    expect(clampDelay(120)).toBe(100);
    expect(clampDelay(99999)).toBe(10000);
  });
});
