import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES, canAddOrderBrackets, canMove, capabilitiesOf, takesOrder, type TradingCapabilities } from "../capabilities";
import type { TradingOrder } from "../types";

const order = (p: Partial<TradingOrder>): TradingOrder => ({
  id: "7",
  symbol: "NASDAQ:QQQ",
  side: "buy",
  type: "limit",
  qty: 1,
  limitPrice: 100,
  stopPrice: null,
  kind: "order",
  parentId: null,
  takeProfit: null,
  stopLoss: null,
  ...p,
});
const caps = (p: Partial<TradingCapabilities>): TradingCapabilities => ({ ...ALL_CAPABILITIES, ...p });

describe("capabilitiesOf", () => {
  it("allows everything when the plugin reports nothing", () => {
    expect(capabilitiesOf(undefined)).toEqual(ALL_CAPABILITIES);
    expect(capabilitiesOf(null)).toEqual(ALL_CAPABILITIES);
    expect(capabilitiesOf({})).toEqual(ALL_CAPABILITIES);
  });

  it("keeps what is reported, a left-out field being supported", () => {
    expect(capabilitiesOf({ brackets: false, modifyOrders: false })).toEqual({
      orderTypes: ["market", "limit", "stop", "stopLimit"],
      brackets: false,
      positionBrackets: true,
      partialClose: true,
      modifyOrders: false,
    });
  });

  it("lists the order types in the ticket's order", () => {
    expect(capabilitiesOf({ orderTypes: ["stop", "market"] }).orderTypes).toEqual(["market", "stop"]);
  });

  it("falls back to every type when none is listed", () => {
    expect(capabilitiesOf({ orderTypes: [] }).orderTypes).toEqual(["market", "limit", "stop", "stopLimit"]);
  });
});

describe("takesOrder", () => {
  it("needs the order type", () => {
    const c = caps({ orderTypes: ["market", "limit"] });
    expect(takesOrder(c, { type: "limit", takeProfit: null, stopLoss: null })).toBe(true);
    expect(takesOrder(c, { type: "stopLimit", takeProfit: null, stopLoss: null })).toBe(false);
  });

  it("needs brackets for a take profit or a stop loss", () => {
    const c = caps({ brackets: false });
    expect(takesOrder(c, { type: "market", takeProfit: null, stopLoss: null })).toBe(true);
    expect(takesOrder(c, { type: "market", takeProfit: 110, stopLoss: null })).toBe(false);
    expect(takesOrder(c, { type: "market", takeProfit: null, stopLoss: 90 })).toBe(false);
  });
});

describe("canMove", () => {
  it("moves a working order when the broker modifies orders", () => {
    expect(canMove(ALL_CAPABILITIES, order({}))).toBe(true);
    expect(canMove(caps({ modifyOrders: false }), order({}))).toBe(false);
  });

  it("moves the position's brackets with position brackets", () => {
    const tp = order({ id: "position:tp", kind: "tp", parentId: "position" });
    expect(canMove(caps({ modifyOrders: false, brackets: false }), tp)).toBe(true);
    expect(canMove(caps({ positionBrackets: false }), tp)).toBe(false);
  });

  it("moves an order's bracket by modifying the order", () => {
    const sl = order({ id: "7:sl", kind: "sl", parentId: "7", type: "stop", stopPrice: 95, limitPrice: null });
    expect(canMove(ALL_CAPABILITIES, sl)).toBe(true);
    expect(canMove(caps({ modifyOrders: false }), sl)).toBe(false);
    expect(canMove(caps({ brackets: false }), sl)).toBe(false);
  });

  it("adds a working order's brackets only with both", () => {
    expect(canAddOrderBrackets(ALL_CAPABILITIES)).toBe(true);
    expect(canAddOrderBrackets(caps({ brackets: false }))).toBe(false);
    expect(canAddOrderBrackets(caps({ modifyOrders: false }))).toBe(false);
  });
});
