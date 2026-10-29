/** The OakScript bridge: strategy() properties, chart context, script bar times and a small script run end to end. */
import { describe, expect, it } from "vitest";
import { strategy } from "oakscriptjs/script";
import type { StrategyProperties as ScriptStrategyProperties } from "oakscriptjs/script";
import { localToUtc } from "../../data/session/zone";
import { brokerProperties, chartWithSymbols, restoreTimes, runOakScriptStrategy, scriptBars, symbolOf } from "../oakscript";
import { runBacktest, type StrategyDefinition } from "../run";
import type { Bar } from "../types";

const NY = "America/New_York";
const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

const scriptProps: ScriptStrategyProperties = {
  initial_capital: 50_000,
  currency: "EUR",
  default_qty_type: "percent_of_equity",
  default_qty_value: 25,
  pyramiding: 2,
  commission_type: "cash_per_order",
  commission_value: 1.5,
  slippage: 3,
  process_orders_on_close: true,
  close_entries_rule: "ANY",
  margin_long: 100,
  margin_short: 50,
} as ScriptStrategyProperties;

describe("brokerProperties", () => {
  it("maps the Pine names to the broker properties, with defaults for the optional ones", () => {
    expect(brokerProperties(scriptProps)).toEqual({
      initialCapital: 50_000,
      currency: "EUR",
      defaultQtyType: "percent_of_equity",
      defaultQtyValue: 25,
      pyramiding: 2,
      commissionType: "cash_per_order",
      commissionValue: 1.5,
      slippage: 3,
      processOrdersOnClose: true,
      closeEntriesRule: "ANY",
      marginLong: 100,
      marginShort: 50,
      fillLimitsTicks: 0,
      barMagnifier: false,
      calcOnOrderFills: false,
      calcOnEveryTick: false,
      calcOnEveryHistoryTick: false,
      fillOrdersOnStandardOhlc: false,
    });
    expect(brokerProperties({ ...scriptProps, currency: undefined } as unknown as ScriptStrategyProperties).currency).toBe("USD");
    expect(brokerProperties({ ...scriptProps, backtest_fill_limits_assumption: 2, use_bar_magnifier: true }).fillLimitsTicks).toBe(2);
  });

  it("passes calc_on_order_fills and calc_on_every_history_tick to the broker", () => {
    const p = brokerProperties({ ...scriptProps, calc_on_order_fills: true, calc_on_every_history_tick: true });
    expect([p.calcOnOrderFills, p.calcOnEveryHistoryTick]).toEqual([true, true]);
  });
});

describe("intrabar runs (calc_on_order_fills)", () => {
  // Bar 2 closes above 10: a long entry fills at the open of bar 3. The script closes any open position.
  const BARS: Bar[] = [10, 10, 11, 12, 13, 14].map((c, i) => ({ time: 1_700_000_000 + i * 86_400, open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
  const body = (fills: boolean) => () => {
    strategy("T", { calc_on_order_fills: fills, default_qty_type: "fixed", default_qty_value: 1 });
    strategy.eachBar((c) => {
      if (c.i === 2) strategy.entry("L", strategy.long);
      if (c.i >= 3 && strategy.position_size > 0) strategy.close("L");
    });
  };
  it("runs the script again at the fill: its close fills at once at the open", () => {
    const trades = runOakScriptStrategy(body(true), BARS).report!.trades;
    expect(trades.map((t) => [t.entry.bar, t.entry.price, t.exit.bar, t.exit.price])).toEqual([[3, 12, 3, 12]]);
  });
  it("without it the close waits for the bar close and fills at the next open", () => {
    const trades = runOakScriptStrategy(body(false), BARS).report!.trades;
    expect(trades.map((t) => [t.entry.bar, t.exit.bar, t.exit.price])).toEqual([[3, 4, 13]]);
  });
});

describe("symbolOf / chartWithSymbols", () => {
  it("takes the zone and tick of the chart context", () => {
    expect(symbolOf(undefined)).toEqual({});
    expect(symbolOf({ timezone: "Europe/Paris", mintick: 0.5 })).toEqual({ timezone: "Europe/Paris", mintick: 0.5 });
    expect(symbolOf({ timeframe: "1D" })).toEqual({});
  });

  it("adds accessors of the other symbols' bars keyed symbol|timeframe", () => {
    expect(chartWithSymbols(undefined, undefined)).toEqual({});
    const bars: Bar[] = [{ time: 1, open: 1, high: 1, low: 1, close: 1 }];
    const ctx = chartWithSymbols({ timeframe: "1D" }, { bars: { "NASDAQ:AAPL|1D": bars }, info: {} });
    expect(ctx.timeframe).toBe("1D");
    expect(ctx.bars?.("NASDAQ:AAPL", "1D")).toBe(bars);
    expect(ctx.bars?.("NASDAQ:AAPL", "60")).toBeUndefined();
  });
});

describe("scriptBars", () => {
  const daily = (d: number): Bar => ({ time: localToUtc(NY, d, 0), open: 1, high: 1, low: 1, close: 1 });
  const chart = { timeframe: "1D", timezone: NY, session: "0930-1600" };

  it("stamps daily bars at the regular-session open in the exchange zone, both sides of DST", () => {
    const winter = daily(day(2024, 1, 10));
    const summer = daily(day(2024, 7, 10));
    const [w, s] = scriptBars([winter, summer], chart);
    expect(new Date(w.time * 1000).toISOString()).toBe("2024-01-10T14:30:00.000Z");
    expect(new Date(s.time * 1000).toISOString()).toBe("2024-07-10T13:30:00.000Z");
    // Only the time changes; the input is not mutated.
    expect(w.close).toBe(1);
    expect(winter.time).toBe(localToUtc(NY, day(2024, 1, 10), 0));
  });

  it("keeps intraday bars, bars off local midnight, 24x7 sessions and contexts without a zone", () => {
    const bars = [daily(day(2024, 1, 10))];
    expect(scriptBars(bars, { ...chart, timeframe: "60" })).toBe(bars);
    expect(scriptBars(bars, { ...chart, session: "24x7" })).toBe(bars);
    expect(scriptBars(bars, { timeframe: "1D" })).toBe(bars);
    expect(scriptBars(bars, undefined)).toBe(bars);
    const offMidnight: Bar = { ...bars[0], time: bars[0].time + 3600 };
    expect(scriptBars([offMidnight], chart)[0]).toBe(offMidnight);
  });

  it("weekly and monthly bars move too", () => {
    const b = daily(day(2024, 1, 8));
    expect(scriptBars([b], { ...chart, timeframe: "1W" })[0].time).toBe(b.time + (9 * 60 + 30) * 60);
    expect(scriptBars([b], { ...chart, timeframe: "M" })[0].time).toBe(b.time + (9 * 60 + 30) * 60);
  });
});

describe("restoreTimes", () => {
  it("maps every time / timeN key back to the chart's bar times, future times keep their distance", () => {
    const bars: Bar[] = [100, 200, 300].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));
    const seen: Bar[] = bars.map((b) => ({ ...b, time: b.time + 50 }));
    const shared = { time: 250 };
    const result = {
      plots: { p: [{ time: 150, value: 1 }, { time: 350, value: 2 }] },
      lines: [{ time1: 150, time2: 400, price: 150 }],
      fills: [shared, shared],
      other: { timeout: 150, time: "150" },
    };
    restoreTimes(result, seen, bars);
    expect(result.plots.p).toEqual([{ time: 100, value: 1 }, { time: 300, value: 2 }]);
    // 400 is 50 s after the last seen bar (350): 50 s after the last chart bar.
    expect(result.lines[0]).toEqual({ time1: 100, time2: 350, price: 150 });
    // An object reached twice moves once.
    expect(shared.time).toBe(200);
    // Not a time key, or not a number: unchanged.
    expect(result.other).toEqual({ timeout: 150, time: "150" });
  });
});

describe("runOakScriptStrategy", () => {
  const bars: Bar[] = Array.from({ length: 6 }, (_, i) => ({
    time: 1_704_067_200 + i * 86_400,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
  }));

  function body(): void {
    strategy("test", { overlay: true, initial_capital: 10_000 });
    strategy.eachBar((c) => {
      if (c.i === 0) strategy.entry("L", strategy.long, { qty: 3 });
      if (c.i === 3) strategy.close("L");
    });
  }

  it("runs a script on the broker: same trades as the TypeScript API", () => {
    const run = runOakScriptStrategy(body, bars);
    expect(run.report).toBeDefined();
    const r = run.report!;
    expect(r.properties.initialCapital).toBe(10_000);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entry).toMatchObject({ bar: 1, price: 101, signal: "L" });
    expect(r.trades[0].exit).toMatchObject({ bar: 4, price: 104 });
    expect(r.trades[0].profit).toBe(9);

    const def: StrategyDefinition = {
      key: "same",
      title: "same",
      source: { id: "", name: "", author: "" },
      properties: { initialCapital: 10_000 },
      defaultInputs: {},
      inputs: [],
      setup: () => (i, s) => {
        if (i === 0) s.entry("L", "long", { qty: 3 });
        if (i === 3) s.close("L");
      },
    };
    const ts = runBacktest(bars, def);
    expect(ts.trades).toEqual(r.trades);
    expect(ts.filledOrders).toEqual(r.filledOrders);
    expect(ts.equity).toEqual(r.equity);
  });

  it("property overrides win over the script's declaration", () => {
    const r = runOakScriptStrategy(body, bars, { properties: { commissionType: "cash_per_order", commissionValue: 2 } }).report!;
    expect(r.trades[0].commission).toBe(4);
    expect(r.trades[0].profit).toBe(5);
  });

  it("a script without strategy() gives no report", () => {
    const run = runOakScriptStrategy(() => {}, bars);
    expect(run.report).toBeUndefined();
  });

  it("strategy.close(immediately) is reported as unsupported", () => {
    const body2 = () => {
      strategy("t2", {});
      strategy.eachBar((c) => {
        if (c.i === 0) strategy.entry("L", strategy.long, { qty: 1 });
        if (c.i === 2) strategy.close("L", { immediately: true });
      });
    };
    expect(() => runOakScriptStrategy(body2, bars)).toThrow(/immediately/);
  });
});
