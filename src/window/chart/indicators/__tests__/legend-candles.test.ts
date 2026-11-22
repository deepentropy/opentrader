/** A study's candles in its legend (#383): open, high, low and close after the plots, in the candle's colour. */
import { describe, expect, it } from "vitest";
import { candleLegendValues } from "../indicator-layer";

const candles = {
  oi: [
    { time: 100, open: 10, high: 12, low: 9, close: 11, color: "#089981" },
    { time: 200, open: 11, high: 13, low: 10, close: 10.5, color: "#F2364580" },
  ],
};

describe("candleLegendValues", () => {
  it("gives the four values of the candle at the time, after the plots", () => {
    expect(candleLegendValues(candles, [{ id: "oi" }], 100, 1)).toEqual([
      { color: "#089981", value: 10, index: 1 },
      { color: "#089981", value: 12, index: 2 },
      { color: "#089981", value: 9, index: 3 },
      { color: "#089981", value: 11, index: 4 },
    ]);
  });

  it("takes the last candle without a time, its colour without transparency", () => {
    const out = candleLegendValues(candles, [{ id: "oi" }], undefined, 0);
    expect(out.map((p) => p.value)).toEqual([11, 13, 10, 10.5]);
    expect(out[0].color).toBe("#F23645");
  });

  it("gives nothing for a time without a candle or a hidden candle output", () => {
    expect(candleLegendValues(candles, [{ id: "oi" }], 150, 0)).toEqual([]);
    expect(candleLegendValues({}, [{ id: "oi" }], 100, 0)).toEqual([]);
  });
});
