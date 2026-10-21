import { describe, expect, it } from "vitest";
import type { TradingOrder } from "../../../data/trading/types";
import {
  centeredTop,
  contextItems,
  countText,
  labelActive,
  needsCenter,
  orderMarks,
  priceIndex,
  priceSide,
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
