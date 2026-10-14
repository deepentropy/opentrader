import { beforeAll, describe, expect, it, vi } from "vitest";
import { WheelHelper } from "../wheel-helper";

// Node has no WheelEvent: the helper only reads its delta-mode constants.
beforeAll(() => {
  vi.stubGlobal("WheelEvent", { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
});

type Ev = { deltaX?: number; deltaY?: number; deltaMode?: number; shiftKey?: boolean; timeStamp: number };
const ev = (e: Ev) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ...e }) as unknown as WheelEvent;

describe("WheelHelper", () => {
  it("pixel deltas are divided by 100", () => {
    const w = new WheelHelper();
    expect(w.process(ev({ deltaY: 120, timeStamp: 1000 }))).toEqual({ deltaX: 0, deltaY: 1.2 });
  });

  it("line deltas x32, page deltas x120", () => {
    expect(new WheelHelper().process(ev({ deltaY: 3, deltaMode: 1, timeStamp: 1000 })).deltaY).toBeCloseTo(0.96, 12);
    expect(new WheelHelper().process(ev({ deltaY: 1, deltaMode: 2, timeStamp: 1000 })).deltaY).toBeCloseTo(1.2, 12);
  });

  it("Shift swaps the axes outside macOS", () => {
    const out = new WheelHelper().process(ev({ deltaY: 100, shiftKey: true, timeStamp: 1000 }));
    expect(out.deltaX).toBe(-1);
    expect(out.deltaY === 0).toBe(true);
  });

  it("drops the weaker axis when the burst is 3x stronger on the other", () => {
    const w = new WheelHelper();
    expect(w.process(ev({ deltaX: 10, deltaY: 100, timeStamp: 1000 }))).toEqual({ deltaX: 0, deltaY: 1 });
    // Same burst (< 100 ms): totals 20 / 200, still dominated.
    expect(w.process(ev({ deltaX: 10, deltaY: 100, timeStamp: 1050 }))).toEqual({ deltaX: 0, deltaY: 1 });
  });

  it("keeps both axes when neither dominates", () => {
    expect(new WheelHelper().process(ev({ deltaX: 50, deltaY: 100, timeStamp: 1000 }))).toEqual({ deltaX: 0.5, deltaY: 1 });
  });

  it("the burst resets after 100 ms without events", () => {
    const w = new WheelHelper();
    w.process(ev({ deltaY: 1000, timeStamp: 1000 }));
    // Within the burst the vertical total dominates a small horizontal move…
    expect(w.process(ev({ deltaX: 100, timeStamp: 1050 })).deltaX).toBe(0);
    // …after a pause the horizontal move stands alone.
    expect(w.process(ev({ deltaX: 100, timeStamp: 1300 })).deltaX).toBe(1);
  });
});
