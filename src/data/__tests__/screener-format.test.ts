import { describe, expect, it } from "vitest";
import { DASH, abbrev, formatCell, parseValue, priceText, valueText } from "../screener-format";

const NNBSP = " ";
const MINUS = "−";

describe("abbrev", () => {
  it("abbreviates with K / M / B / T, up to 2 decimals, trailing zeros trimmed", () => {
    expect(abbrev(512)).toBe("512");
    expect(abbrev(810_000)).toBe(`810${NNBSP}K`);
    expect(abbrev(9_070_000)).toBe(`9.07${NNBSP}M`);
    expect(abbrev(6_000_000)).toBe(`6${NNBSP}M`);
    expect(abbrev(4_800_000_000)).toBe(`4.8${NNBSP}B`);
    expect(abbrev(1_740_000_000)).toBe(`1.74${NNBSP}B`);
    expect(abbrev(2.5e12)).toBe(`2.5${NNBSP}T`);
    expect(abbrev(1000)).toBe(`1${NNBSP}K`);
  });

  it("keeps up to 2 decimals for small numbers and handles zero", () => {
    expect(abbrev(0)).toBe("0");
    expect(abbrev(12.345)).toBe("12.35");
    expect(abbrev(10)).toBe("10");
    expect(abbrev(0.5)).toBe("0.5");
  });

  it("uses the U+2212 minus for negatives", () => {
    expect(abbrev(-4_800_000_000)).toBe(`${MINUS}4.8${NNBSP}B`);
    expect(abbrev(-12)).toBe(`${MINUS}12`);
  });

  it("rolls a value rounding to 1000 of a unit over to the next unit", () => {
    expect(abbrev(999_999)).toBe(`1${NNBSP}M`);
    expect(abbrev(999_995)).toBe(`1${NNBSP}M`);
    expect(abbrev(999_994.9)).toBe(`999.99${NNBSP}K`);
    expect(abbrev(999_995_000)).toBe(`1${NNBSP}B`);
    expect(abbrev(999.995e12)).toBe(`1,000${NNBSP}T`);
    expect(abbrev(-999_999)).toBe(`${MINUS}1${NNBSP}M`);
  });

  it("volume / money cells: whole numbers under 1,000 (reference volume formatter)", () => {
    expect(formatCell("volume", 512.5, null)).toEqual({ text: "513" });
    expect(formatCell("volume", 999.5, null)).toEqual({ text: `1${NNBSP}K` });
    expect(formatCell("volume", 999_999, null)).toEqual({ text: `1${NNBSP}M` });
    expect(formatCell("money", 2.5e12, "usd")).toEqual({ text: `2.5${NNBSP}T`, unit: "USD" });
  });
});

describe("priceText", () => {
  it("shows 2 decimals, 4 under 1", () => {
    expect(priceText(14.82)).toBe("14.82");
    expect(priceText(14.8)).toBe("14.80");
    expect(priceText(1)).toBe("1.00");
    expect(priceText(0.5)).toBe("0.5000");
    expect(priceText(0.12345)).toBe("0.1235");
    expect(priceText(0)).toBe("0.00");
  });

  it("uses the U+2212 minus", () => {
    expect(priceText(-0.25)).toBe(`${MINUS}0.2500`);
    expect(priceText(-14.8)).toBe(`${MINUS}14.80`);
  });
});

describe("formatCell", () => {
  it("shows a dash for missing or non-finite values", () => {
    expect(formatCell("price", null, "usd")).toEqual({ text: DASH });
    expect(formatCell("price", undefined, "usd")).toEqual({ text: DASH });
    expect(formatCell("text", "", null)).toEqual({ text: DASH });
    expect(formatCell("number", NaN, null)).toEqual({ text: DASH });
    expect(formatCell("number", Infinity, null)).toEqual({ text: DASH });
    expect(DASH).toBe("—");
  });

  it("shows strings as they are", () => {
    expect(formatCell("text", "Technology", null)).toEqual({ text: "Technology" });
    expect(formatCell("price", "n/a", "usd")).toEqual({ text: "n/a" });
  });

  it("formats prices with the upper-cased currency unit and no tone", () => {
    expect(formatCell("price", 14.82, "usd")).toEqual({ text: "14.82", unit: "USD" });
    expect(formatCell("price", -3, null)).toEqual({ text: `${MINUS}3.00` });
    expect(formatCell("price", 14.82, null).unit).toBeUndefined();
  });

  it("formats signed prices with a sign and a tone", () => {
    expect(formatCell("signedPrice", 0.12, "usd")).toEqual({ text: "+0.1200", unit: "USD", tone: "up" });
    expect(formatCell("signedPrice", 1.5, "usd")).toEqual({ text: "+1.50", unit: "USD", tone: "up" });
    expect(formatCell("signedPrice", -1.5, "usd")).toEqual({ text: `${MINUS}1.50`, unit: "USD", tone: "down" });
    const zero = formatCell("signedPrice", 0, "usd");
    expect(zero.text).toBe("0.00");
    expect(zero.tone).toBeUndefined();
  });

  it("formats changes as signed percentages with a tone", () => {
    expect(formatCell("change", 6.47, "usd")).toEqual({ text: "+6.47%", tone: "up" });
    expect(formatCell("change", -1.36, null)).toEqual({ text: `${MINUS}1.36%`, tone: "down" });
    expect(formatCell("change", 0, null)).toEqual({ text: "0.00%" });
  });

  it("formats percents, volumes, money and numbers", () => {
    expect(formatCell("percent", 5.22, "usd")).toEqual({ text: "5.22%" });
    expect(formatCell("percent", -2, null)).toEqual({ text: `${MINUS}2.00%` });
    expect(formatCell("volume", 9_070_000, "usd")).toEqual({ text: `9.07${NNBSP}M` });
    expect(formatCell("money", 4.8e9, "usd")).toEqual({ text: `4.8${NNBSP}B`, unit: "USD" });
    expect(formatCell("number", 1.79, "usd")).toEqual({ text: "1.79" });
    expect(formatCell("number", -1.5, null)).toEqual({ text: `${MINUS}1.50` });
    expect(formatCell("text", 42, null)).toEqual({ text: "42" });
  });
});

describe("valueText", () => {
  it("writes filter values without currency, trailing zeros trimmed", () => {
    expect(valueText("volume", 500_000)).toBe(`500${NNBSP}K`);
    expect(valueText("money", 1e10)).toBe(`10${NNBSP}B`);
    expect(valueText("change", 5)).toBe("5%");
    expect(valueText("percent", -2.5)).toBe(`${MINUS}2.5%`);
    expect(valueText("number", 5)).toBe("5");
    expect(valueText("price", 10.25)).toBe("10.25");
    expect(valueText("number", -0.1)).toBe(`${MINUS}0.1`);
    expect(valueText("price", 0)).toBe("0");
  });
});

describe("parseValue", () => {
  it("parses plain numbers and K / M / B / T suffixes (any case)", () => {
    expect(parseValue("5")).toBe(5);
    expect(parseValue(" 12 ")).toBe(12);
    expect(parseValue(".5")).toBe(0.5);
    expect(parseValue("500k")).toBe(500_000);
    expect(parseValue("1.5M")).toBe(1_500_000);
    expect(parseValue("10 B")).toBe(1e10);
    expect(parseValue("2t")).toBe(2e12);
  });

  it("accepts the U+2212 minus, percent signs and thousands separators", () => {
    expect(parseValue(`${MINUS}3`)).toBe(-3);
    expect(parseValue("-3%")).toBe(-3);
    expect(parseValue("1,000")).toBe(1000);
    expect(parseValue(`500${NNBSP}K`)).toBe(500_000);
  });

  it("rejects empty and malformed input", () => {
    expect(parseValue("")).toBeNull();
    expect(parseValue("   ")).toBeNull();
    expect(parseValue("abc")).toBeNull();
    expect(parseValue("5.")).toBeNull();
    expect(parseValue("1e3")).toBeNull();
    expect(parseValue("5x")).toBeNull();
    expect(parseValue("--5")).toBeNull();
  });

  it("round-trips valueText output", () => {
    for (const n of [5, 500_000, 1e10, -2.5, 1.74e9]) expect(parseValue(valueText("money", n))).toBeCloseTo(n, 6);
  });
});
