import { describe, expect, it } from "vitest";
import { TickReplayFeed } from "../tick-replay-feed";
import type { OHLC } from "../chart-types";

const bar = (time: number, close: number): OHLC => ({ time: time as OHLC["time"], open: close, high: close, low: close, close, volume: 3 });
const tick = (timeMs: number, price: number) => ({ timeMs, price, volume: 1 });

describe("TickReplayFeed (#377)", () => {
  it("fills the forming bar up to N ticks, then starts the next", () => {
    const f = new TickReplayFeed([bar(1, 10)], 3, 2000);
    expect(f.needs()).toBe("sub");
    expect(f.nextTime()).toBeUndefined();
    f.pushPage([tick(2000, 11), tick(2500, 12), tick(3000, 9), tick(3500, 10)], false, 3500, 1);
    expect(f.subDone).toBe(true);
    expect(f.nextTime()).toBe(2);
    let changes = f.advanceTo(2);
    expect(changes).toHaveLength(1);
    expect(changes[0].appended).toBe(true);
    expect(f.shown[1]).toMatchObject({ time: 2, open: 11, close: 11, volume: 1 });
    changes = f.advanceTo(3.5);
    expect(changes.map((c) => c.appended)).toEqual([false, false, true]);
    expect(f.shown[1]).toMatchObject({ open: 11, high: 12, low: 9, close: 9, volume: 3 });
    expect(f.shown[2]).toMatchObject({ time: 3.5, close: 10 });
    expect(f.nextTime()).toBeNull();
  });

  it("reads on from the last tick, its millisecond's ticks read already left out", () => {
    const f = new TickReplayFeed([], 2, 1000);
    f.pushPage([tick(1000, 1), tick(1200, 2), tick(1200, 3)], true, 1200, 2);
    expect([f.fromMs, f.skip]).toEqual([1200, 2]);
    f.pushPage([tick(1200, 4)], true, 1200, 3);
    expect([f.fromMs, f.skip]).toEqual([1200, 5]);
    expect(f.subDone).toBe(false);
    // The first tick of a chart with no bar before it starts the first bar.
    f.advanceTo(1);
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0].time).toBe(1);
  });
});
