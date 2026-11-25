import { describe, expect, it, vi } from "vitest";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

vi.mock("../../window/chart/indicators/script-chart", () => ({ scriptChartContext: () => ({ timeframe: "5" }), symbolDetails: () => null }));

import { runStudy } from "../alert-studies";
import { VISIBLE_RANGE_KEY, visibleRangeOf } from "../../window/chart/indicators/study-sources";

const bars = Array.from({ length: 5 }, (_, i) => ({ time: 1_700_000_000 + i * 300, open: 1, high: 1, low: 1, close: 1, volume: 1 }));

describe("an alert on a study that reads the bars in view (#410)", () => {
  function run(inputs: Record<string, unknown>) {
    const calculate = vi.fn((..._args: unknown[]) => ({ plots: {} }));
    runStudy({ calculate } as unknown as IndicatorRegistryEntry, bars, inputs, "AAPL", "5", "RTH");
    const [, given, chart] = calculate.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    return { given, view: [chart.leftVisibleBarTime, chart.rightVisibleBarTime] };
  }

  it("keeps the ones it was made with, in ms", () => {
    const out = run({ length: 3, [VISIBLE_RANGE_KEY]: { from: 1_700_000_300, to: 1_700_000_900 } });
    expect(out).toEqual({ given: { length: 3 }, view: [1_700_000_300_000, 1_700_000_900_000] });
  });

  it("has none when it was made without", () => {
    expect(run({ length: 3 })).toEqual({ given: { length: 3 }, view: [undefined, undefined] });
    expect(visibleRangeOf({ [VISIBLE_RANGE_KEY]: { from: "x" } })).toBeNull();
    expect(visibleRangeOf(undefined)).toBeNull();
  });
});
