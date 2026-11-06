/** Live strategy runs (#255): a feed of ticks and new bars through createStrategyRun gives the full runs' results. */
import { describe, expect, it } from "vitest";
import { calculateTechnicalRatingsStandard } from "lightweight-charts-indicators";
import { strategy } from "oakscriptjs/script";
import { BUILTIN_STRATEGIES } from "../builtins";
import { provideTechnicalRatings } from "../builtins/technical-ratings";
import { BrokerEngine, createStrategyRun, runOakScriptStrategy, type OakScriptRunOptions } from "../oakscript";
import { SCRIPT_STRATEGIES } from "../scripts";
import { DEFAULT_PROPERTIES, DEFAULT_SYMBOL, type Bar } from "../types";
import { datasets } from "./golden";
import { liveFeed } from "./live-feed";

provideTechnicalRatings(calculateTechnicalRatingsStandard);

/** The report without its run time. */
function comparable(out: ReturnType<typeof runOakScriptStrategy>) {
  return { report: out.report && { ...out.report, elapsedMs: 0 }, result: out.script.result };
}

describe("BrokerEngine save / restore", () => {
  it("puts the whole broker state back on a new engine, open trades shared with their exit legs", () => {
    const bars: Bar[] = Array.from({ length: 6 }, (_, i) => ({ time: 86_400 * (i + 1), open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 100 }));
    const props = { ...DEFAULT_PROPERTIES, defaultQtyType: "fixed" as const, defaultQtyValue: 2 };
    const a = new BrokerEngine(bars, props, DEFAULT_SYMBOL);
    a.processBar(0);
    a.entry("L", "long", {});
    a.processClose(0);
    a.processBar(1);
    a.exit("X", { from_entry: "L", profit: 300 });
    a.processClose(1);
    const state = a.save();
    const b = new BrokerEngine(bars, props, DEFAULT_SYMBOL);
    b.restore(state);
    for (const e of [a, b]) {
      e.processBar(2);
      e.processClose(2);
    }
    expect(b.get("position_size")).toBe(2);
    expect(b.equity.slice(0, 3)).toEqual(a.equity.slice(0, 3));
    expect(b.broker.filledOrders).toEqual(a.broker.filledOrders);
    expect(b.openTrade(0)).toEqual(a.openTrade(0));
    // The saved state is not changed by the engine it came from, nor by the one it was restored on.
    const c = new BrokerEngine(bars, props, DEFAULT_SYMBOL);
    c.restore(state);
    expect(c.equity[2]).toBeNaN();
    expect(c.get("position_size")).toBe(2);
  });
});

describe("createStrategyRun", () => {
  const ds = datasets().find((d) => d.name === "daily")!;
  const bars = ds.bars.slice(0, 700);

  it("a strategy with orders over ticks and new bars: the full runs' reports, trades and plots", () => {
    const body = () => {
      strategy("Live test", { overlay: true, default_qty_type: strategy.percent_of_equity, default_qty_value: 50, pyramiding: 2 });
      strategy.eachBar((c) => {
        if (c.close > c.open && strategy.position_size <= 0) strategy.entry("L", strategy.long);
        if (c.close < c.open * 0.99) strategy.entry("S", strategy.short, { stop: c.low });
        strategy.exit("XL", { from_entry: "L", profit: 200, loss: 150 });
      });
    };
    const opts: OakScriptRunOptions = { chart: ds.chart };
    const run = createStrategyRun(body, { verify: 0 });
    let resumed = 0;
    for (const feed of liveFeed(bars, 600, 30)) {
      const live = run.update(feed, opts);
      expect(live.fullRunReason).toBeNull();
      if ((live.script as { incremental?: boolean }).incremental) resumed++;
      expect(comparable(live)).toEqual(comparable(runOakScriptStrategy(body, feed, opts)));
    }
    expect(resumed).toBeGreaterThan(80);
  });

  it("a realtime forming bar the strategy does not run on, then other properties: the full runs' reports", () => {
    const body = () => {
      strategy("Live realtime", { overlay: true });
      strategy.eachBar((c) => {
        if (c.close > c.open) strategy.entry("L", strategy.long);
        else strategy.close("L");
      });
    };
    const run = createStrategyRun(body, { verify: 0 });
    const feeds = liveFeed(bars, 650, 10);
    feeds.forEach((feed, k) => {
      const opts: OakScriptRunOptions = { chart: { ...ds.chart, realtime: true }, properties: k > 20 ? { slippage: 2 } : {} };
      expect(comparable(run.update(feed, opts))).toEqual(comparable(runOakScriptStrategy(body, feed, opts)));
    });
  });

  // Every built-in and community strategy script: those the runtime resumes and those it calculates in full give the
  // full runs' results.
  for (const s of [...BUILTIN_STRATEGIES, ...SCRIPT_STRATEGIES]) {
    it(`${s.key}: live updates equal full runs`, () => {
      const opts: OakScriptRunOptions = { chart: ds.chart };
      const run = createStrategyRun(s.body);
      for (const feed of liveFeed(bars, 640, 5)) {
        let full: ReturnType<typeof comparable> | Error;
        try {
          full = comparable(runOakScriptStrategy(s.body, feed, opts));
        } catch (err) {
          full = err as Error;
        }
        if (full instanceof Error) {
          expect(() => run.update(feed, opts)).toThrow(full.message);
          return;
        }
        expect(comparable(run.update(feed, opts))).toEqual(full);
      }
    });
  }
});
