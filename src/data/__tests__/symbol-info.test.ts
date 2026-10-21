import { describe, expect, it } from "vitest";
import { securityTypeLabel, siteName, symbolInfoGroups, zoneCity } from "../symbol-info";

describe("symbol info", () => {
  it("names the security types as the reference", () => {
    expect(securityTypeLabel("etf")).toBe("Fund ETF");
    expect(securityTypeLabel("stock")).toBe("Stock");
    expect(securityTypeLabel("preferred")).toBe("Stock");
    expect(securityTypeLabel("adr")).toBe("DR");
    expect(securityTypeLabel("other")).toBeNull();
  });

  it("lists the fields with a value, Website for a stock and Home page for a fund", () => {
    const fund = symbolInfoGroups({ symbol: "AMEX:SPY", name: "SPDR", figi: "BBG000BDTBL9", homepageUrl: "https://www.ssga.com/x", securityType: "etf", listedExchange: "AMEX", currency: "USD", tickSize: "0.01" });
    expect(fund[0].map((f) => f.title)).toEqual(["Symbol", "Name", "FIGI", "Home page"]);
    expect(fund[0][3]).toMatchObject({ value: "ssga.com", link: "https://www.ssga.com/x" });
    expect(fund[1].map((f) => [f.title, f.value])).toEqual([["Type", "Fund ETF"], ["Point value", "1"], ["Listed exchange", "AMEX"], ["Currency", "USD"], ["Tick size", "0.01"]]);
    const stock = symbolInfoGroups({ symbol: "NASDAQ:AAPL", homepageUrl: "https://apple.com", securityType: "stock", industry: "Electronic Computers" });
    expect(stock[0].map((f) => f.title)).toEqual(["Symbol", "Industry", "Website"]);
    expect(symbolInfoGroups({ symbol: "X:Y", homepageUrl: "https://a.b", securityType: "adr" })[0].map((f) => f.title)).toEqual(["Symbol"]);
    expect(siteName("https://www.ssga.com/us/en")).toBe("ssga.com");
  });

  it("names the exchange time zone by its city", () => {
    expect(zoneCity("America/New_York")).toBe("New York");
  });
});
