import { describe, expect, it } from "vitest";
import { legendButtonsMode, legendHidesMinorValues, legendTitleParts } from "../legend-widths";

describe("legendButtonsMode", () => {
  it("drops study buttons on narrow charts (reference widths)", () => {
    expect(legendButtonsMode(undefined)).toBe("large");
    expect(legendButtonsMode(222)).toBe("large");
    expect(legendButtonsMode(221)).toBe("medium");
    expect(legendButtonsMode(205)).toBe("medium");
    expect(legendButtonsMode(204)).toBe("small");
  });
});

describe("legendTitleParts", () => {
  it("drops the exchange and a single chart's interval below 442 px", () => {
    expect(legendTitleParts(442, false)).toEqual({ exchange: true, interval: true, tickerOnly: false });
    expect(legendTitleParts(441, false)).toEqual({ exchange: false, interval: false, tickerOnly: false });
  });
  it("keeps a multi-chart layout's interval down to 192 px", () => {
    expect(legendTitleParts(300, true)).toEqual({ exchange: false, interval: true, tickerOnly: false });
    expect(legendTitleParts(191, true).interval).toBe(false);
  });
  it("shows the ticker at 132 px and less", () => {
    expect(legendTitleParts(133, false).tickerOnly).toBe(false);
    expect(legendTitleParts(132, false).tickerOnly).toBe(true);
    expect(legendTitleParts(undefined, false)).toEqual({ exchange: true, interval: true, tickerOnly: false });
  });
});

describe("legendHidesMinorValues", () => {
  it("leaves out open, high and low at 272 px and less", () => {
    expect(legendHidesMinorValues(273)).toBe(false);
    expect(legendHidesMinorValues(272)).toBe(true);
    expect(legendHidesMinorValues(undefined)).toBe(false);
  });
});
