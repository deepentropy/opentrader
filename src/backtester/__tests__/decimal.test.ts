import { describe, expect, it } from "vitest";
import { decimalSumAtMost } from "../decimal";

describe("decimalSumAtMost", () => {
  it("compares the exact decimal product, not the binary float one", () => {
    // 565,153 x 0.41000000000000003 = 231,712.73000000001695459 > 231,712.73
    expect(decimalSumAtMost([[565_153, 0.41000000000000003]], 231_712.73)).toBe(false);
    expect(decimalSumAtMost([[565_153, 0.41]], 231_712.73)).toBe(true);
    // The float product is off: 0.1 x 3 = 0.30000000000000004 in binary, exactly 0.3 in decimals.
    expect(0.1 * 3 <= 0.3).toBe(false);
    expect(decimalSumAtMost([[0.1, 3]], 0.3)).toBe(true);
  });

  it("sums several products and handles equality exactly", () => {
    expect(decimalSumAtMost([[2, 0.5], [3, 0.25]], 1.75)).toBe(true);
    expect(decimalSumAtMost([[2, 0.5], [3, 0.25]], 1.7499999999)).toBe(false);
    expect(decimalSumAtMost([[1, 0.1], [1, 0.2]], 0.3)).toBe(true); // 0.1 + 0.2 = 0.3 in decimals
  });

  it("handles negative factors, an empty sum and products of more than two factors", () => {
    expect(decimalSumAtMost([[-5, 2]], -10)).toBe(true);
    expect(decimalSumAtMost([[-5, 2]], -10.000001)).toBe(false);
    expect(decimalSumAtMost([], 0)).toBe(true);
    expect(decimalSumAtMost([], -0.01)).toBe(false);
    expect(decimalSumAtMost([[1_125_000, 0.05, 1]], 56_250)).toBe(true);
    expect(decimalSumAtMost([[0.5, 0.5, 0.5]], 0.125)).toBe(true);
  });

  it("reads exponent notation (very small and very large numbers)", () => {
    expect(decimalSumAtMost([[1e-7, 3]], 3e-7)).toBe(true);
    expect(decimalSumAtMost([[1e-7, 3]], 2.9999999e-7)).toBe(false);
    expect(decimalSumAtMost([[1e21, 2]], 2e21)).toBe(true);
    expect(decimalSumAtMost([[1e21, 2]], 1.9e21)).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    expect(() => decimalSumAtMost([[NaN, 1]], 1)).toThrow(/finite/);
    expect(() => decimalSumAtMost([[1, 1]], Infinity)).toThrow(/finite/);
  });
});
