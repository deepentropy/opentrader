import { describe, expect, it, vi } from "vitest";

vi.mock("../providers", () => ({ defaultExchange: () => "NASDAQ" }));

import { isFullSymbol, splitSymbol, tickerOf } from "../symbol-name";

describe("splitSymbol", () => {
  it("splits a full name", () => {
    expect(splitSymbol("NYSE:IBM")).toEqual({ exchange: "NYSE", ticker: "IBM" });
    expect(splitSymbol("NYSE:BRK.B")).toEqual({ exchange: "NYSE", ticker: "BRK.B" });
  });

  it("gives a bare ticker the default exchange, trimmed", () => {
    expect(splitSymbol("AAPL")).toEqual({ exchange: "NASDAQ", ticker: "AAPL" });
    expect(splitSymbol("  AAPL ")).toEqual({ exchange: "NASDAQ", ticker: "AAPL" });
  });

  it("reads only the part before a comma", () => {
    expect(splitSymbol("NYSE:IBM, NASDAQ:AAPL")).toEqual({ exchange: "NYSE", ticker: "IBM" });
    expect(splitSymbol(" MSFT ,x")).toEqual({ exchange: "NASDAQ", ticker: "MSFT" });
  });
});

describe("isFullSymbol / tickerOf", () => {
  it("a full name has an exchange prefix", () => {
    expect(isFullSymbol("NASDAQ:AAPL")).toBe(true);
    expect(isFullSymbol("AAPL")).toBe(false);
    expect(isFullSymbol("")).toBe(false);
  });

  it("tickerOf", () => {
    expect(tickerOf("NASDAQ:AAPL")).toBe("AAPL");
    expect(tickerOf("AAPL")).toBe("AAPL");
    expect(tickerOf("")).toBe("");
  });
});
