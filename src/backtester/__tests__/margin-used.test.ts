/**
 * The reference app's average / open margin used, a trailing stop moved to the price reached, and order prices
 * below zero (issues #163, #164).
 */
import { describe, expect, it } from "vitest";
import { StrategyRuntimeError, type Broker } from "../broker";
import { runBacktest, type StrategyDefinition } from "../run";
import type { Bar, StrategyProperties } from "../types";

const DAY = 86_400;
function bar(i: number, open: number, high: number, low: number, close: number): Bar {
  return { time: 1_704_067_200 + i * DAY, open, high, low, close, volume: 1000 };
}

function run(bars: Bar[], onBar: (i: number, s: Broker) => void, properties: Partial<StrategyProperties> = {}) {
  const def: StrategyDefinition = {
    key: "test",
    title: "test",
    source: { id: "", name: "", author: "" },
    properties,
    defaultInputs: {},
    inputs: [],
    setup: () => onBar,
  };
  return runBacktest(bars, def);
}

// Closes 10, 11, 12, 13, 14, 15.
const flat = (n: number) => Array.from({ length: n }, (_, i) => bar(i, 10 + i, 10 + i, 10 + i, 10 + i));

describe("margin used", () => {
  // 10 shares bought at the close of bar 1 (11), closed at the close of bar 3 (13), process_orders_on_close.
  const script = (i: number, s: Broker) => {
    if (i === 1) s.entry("L", "long", { qty: 10 });
    if (i === 3) s.close("L");
  };

  it("long-only margin: flat bars keep the margin at the exit bar's close", () => {
    const r = run(flat(6), script, { processOrdersOnClose: true, marginLong: 50 });
    // Bars 1..4 (the last bar is left out): 55, 60, 65 at bar 3's close, kept at bar 4.
    expect(r.performance.avgMarginUsed).toBeCloseTo((55 + 60 + 65 + 65) / 4, 10);
    expect(r.performance.openMarginUsed).toBeCloseTo(65, 10);
  });

  it("with a short margin: flat bars count 0", () => {
    const r = run(flat(6), script, { processOrdersOnClose: true, marginLong: 50, marginShort: 50 });
    // Bar 3: the position closed at the close, read again after the fill.
    expect(r.performance.avgMarginUsed).toBeCloseTo((55 + 60 + 0 + 0) / 4, 10);
    expect(r.performance.openMarginUsed).toBe(0);
  });

  it("no margin: 0", () => {
    const r = run(flat(6), script, { processOrdersOnClose: true });
    expect(r.performance.avgMarginUsed).toBe(0);
    expect(r.performance.openMarginUsed).toBe(0);
  });
});

describe("trailing stop at the price reached", () => {
  it("a 1.025 high on a 0.01 tick is 1.02: an offset of 0 ticks fills there, not at the next bar", () => {
    const bars = [bar(0, 0.9, 0.9, 0.9, 0.9), bar(1, 0.91, 0.912, 0.873, 0.889), bar(2, 0.97975, 1.025, 0.975, 1.0245), bar(3, 1.01675, 1.07, 1.0135, 1.05)];
    const r = run(bars, (i, s) => {
      if (i === 0) s.entry("L", "long", { qty: 1 });
      s.exit("X", { fromEntry: "L", trailPoints: 0.009, trailOffset: 0.004 });
    });
    expect(r.trades[0].exit?.bar).toBe(2);
    expect(r.trades[0].exit?.price).toBeCloseTo(1.02, 10);
  });
});

describe("order price below zero", () => {
  it("a sell stop at -0.0278 is placed at -0.02: RE10024 with the size cut toward zero", () => {
    const bars = [bar(0, 0.3, 0.3, 0.25, 0.25), bar(1, 0.25, 0.25, 0.25, 0.25)];
    let err: StrategyRuntimeError | null = null;
    try {
      run(bars, (_i, s) => s.entry("S", "short", { stop: -0.0278 }), { defaultQtyType: "cash", defaultQtyValue: 5001 });
    } catch (e) {
      err = e as StrategyRuntimeError;
    }
    expect(err?.code).toBe("RE10024");
    // 5,001 / -0.02 = -250,050.
    expect(err?.value).toBe(-250050);
  });
});
