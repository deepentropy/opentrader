/** Bar magnifier: lower timeframe and "High" detalization ticks per chart interval. */
import { describe, expect, it } from "vitest";
import { detalizationTicks, intervalSeconds, magnifierInterval } from "../magnifier";

describe("magnifierInterval", () => {
  it.each([
    ["1", "10S"],
    ["3", "10S"],
    ["5", "30S"],
    ["10", "1"],
    ["15", "2"],
    ["30", "5"],
    ["45", "5"],
    ["60", "10"],
    ["120", "10"],
    ["240", "30"],
    ["1D", "60"],
    ["D", "60"],
    ["2D", "60"],
    ["3D", "240"],
    ["1W", "1D"],
    ["1M", "1D"],
    ["30S", "5S"],
    ["45S", "5S"],
  ])("%s -> %s", (interval, ltf) => {
    expect(magnifierInterval(interval)).toBe(ltf);
  });

  it("has no lower timeframe for short seconds, ticks, ranges and invalid ids", () => {
    expect(magnifierInterval("10S")).toBeNull();
    expect(magnifierInterval("59S")).toBeNull();
    expect(magnifierInterval("100T")).toBeNull();
    expect(magnifierInterval("1R")).toBeNull();
    expect(magnifierInterval("1440")).toBeNull();
    expect(magnifierInterval("abc")).toBeNull();
    expect(magnifierInterval("")).toBe("10S"); // "" parses as 1 minute
  });
});

describe("detalizationTicks", () => {
  it.each([
    ["1", 24],
    ["4", 24],
    ["5", 40],
    ["10", 40],
    ["15", 28],
    ["30", 24],
    ["60", 24],
    ["240", 32],
    ["1D", 96],
    ["3D", 72],
    ["1W", 28],
    ["1M", 28],
    ["10S", 4],
    ["30S", 24],
    ["50T", 4],
    ["100T", 40],
    ["1R", 4],
    ["bad", 0],
  ])("%s -> %i", (interval, ticks) => {
    expect(detalizationTicks(interval)).toBe(ticks);
  });
});

describe("intervalSeconds", () => {
  it("converts interval ids to seconds", () => {
    expect(intervalSeconds("10S")).toBe(10);
    expect(intervalSeconds("2")).toBe(120);
    expect(intervalSeconds("60")).toBe(3600);
    expect(intervalSeconds("1D")).toBe(86_400);
    expect(intervalSeconds("1W")).toBe(604_800);
    expect(intervalSeconds("1M")).toBe(0);
    expect(intervalSeconds("x")).toBe(0);
  });
});
