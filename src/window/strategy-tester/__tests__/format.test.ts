import { describe, expect, it } from "vitest";
import { DASH, MINUS, NNBSP, compact, count, dateRange, money, percent, ratio, tone, tradeDate } from "../format";

describe("money / percent / ratio / count", () => {
  it("thousands, 2 decimals, + on signed values, U+2212 on negatives", () => {
    expect(money(133192.13)).toBe("133,192.13");
    expect(money(133192.13, true)).toBe("+133,192.13");
    expect(money(-18927.37)).toBe(`${MINUS}18,927.37`);
    expect(money(-18927.37, true)).toBe(`${MINUS}18,927.37`);
    expect(money(0, true)).toBe("0.00");
    expect(money(0.005)).toBe("0.01");
  });

  it("not available: em dash", () => {
    expect(money(null)).toBe(DASH);
    expect(money(undefined)).toBe(DASH);
    expect(money(Number.NaN)).toBe(DASH);
    expect(money(Infinity)).toBe(DASH);
    expect(percent(null)).toBe(DASH);
    expect(ratio(Number.NaN)).toBe(DASH);
  });

  it("percent of a fraction", () => {
    expect(percent(1.3319)).toBe("133.19%");
    expect(percent(-0.05, true)).toBe(`${MINUS}5.00%`);
    expect(percent(0.1071, true)).toBe("+10.71%");
    expect(percent(0)).toBe("0.00%");
  });

  it("ratio with 3 decimals", () => {
    expect(ratio(1.5)).toBe("1.500");
    expect(ratio(-0.25)).toBe(`${MINUS}0.250`);
    expect(ratio(1234.5)).toBe("1,234.500");
  });

  it("count: integer with thousands", () => {
    expect(count(1234567)).toBe("1,234,567");
    expect(count(2.6)).toBe("3");
    expect(count(0)).toBe("0");
  });
});

describe("compact", () => {
  it("K / M / B with a narrow no-break space", () => {
    expect(compact(100000)).toBe(`100${NNBSP}K`);
    expect(compact(36683.12)).toBe(`36.68${NNBSP}K`);
    expect(compact(1_500_000)).toBe(`1.5${NNBSP}M`);
    expect(compact(-2_500_000_000)).toBe(`${MINUS}2.5${NNBSP}B`);
    expect(compact(1000)).toBe(`1${NNBSP}K`);
  });

  it("below a thousand: up to 2 decimals, no letter (reference volume formatter)", () => {
    expect(compact(999)).toBe("999");
    expect(compact(512.5)).toBe("512.5");
    expect(compact(-5)).toBe(`${MINUS}5`);
    expect(compact(0)).toBe("0");
    expect(compact(0.123)).toBe("0.12");
  });

  it("rounds before choosing the unit; T unit", () => {
    expect(compact(999_999)).toBe(`1${NNBSP}M`);
    expect(compact(999_994.9)).toBe(`999.99${NNBSP}K`);
    expect(compact(1.5e12)).toBe(`1.5${NNBSP}T`);
  });
});

describe("tone", () => {
  it("class of a signed value", () => {
    expect(tone(5)).toBe("is-positive");
    expect(tone(-0.01)).toBe("is-negative");
    expect(tone(0)).toBe("");
    expect(tone(null)).toBe("");
    expect(tone(Number.NaN)).toBe("");
  });
});

describe("dates", () => {
  // 08/09/2026 13:30 UTC = 09:30 New York (EDT).
  const t = Date.UTC(2026, 8, 8, 13, 30);

  it("trade date in the exchange zone", () => {
    expect(tradeDate(t, false, "America/New_York")).toBe("Sep 8, 2026");
    expect(tradeDate(t, true, "America/New_York")).toBe("Sep 8, 2026 09:30");
    expect(tradeDate(t, true, "UTC")).toBe("Sep 8, 2026 13:30");
  });

  it("the zone decides the date near midnight", () => {
    const late = Date.UTC(2026, 8, 9, 2, 0); // 08/09 22:00 New York
    expect(tradeDate(late, false, "America/New_York")).toBe("Sep 8, 2026");
    expect(tradeDate(late, false, "UTC")).toBe("Sep 9, 2026");
  });

  it("testing period pill", () => {
    expect(dateRange(Date.UTC(2018, 6, 25, 14), Date.UTC(2026, 8, 29, 14), "America/New_York")).toBe(`Jul 25, 2018 ${DASH} Sep 29, 2026`);
  });
});
