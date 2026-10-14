/**
 * Hand-checked broker rules on tiny bar series: fills, P&L, commissions, slippage, sizing, pyramiding, reversals,
 * brackets, price rounding, runtime errors and the report built from them.
 */
import { describe, expect, it } from "vitest";
import { StrategyRuntimeError, type Broker } from "../broker";
import { binIntrabars, chartBars, heikinAshiBars, runBacktest, type StrategyDefinition } from "../run";
import type { Bar, StrategyProperties, SymbolInfo } from "../types";

const DAY = 86_400;
/** Bar i of a test series: daily bars from 01/01/2024 00:00 UTC. */
function bar(i: number, open: number, high: number, low: number, close: number): Bar {
  return { time: 1_704_067_200 + i * DAY, open, high, low, close, volume: 1000 };
}

/** Rising bars: open 100 + 2i, high +1.5, low -1.5, close +1 (bar 0: 100 / 101.5 / 98.5 / 101). */
function rising(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => bar(i, 100 + 2 * i, 101.5 + 2 * i, 98.5 + 2 * i, 101 + 2 * i));
}

function strategy(onBar: (i: number, s: Broker) => void, properties: Partial<StrategyProperties> = {}): StrategyDefinition {
  return {
    key: "test",
    title: "test",
    source: { id: "", name: "", author: "" },
    properties,
    defaultInputs: {},
    inputs: [],
    setup: () => onBar,
  };
}

function run(bars: Bar[], onBar: (i: number, s: Broker) => void, properties: Partial<StrategyProperties> = {}, symbol: Partial<SymbolInfo> = {}) {
  return runBacktest(bars, strategy(onBar, properties), { symbol });
}

describe("market orders", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 102, 103, 101, 102), bar(2, 104, 106, 103, 105), bar(3, 107, 108, 106, 107)];

  it("fill at the next bar's open; the trade P&L is qty x price move", () => {
    const r = run(bars, (i, s) => {
      if (i === 0) s.entry("L", "long", { qty: 10 });
      if (i === 2) s.close("L");
    });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.direction).toBe("long");
    expect(t.open).toBe(false);
    expect(t.entry).toMatchObject({ signal: "L", price: 102, bar: 1, time: bars[1].time * 1000 });
    expect(t.exit).toMatchObject({ signal: "Close entry(s) order L", price: 107, bar: 3 });
    expect(t.qty).toBe(10);
    expect(t.profit).toBe(50);
    expect(t.profitPercent).toBeCloseTo(50 / 1020, 12);
    expect(t.commission).toBe(0);
    expect(t.cumProfit).toBe(50);
    // Best price after the fill: the exit at 107; worst: bar 1's low 101.
    expect(t.runUp).toBe(50);
    expect(t.drawdown).toBe(10);
    expect(r.filledOrders.map((o) => [o.bar, o.buy, o.entry, o.type, o.id, o.price, o.qty])).toEqual([
      [1, true, true, "MARKET", "L", 102, 10],
      [3, false, false, "MARKET", "Close entry(s) order L", 107, 10],
    ]);
    expect(r.performance.all).toMatchObject({ netProfit: 50, grossProfit: 50, grossLoss: 0, totalTrades: 1, numberOfWiningTrades: 1, percentProfitable: 1, profitFactor: null });
    // Bars in trade count the entry and the exit bar.
    expect(r.performance.all.avgBarsInTrade).toBe(3);
    expect(r.equity[r.equity.length - 1]).toBe(1_000_050);
    expect(r.range).toEqual({ from: bars[0].time * 1000, to: bars[3].time * 1000 });
  });

  it("a short trade profits from a falling price", () => {
    const down = [bar(0, 50, 51, 49, 50), bar(1, 48, 49, 47, 48), bar(2, 45, 46, 44, 45), bar(3, 40, 41, 39, 40)];
    const r = run(down, (i, s) => {
      if (i === 0) s.entry("S", "short", { qty: 3 });
      if (i === 2) s.close("S");
    });
    expect(r.trades[0]).toMatchObject({ direction: "short", qty: 3, profit: 24 });
    expect(r.trades[0].entry.price).toBe(48);
    expect(r.trades[0].exit.price).toBe(40);
    expect(r.performance.short.netProfit).toBe(24);
    expect(r.performance.long.totalTrades).toBe(0);
  });

  it("process_orders_on_close fills at the close of the bar the order was placed on", () => {
    const r = run(
      bars,
      (i, s) => {
        if (i === 0) s.entry("L", "long", { qty: 1 });
        if (i === 2) s.closeAll();
      },
      { processOrdersOnClose: true },
    );
    expect(r.trades[0].entry).toMatchObject({ bar: 0, price: 100 });
    expect(r.trades[0].exit).toMatchObject({ bar: 2, price: 105, signal: "Close position order" });
    expect(r.trades[0].profit).toBe(5);
  });

  it("an open trade at the end is marked to the last close", () => {
    const r = run(bars, (i, s) => {
      if (i === 1) s.entry("L", "long", { qty: 2 });
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].open).toBe(true);
    expect(r.trades[0].entry.price).toBe(104);
    expect(r.trades[0].exit.price).toBe(107);
    expect(r.performance.openPL).toBe(6);
    expect(r.performance.all.totalTrades).toBe(0);
    expect(r.performance.all.totalOpenTrades).toBe(1);
  });

  it("no orders: no trades, flat equity, null statistics", () => {
    const r = run(bars, () => {});
    expect(r.trades).toEqual([]);
    expect(r.filledOrders).toEqual([]);
    expect(r.equity).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000]);
    expect(r.performance.all.percentProfitable).toBeNull();
    expect(r.performance.all.avgTrade).toBeNull();
    expect(r.performance.buyHoldReturnPercent).toBeNull();
    expect(r.performance.buyHoldReturn).toBe(0);
  });

  it("an empty series gives an empty report", () => {
    const r = run([], () => {});
    expect(r.trades).toEqual([]);
    expect(r.range).toEqual({ from: 0, to: 0 });
  });
});

describe("costs", () => {
  const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 110, 111, 109, 110), bar(3, 110, 111, 109, 110)];
  const roundTrip = (i: number, s: Broker) => {
    if (i === 0) s.entry("L", "long", { qty: 10 });
    if (i === 1) s.close("L");
  };

  it("percent commission is value x percent on each fill", () => {
    const r = run(bars, roundTrip, { commissionType: "percent", commissionValue: 0.1 });
    // Entry 10 x 100 = 1,000 -> 1.00; exit 10 x 110 = 1,100 -> 1.10.
    expect(r.trades[0].commission).toBeCloseTo(2.1, 10);
    expect(r.trades[0].entryCommission).toBeCloseTo(1, 10);
    expect(r.trades[0].profit).toBeCloseTo(100 - 2.1, 10);
    expect(r.performance.all.commissionPaid).toBeCloseTo(2.1, 10);
    expect(r.performance.all.grossProfitWC).toBeCloseTo(100, 10);
  });

  it("cash per contract and cash per order", () => {
    const perContract = run(bars, roundTrip, { commissionType: "cash_per_contract", commissionValue: 0.5 });
    expect(perContract.trades[0].commission).toBe(10); // 10 x 0.5 on both fills
    const perOrder = run(bars, roundTrip, { commissionType: "cash_per_order", commissionValue: 3 });
    expect(perOrder.trades[0].commission).toBe(6);
    expect(perOrder.trades[0].profit).toBe(94);
  });

  it("slippage moves market fills against the trader by whole ticks", () => {
    const r = run(bars, roundTrip, { slippage: 3 });
    expect(r.trades[0].entry.price).toBeCloseTo(100.03, 10);
    expect(r.trades[0].exit.price).toBeCloseTo(109.97, 10);
    expect(r.trades[0].profit).toBeCloseTo(99.4, 8);
    const coarse = run(bars, roundTrip, { slippage: 1 }, { mintick: 0.25 });
    expect(coarse.trades[0].entry.price).toBe(100.25);
    expect(coarse.trades[0].exit.price).toBe(109.75);
  });
});

describe("sizing", () => {
  it("fixed default quantity", () => {
    const r = run(rising(4), (i, s) => {
      if (i === 0) s.entry("L", "long");
    }, { defaultQtyType: "fixed", defaultQtyValue: 7 });
    expect(r.trades[0].qty).toBe(7);
  });

  it("percent of equity: equity x % / close, rounded down to whole shares", () => {
    // 10 % of 1,000,000 at the close 101: 990.09... -> 990.
    const r = run(rising(4), (i, s) => {
      if (i === 0) s.entry("L", "long");
    }, { defaultQtyType: "percent_of_equity", defaultQtyValue: 10 });
    expect(r.trades[0].qty).toBe(990);
  });

  it("cash: cash / close, commission included", () => {
    // 10,000 / (101 x 1.01) = 98.03 -> 98 (without the 1 % commission it would be 99).
    const r = run(rising(4), (i, s) => {
      if (i === 0) s.entry("L", "long");
    }, { defaultQtyType: "cash", defaultQtyValue: 10_000, commissionType: "percent", commissionValue: 1 });
    expect(r.trades[0].qty).toBe(98);
  });

  it("fractional quantity step", () => {
    const r = run(rising(4), (i, s) => {
      if (i === 0) s.entry("L", "long", { qty: 1.2345 });
    }, {}, { qtyStep: 0.01 });
    expect(r.trades[0].qty).toBeCloseTo(1.23, 12);
  });

  it("a negative quantity stops the script with RE10024 on its bar", () => {
    expect.assertions(4);
    try {
      run(rising(4), (i, s) => {
        if (i === 2) s.entry("L", "long", { qty: -1 });
      });
    } catch (e) {
      expect(e).toBeInstanceOf(StrategyRuntimeError);
      const err = e as StrategyRuntimeError;
      expect(err.code).toBe("RE10024");
      expect(err.bar).toBe(2);
      expect(err.value).toBe(-1);
    }
  });

  it("percent of equity with a negative equity stops the script with RE10141", () => {
    // 2,000 shares long from 100 with 1,000 of capital: the drop to 10 leaves the equity below 0.
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 10, 10, 10, 10), bar(3, 10, 10, 10, 10), bar(4, 10, 10, 10, 10)];
    let code = "";
    try {
      run(bars, (i, s) => {
        if (i === 0) s.entry("L", "long", { qty: 2000 });
        if (i === 3) s.entry("L2", "short");
      }, { initialCapital: 1000, defaultQtyType: "percent_of_equity", defaultQtyValue: 100 });
    } catch (e) {
      code = e instanceof StrategyRuntimeError ? `${e.code}@${e.bar}` : String(e);
    }
    expect(code).toBe("RE10141@3");
  });
});

describe("pyramiding and reversals", () => {
  it("entries beyond `pyramiding` in the same direction are not filled", () => {
    const one = run(rising(6), (i, s) => {
      if (i < 3) s.entry(`L${i}`, "long", { qty: 1 });
    });
    expect(one.trades).toHaveLength(1);
    const three = run(rising(6), (i, s) => {
      if (i < 3) s.entry(`L${i}`, "long", { qty: 1 });
    }, { pyramiding: 3 });
    expect(three.trades.map((t) => t.entryId)).toEqual(["L0", "L1", "L2"]);
    expect(three.performance.all.maxContractsHeld).toBe(3);
  });

  it("an entry the other way closes the position and opens the new one in the same fill", () => {
    const r = run(rising(5), (i, s) => {
      if (i === 0) s.entry("L", "long", { qty: 5 });
      if (i === 2) s.entry("S", "short", { qty: 2 });
    });
    expect(r.trades).toHaveLength(2);
    const [long, short] = r.trades;
    expect(long).toMatchObject({ direction: "long", qty: 5, open: false });
    expect(long.exit).toMatchObject({ signal: "S", bar: 3, price: 106 });
    expect(long.profit).toBe(5 * (106 - 102));
    expect(short).toMatchObject({ direction: "short", qty: 2, open: true });
    expect(short.entry.price).toBe(106);
    // One fill of 7 sold.
    expect(r.filledOrders[1]).toMatchObject({ bar: 3, buy: false, entry: true, qty: 7, price: 106 });
  });

  it("strategy.order nets against the position and is reported with entry = null", () => {
    const r = run(rising(5), (i, s) => {
      if (i === 0) s.order("buy", "long", { qty: 5 });
      if (i === 1) s.order("sell", "short", { qty: 2 });
    });
    expect(r.filledOrders.map((o) => o.entry)).toEqual([null, null]);
    expect(r.trades.filter((t) => !t.open).map((t) => t.qty)).toEqual([2]);
    expect(r.trades.filter((t) => t.open).map((t) => t.qty)).toEqual([3]);
  });

  it("allow_entry_in long: a short entry only closes the long", () => {
    const r = run(rising(5), (i, s) => {
      s.risk({ rule: "allow_entry_in", direction: "long" });
      if (i === 0) s.entry("L", "long", { qty: 5 });
      if (i === 2) s.entry("S", "short", { qty: 5 });
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].open).toBe(false);
    expect(r.trades[0].exit.signal).toBe("S");
  });
});

describe("stop and limit orders", () => {
  it("a buy stop fills when the high reaches it; a gap above fills at the open", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 103, 99, 102), bar(2, 110, 111, 109, 110)];
    const touched = run(bars, (i, s) => {
      if (i === 0) s.entry("B", "long", { qty: 1, stop: 102.5 });
    });
    expect(touched.trades[0].entry).toMatchObject({ bar: 1, price: 102.5 });
    expect(touched.filledOrders[0].type).toBe("STOP");
    const gapped = run(bars, (i, s) => {
      if (i === 1) s.entry("B", "long", { qty: 1, stop: 105 });
    });
    expect(gapped.trades[0].entry).toMatchObject({ bar: 2, price: 110 });
  });

  it("a buy limit fills when the low reaches it, never above its price", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 100.5, 97, 98), bar(2, 95, 96, 94, 95)];
    const r = run(bars, (i, s) => {
      if (i === 0) s.entry("B", "long", { qty: 1, limit: 97.5 });
    });
    expect(r.trades[0].entry).toMatchObject({ bar: 1, price: 97.5 });
    expect(r.filledOrders[0].type).toBe("LIMIT");
    const gap = run(bars, (i, s) => {
      if (i === 1) s.entry("B", "long", { qty: 1, limit: 96.5 });
    });
    // Gap down through the limit: the open, a better price.
    expect(gap.trades[0].entry).toMatchObject({ bar: 2, price: 95 });
  });

  it("order prices are rounded away from the market to the tick", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 103, 97, 100)];
    const stop = run(bars, (i, s) => {
      if (i === 0) s.entry("B", "long", { qty: 1, stop: 101.231 });
    });
    expect(stop.trades[0].entry.price).toBeCloseTo(101.24, 10); // buy stop: up
    const limit = run(bars, (i, s) => {
      if (i === 0) s.entry("B", "long", { qty: 1, limit: 98.769 });
    });
    expect(limit.trades[0].entry.price).toBeCloseTo(98.76, 10); // buy limit: down
    const nearLevel = run(bars, (i, s) => {
      if (i === 0) s.entry("B", "long", { qty: 1, stop: 101.230000001 });
    });
    expect(nearLevel.trades[0].entry.price).toBeCloseTo(101.23, 10); // within 1/10,000 tick of a level
  });

  it("exit brackets: take profit and stop loss in ticks from the entry", () => {
    // Entry at 100 (bar 1 open). Bar 2 reaches 101 (TP at +100 ticks) before 99.5 (SL at -100 ticks: 99): TP.
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.4, 99.6, 100), bar(2, 100.2, 101.2, 99.5, 100.5), bar(3, 100, 100, 100, 100)];
    const r = run(bars, (i, s) => {
      if (i === 0) {
        s.entry("L", "long", { qty: 4 });
        s.exit("X", { fromEntry: "L", profit: 100, loss: 100 });
      }
    });
    expect(r.trades[0].exit).toMatchObject({ bar: 2, price: 101, signal: "X" });
    expect(r.trades[0].profit).toBeCloseTo(4, 10);
    expect(r.filledOrders[1].type).toBe("LIMIT");
    // Same bracket, a bar that hits the stop first (the low is closer to the open): SL at 99.
    const down = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.4, 99.6, 100), bar(2, 99.6, 101.5, 98.8, 100), bar(3, 100, 100, 100, 100)];
    const sl = run(down, (i, s) => {
      if (i === 0) {
        s.entry("L", "long", { qty: 4 });
        s.exit("X", { fromEntry: "L", profit: 100, loss: 100, commentLoss: "SL" });
      }
    });
    expect(sl.trades[0].exit).toMatchObject({ bar: 2, price: 99, signal: "SL" });
    expect(sl.filledOrders[1].type).toBe("STOP");
  });

  it("an exit called before any entry of its id is no order", () => {
    const r = run(rising(5), (i, s) => {
      if (i === 0) s.exit("X", { fromEntry: "L", profit: 1 });
      if (i === 1) s.entry("L", "long", { qty: 1 });
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].open).toBe(true);
  });

  it("cancel removes a pending order", () => {
    const r = run(rising(5), (i, s) => {
      if (i === 0) s.entry("B", "long", { qty: 1, stop: 1000 });
      if (i === 1) s.cancel("B");
      if (i === 1) s.entry("C", "long", { qty: 1, stop: 104.5 });
    });
    expect(r.trades.map((t) => t.entryId)).toEqual(["C"]);
  });
});

describe("chart-bar transforms of run.ts", () => {
  it("Heikin Ashi: close = ohlc4, open = mid of the previous HA open and close", () => {
    const bars = [bar(0, 10, 14, 8, 12), bar(1, 12, 16, 11, 15)];
    const ha = heikinAshiBars(bars);
    expect(ha[0]).toMatchObject({ open: 11, close: 11, high: 14, low: 8 });
    expect(ha[1].open).toBe(11);
    expect(ha[1].close).toBe(13.5);
    expect(ha[1].high).toBe(16);
    expect(ha[1].low).toBe(11);
    expect(heikinAshiBars([])).toEqual([]);
  });

  it("chartBars: standard bars unless Heikin Ashi; fills on standard bars when asked", () => {
    const bars = rising(3);
    expect(chartBars(bars, false, false)).toEqual({ script: bars, fills: bars });
    const ha = chartBars(bars, true, false);
    expect(ha.script).toBe(ha.fills);
    expect(ha.script[0].close).toBe((100 + 101.5 + 98.5 + 101) / 4);
    const std = chartBars(bars, true, true);
    expect(std.fills).toBe(bars);
    expect(std.script).not.toBe(bars);
  });

  it("binIntrabars: a lower-timeframe bar belongs to the chart bar its last second falls in", () => {
    const t0 = 1_704_067_200;
    const chart: Bar[] = [0, 900, 1800].map((s) => ({ time: t0 + s, open: 1, high: 1, low: 1, close: 1 }));
    const ltf: Bar[] = Array.from({ length: 15 }, (_, k) => ({ time: t0 - 120 + k * 120, open: 1, high: 1, low: 1, close: 1 }));
    const bins = binIntrabars(chart, ltf)!;
    expect(bins).toHaveLength(3);
    // 2-minute bars from t0 - 120: the one from t0 - 120 ends at t0 - 1 (before the first chart bar).
    expect(bins[0]!.map((b) => b.time - t0)).toEqual([0, 120, 240, 360, 480, 600, 720]);
    // 13:44-13:46 style: the bar from 840 ends at 959, inside the second chart bar.
    expect(bins[1]![0].time - t0).toBe(840);
    expect(binIntrabars(chart, [])).toBeUndefined();
    expect(binIntrabars([], ltf)).toBeUndefined();
  });

  it("the bar magnifier fills a stop on the lower-timeframe path", () => {
    // Chart bar 1 reaches both the TP (101) and SL (99), its high nearer the open (the TP first on the chart bar);
    // the 1-minute path goes down first.
    const t0 = 1_704_067_200;
    const chart: Bar[] = [
      { time: t0, open: 100, high: 100, low: 100, close: 100 },
      { time: t0 + 300, open: 100, high: 101.2, low: 98.5, close: 100 },
      { time: t0 + 600, open: 100, high: 100, low: 100, close: 100 },
    ];
    const ltf: Bar[] = [
      { time: t0 + 300, open: 100, high: 100, low: 98.5, close: 98.6 },
      { time: t0 + 360, open: 98.6, high: 101.2, low: 98.6, close: 100 },
    ];
    const def = strategy((i, s) => {
      if (i === 0) {
        s.entry("L", "long", { qty: 1 });
        s.exit("X", { fromEntry: "L", profit: 100, loss: 100 });
      }
    }, { processOrdersOnClose: true, barMagnifier: true });
    const plain = runBacktest(chart, { ...def, properties: { processOrdersOnClose: true } });
    const magnified = runBacktest(chart, def, { intrabars: ltf, intrabarSeconds: 60 });
    expect(plain.trades[0].exit).toMatchObject({ bar: 1, price: 101 });
    expect(magnified.trades[0].exit).toMatchObject({ bar: 1, price: 99 });
  });
});
