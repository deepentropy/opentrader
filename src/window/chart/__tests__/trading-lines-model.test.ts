import { describe, expect, it } from "vitest";
import {
  defaultBracket,
  defaultOrderBracket,
  stackLabels,
  executionLabel,
  fmtPl,
  orderChipText,
  orderLinePrice,
  orderMenuTitle,
  positionQtyText,
  orderSummary,
  cancelTitle,
  positionSummary,
  requestWithPrice,
  snapToTick,
  tickDecimals,
} from "../trading-lines-model";
import type { TradingOrder, TradingPosition } from "../../../data/trading/types";

const order = (p: Partial<TradingOrder>): TradingOrder => ({
  id: "1",
  symbol: "NASDAQ:QQQ",
  side: "buy",
  type: "limit",
  qty: 1,
  limitPrice: 640,
  stopPrice: null,
  kind: "order",
  parentId: null,
  takeProfit: null,
  stopLoss: null,
  ...p,
});

const pos: TradingPosition = { id: "position", symbol: "NASDAQ:QQQ", side: "buy", qty: 1, avgPrice: 651.42, pl: 12.46, takeProfit: null, stopLoss: null };

describe("trading lines model", () => {
  it("chip and dialog texts", () => {
    expect(orderChipText(order({}))).toBe("Buy limit");
    expect(orderChipText(order({ side: "sell", type: "stopLimit" }))).toBe("Sell stop limit");
    expect(orderChipText(order({ kind: "tp" }))).toBe("Take profit");
    expect(orderChipText(order({ kind: "sl" }))).toBe("Stop loss");
    expect(orderSummary(order({}), 0.01)).toBe("Buy Limit 1 @ 640.00");
    expect(orderSummary(order({ kind: "sl", side: "sell", type: "stop", limitPrice: null, stopPrice: 639.75 }), 0.01)).toBe("SL 1 @ 639.75");
    expect(orderSummary(order({ kind: "tp", side: "sell", type: "limit", limitPrice: 640.75 }), 0.01)).toBe("TP 1 @ 640.75");
    expect(cancelTitle(order({ kind: "tp" }))).toBe("Cancel take profit order");
    expect(cancelTitle(order({ kind: "sl" }))).toBe("Cancel stop loss order");
    expect(cancelTitle(order({}))).toBe("Cancel order");
    expect(positionSummary(pos, 0.01)).toBe("Long 1 @ 651.42");
    expect(executionLabel({ id: "1", symbol: "X", side: "buy", qty: 1, price: 651.42, time: 0 }, 0.01)).toBe("1 @ 651.42");
    expect(fmtPl(12.46, "USD")).toBe("+12.46 USD");
    expect(fmtPl(-3.1, "USD")).toBe("−3.10 USD");
  });

  it("line prices, tick snapping and default brackets", () => {
    expect(orderLinePrice(order({ type: "stop", limitPrice: null, stopPrice: 655 }))).toBe(655);
    expect(orderLinePrice(order({ type: "stopLimit", limitPrice: 654, stopPrice: 655 }))).toBe(655);
    expect(tickDecimals(0.01)).toBe(2);
    expect(tickDecimals(0.0001)).toBe(4);
    expect(snapToTick(640.006, 0.01)).toBe(640.01);
    expect(snapToTick(10.13, 0.25)).toBe(10.25);
    expect(defaultBracket(pos, "tp", 0.01)).toBe(652.17);
    expect(defaultBracket(pos, "sl", 0.01)).toBe(651.17);
    expect(defaultBracket({ ...pos, side: "sell" }, "tp", 0.01)).toBe(650.67);
  });

  it("a dragged order keeps its fields, with the new price on its line", () => {
    expect(requestWithPrice(order({ takeProfit: 650 }), 641)).toMatchObject({ type: "limit", limitPrice: 641, takeProfit: 650, qty: 1 });
    expect(requestWithPrice(order({ type: "stopLimit", limitPrice: 654, stopPrice: 655 }), 656)).toMatchObject({ limitPrice: 654, stopPrice: 656 });
    expect(requestWithPrice(order({ stopLoss: 630 }), null, { stopLoss: 631 })).toMatchObject({ limitPrice: 640, stopLoss: 631 });
  });

  it("default brackets of an order", () => {
    expect(defaultOrderBracket(order({ limitPrice: 640 }), "tp", 0.01)).toBe(640.75);
    expect(defaultOrderBracket(order({ limitPrice: 640 }), "sl", 0.01)).toBe(639.75);
    expect(defaultOrderBracket(order({ side: "sell", type: "stop", limitPrice: null, stopPrice: 100 }), "tp", 0.01)).toBe(99.25);
  });

  it("stacks axis labels without overlap, in price order", () => {
    // Apart: unchanged.
    expect(stackLabels([{ y: 10 }, { y: 50 }], 20)).toEqual([10, 50]);
    // Two touching labels: centred on their lines.
    expect(stackLabels([{ y: 100 }, { y: 104 }], 20)).toEqual([92, 112]);
    // Input order kept in the result.
    expect(stackLabels([{ y: 104 }, { y: 100 }], 20)).toEqual([112, 92]);
    // A fixed label keeps its place, the others go around it (reference: the
    // position label over the last price label at the same price).
    expect(stackLabels([{ y: 100, fixed: true }, { y: 100 }, { y: 103 }], 20)).toEqual([100, 80, 120]);
    // A chain: no two labels closer than the label height.
    const ys = stackLabels([{ y: 0 }, { y: 5 }, { y: 10 }, { y: 15 }, { y: 70 }], 20).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(20 - 1e-9);
  });

  it("short position quantity and stop-limit line price", () => {
    expect(positionQtyText(pos)).toBe("1");
    expect(positionQtyText({ ...pos, side: "sell" })).toBe("−1");
    const sl = order({ type: "stopLimit", side: "sell", stopPrice: 643.93, limitPrice: 643.83 });
    expect(orderLinePrice(sl)).toBe(643.93);
    expect(orderLinePrice({ ...sl, stopTriggered: true })).toBe(643.83);
  });

  it("context menu header", () => {
    expect(orderMenuTitle(order({}), 0.01)).toBe("Buy 1 @640.00 Limit");
    expect(orderMenuTitle(order({ kind: "tp", side: "sell", limitPrice: 640.75 }), 0.01)).toBe("Sell 1 @640.75 Take profit");
  });
});
