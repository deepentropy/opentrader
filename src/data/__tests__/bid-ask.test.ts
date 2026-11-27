import { describe, expect, it, vi } from "vitest";

// The charts' bid and ask: the newest quote of each symbol, a side left out keeps its last value.
vi.mock("../../bindings", () => ({ events: { chartQuote: { listen: vi.fn() }, marketTier: { listen: vi.fn() } } }));
vi.mock("../datafeed-live", () => ({ onChartQuote: vi.fn(async () => () => {}) }));

import { bidAskFor, takeQuote } from "../bid-ask";

describe("bid and ask", () => {
  it("keeps the newest quote; an older one (a snapshot behind the stream) does not replace it", () => {
    takeQuote("nasdaq:aapl", { time: 2000, bid: 10, ask: 10.1 });
    expect(bidAskFor("NASDAQ:AAPL")).toEqual({ time: 2000, bid: 10, ask: 10.1 });
    takeQuote("NASDAQ:AAPL", { time: 1000, bid: 9, ask: 9.1 });
    expect(bidAskFor("NASDAQ:AAPL")?.bid).toBe(10);
    // A quote of one side keeps the other's.
    takeQuote("NASDAQ:AAPL", { time: 3000, bid: null, ask: 10.2 });
    expect(bidAskFor("NASDAQ:AAPL")).toEqual({ time: 3000, bid: 10, ask: 10.2 });
    expect(bidAskFor("NASDAQ:MSFT")).toBeUndefined();
  });
});
