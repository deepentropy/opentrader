import { describe, expect, it } from "vitest";
import { DRAW_WINDOW_BARS, DRAW_WINDOW_MARGIN, nextDrawWindow, windowResult } from "../draw-window";

const barsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 10, close: i }));

describe("nextDrawWindow", () => {
  it("draws every bar up to the window size", () => {
    expect(nextDrawWindow(barsOf(DRAW_WINDOW_BARS), { from: 0, to: 100 }, null)).toBeNull();
  });

  it("opens at the last bar when the view is there", () => {
    const bars = barsOf(100_000);
    const w = nextDrawWindow(bars, { from: 99_700, to: 99_999 }, null)!;
    expect(w.to).toBe(Infinity);
    expect(w.from).toBe(bars[100_000 - DRAW_WINDOW_BARS].time);
  });

  it("keeps the window while the view is well inside it, moves it near an edge", () => {
    const bars = barsOf(100_000);
    const w = nextDrawWindow(bars, { from: 99_700, to: 99_999 }, null)!;
    const firstDrawn = 100_000 - DRAW_WINDOW_BARS;
    expect(nextDrawWindow(bars, { from: firstDrawn + DRAW_WINDOW_MARGIN, to: firstDrawn + DRAW_WINDOW_MARGIN + 300 }, w)).toBe(w);
    const moved = nextDrawWindow(bars, { from: firstDrawn + 100, to: firstDrawn + 400 }, w)!;
    expect(moved).not.toBe(w);
    expect(moved.to).not.toBe(Infinity);
    expect(moved.from).toBeLessThan(bars[firstDrawn].time);
  });

  it("makes again a window open at the start that took the older pages loaded after it", () => {
    const bars = barsOf(35_000);
    const w = nextDrawWindow(bars, { from: 0, to: 300 }, null)!;
    expect(w.from).toBe(-Infinity);
    // 65,000 older bars come in front: the same view is now 65,000 bars further.
    const more = [...barsOf(65_000).map((b) => ({ ...b, time: b.time - 1_000_000 })), ...bars];
    const again = nextDrawWindow(more, { from: 0, to: 300 }, w)!;
    expect(again).not.toBe(w);
    expect(again.to).toBe(more[DRAW_WINDOW_BARS - 1].time);
  });

  it("reaches the first bar at the start", () => {
    const w = nextDrawWindow(barsOf(100_000), { from: 0, to: 300 }, null)!;
    expect(w.from).toBe(-Infinity);
  });

  it("is wider than the view when the view is wider than a window", () => {
    const bars = barsOf(200_000);
    const w = nextDrawWindow(bars, { from: 50_000, to: 100_000 }, null)!;
    expect(w.from).toBeLessThanOrEqual(bars[50_000].time);
    expect(w.to).toBeGreaterThanOrEqual(bars[100_000].time);
  });
});

describe("windowResult", () => {
  it("cuts the bars and every per-bar output to the window, keeping the positions they go with", () => {
    const bars = barsOf(10);
    const t = (i: number) => bars[i].time;
    const result = {
      plots: { p: bars.map((b) => ({ time: b.time, value: b.close })), q: bars.slice(4).map((b) => ({ time: b.time, value: 1 })) },
      fills: [
        { plot1: "q", plot2: "p", colors: ["c4", "c5", "c6", "c7", "c8", "c9"] },
        { plot1: "p", plot2: "q", gradient: { topValue: bars.map((_, i) => i), bottomValue: bars.map((_, i) => -i), topColor: bars.map(() => "a"), bottomColor: bars.map(() => null) } },
      ],
      markers: [{ time: t(1) }, { time: t(5) }],
      barColors: [{ time: t(6), color: "x" }],
      plotCandles: { c: [{ time: t(2) }, { time: t(7) }] },
      lines: [{ x1: t(0) }],
    };
    const { bars: cut, result: r } = windowResult(bars, result, { from: t(5), to: t(7) });
    expect(cut.map((b) => b.close)).toEqual([5, 6, 7]);
    expect(r.plots.p.map((p) => p.value)).toEqual([5, 6, 7]);
    expect(r.plots.q.map((p) => p.time)).toEqual([t(5), t(6), t(7)]);
    expect(r.fills[0].colors).toEqual(["c5", "c6", "c7"]);
    expect(r.fills[1].gradient!.topValue).toEqual([5, 6, 7]);
    expect(r.markers).toEqual([{ time: t(5) }]);
    expect(r.barColors).toEqual([{ time: t(6), color: "x" }]);
    expect(r.plotCandles.c).toEqual([{ time: t(7) }]);
    expect(r.lines).toBe(result.lines);
  });

  it("cuts the colours of a fill between two levels along the bars, keeps a whole window's fills as they are", () => {
    const bars = barsOf(10);
    const colors = bars.map((_, i) => `c${i}`);
    const result = { plots: { p: bars.slice(0, 8).map((b) => ({ time: b.time, value: 1 })) }, fills: [{ plot1: "hline_upper", plot2: "hline_lower", colors }, { plot1: "p", plot2: "hline_lower", colors }] };
    const { result: r } = windowResult(bars, result, { from: bars[5].time, to: bars[7].time });
    expect(r.fills[0].colors).toEqual(["c5", "c6", "c7"]);
    const whole = windowResult(bars, result, { from: -Infinity, to: Infinity }).result;
    expect(whole.fills).toEqual(result.fills);
  });

  it("keeps the points after the last bar when the window reaches it", () => {
    const bars = barsOf(5);
    const result = { plots: { p: [...bars, { time: 9999 }].map((b) => ({ time: b.time, value: 1 })) } };
    const { result: r } = windowResult(bars, result, { from: bars[2].time, to: Infinity });
    expect(r.plots.p.map((p) => p.time)).toEqual([bars[2].time, bars[3].time, bars[4].time, 9999]);
  });
});
