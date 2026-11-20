import { describe, expect, it } from "vitest";
import type { TradingOrder } from "../../../data/trading/types";
import {
  centeredRow,
  centeredTop,
  contextItems,
  countText,
  depthRows,
  domRows,
  labelActive,
  meterShare,
  needsCenter,
  orderMarks,
  priceIndex,
  priceSide,
  rowIndex,
  rowOf,
  sideCounts,
  wheelRows,
} from "../dom-ladder";

const order = (p: Partial<TradingOrder>): TradingOrder => ({
  id: "1",
  symbol: "NASDAQ:QQQ",
  side: "buy",
  type: "limit",
  qty: 1,
  limitPrice: null,
  stopPrice: null,
  kind: "order",
  parentId: null,
  takeProfit: null,
  stopLoss: null,
  ...p,
});

// Replay quotes: bid = ask = last (717.12).
const L = priceIndex(717.12, 0.01);
const m = { bid: L, ask: L, last: L };

describe("DOM ladder", () => {
  it("indexes prices on the tick grid", () => {
    expect(priceIndex(717.12, 0.01)).toBe(71712);
    expect(priceIndex(4321.25, 0.25)).toBe(17285);
  });

  it("centres the market in the middle row", () => {
    expect(centeredTop(m, 30)).toBe(L + 15);
    expect(centeredTop({ bid: NaN, ask: NaN, last: L }, 31)).toBe(L + 15);
  });

  it("re-centres when the market nears an edge", () => {
    const top = centeredTop(m, 30);
    expect(needsCenter(top, 30, m)).toBe(false);
    expect(needsCenter(top - 1, 30, m)).toBe(false); // 14 rows above the bottom… still inside
    expect(needsCenter(L + 2, 30, m)).toBe(true); // best ask 2 rows under the top
    expect(needsCenter(L + 26, 30, m)).toBe(false); // best bid 3 rows above the bottom
    expect(needsCenter(L + 27, 30, m)).toBe(true);
    expect(needsCenter(NaN, 30, m)).toBe(true);
  });

  it("colours asks at and above the best ask, bids below", () => {
    expect(priceSide(L, m)).toBe("ask");
    expect(priceSide(L + 1, m)).toBe("ask");
    expect(priceSide(L - 1, m)).toBe("bid");
  });

  it("tints the hover label", () => {
    expect(labelActive("buy", L + 1, m, false)).toBe(true);
    expect(labelActive("buy", L - 1, m, false)).toBe(false);
    expect(labelActive("buy", L - 1, m, true)).toBe(true);
    expect(labelActive("sell", L - 1, m, false)).toBe(true);
    expect(labelActive("sell", L + 1, m, true)).toBe(true);
  });

  it("marks orders on their price rows", () => {
    const orders = [
      order({ id: "1", type: "limit", limitPrice: 716.5 }),
      order({ id: "2", side: "sell", type: "stopLimit", stopPrice: 715, limitPrice: 714.99 }),
      order({ id: "3", side: "sell", type: "limit", kind: "tp", parentId: "1", limitPrice: 720 }),
      order({ id: "4", side: "sell", type: "stop", kind: "sl", parentId: "pos", stopPrice: 710 }),
    ];
    const marks = orderMarks(orders, 0.01);
    expect(marks.get(71650)?.[0]).toMatchObject({ type: "limit", typeText: "Limit", inactive: false });
    expect(marks.get(71500)?.[0]).toMatchObject({ field: "stopPrice", type: "stoplimit", inactive: false });
    expect(marks.get(71499)?.[0]).toMatchObject({ field: "limitPrice", inactive: true });
    expect(marks.get(72000)?.[0]).toMatchObject({ typeText: "TakeProfit", inactive: true });
    expect(marks.get(71000)?.[0]).toMatchObject({ typeText: "StopLoss", inactive: false });
    expect(sideCounts(orders, "sell")).toEqual({ active: 2, inactive: 1, qty: 2 });
    expect(countText(sideCounts(orders, "sell"))).toEqual({ text: "2", title: "2 active orders x 2, 1 inactive order" });
    expect(countText({ active: 0, inactive: 0, qty: 0 }).text).toBe("");
  });

  it("lists the context menu orders", () => {
    const items = contextItems("buy", 717, "1", "QQQ", 0.01, (p) => p.toFixed(2));
    expect(items.map((x) => x.label)).toEqual([
      "Buy 1 QQQ @ 717.00 Stop",
      "Buy 1 QQQ @ 717.00 Limit",
      "Buy 1 QQQ @ 717.00 Stop 717.01 Limit",
      "Buy 1 QQQ @ Market",
    ]);
    expect(contextItems("sell", 717, "2", "QQQ", 0.01, (p) => p.toFixed(2))[2].label).toBe("Sell 2 QQQ @ 717.00 Stop 716.99 Limit");
  });

  it("scrolls a row per 100 px of wheel", () => {
    expect(wheelRows(0, 100)).toEqual({ rows: -1, rest: 0 });
    expect(wheelRows(0, 50).rows + 0).toBe(0);
    expect(wheelRows(-0.5, 60).rows).toBe(-1);
  });
});

describe("order book rows (#372)", () => {
  it("puts the levels on the tick grid with totals, the largest level and the best bid / ask", () => {
    const d = depthRows(
      {
        bids: new Map([[100.0, 300], [99.99, 50], [99.991, 25]]),
        asks: new Map([[100.02, 120], [100.05, 40]]),
      },
      0.01,
    );
    expect([...d.bids]).toEqual([[10000, 300], [9999, 75]]);
    expect(d.totalBid).toBe(375);
    expect(d.totalAsk).toBe(160);
    expect(d.max).toBe(300);
    expect(d.bestBid).toBe(10000);
    expect(d.bestAsk).toBe(10002);
    expect(meterShare(120, d.max)).toBeCloseTo(0.4);
    expect(meterShare(undefined, d.max)).toBe(0);
  });

  it("a side without levels has no best price", () => {
    const d = depthRows({ bids: new Map(), asks: new Map([[5, 1]]) }, 1);
    expect(d.bestBid).toBeNaN();
    expect(d.totalBid).toBe(0);
  });
});

describe("price step and hidden rows (#374)", () => {
  it("a price step puts a price on the row at or above it", () => {
    expect(priceIndex(100.03, 0.01, 5)).toBe(2001);
    expect(priceIndex(100.05, 0.01, 5)).toBe(2001);
    expect(priceIndex(100.06, 0.01, 5)).toBe(2002);
    const d = depthRows({ bids: new Map([[100.03, 2], [100.01, 3]]), asks: new Map([[100.06, 4]]) }, 0.01, 5);
    expect([...d.bids]).toEqual([[2001, 5]]);
    expect(d.bestAsk).toBe(2002);
  });

  // Asks 110, 108, 105 (best), bids 100 (best), 97, 95; an order at 107.
  const book = depthRows({ asks: new Map([[110, 1], [108, 1], [105, 1]]), bids: new Map([[100, 1], [97, 1], [95, 1]]) }, 1);
  const show = (zeroVolume: boolean, spread: boolean) => domRows(book, [107], { zeroVolume, spread });
  const shownRows = (rows: ReturnType<typeof domRows>, top: number, n: number) => Array.from({ length: n }, (_, k) => rowIndex(rows.zones, top - k));

  it("shows every row with both settings on", () => {
    expect(show(true, true).zones).toEqual([]);
    expect(shownRows(show(true, true), 112, 3)).toEqual([112, 111, 110]);
  });

  it("without zero volume prices: inside the book only rows with size or orders", () => {
    const r = show(false, true);
    expect(shownRows(r, 112, 12)).toEqual([112, 111, 110, 108, 107, 105, 104, 103, 102, 101, 100, 97]);
    expect(shownRows(r, 112, 15).slice(12)).toEqual([95, 94, 93]);
  });

  it("without the spread: the best ask sits on the best bid", () => {
    const r = show(true, false);
    expect(r.spreadHidden).toBe(true);
    expect(shownRows(r, 107, 6)).toEqual([107, 106, 105, 100, 99, 98]);
    const both = show(false, false);
    expect(shownRows(both, 111, 8)).toEqual([111, 110, 108, 107, 105, 100, 97, 95]);
  });

  it("rowOf is the inverse of rowIndex; a hidden price takes the next row under it", () => {
    for (const r of [show(false, true), show(true, false), show(false, false)]) {
      for (let v = 90; v < 115; v++) expect(rowOf(r.zones, rowIndex(r.zones, v))).toBe(v);
    }
    const r = show(false, true);
    expect(rowIndex(r.zones, rowOf(r.zones, 109))).toBe(108);
  });

  it("centres on the spread's middle, or on the best ask when the spread is hidden", () => {
    const m = { bid: 100, ask: 105, last: 102 };
    expect(rowIndex([], centeredRow(m, show(true, true), 10) - 5)).toBe(102);
    const r = show(true, false);
    expect(rowIndex(r.zones, centeredRow(m, r, 10) - 5)).toBe(105);
  });

  it("hides nothing before the book has two levels, nor in a crossed book's spread", () => {
    const one = depthRows({ asks: new Map([[105, 1]]), bids: new Map() }, 1);
    expect(domRows(one, [], { zeroVolume: false, spread: false }).zones).toEqual([]);
    const crossed = depthRows({ asks: new Map([[100, 1]]), bids: new Map([[101, 1]]) }, 1);
    expect(domRows(crossed, [], { zeroVolume: true, spread: false }).zones).toEqual([]);
  });
});
