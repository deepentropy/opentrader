import { describe, expect, it } from "vitest";
import { paneRanks, seriesPaneLast } from "../indicators/pane-order";

describe("pane stacking order", () => {
  it("price pane on top when the saved order does not place it (older charts)", () => {
    expect(paneRanks(["_series", "rsi", "macd"], [])).toEqual(["_series", "rsi", "macd"]);
    expect(paneRanks(["_series", "rsi", "macd"], ["macd", "rsi"])).toEqual(["_series", "macd", "rsi"]);
  });

  it("the saved order places the price pane anywhere", () => {
    expect(paneRanks(["_series", "rsi", "macd"], ["rsi", "_series", "macd"])).toEqual(["rsi", "_series", "macd"]);
    expect(paneRanks(["_series", "rsi", "macd"], ["rsi", "macd", "_series"])).toEqual(["rsi", "macd", "_series"]);
  });

  it("ids the saved order does not list follow, in their given order", () => {
    // A study added after the price pane was moved down opens at the bottom.
    expect(paneRanks(["_series", "rsi", "macd", "cci"], ["rsi", "_series"])).toEqual(["rsi", "_series", "macd", "cci"]);
  });

  it("saved ids no longer on the chart are skipped", () => {
    expect(paneRanks(["_series", "macd"], ["rsi", "macd", "_series"])).toEqual(["macd", "_series"]);
  });

  it("the series dropped on the time axis: its pane goes last", () => {
    expect(seriesPaneLast(["_series", "rsi", "macd"])).toEqual(["rsi", "macd", "_series"]);
    expect(seriesPaneLast(["rsi", "macd"])).toEqual(["rsi", "macd", "_series"]);
  });
});
