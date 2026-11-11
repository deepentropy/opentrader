import { describe, expect, it, vi } from "vitest";

// The script engine answers when the test lets it (one pending run at a time).
const engine = vi.hoisted(() => ({
  pending: [] as ((v: unknown) => void)[],
  generation: 1,
}));

vi.mock("../../../../data/oakscript-store", () => ({
  loadScript: () => ({ id: "S1", name: "Test", source: "", meta: null }),
  saveCompiledMeta: () => undefined,
}));
vi.mock("../../../oakscript/engine", () => ({
  OakEngineError: class extends Error {},
  getOakEngine: () => ({
    generation: engine.generation,
    compile: async () => ({ title: "Test", overlay: true, plotConfig: [] }),
    update: (_run: string, _id: string, bars: { time: number }[]) =>
      new Promise((resolve) => engine.pending.push(() => resolve({ result: { plots: { p: bars.map((b) => ({ time: b.time, value: 1 })) } }, fullRunReason: null }))),
  }),
}));
vi.mock("../../../../data/app-events", () => ({ emitAppEvent: () => undefined }));

import { getUserIndicatorEntry } from "../user-scripts";

const bars = (from: number, n: number, step: number) => Array.from({ length: n }, (_, i) => ({ time: from + i * step, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  engine.pending.shift()?.(undefined);
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("user script results and their series (#308)", () => {
  it("keeps the result before on the same series only", async () => {
    const entry = getUserIndicatorEntry("user:S1")!;
    const calc = entry.calculate as unknown as (b: unknown, i: unknown, ctx: unknown) => { plots?: Record<string, unknown[]>; pending?: boolean };
    const intraday = { chartId: "c", studyId: "s", tickerid: "LOCAL:EUR", timeframe: "5", sessionType: "regular" };
    const five = bars(1_790_812_800, 10, 300);

    expect(calc(five, {}, intraday).pending).toBe(true);
    await settle();
    expect(calc(five, {}, intraday).plots?.p).toHaveLength(10);

    // More bars on the same series: the result before stays while the run calculates.
    expect(calc(bars(1_790_812_800, 11, 300), {}, intraday).plots?.p).toHaveLength(10);
    await settle();

    // Another series: not the bars that result was calculated on.
    const daily = { ...intraday, tickerid: "AMEX:SPY", timeframe: "1D" };
    expect(calc(bars(1_063_166_400, 5, 86_400), {}, daily).pending).toBe(true);
  });
});
