import { describe, expect, it } from "vitest";
import { liveBarWaitsForHistory, liveUpdateBar } from "../live";
import type { OHLC } from "../../chart-types";

const bar = (time: number, close = 1): OHLC => ({ time: time as OHLC["time"], open: 1, high: 2, low: 0, close });

describe("live paint after the series changed (#361)", () => {
  it("updates the series' newest bar when the queued bar is still the newest", () => {
    const bars = [bar(100), bar(200, 3)];
    expect(liveUpdateBar(bar(200, 2), bars)).toBe(bars[1]);
  });

  it("sets the whole series when it was given later bars meanwhile (1W to 1D)", () => {
    expect(liveUpdateBar(bar(200), [bar(200), bar(300)])).toBeNull();
  });

  it("sets the whole series when its newest bar is earlier than the queued one", () => {
    expect(liveUpdateBar(bar(300), [bar(100), bar(200)])).toBeNull();
  });

  it("keeps the full repaint when nothing was queued or the series is empty", () => {
    expect(liveUpdateBar(null, [bar(100)])).toBeNull();
    expect(liveUpdateBar(bar(100), [])).toBeNull();
  });
});

describe("live bars before the first history load (#360)", () => {
  it("leaves out a live bar while the empty series' history is loading", () => {
    expect(liveBarWaitsForHistory(true, [])).toBe(true);
  });

  it("merges live bars into loaded bars, also while a reload runs", () => {
    expect(liveBarWaitsForHistory(true, [bar(100)])).toBe(false);
    expect(liveBarWaitsForHistory(false, [bar(100)])).toBe(false);
  });

  it("starts the series from live bars once a load gave no bars", () => {
    expect(liveBarWaitsForHistory(false, [])).toBe(false);
  });
});
