import { describe, expect, it } from "vitest";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { choiceIndex, messageOutputs, outputByKey, outputChoices, outputSeries, outputValue } from "../alert-outputs";

const entry = (e: Record<string, unknown>) => e as unknown as IndicatorRegistryEntry;

describe("messageOutputs", () => {
  it("numbers the line plots only for a study without its output order", () => {
    const out = messageOutputs(entry({ plotConfig: [{ id: "plot0", title: "MA" }, { id: "plot1", title: "" }] }));
    expect(out.map((o) => [o.title, o.source, o.id])).toEqual([
      ["MA", "plot", "plot0"],
      ["plot1", "plot", "plot1"],
    ]);
  });

  it("follows the script's order: shapes, characters, arrows and the four prices of a candle", () => {
    const out = messageOutputs(
      entry({
        plotConfig: [{ id: "plot0", title: "Close" }, { id: "plot1", title: "Double" }],
        outputs: [
          { kind: "shape", id: "shape0", title: "Up" },
          { kind: "plot", id: "plot0", title: "Close" },
          { kind: "char", id: "char0" },
          { kind: "candle", id: "plotcandle0", title: "C" },
          { kind: "arrow", id: "arrow0", title: "A" },
          { kind: "plot", id: "plot1" },
          { kind: "bar", id: "plotbar0" },
        ],
      }),
    );
    expect(out.map((o) => o.title)).toEqual(["Up", "Close", "Chars", "C (Open)", "C (High)", "C (Low)", "C (Close)", "A", "Double", "Open", "High", "Low", "Close"]);
    expect(out.filter((o) => !o.named).length).toBe(8);
  });

  it("adds the prices of the candles after the line plots for a study without its output order", () => {
    const out = messageOutputs(entry({ plotConfig: [{ id: "plot0", title: "OI" }], plotCandleConfig: [{ id: "delta", title: "Volume Delta" }] }));
    expect(out.map((o) => o.title)).toEqual(["OI", "Volume Delta (Open)", "Volume Delta (High)", "Volume Delta (Low)", "Volume Delta (Close)"]);
  });
});

describe("plot select of a condition", () => {
  const e = entry({
    plotConfig: [{ id: "plot0", title: "RSI" }, { id: "plot1", title: "MA" }, { id: "plot6", title: "Plot" }],
    outputs: [
      { kind: "plot", id: "plot0" },
      { kind: "plot", id: "plot6" },
      { kind: "plot", id: "plot1" },
      { kind: "shape", id: "bull", title: "Bull Label" },
      { kind: "candle", id: "c", title: "C" },
    ],
  });

  it("lists every output in message order: line plots by index, other outputs by key", () => {
    expect(outputChoices(e).map((c) => [c.index, c.title, c.plot ?? c.output])).toEqual([
      [0, "RSI", 0],
      [1, "Plot", 2],
      [2, "MA", 1],
      [3, "Bull Label", "bull"],
      [4, "C (Open)", "c:open"],
      [5, "C (High)", "c:high"],
      [6, "C (Low)", "c:low"],
      [7, "C (Close)", "c:close"],
    ]);
  });

  it("finds the row of a saved operand (a line plot by index, an output by key, 0 when gone)", () => {
    expect(choiceIndex(e, { plot: 1 })).toBe(2);
    expect(choiceIndex(e, {})).toBe(0);
    expect(choiceIndex(e, { output: "bull" })).toBe(3);
    expect(choiceIndex(e, { output: "c:low" })).toBe(6);
    expect(choiceIndex(e, { output: "gone" })).toBe(0);
    expect(outputByKey(e, "c:close")?.part).toBe("close");
    expect(outputByKey(e, "plot0")).toBeUndefined();
  });

  it("reads an output on every bar", () => {
    const result = { outputValues: { bull: [{ time: 200, value: 31.5 }] }, plotCandles: { c: [{ time: 100, open: 1, high: 4, low: 0.5, close: 2 }] } };
    const times = [[100], [150, 200], [300]];
    expect(outputSeries(result, outputByKey(e, "bull")!, times)).toEqual([null, 31.5, null]);
    expect(outputSeries(result, outputByKey(e, "c:high")!, times)).toEqual([4, null, null]);
    expect(outputSeries(null, outputByKey(e, "bull")!, times)).toEqual([null, null, null]);
  });
});

describe("outputValue", () => {
  const result = {
    plots: { plot0: [{ time: 100, value: 1.5 }, { time: 200, value: 2.5 }] },
    outputValues: { shape0: [{ time: 200, value: 1 }], char0: [{ time: 100, value: -3 }] },
    plotCandles: { plotcandle0: [{ time: 200, open: 1, high: 4, low: 0.5, close: 2 }] },
  };
  const outputs = messageOutputs(
    entry({
      plotConfig: [{ id: "plot0", title: "P" }],
      outputs: [
        { kind: "plot", id: "plot0" },
        { kind: "shape", id: "shape0" },
        { kind: "char", id: "char0" },
        { kind: "candle", id: "plotcandle0" },
      ],
    }),
  );

  it("reads each output on the bar by its time", () => {
    expect(outputs.map((o) => outputValue(result, o, [200]))).toEqual([2.5, 1, null, 1, 4, 0.5, 2]);
    expect(outputs.map((o) => outputValue(result, o, [100]))).toEqual([1.5, null, -3, null, null, null, null]);
  });

  it("matches either time of the bar (as given to the study, as charted)", () => {
    expect(outputValue(result, outputs[0], [999, 100])).toBe(1.5);
    expect(outputValue(null, outputs[0], [100])).toBeNull();
  });
});
