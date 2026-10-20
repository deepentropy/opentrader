import { describe, expect, it } from "vitest";
import type { SymbolSessions } from "../../../data/session";
import { abbreviatedPrice, chartPriceFormat, groupThousands } from "../price-format";

const MINUS = "−";
const fmt = (precision: string | undefined, v: number) => chartPriceFormat(precision, null)!.format(v);

describe("groupThousands", () => {
  it("groups the integer part by thousands with ','", () => {
    expect(groupThousands("1234567.5")).toBe("1,234,567.5");
    expect(groupThousands("1000")).toBe("1,000");
    expect(groupThousands("999.999")).toBe("999.999");
    expect(groupThousands("0.12345")).toBe("0.12345");
    expect(groupThousands("100000000")).toBe("100,000,000");
  });

  it("uses the U+2212 minus sign", () => {
    expect(groupThousands("-1234.5")).toBe(`${MINUS}1,234.5`);
    expect(groupThousands("-5")).toBe(`${MINUS}5`);
  });

  it("leaves non-numeric text alone", () => {
    expect(groupThousands("abc")).toBe("abc");
    expect(groupThousands("")).toBe("");
  });
});

describe("chartPriceFormat — fixed decimals", () => {
  it("Default without a resolved session: 2 decimals", () => {
    const f = chartPriceFormat(undefined, null)!;
    expect(f.format(1234.567)).toBe("1,234.57");
    expect(f.minMove).toBe(0.01);
    expect(chartPriceFormat("", null)!.format(1)).toBe("1.00");
  });

  it("Default with a session: the symbol's tick grid, grouped", () => {
    const grid = { formatPrice: (v: number) => v.toFixed(4), mintick: 0.0001 } as unknown as SymbolSessions;
    const f = chartPriceFormat("Default", grid)!;
    expect(f.format(12345.6)).toBe("12,345.6000");
    expect(f.minMove).toBe(0.0001);
  });

  it("Integer and N decimals", () => {
    expect(fmt("Integer", 1234.4)).toBe("1,234");
    expect(chartPriceFormat("Integer", null)!.minMove).toBe(1);
    expect(fmt("1 decimal", 0.06)).toBe("0.1");
    expect(fmt("4 decimals", 1.5)).toBe("1.5000");
    expect(chartPriceFormat("3 decimals", null)!.minMove).toBeCloseTo(0.001, 12);
    expect(fmt("2 decimals", -98765.432)).toBe(`${MINUS}98,765.43`);
  });

  it("unknown choices give null", () => {
    expect(chartPriceFormat("weird", null)).toBeNull();
    expect(chartPriceFormat("0/32", null)).toBeNull();
    expect(chartPriceFormat("1/0", null)).toBeNull();
  });
});

describe("chartPriceFormat — fractional", () => {
  it("1/32: fraction in 32nds, 2 digits", () => {
    const f = chartPriceFormat("1/32", null)!;
    expect(f.format(123.5)).toBe("123'16");
    expect(f.format(123)).toBe("123'00");
    expect(f.format(123 + 1 / 32)).toBe("123'01");
    expect(f.minMove).toBe(1 / 32);
  });

  it("1/4 and 1/2 write quarters / halves in tenths", () => {
    const q = chartPriceFormat("1/4", null)!;
    expect(q.format(123.25)).toBe("123'2");
    expect(q.format(123.5)).toBe("123'5");
    expect(q.format(123.75)).toBe("123'7");
    expect(q.format(123)).toBe("123'0");
    expect(chartPriceFormat("1/2", null)!.format(0.5)).toBe("0'5");
  });

  it("digit count follows the denominator", () => {
    expect(fmt("1/8", 0.375)).toBe("0'3");
    expect(fmt("1/16", 0.5)).toBe("0'08");
    expect(fmt("1/128", 1 / 128)).toBe("0'001");
    expect(fmt("1/320", 1.5)).toBe("1'160");
  });

  it("a fraction that rounds to a whole carries into the integer", () => {
    expect(fmt("1/32", 123.999)).toBe("124'00");
  });

  it("negatives and thousands", () => {
    expect(fmt("1/32", -123.5)).toBe(`${MINUS}123'16`);
    expect(fmt("1/4", 1234.5)).toBe("1,234'5");
  });
});

describe("abbreviatedPrice (economic series)", () => {
  const small = (v: number) => v.toFixed(1);
  it("abbreviates from 1,000 on with at most 2 decimals, as the reference values", () => {
    expect(abbreviatedPrice(32563030000000, small)).toBe("32.56 T");
    expect(abbreviatedPrice(159040000, small)).toBe("159.04 M");
    expect(abbreviatedPrice(124900000000, small)).toBe("124.9 B");
    expect(abbreviatedPrice(199000, small)).toBe("199 K");
    expect(abbreviatedPrice(-34000, small)).toBe(`${MINUS}34 K`);
  });
  it("keeps values under 1,000 in the symbol's format", () => {
    expect(abbreviatedPrice(336.3, small)).toBe("336.3");
    expect(chartPriceFormat(undefined, null, true)!.format(4.2)).toBe("4.20");
  });
});
