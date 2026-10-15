import { describe, expect, it } from "vitest";
import { SessionSpec } from "../session";
import { dayParts, securityTypeLabel, sessionWeek, siteName, symbolInfoGroups, zoneCity } from "../symbol-info";

const TZ = "America/New_York";
const RTH = new SessionSpec(TZ, "0930-1600:23456");
const ETH = new SessionSpec(TZ, "0400-2000:23456");

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

  it("splits a trading day into pre-market, market open, post-market", () => {
    const week = sessionWeek(RTH, ETH, Date.UTC(2026, 9, 15, 17) / 1000); // Thursday 13:00 New York
    expect(week.map((d) => d.weekday)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(week.findIndex((d) => d.today)).toBe(4);
    expect(week[4].segments).toEqual([
      { part: "pre", from: 240, to: 570 },
      { part: "open", from: 570, to: 960 },
      { part: "post", from: 960, to: 1200 },
    ]);
    expect(week[0].segments).toEqual([]);
    expect(dayParts(RTH, null, week[1].day)).toEqual([{ part: "open", from: 570, to: 960 }]);
    expect(zoneCity(TZ)).toBe("New York");
  });
});
