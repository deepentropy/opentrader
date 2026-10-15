import { describe, expect, it } from "vitest";
import type { IChartApi } from "lightweight-charts";
import {
  CONTROL_BAR_H,
  GROUPS,
  MAIN_PANE_MARGIN,
  MOVE_ACCEL,
  MOVE_RAMP,
  MOVE_VMAX,
  barAnchor,
  canShow,
  easeInOutQuint,
  easeOutCubic,
  groupsWidth,
  liveBarSpacing,
  moveEndAfterStop,
  movePixels,
  pointerNearBox,
  type GroupId,
} from "../control-bar";

describe("scroll move kinematics", () => {
  it("ramp reaches top speed at 367 ms", () => {
    expect(MOVE_RAMP).toBe(367);
  });

  it("accelerates as a t^2 / 2 while held", () => {
    expect(movePixels(0, Infinity)).toBe(0);
    expect(movePixels(100, Infinity)).toBeCloseTo((MOVE_ACCEL * 100 * 100) / 2, 12);
    expect(movePixels(MOVE_RAMP, Infinity)).toBeCloseTo((MOVE_ACCEL * MOVE_RAMP ** 2) / 2, 12);
  });

  it("then coasts at top speed", () => {
    const atRamp = movePixels(MOVE_RAMP, Infinity);
    expect(movePixels(MOVE_RAMP + 100, Infinity)).toBeCloseTo(atRamp + 100 * MOVE_VMAX, 9);
  });

  it("is continuous and never goes backwards while slowing down", () => {
    let prev = -1;
    // Released at 500 ms: ends RAMP later (the ramp down).
    const end = 500 + moveEndAfterStop(500);
    for (let t = 0; t <= end; t += 5) {
      const remaining = end - t;
      const p = movePixels(t, t < 500 ? Infinity : remaining);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it("a release before top speed still ramps up fully, then down", () => {
    expect(moveEndAfterStop(100)).toBe(MOVE_RAMP - 100 + MOVE_RAMP);
    expect(moveEndAfterStop(1000)).toBe(MOVE_RAMP);
  });
});

describe("easings", () => {
  it("end points and midpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBe(0.875);
    expect(easeInOutQuint(0)).toBe(0);
    expect(easeInOutQuint(1)).toBe(1);
    expect(easeInOutQuint(0.5)).toBe(0.5);
    expect(easeInOutQuint(0.25)).toBeCloseTo(16 * 0.25 ** 5, 12);
  });
});

describe("canShow / groupsWidth", () => {
  it("Navigation setting", () => {
    expect(canShow("alwaysOn", false)).toBe(true);
    expect(canShow("alwaysOff", true)).toBe(false);
    expect(canShow("visibleOnMouseOver", true)).toBe(true);
    expect(canShow("visibleOnMouseOver", false)).toBe(false);
  });

  it("sums the budget widths of the fitting groups", () => {
    expect(groupsWidth(new Set<GroupId>(["maximize", "zoom"]))).toBe(50 + 86);
    expect(groupsWidth(new Set<GroupId>(GROUPS.map((g) => g.id)))).toBe(272);
    expect(groupsWidth(new Set())).toBe(0);
  });
});

describe("pointerNearBox", () => {
  const box = { left: 100, right: 300, top: 400, bottom: 434 } as DOMRect;
  const me = (x: number, y: number, extra: Partial<{ type: string; buttons: number }> = {}) =>
    ({ type: "mousemove", buttons: 0, clientX: x, clientY: y, ...extra }) as unknown as MouseEvent;

  it("padded 100 px left / right / bottom and 73 px on top", () => {
    expect(pointerNearBox(me(0, 420), box, false)).toBe(true);
    expect(pointerNearBox(me(-1, 420), box, false)).toBe(false);
    expect(pointerNearBox(me(400, 534), box, false)).toBe(true);
    expect(pointerNearBox(me(401, 420), box, false)).toBe(false);
    expect(pointerNearBox(me(200, 400 - (100 - MAIN_PANE_MARGIN)), box, false)).toBe(true);
    expect(pointerNearBox(me(200, 400 - (100 - MAIN_PANE_MARGIN) - 1), box, false)).toBe(false);
  });

  it("frozen while a button is held or a drawing is placed; mouseleave hides", () => {
    expect(pointerNearBox(me(200, 420, { buttons: 1 }), box, false)).toBeUndefined();
    expect(pointerNearBox(me(200, 420), box, true)).toBeUndefined();
    expect(pointerNearBox(me(200, 420, { type: "mouseleave" }), box, false)).toBe(false);
  });
});

/** Fake chart: pane heights, time-axis height, scale widths, visible range. */
function fakeChart(o: { heights: number[]; axis?: number; right?: number; left?: number | "throw"; range?: { from: number; to: number } | null; width?: number }): IChartApi {
  return {
    panes: () => o.heights.map((h) => ({ getHeight: () => h })),
    timeScale: () => ({
      height: () => o.axis ?? 28,
      width: () => o.width ?? 800,
      getVisibleLogicalRange: () => (o.range === undefined ? { from: 0, to: 99 } : o.range),
    }),
    priceScale: (side: string) => ({
      width: () => {
        const v = side === "right" ? o.right ?? 60 : o.left ?? 0;
        if (v === "throw") throw new Error("no widget");
        return v;
      },
    }),
  } as unknown as IChartApi;
}

describe("barAnchor", () => {
  it("single main pane: lifted by the main-pane margin above the time axis", () => {
    const a = barAnchor(fakeChart({ heights: [500] }), 528, 1000)!;
    expect(a.bottom).toBe(28 + MAIN_PANE_MARGIN);
    expect(a.right).toBe(60 + 16);
    expect(a.centre(272)).toBe(500 - 136);
    expect(a.centre(51)).toBe(500 - 26);
  });

  it("skips short indicator panes; separators backed out of the leftover height", () => {
    // Main 400, RSI 50 (too short: < 34 + 28), separator 1 px.
    const a = barAnchor(fakeChart({ heights: [400, 50] }), 28 + 400 + 50 + 1, 1000)!;
    expect(a.bottom).toBe(28 + 50 + 1 + MAIN_PANE_MARGIN);
  });

  it("a tall bottom indicator pane holds the bar (no main-pane lift)", () => {
    const a = barAnchor(fakeChart({ heights: [400, CONTROL_BAR_H + 28] }), 28 + 400 + 62 + 1, 1000)!;
    expect(a.bottom).toBe(28);
  });

  it("the price pane at the bottom takes the main-pane lift there", () => {
    // RSI 400 on top, price pane 300 at the bottom (index 1).
    const a = barAnchor(fakeChart({ heights: [400, 300] }), 28 + 400 + 300 + 1, 1000, 1)!;
    expect(a.bottom).toBe(28 + MAIN_PANE_MARGIN);
    // The same panes with the price pane on top: the bottom pane has no lift.
    const b = barAnchor(fakeChart({ heights: [400, 300] }), 28 + 400 + 300 + 1, 1000, 0)!;
    expect(b.bottom).toBe(28);
  });

  it("null when no pane is tall enough", () => {
    expect(barAnchor(fakeChart({ heights: [CONTROL_BAR_H + 28 + MAIN_PANE_MARGIN - 1] }), 200, 1000)).toBeNull();
  });

  it("groups fit in priority order and once one misses the rest drop", () => {
    // Budget = 1000 - 2 * 60 - 100 = 780: all fit.
    const wide = barAnchor(fakeChart({ heights: [500] }), 528, 1000)!;
    expect([...wide.fits(() => true)]).toEqual(["maximize", "reset", "zoom", "scroll"]);
    // Budget = 400 - 120 - 100 = 180: maximize (50) + reset (50) fit, zoom (86) does not (-6).
    const narrow = barAnchor(fakeChart({ heights: [500] }), 528, 400)!;
    expect([...narrow.fits(() => true)]).toEqual(["maximize", "reset"]);
    // An unavailable group costs nothing.
    expect([...narrow.fits((id) => id !== "reset")]).toEqual(["maximize", "zoom"]);
  });

  it("a scale that throws counts as 0 width; the widest scale sets the budget", () => {
    const a = barAnchor(fakeChart({ heights: [500], left: "throw", right: 70 }), 528, 400)!;
    expect(a.right).toBe(86);
    // Budget 400 - 140 - 100 = 160: maximize + reset (100) fit, zoom misses.
    expect([...a.fits(() => true)]).toEqual(["maximize", "reset"]);
  });
});

describe("liveBarSpacing", () => {
  it("width over the bars drawn (L + 1 bars for a range of length L)", () => {
    expect(liveBarSpacing(fakeChart({ heights: [1], width: 800, range: { from: 0, to: 99 } }))).toBe(8);
    expect(liveBarSpacing(fakeChart({ heights: [1], width: 800, range: { from: 10.5, to: 49.5 } }))).toBe(20);
  });

  it("null without a range or with an empty one", () => {
    expect(liveBarSpacing(fakeChart({ heights: [1], range: null }))).toBeNull();
    expect(liveBarSpacing(fakeChart({ heights: [1], range: { from: 5, to: 5 } }))).toBeNull();
  });
});
