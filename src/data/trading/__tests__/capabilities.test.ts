import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES, ANY_INSTRUMENT, canAddOrderBrackets, canMove, capabilitiesOf, durationsFor, fieldsFor, instrumentOf, pickDuration, qtyArrowStep, qtyProblem, takesOrder, wholeLots, type TradingCapabilities } from "../capabilities";
import { qtyMessage } from "../qty-message";
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
      stopOrdersBothSides: false,
      stopLimitOrdersBothSides: false,
      strictLimitPrice: false,
      orderPreview: false,
    });
    expect(capabilitiesOf({ orderPreview: true }).orderPreview).toBe(true);
    expect(capabilitiesOf({ stopOrdersBothSides: true, strictLimitPrice: true })).toMatchObject({ stopOrdersBothSides: true, stopLimitOrdersBothSides: false, strictLimitPrice: true });
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

describe("broker instruments (#341)", () => {
  const product = { id: "product", label: "Product", options: [{ value: "MIS", label: "Intraday" }, { value: "CNC", label: null }, { value: "", label: "none" }], default: "CNC" };

  it("reads a plugin's instrument and its ticket fields", () => {
    const i = instrumentOf({ qtyMin: 65, qtyStep: 65, pointValue: null }, [product]);
    expect(i).toMatchObject({ qtyMin: 65, qtyStep: 65, qtyMax: null, pointValue: 1 });
    expect(i.fields).toEqual([
      { id: "product", label: "Product", kind: "select", options: [{ value: "MIS", label: "Intraday" }, { value: "CNC", label: "CNC" }], default: "CNC", orderTypes: null, exit: null },
    ]);
    // The instrument's own fields replace the broker's; a field without options or id is left out.
    expect(instrumentOf({ ticketFields: [{ ...product, default: "X" }] }, []).fields[0].default).toBe("MIS");
    expect(instrumentOf({ ticketFields: [{ id: "x", options: [] }, { options: [{ value: "a" }] }] }, [product]).fields).toEqual([]);
    expect(instrumentOf(null, null)).toEqual(ANY_INSTRUMENT);
    expect(instrumentOf({ qtyStep: 0, pointValue: -1 }, null)).toMatchObject({ qtyStep: null, pointValue: 1 });
  });

  it("reads the durations and picks an order's time in force (#349)", () => {
    const caps = [
      { id: "day", label: "Day" },
      { id: "gtc", label: "Good Till Cancel", default: true },
      { id: "ioc", label: null, orderTypes: ["market", "limit", "bogus"] },
      { id: "", label: "none" },
    ];
    const i = instrumentOf(null, null, caps);
    expect(i.durations).toEqual([
      { id: "day", label: "Day", orderTypes: null, default: false },
      { id: "gtc", label: "Good Till Cancel", orderTypes: null, default: true },
      { id: "ioc", label: "ioc", orderTypes: ["market", "limit"], default: false },
    ]);
    expect(durationsFor(i.durations, "stop").map((d) => d.id)).toEqual(["day", "gtc"]);
    // The one wanted when the type takes it, else the default, else the first; none declared: none sent.
    expect(pickDuration(i.durations, "limit", "ioc")).toBe("ioc");
    expect(pickDuration(i.durations, "stop", "ioc", "day")).toBe("day");
    expect(pickDuration(i.durations, "stop", undefined)).toBe("gtc");
    expect(pickDuration([{ id: "day", label: "Day", orderTypes: ["limit"], default: false }], "limit")).toBe("day");
    expect(pickDuration([{ id: "day", label: "Day", orderTypes: ["limit"], default: false }], "market")).toBeNull();
    expect(pickDuration([], "market", "day")).toBeNull();
    // The ticker's own replace the broker's.
    expect(instrumentOf({ durations: [{ id: "gfd" }] }, null, caps).durations.map((d) => d.id)).toEqual(["gfd"]);
  });

  it("checks a quantity against the lots, minimum and maximum", () => {
    const lot = { ...ANY_INSTRUMENT, qtyMin: 65, qtyStep: 65 };
    expect(qtyProblem(130, lot)).toBeNull();
    expect(qtyProblem(1, lot)).toEqual({ kind: "step", n: 65, next: 130 });
    expect(qtyProblem(50, { ...ANY_INSTRUMENT, qtyMin: 100, qtyStep: 10 })).toEqual({ kind: "min", n: 100 });
    expect(qtyProblem(100, lot)).toEqual({ kind: "step", n: 65, next: 130 });
    expect(qtyProblem(200, lot)).toEqual({ kind: "step", n: 195, next: 260 });
    expect(qtyProblem(5, { ...ANY_INSTRUMENT, qtyMax: 4 })).toEqual({ kind: "max", n: 4 });
    expect(qtyProblem(0.3, { ...ANY_INSTRUMENT, qtyStep: 0.1 })).toBeNull();
    expect(qtyProblem(7, ANY_INSTRUMENT)).toBeNull();
    expect(qtyMessage(1, lot)).toBe("65 is one lot: use 65 or 130");
    expect(qtyMessage(1, { ...ANY_INSTRUMENT, qtyMin: 5 })).toBe("The smallest quantity is 5");
    expect(qtyMessage(130, lot)).toBeNull();
  });

  it("rounds units down to whole lots and steps by a lot", () => {
    const lot = { ...ANY_INSTRUMENT, qtyMin: 65, qtyStep: 65 };
    expect(wholeLots(200, lot)).toBe(195);
    expect(wholeLots(60, lot)).toBeNull();
    expect(wholeLots(0.37, { ...ANY_INSTRUMENT, qtyStep: 0.01 })).toBe(0.37);
    expect(wholeLots(10, { ...ANY_INSTRUMENT, qtyStep: 1, qtyMax: 4 })).toBe(4);
    expect(qtyArrowStep(lot)).toBe(65);
    expect(qtyArrowStep(ANY_INSTRUMENT)).toBe(1);
  });

  it("reads checkbox fields, the fields of an order type or an exit, and the margin rate (#139)", () => {
    const i = instrumentOf(
      {
        marginRate: 0.05,
        ticketFields: [
          { id: "rth", label: "Outside RTH", type: "checkbox", orderTypes: ["limit", "stopLimit"] },
          { id: "tpRth", label: "Outside RTH Take Profit", type: "checkbox", default: "true", exit: "takeProfit" },
          { id: "slRth", label: "Outside RTH Stop Loss", type: "checkbox", exit: "stopLoss" },
        ],
      },
      null,
    );
    expect(i.marginRate).toBe(0.05);
    expect(i.fields.map((f) => [f.kind, f.default, f.exit])).toEqual([
      ["checkbox", "false", null],
      ["checkbox", "true", "tp"],
      ["checkbox", "false", "sl"],
    ]);
    expect(i.fields[0].options.map((o) => o.value)).toEqual(["true", "false"]);
    const ids = (type: "market" | "limit", tp: boolean, sl: boolean) => fieldsFor(i.fields, type, tp, sl).map((f) => f.id);
    expect(ids("market", false, false)).toEqual([]);
    expect(ids("limit", false, true)).toEqual(["rth", "slRth"]);
    expect(ids("limit", true, true)).toEqual(["rth", "tpRth", "slRth"]);
    expect(instrumentOf({ marginRate: 0 }, null).marginRate).toBeNull();
  });
});
