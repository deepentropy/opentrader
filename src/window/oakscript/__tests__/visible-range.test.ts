import { describe, expect, it } from "vitest";
import { chart as chartApi, close, createScriptRun, indicator, plot, type ChartContext } from "oakscriptjs/script";
import { KeptRuns, SentRuns } from "../../../backtester/live-runs";
import { intradaySeries } from "../../../backtester/__tests__/synthetic";
import { builtinSource } from "lightweight-charts-indicators/sources";
import { readsVisibleRange } from "../script-transform";
import { updateLiveScript, type LiveScript } from "../live-script";

describe("readsVisibleRange (#410)", () => {
  it("finds the script variables and the chart context's times", () => {
    expect(readsVisibleRange("plot(chart.right_visible_bar_time)")).toBe(true);
    expect(readsVisibleRange("const { left_visible_bar_time } = chart;")).toBe(true);
    expect(readsVisibleRange('plot(chart["left_visible_bar_time"])')).toBe(true);
    expect(readsVisibleRange("export function calculate(bars, i, chart) { return visibleRangeOf(bars, chart); }")).toBe(true);
    expect(readsVisibleRange("const t = chart.rightVisibleBarTime;")).toBe(true);
  });

  it("not in a comment, nor as a part of another name", () => {
    expect(readsVisibleRange("// chart.right_visible_bar_time\nplot(close)")).toBe(false);
    expect(readsVisibleRange("/* chart.left_visible_bar_time */ plot(close)")).toBe(false);
    expect(readsVisibleRange("const my_left_visible_bar_time_2 = 1;")).toBe(false);
    expect(readsVisibleRange('const url = "https://x.y"; plot(chart.right_visible_bar_time)')).toBe(true);
  });

  it("a copy of a built-in that reads it keeps its flag", () => {
    expect(readsVisibleRange(builtinSource("visible-average-price")!)).toBe(true);
    expect(readsVisibleRange(builtinSource("rsi")!)).toBe(false);
  });
});

describe("a live script and the bars in view (#410)", () => {
  const bars = intradaySeries().slice(0, 400);
  const chart = (k: number): ChartContext => ({ timeframe: "5", timezone: "America/New_York", session: "0930-1600", leftVisibleBarTime: k, rightVisibleBarTime: k + 1 });
  function feed(body: () => void) {
    const host = new SentRuns();
    const worker = new KeptRuns<LiveScript>();
    const entry = { kind: "script" as const, run: body };
    return (k: number) => {
      const sent = host.request("a", bars, false);
      const out = updateLiveScript(worker, entry, structuredClone({ bars: sent.bars, inputs: {}, chart: chart(k), live: sent.live }))!;
      const reply = structuredClone(out);
      return host.received("a", reply.result, reply.live) as { plots: Record<string, { value: number }[]> };
    };
  }

  it("the values follow the view", () => {
    const run = feed(() => {
      indicator("x", { overlay: true });
      plot(close.mul(0).add(chartApi.right_visible_bar_time), "R");
    });
    const last = (k: number) => Object.values(run(k).plots)[0]![bars.length - 1]!.value;
    expect([last(5), last(5), last(9)]).toEqual([6, 6, 10]);
  });

  it("a script that does not read it is resumed when the view moves", () => {
    const run = createScriptRun(() => {
      indicator("x", { overlay: true });
      plot(close, "C");
    });
    run.update(bars as never[], chart(1));
    expect(run.update(bars as never[], chart(2)).incremental).toBe(true);
  });
});
