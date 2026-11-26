import { describe, expect, it } from "vitest";
import { timeframeChoices, timeframeLabel, timeframeValue } from "../timeframe-input";
import { statusLineInputs } from "../indicators/indicator-options";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

describe("timeframe inputs", () => {
  it("reads values in the interval menu's form", () => {
    expect(timeframeValue("")).toBe("");
    expect(timeframeValue("D")).toBe("1D");
    expect(timeframeValue("1H")).toBe("60");
    expect(timeframeValue("5s")).toBe("5S");
    expect(timeframeValue("240")).toBe("240");
    expect(timeframeValue("12M")).toBe("12M");
    expect(timeframeValue("abc")).toBe("abc");
  });

  it("lists the chart, the seconds, minutes, hours, days, weeks and months in menu order", () => {
    const list = timeframeChoices();
    expect(list[0]).toBe("");
    expect(list.slice(1, 8)).toEqual(["1S", "5S", "10S", "15S", "30S", "45S", "1"]);
    expect(list.slice(-6)).toEqual(["1D", "1W", "1M", "3M", "6M", "12M"]);
    expect(list).toContain("240");
  });

  it("lists a script's options only (the intervals, in its order)", () => {
    expect(timeframeChoices(["D", "60", "nope", "5S"])).toEqual(["1D", "60", "5S"]);
  });

  it("names the choices", () => {
    expect(timeframeLabel("")).toBe("Chart");
    expect(timeframeLabel("60")).toBe("1 hour");
    expect(timeframeLabel("5S")).toBe("5 seconds");
    expect(timeframeLabel("1D")).toBe("1 day");
  });
});

describe("status line inputs", () => {
  it("shows an enum input by its title", () => {
    const entry = {
      inputConfig: [{ id: "average", type: "enum", defval: "sma", options: ["sma", "ema"], optionsTitles: { sma: "Simple", ema: "Exponential" } }],
    } as unknown as IndicatorRegistryEntry;
    expect(statusLineInputs(entry, { average: "ema" })).toBe("Exponential");
  });
});
