import { describe, expect, it } from "vitest";
import { indexOfTime, lastAtOrBefore, lowerBound, upperBound } from "../time-search";

const bars = [100, 200, 300].map((time) => ({ time }));
const times = [100, 200, 300];

describe("time search", () => {
  it("lowerBound: first item at or after the time", () => {
    for (const items of [bars, times]) {
      expect(lowerBound(items, 50)).toBe(0);
      expect(lowerBound(items, 100)).toBe(0);
      expect(lowerBound(items, 150)).toBe(1);
      expect(lowerBound(items, 300)).toBe(2);
      expect(lowerBound(items, 301)).toBe(3);
    }
    expect(lowerBound([], 1)).toBe(0);
  });

  it("upperBound: first item after the time", () => {
    for (const items of [bars, times]) {
      expect(upperBound(items, 50)).toBe(0);
      expect(upperBound(items, 100)).toBe(1);
      expect(upperBound(items, 250)).toBe(2);
      expect(upperBound(items, 300)).toBe(3);
    }
    expect(upperBound([], 1)).toBe(0);
  });

  it("lastAtOrBefore: the bar a time falls in", () => {
    expect(lastAtOrBefore(bars, 50)).toBe(-1);
    expect(lastAtOrBefore(bars, 100)).toBe(0);
    expect(lastAtOrBefore(bars, 250)).toBe(1);
    expect(lastAtOrBefore(bars, 300)).toBe(2);
    expect(lastAtOrBefore(bars, 999)).toBe(2);
    expect(lastAtOrBefore([], 1)).toBe(-1);
  });

  it("indexOfTime: exact match only", () => {
    expect(indexOfTime(bars, 200)).toBe(1);
    expect(indexOfTime(bars, 250)).toBe(-1);
    expect(indexOfTime(bars, 999)).toBe(-1);
    expect(indexOfTime(times, 100)).toBe(0);
    expect(indexOfTime([], 100)).toBe(-1);
  });
});
