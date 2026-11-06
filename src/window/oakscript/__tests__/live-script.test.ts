/**
 * Live runs of user scripts and strategies through the worker path (#255): the host's requests (changed bars only,
 * results as changes) and the worker's kept runs, the messages copied as postMessage copies them. After a feed of
 * ticks and new bars, the host's results equal full runs on the same bars.
 */
import { describe, expect, it } from "vitest";
import { close, eachBar, executeScript, indicator, input, label, persist, plot, strategy, ta, type ChartContext } from "oakscriptjs/script";
import { KeptRuns, SentRuns, updateLiveStrategy, type KeptStrategy } from "../../../backtester/live-runs";
import { restoreTimes, runOakScriptStrategy, scriptBars, type OakScriptRunOptions } from "../../../backtester/oakscript";
import { liveFeed } from "../../../backtester/__tests__/live-feed";
import { dailySeries, intradaySeries } from "../../../backtester/__tests__/synthetic";
import type { Bar } from "../../../backtester/types";
import { updateLiveScript, type Compiled, type LiveScript } from "../live-script";

const CHART: ChartContext = { timeframe: "5", timezone: "America/New_York", session: "0930-1600" };
const BARS = intradaySeries().slice(0, 1_400);

/** A host and a worker of user scripts, the messages between them copied. */
class ScriptChannel {
  host = new SentRuns();
  worker = new KeptRuns<LiveScript>();

  update(entry: Compiled, key: string, bars: Bar[], inputs: Record<string, unknown> = {}, chart: ChartContext = CHART, restamp = false) {
    for (let whole = false; ; whole = true) {
      const sent = this.host.request(key, bars, whole);
      const out = updateLiveScript(this.worker, entry, structuredClone({ bars: sent.bars, inputs, chart, live: sent.live, restamp }));
      if (!out) {
        expect(whole).toBe(false);
        continue;
      }
      const reply = structuredClone(out);
      return { result: this.host.received(key, reply.result, reply.live), reason: reply.live.fullRunReason, sent: sent.bars.length, delta: reply.live.delta };
    }
  }
}

/** The output of a full run, as the worker sends it. */
function fullRun(body: () => void, bars: Bar[], inputs: Record<string, unknown> = {}): unknown {
  const run = executeScript(body, bars, inputs, CHART);
  return structuredClone(run.drawingKinds.length ? { ...run.result, drawingKinds: run.drawingKinds } : run.result);
}

const trendBody = () => {
  indicator("Live trend", { overlay: false });
  const length = input.int(14, "Length");
  const ma = ta.sma(close, length);
  const dir = persist(0);
  const trend = eachBar((c) => {
    if (c.close > c.get(ma)) dir.value = 1;
    else if (c.close < c.get(ma)) dir.value = -1;
    return dir.value;
  });
  plot(trend, "Trend");
  plot(ma, "MA");
  plot(ta.rsi(close, length), "RSI");
};

describe("user scripts on live updates", () => {
  it("eachBar + persist: resumed, the changed bars sent, the results of full runs", () => {
    const ch = new ScriptChannel();
    const entry: Compiled = { kind: "script", run: trendBody };
    const feed = liveFeed(BARS, 1_300, 40);
    feed.forEach((bars, k) => {
      const got = ch.update(entry, "chart|study", bars);
      expect(got.result).toEqual(fullRun(trendBody, bars));
      if (k > 0) {
        expect(got.reason).toBeNull();
        // The forming bar (and the new one after it), the result as the changes from the one before.
        expect(got.sent).toBeLessThanOrEqual(2);
        expect(got.delta).toBe(true);
      }
    });
  });

  it("other inputs, history loaded before, a new worker: whole runs, the results of full runs", () => {
    const ch = new ScriptChannel();
    const entry: Compiled = { kind: "script", run: trendBody };
    const feed = liveFeed(BARS, 1_300, 12);
    feed.forEach((bars, k) => {
      const inputs = k >= 10 ? { length: 9 } : {};
      // More history at the start from the 20th update; the worker replaced at the 30th.
      const given = k >= 20 ? bars : bars.slice(100);
      if (k === 30) ch.worker = new KeptRuns<LiveScript>();
      const got = ch.update(entry, "chart|study", given, inputs);
      expect(got.result).toEqual(fullRun(trendBody, given, inputs));
      if (k === 20 || k === 30) expect(got.sent).toBe(given.length);
    });
  });

  it("a script keeping state outside persist() (full runs, with the reason) and one with drawings: the same results", () => {
    const outside = () => {
      indicator("Outside state");
      let count = 0;
      plot(eachBar((c) => (c.close > c.open ? ++count : count)), "Up bars");
    };
    const drawings = () => {
      indicator("Drawings", { overlay: true });
      const hi = ta.highest(close, 20);
      eachBar((c) => {
        if (c.close >= c.get(hi)) label.new(c.i, c.close, "High");
      });
      plot(hi, "Highest");
    };
    for (const [body, why] of [[outside, /count outside it/], [drawings, null]] as const) {
      const ch = new ScriptChannel();
      const entry: Compiled = { kind: "script", run: body };
      let reason: string | null = null;
      for (const bars of liveFeed(BARS, 1_300, 8)) {
        const got = ch.update(entry, "chart|study", bars);
        expect(got.result).toEqual(fullRun(body, bars));
        reason = got.reason;
      }
      if (why) expect(reason).toMatch(why);
      else expect(reason).toBeNull();
    }
  });

  it("daily bars: restamped in the worker, the changes on the chart's times, the results of full runs", () => {
    const daily: ChartContext = { timeframe: "1D", timezone: "America/New_York", session: "0930-1600", regularSession: "0930-1600" };
    const bars0 = dailySeries();
    const ch = new ScriptChannel();
    const entry: Compiled = { kind: "script", run: trendBody };
    liveFeed(bars0, bars0.length - 60, 30).forEach((bars, k) => {
      const got = ch.update(entry, "chart|daily", bars, {}, daily, true);
      // The full run on the bars as scripts read them, put back on the chart's times (as the chart did before).
      const seen = scriptBars(bars, daily);
      expect(seen).not.toBe(bars);
      const run = executeScript(trendBody, seen, {}, daily);
      const want = structuredClone(run.result);
      restoreTimes(want, seen, bars);
      expect(got.result).toEqual(want);
      if (k > 0) {
        expect(got.sent).toBeLessThanOrEqual(2);
        expect(got.delta).toBe(true);
      }
    });
  });

  it("a calculate() module: the kept bars with the changed ones, a reason", () => {
    const mod = { calculate: (given: unknown[]) => ({ plots: { last: (given as Bar[]).map((b) => ({ time: b.time, value: b.close })) } }) };
    const ch = new ScriptChannel();
    for (const bars of liveFeed(BARS, 1_300, 4)) {
      const got = ch.update({ kind: "convention", mod }, "chart|study", bars);
      expect(got.result).toEqual(mod.calculate(bars));
      expect(got.reason).toMatch(/calculate\(\)/);
    }
  });
});

describe("strategies on live updates", () => {
  const body = () => {
    strategy("Live strategy", { overlay: true, default_qty_type: strategy.percent_of_equity, default_qty_value: 20 });
    const fast = ta.ema(close, 9);
    const slow = ta.ema(close, 21);
    strategy.eachBar((c) => {
      if (c.get(fast) > c.get(slow) && c.get(fast, 1) <= c.get(slow, 1)) strategy.entry("L", strategy.long);
      if (c.get(fast) < c.get(slow) && c.get(fast, 1) >= c.get(slow, 1)) strategy.entry("S", strategy.short, { limit: c.close * 1.001 });
      strategy.exit("XL", { from_entry: "L", loss: 300 });
    });
    plot(fast, "Fast");
    plot(slow, "Slow");
  };

  it("orders over ticks and new bars: the full runs' reports, trades and plots", () => {
    const host = new SentRuns();
    const worker = new KeptRuns<KeptStrategy | null>();
    const opts: OakScriptRunOptions = { chart: CHART };
    for (const bars of liveFeed(BARS, 1_300, 40)) {
      const sent = host.request("chart|strategy", bars);
      const out = structuredClone(updateLiveStrategy(worker, structuredClone(sent.live), body, structuredClone(sent.bars), opts)!);
      const visuals = host.received("chart|strategy", out.visuals, out.live);
      expect(out.live.fullRunReason).toBeNull();
      const full = runOakScriptStrategy(body, bars, opts);
      expect({ ...out.report!, elapsedMs: 0 }).toEqual(structuredClone({ ...full.report!, elapsedMs: 0 }));
      expect(visuals).toEqual(structuredClone(full.script.result));
    }
  });
});
