import { describe, expect, it } from "vitest";
import {
  defaultBracket,
  executionLabel,
  fmtPl,
  orderChipText,
  orderLinePrice,
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
    expect(orderChipText(order({ kind: "tp" }))).toBe("TP");
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
});
