import { describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../../../bindings";

const sessions = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../../data/session", async (orig) => ({
  ...(await orig<typeof import("../../../../data/session")>()),
  cachedSymbolSessions: (s: string) => sessions.get(s) ?? null,
}));

import { SymbolSessions } from "../../../../data/session";
import { fmtChange, formatLast, moveText, priceText } from "../format";

function info(pricescale: number, variableTickSize = ""): SymbolSession {
  return { timezone: "Etc/UTC", session: "24x7", subsessions: [], holidays: "", corrections: "", pricescale, minmov: 1, variableTickSize };
}
// A US stock (0.0001 under 1, 0.01 above) and a currency pair from a data plugin quoted to 0.00001.
sessions.set("NASDAQ:AAPL", new SymbolSessions(info(100, "0.0001 1 0.01")));
sessions.set("FX:EURUSD", new SymbolSessions(info(100000)));

describe("watchlist prices on the symbol's tick grid (#319)", () => {
  it("writes a price with its symbol's tick decimals", () => {
    expect(priceText(1.086457, "FX:EURUSD")).toBe("1.08646");
    expect(priceText(189.8412, "NASDAQ:AAPL")).toBe("189.84");
    expect(priceText(0.51234, "NASDAQ:AAPL")).toBe("0.5123");
    expect(formatLast(1.08646, "FX:EURUSD")).toBe("1.08646");
    expect(formatLast(1641.6, "NASDAQ:AAPL")).toBe("1,641.60");
  });

  it("writes a change with the decimals of the price it moved", () => {
    expect(fmtChange(0.00123, { symbol: "FX:EURUSD", price: 1.08646 })).toBe("0.00123");
    expect(fmtChange(-0.5, { symbol: "NASDAQ:AAPL", price: 189.84 })).toBe("−0.50");
    expect(fmtChange(0, { symbol: "FX:EURUSD", price: 1.08646 })).toBe("0.00000");
    expect(moveText(-0.0123, "NASDAQ:AAPL", 0.51)).toBe("0.0123");
  });

  it("keeps 2 decimals until the symbol's session resolves", () => {
    expect(priceText(1.086457, "OANDA:GBPUSD")).toBe("1.09");
    expect(formatLast(1641.6)).toBe("1,641.60");
    expect(fmtChange(-3.04)).toBe("−3.04");
    expect(fmtChange(0.00123, { symbol: "OANDA:GBPUSD", price: 1.27 })).toBe("0.00");
  });
});
