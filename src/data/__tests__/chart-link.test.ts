import { describe, expect, it } from "vitest";
import { chartLinkOf, chartLinkOfUrl, chartLinkUrl, linkInterval } from "../chart-link";

describe("chart links (#350)", () => {
  it("reads a page's symbol and interval", () => {
    expect(chartLinkOf("?symbol=ARRY")).toEqual({ symbol: "ARRY" });
    expect(chartLinkOf("?symbol=nasdaq%3Aarry&interval=60")).toEqual({ symbol: "NASDAQ:ARRY", interval: "60" });
    expect(chartLinkOf("?symbol=BRK.B&interval=D")).toEqual({ symbol: "BRK.B", interval: "1D" });
  });
  it("leaves out an interval that is not one, and needs a symbol", () => {
    expect(chartLinkOf("?symbol=ARRY&interval=abc")).toEqual({ symbol: "ARRY" });
    for (const q of ["", "?interval=60", "?symbol=", "?symbol=A%20B", "?symbol=A:B:C", "?symbol=:ARRY", `?symbol=${"A".repeat(65)}`]) expect(chartLinkOf(q)).toBeNull();
  });
  it("reads one of the app's strategies and its inputs, nothing else", () => {
    const inputs = encodeURIComponent(JSON.stringify({ "RSI Period Length": 5, in_1: 240 }));
    expect(chartLinkOf(`?symbol=AAPL&interval=60&study=strategy:chartart-bb-rsi&inputs=${inputs}`)).toEqual({
      symbol: "AAPL", interval: "60", study: "strategy:chartart-bb-rsi", inputs: { "RSI Period Length": 5, in_1: 240 },
    });
    expect(chartLinkOf("?symbol=AAPL&study=strategy:chartart-bb-rsi&inputs=%5B1%5D")).toEqual({ symbol: "AAPL", study: "strategy:chartart-bb-rsi" });
    expect(chartLinkOf(`?symbol=AAPL&study=strategy:chartart-bb-rsi&inputs=${encodeURIComponent('{"a":{"b":1}}')}`)).toEqual({ symbol: "AAPL", study: "strategy:chartart-bb-rsi" });
    for (const study of ["user:abc", "strategy:user:abc", "javascript:alert(1)", "strategy:"]) {
      expect(chartLinkOf(`?symbol=AAPL&study=${encodeURIComponent(study)}&inputs=${inputs}`)).toEqual({ symbol: "AAPL" });
    }
  });
  it("gives the app's interval ids", () => {
    expect(["1", "15", "1H", "4h", "D", "1D", "W", "M", "3M", "30S"].map(linkInterval)).toEqual(["1", "15", "60", "240", "1D", "1D", "1W", "1M", "3M", "30S"]);
    expect(linkInterval("0")).toBeUndefined();
    expect(linkInterval(null)).toBeUndefined();
  });
  it("reads an app link or a web chart link", () => {
    const sites = ["https://demo.opentrader.markets"];
    expect(chartLinkOfUrl("opentrader://chart?symbol=ARRY&interval=60", sites)).toEqual({ symbol: "ARRY", interval: "60" });
    expect(chartLinkOfUrl("opentrader://chart/?symbol=ARRY", sites)).toEqual({ symbol: "ARRY" });
    expect(chartLinkOfUrl(" https://demo.opentrader.markets/chart/?symbol=NASDAQ:ARRY&interval=1W ", sites)).toEqual({ symbol: "NASDAQ:ARRY", interval: "1W" });
    expect(chartLinkOfUrl("https://demo.opentrader.markets/?symbol=ARRY", sites)).toEqual({ symbol: "ARRY" });
  });
  it("ignores other links", () => {
    const sites = ["https://demo.opentrader.markets"];
    for (const u of ["", "ARRY", "opentrader://post/abc123", "opentrader://chart", "https://example.com/chart/?symbol=ARRY", "https://demo.opentrader.markets/screener/?symbol=ARRY", "https://demo.opentrader.markets/chart/"])
      expect(chartLinkOfUrl(u, sites)).toBeNull();
  });
  it("writes a web link that reads back", () => {
    const url = chartLinkUrl({ symbol: "NASDAQ:ARRY", interval: "60" }, "https://demo.opentrader.markets");
    expect(url).toBe("https://demo.opentrader.markets/chart/?symbol=NASDAQ:ARRY&interval=60");
    expect(chartLinkOfUrl(url, ["https://demo.opentrader.markets"])).toEqual({ symbol: "NASDAQ:ARRY", interval: "60" });
    expect(chartLinkUrl({ symbol: "ECON:A&B" }, "https://x.test")).toBe("https://x.test/chart/?symbol=ECON:A%26B");
  });
});
