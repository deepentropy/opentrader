import { describe, expect, it } from "vitest";
import { liveUpdateBar } from "../live";
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
