import { describe, expect, it } from "vitest";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { messageOutputs, outputValue } from "../alert-outputs";

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
