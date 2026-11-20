import { describe, expect, it } from "vitest";
import { badSide, onTick, orderPriceError, stopLimitPrice, type PriceRules } from "../price-rules";

const rules: PriceRules = { stopOrdersBothSides: false, stopLimitOrdersBothSides: false, strictLimitPrice: false };
const NOT_VALID = "This price is not valid for this order type";

describe("order price rules (#370)", () => {
  it("checks the tick", () => {
    expect(onTick(100.05, 0.05)).toBe(true);
    expect(onTick(351.95, 0.01)).toBe(true);
    expect(onTick(100.03, 0.05)).toBe(false);
    expect(orderPriceError({ type: "limit", side: "buy", field: "limit", price: 100.03 }, 101, 0.05, rules)).toBe("The price must be a multiple of 0.05");
    expect(orderPriceError({ type: "limit", side: "buy", field: "limit", price: 100.05 }, 101, 0.05, rules)).toBeNull();
  });

  it("refuses a stop on the wrong side of the market", () => {
    // Buy stop at or above the ask, sell stop at or below the bid.
    expect(badSide({ type: "stop", side: "buy", field: "stop", price: 99 }, 100, rules)).toBe(true);
    expect(badSide({ type: "stop", side: "buy", field: "stop", price: 100 }, 100, rules)).toBe(false);
    expect(badSide({ type: "stop", side: "sell", field: "stop", price: 101 }, 100, rules)).toBe(true);
    expect(badSide({ type: "stop", side: "sell", field: "stop", price: 99 }, 100, rules)).toBe(false);
    expect(orderPriceError({ type: "stop", side: "buy", field: "stop", price: 99 }, 100, 0.01, rules)).toBe(NOT_VALID);
    // A broker that takes stops on either side.
    expect(badSide({ type: "stop", side: "buy", field: "stop", price: 99 }, 100, { ...rules, stopOrdersBothSides: true })).toBe(false);
  });

  it("checks the stop of a stop limit, not its limit", () => {
    expect(badSide({ type: "stopLimit", side: "buy", field: "stop", price: 99 }, 100, rules)).toBe(true);
    expect(badSide({ type: "stopLimit", side: "buy", field: "stop", price: 99 }, 100, { ...rules, stopLimitOrdersBothSides: true })).toBe(false);
    // The limit may sit on either side of the stop and of the market.
    expect(badSide({ type: "stopLimit", side: "buy", field: "limit", price: 98 }, 100, rules)).toBe(false);
    expect(badSide({ type: "stopLimit", side: "sell", field: "limit", price: 120 }, 100, rules)).toBe(false);
  });

  it("lets a limit cross the market, unless far or the broker is strict", () => {
    // A marketable buy limit above the ask is sent.
    expect(badSide({ type: "limit", side: "buy", field: "limit", price: 101 }, 100, rules)).toBe(false);
    expect(badSide({ type: "limit", side: "buy", field: "limit", price: 151 }, 100, rules)).toBe(true);
    expect(badSide({ type: "limit", side: "sell", field: "limit", price: 49 }, 100, rules)).toBe(true);
    expect(badSide({ type: "limit", side: "sell", field: "limit", price: 99 }, 100, rules)).toBe(false);
    expect(badSide({ type: "limit", side: "buy", field: "limit", price: 101 }, 100, { ...rules, strictLimitPrice: true })).toBe(true);
    // On its own side, a limit can be anywhere above zero.
    expect(badSide({ type: "limit", side: "buy", field: "limit", price: 1 }, 100, rules)).toBe(false);
    expect(badSide({ type: "limit", side: "sell", field: "limit", price: 10001 }, 100, rules)).toBe(true);
  });

  it("checks only the tick without a market price", () => {
    expect(orderPriceError({ type: "stop", side: "buy", field: "stop", price: 1 }, null, 0.01, rules)).toBeNull();
  });

  it("starts a stop limit's limit one tick beyond its stop", () => {
    expect(stopLimitPrice(100, "buy", 0.05)).toBeCloseTo(100.05, 10);
    expect(stopLimitPrice(100, "sell", 0.05)).toBeCloseTo(99.95, 10);
  });
});
