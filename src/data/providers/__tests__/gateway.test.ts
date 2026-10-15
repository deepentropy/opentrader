import { describe, expect, it } from "vitest";
import type { SymbolSearchResult } from "../../../bindings";
import { defaultExchange, exchangeCode, exchangeName, gateway, migrateTypeCode, searchResultToRow, typeFilters } from "../gateway";

const res = (over: Partial<SymbolSearchResult>): SymbolSearchResult => ({
  ticker: "AAPL",
  name: "Apple Inc.",
  market: "stocks",
  locale: "us",
  exchange: "XNAS",
  type: "stock",
  ...over,
});

describe("exchange names and codes", () => {
  it("maps MICs to display names, case-insensitively, else passes them through", () => {
    expect(exchangeName("XNAS")).toBe("NASDAQ");
    expect(exchangeName("xnys")).toBe("NYSE");
    expect(exchangeName("ARCX")).toBe("NYSE ARCA");
    expect(exchangeName("BATS")).toBe("CBOE BZX");
    expect(exchangeName("LSE")).toBe("LSE");
    expect(exchangeName(null)).toBe("");
    expect(exchangeName("")).toBe("");
  });

  it("maps MICs to the full-name prefix (NYSE Arca listings are AMEX, Cboe ones CBOE)", () => {
    expect(exchangeCode("XNAS")).toBe("NASDAQ");
    expect(exchangeCode("ARCX")).toBe("AMEX");
    expect(exchangeCode("XASE")).toBe("AMEX");
    expect(exchangeCode("BATS")).toBe("CBOE");
    expect(exchangeCode("EDGA")).toBe("CBOE");
    expect(exchangeCode("PINX")).toBe("OTC");
    expect(exchangeCode("nyse arca")).toBe("NYSEARCA"); // unknown: one upper-case token
    expect(exchangeCode(undefined)).toBe(defaultExchange);
  });
});

describe("searchResultToRow", () => {
  it("a US common stock", () => {
    expect(searchResultToRow(res({}))).toEqual({
      symbolName: "NASDAQ:AAPL",
      ticker: "AAPL",
      description: "Apple Inc.",
      marketType: "stock",
      exchange: "NASDAQ",
      exchangeTooltip: "NASDAQ",
      primaryExchange: true,
      category: "stocks",
      country: "US",
    });
  });

  it("an ETF on NYSE Arca goes to Funds, named AMEX:", () => {
    const r = searchResultToRow(res({ ticker: "SPY", exchange: "ARCX", type: "etf" }));
    expect(r.symbolName).toBe("AMEX:SPY");
    expect(r.exchange).toBe("NYSE ARCA");
    expect(r.marketType).toBe("etf");
    expect(r.category).toBe("funds");
  });

  it("depositary receipts, NYSE American, indices", () => {
    expect(searchResultToRow(res({ type: "adr", exchange: "XNYS" }))).toMatchObject({ marketType: "dr", category: "stocks", exchange: "NYSE" });
    expect(searchResultToRow(res({ exchange: "XASE" })).exchange).toBe("NYSE AMERICAN");
    expect(searchResultToRow(res({ type: "index", market: "indices", exchange: null }))).toMatchObject({
      symbolName: "AAPL",
      marketType: "index",
      category: "indices",
      exchange: "",
      exchangeTooltip: undefined,
      primaryExchange: false,
    });
  });

  it("crypto and forex: their own tabs, no listing country", () => {
    const c = searchResultToRow(res({ ticker: "X:BTCUSD", market: "crypto", type: null, exchange: null, locale: "global" }));
    expect(c).toMatchObject({ marketType: "crypto", category: "crypto", country: undefined });
    const f = searchResultToRow(res({ ticker: "C:EURUSD", market: "fx", type: null, exchange: null, locale: "us" }));
    expect(f).toMatchObject({ marketType: "forex", category: "forex", country: undefined });
  });

  it("defaults: stocks market, empty description, unknown exchange as is", () => {
    const r = searchResultToRow(res({ market: null, name: null, type: null, exchange: "XLON", locale: null }));
    expect(r).toMatchObject({ symbolName: "XLON:AAPL", description: "", marketType: "stock", exchange: "XLON", category: "stocks", country: undefined });
    expect(searchResultToRow(res({ market: "otc", type: "stock", exchange: "OTCM" }))).toMatchObject({ category: "stocks", exchange: "OTC", symbolName: "OTC:AAPL" });
  });
});

describe("adapter", () => {
  it("bundles the hooks under the backend's provider name", () => {
    expect(gateway.name).toBe("gateway");
    expect(gateway.defaultExchange).toBe("NASDAQ");
    expect(typeFilters[0]).toEqual({ label: "All types", code: null });
    expect(typeFilters.map((t) => t.code)).toEqual([null, "stock", "preferred", "adr", "warrant"]);
  });

  it("translates a Type filter saved by an earlier version", () => {
    expect(["CS", "PFD", "ADRC", "WARRANT"].map(migrateTypeCode)).toEqual(["stock", "preferred", "adr", "warrant"]);
    expect(migrateTypeCode("stock")).toBe("stock");
    expect(migrateTypeCode("XYZ")).toBe("XYZ");
  });

  it("every fund-like type goes to Funds", () => {
    for (const type of ["etf", "etn", "etv", "fund"]) expect(searchResultToRow(res({ type })).category).toBe("funds");
    expect(searchResultToRow(res({ type: "etv" })).marketType).toBe("etf");
    expect(searchResultToRow(res({ type: "bond" })).category).toBe("bonds");
    expect(searchResultToRow(res({ type: "other" })).marketType).toBe("stock");
  });
});
