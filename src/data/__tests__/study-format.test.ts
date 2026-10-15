import { describe, expect, it } from "vitest";
import { formatStudyValue, parseAmountText, stepAmountText } from "../study-format";

describe("study value formats", () => {
  it("writes a price with its decimals, a percentage, a volume with its unit", () => {
    expect(formatStudyValue(1, { type: "price", precision: 0 })).toBe("1");
    expect(formatStudyValue(57.634, { type: "price", precision: 2 })).toBe("57.63");
    expect(formatStudyValue(1234.5, { type: "price" })).toBe("1,234.50");
    expect(formatStudyValue(0.12345, { type: "price", precision: 4 })).toBe("0.1235");
    expect(formatStudyValue(12.5, { type: "percent", precision: 2 })).toBe("12.50%");
    expect(formatStudyValue(5370, { type: "volume" })).toBe("5.37 K");
    expect(formatStudyValue(-47_460_000, { type: "volume" })).toBe("-47.46 M");
    expect(formatStudyValue(151, { type: "volume" })).toBe("151");
    expect(formatStudyValue(0, { type: "volume" })).toBe("0");
  });

  it("reads an amount back with its unit", () => {
    expect(parseAmountText("5.37 K")).toBe(5370);
    expect(parseAmountText("5.37 K")).toBe(5370);
    expect(parseAmountText("-1.5M")).toBe(-1_500_000);
    expect(parseAmountText("1,234.50")).toBe(1234.5);
    expect(parseAmountText("−2.5")).toBe(-2.5);
    expect(parseAmountText("12.50%")).toBe(12.5);
    expect(parseAmountText("abc")).toBeNaN();
  });

  it("steps an amount in its last decimal, its unit kept", () => {
    expect(stepAmountText("5.37 K", 1)).toBe("5.38 K");
    expect(stepAmountText("0", -1)).toBe("-0.01");
    expect(stepAmountText("12.50%", 1)).toBe("12.51%");
    expect(stepAmountText("1,234.5", 1)).toBe("1234.6");
  });
});
