import { describe, expect, it } from "vitest";
import { intervalMs, intervalSeconds, isDailyInterval, parseInterval } from "../interval";

describe("parseInterval", () => {
  it("reads a bare number as minutes", () => {
    expect(parseInterval("1")).toEqual({ count: 1, unit: "minute" });
    expect(parseInterval("15")).toEqual({ count: 15, unit: "minute" });
    expect(parseInterval("240")).toEqual({ count: 240, unit: "minute" });
  });

  it("reads the unit letters, a missing count being one", () => {
    expect(parseInterval("10S")).toEqual({ count: 10, unit: "second" });
    expect(parseInterval("1D")).toEqual({ count: 1, unit: "day" });
    expect(parseInterval("D")).toEqual({ count: 1, unit: "day" });
    expect(parseInterval("W")).toEqual({ count: 1, unit: "week" });
    expect(parseInterval("2W")).toEqual({ count: 2, unit: "week" });
    expect(parseInterval("1M")).toEqual({ count: 1, unit: "month" });
    expect(parseInterval("M")).toEqual({ count: 1, unit: "month" });
    expect(parseInterval("4H")).toEqual({ count: 4, unit: "hour" });
  });

  it("tells a month (M) from a minute (m); other letters read either case", () => {
    expect(parseInterval("1m")).toEqual({ count: 1, unit: "minute" });
    expect(parseInterval("3M")).toEqual({ count: 3, unit: "month" });
    expect(parseInterval("5s")).toEqual({ count: 5, unit: "second" });
    expect(parseInterval("1d")).toEqual({ count: 1, unit: "day" });
    expect(parseInterval("1w")).toEqual({ count: 1, unit: "week" });
    expect(parseInterval("2h")).toEqual({ count: 2, unit: "hour" });
  });

  it("ignores spaces", () => {
    expect(parseInterval(" 15 ")).toEqual({ count: 15, unit: "minute" });
    expect(parseInterval("1 D")).toEqual({ count: 1, unit: "day" });
  });

  it("refuses what is not an interval", () => {
    for (const id of ["", " ", "0", "0D", "1X", "1T", "abc", "1.5", "-1", "1DD"]) expect(parseInterval(id)).toBeNull();
  });
});

describe("isDailyInterval", () => {
  it("is true for day, week and month bars only", () => {
    expect(["1D", "D", "1W", "3M"].map((id) => isDailyInterval(parseInterval(id)!))).toEqual([true, true, true, true]);
    expect(["1", "60", "10S", "4H"].map((id) => isDailyInterval(parseInterval(id)!))).toEqual([false, false, false, false]);
  });
  it("reads an id directly; a minute \"1m\" or a non-interval is not daily", () => {
    expect(["1D", "W", "1M"].map((id) => isDailyInterval(id))).toEqual([true, true, true]);
    expect(["1m", "", "x"].map((id) => isDailyInterval(id))).toEqual([false, false, false]);
  });
});

describe("intervalSeconds / intervalMs", () => {
  it("gives the bar length, a month counting 30 days", () => {
    expect(intervalSeconds("1")).toBe(60);
    expect(intervalSeconds("15")).toBe(900);
    expect(intervalSeconds("10S")).toBe(10);
    expect(intervalSeconds("4H")).toBe(14_400);
    expect(intervalSeconds("1D")).toBe(86_400);
    expect(intervalSeconds("D")).toBe(86_400);
    expect(intervalSeconds("W")).toBe(604_800);
    expect(intervalSeconds("1M")).toBe(2_592_000);
    expect(intervalSeconds("1m")).toBe(60);
    expect(intervalSeconds({ count: 2, unit: "day" })).toBe(172_800);
    expect(intervalMs("5")).toBe(300_000);
  });

  it("is null when the id is not an interval", () => {
    expect(intervalSeconds("x")).toBeNull();
    expect(intervalMs("")).toBeNull();
  });
});
