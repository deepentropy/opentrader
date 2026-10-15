import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBILITY, isVisibleOnInterval } from "lightweight-charts-drawing/core/types";
import { intervalUnit, visibilityForMode } from "../interval-visibility-mode";

const off = (from: number, to: number) => ({ on: false, from, to });
const on = (from: number, to: number) => ({ on: true, from, to });

describe("intervalUnit", () => {
  it("reads the unit and value of the interval ids", () => {
    expect(intervalUnit("1T")).toEqual({ unit: "ticks", n: 1 });
    expect(intervalUnit("10S")).toEqual({ unit: "seconds", n: 10 });
    expect(intervalUnit("120S")).toEqual({ unit: "minutes", n: 2 });
    expect(intervalUnit("5")).toEqual({ unit: "minutes", n: 5 });
    expect(intervalUnit("240")).toEqual({ unit: "hours", n: 4 });
    expect(intervalUnit("1D")).toEqual({ unit: "days", n: 1 });
    expect(intervalUnit("1W")).toEqual({ unit: "weeks", n: 1 });
    expect(intervalUnit("3M")).toEqual({ unit: "months", n: 3 });
    expect(intervalUnit("100R")).toEqual({ unit: "ranges", n: 100 });
    expect(intervalUnit("x")).toBeNull();
  });
});

describe("visibilityForMode", () => {
  it("all intervals = the defaults", () => {
    expect(visibilityForMode("1D", "all")).toEqual(DEFAULT_VISIBILITY);
  });

  it("current interval only: its unit alone, from = to", () => {
    expect(visibilityForMode("1W", "current")).toEqual({
      ticks: false,
      seconds: off(1, 59),
      minutes: off(1, 59),
      hours: off(1, 24),
      days: off(1, 366),
      weeks: on(1, 1),
      months: off(1, 12),
      ranges: false,
    });
  });

  it("current interval and above: its unit from the interval, the larger units and ranges on", () => {
    expect(visibilityForMode("15", "currentAndAbove")).toEqual({
      ticks: false,
      seconds: off(1, 59),
      minutes: on(15, 59),
      hours: on(1, 24),
      days: on(1, 366),
      weeks: on(1, 52),
      months: on(1, 12),
      ranges: true,
    });
  });

  it("current interval and below: its unit up to the interval, the smaller units and ticks on", () => {
    expect(visibilityForMode("1D", "currentAndBelow")).toEqual({
      ticks: true,
      seconds: on(1, 59),
      minutes: on(1, 59),
      hours: on(1, 24),
      days: on(1, 1),
      weeks: off(1, 52),
      months: off(1, 12),
      ranges: false,
    });
  });

  it("hour intervals use the hours unit", () => {
    const v = visibilityForMode("240", "current");
    expect(v.hours).toEqual(on(4, 4));
    expect(v.minutes.on).toBe(false);
  });

  it("ticks and above / ranges and below are all intervals", () => {
    expect(visibilityForMode("1T", "currentAndAbove")).toEqual(DEFAULT_VISIBILITY);
    expect(visibilityForMode("100R", "currentAndBelow")).toEqual(DEFAULT_VISIBILITY);
  });

  it("the source stays visible on the interval it was set on, and follows the mode elsewhere", () => {
    for (const iv of ["5", "60", "90", "240", "1D", "1W", "1M"]) {
      for (const mode of ["current", "currentAndAbove", "currentAndBelow"] as const) {
        expect(isVisibleOnInterval(visibilityForMode(iv, mode), iv)).toBe(true);
      }
    }
    expect(isVisibleOnInterval(visibilityForMode("1D", "current"), "1W")).toBe(false);
    expect(isVisibleOnInterval(visibilityForMode("1D", "currentAndAbove"), "1W")).toBe(true);
    expect(isVisibleOnInterval(visibilityForMode("1D", "currentAndAbove"), "60")).toBe(false);
    expect(isVisibleOnInterval(visibilityForMode("1D", "currentAndBelow"), "60")).toBe(true);
    expect(isVisibleOnInterval(visibilityForMode("1D", "currentAndBelow"), "1W")).toBe(false);
  });

  it("returns a fresh object every time", () => {
    const a = visibilityForMode("1D", "all");
    a.days.on = false;
    expect(DEFAULT_VISIBILITY.days.on).toBe(true);
  });
});
