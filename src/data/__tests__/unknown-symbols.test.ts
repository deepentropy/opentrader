import { describe, expect, it } from "vitest";
import { forgetUnknownSymbols, isUnknownSymbol, noteSymbolError } from "../unknown-symbols";

describe("unknown symbols (#341)", () => {
  it("remembers a symbol the source says doesn't exist, until the plugins change", () => {
    noteSymbolError("NFO:NIFTY09NOV2624450CE", "NFO:NIFTY09NOV2624450CE: unknown symbol (NOT_FOUND)");
    noteSymbolError("NSE:RELIANCE", "The plugin did not answer in time");
    noteSymbolError("NASDAQ:AAPL", new Error("bars: not found (NOT_FOUND, ref a1)"));
    expect(isUnknownSymbol("nfo:nifty09nov2624450ce")).toBe(true);
    expect(isUnknownSymbol("NASDAQ:AAPL")).toBe(true);
    expect(isUnknownSymbol("NSE:RELIANCE")).toBe(false);
    // Says whether some were unknown (#423: their charts load again).
    expect(forgetUnknownSymbols((s) => s.startsWith("NSE:"))).toBe(false);
    expect(forgetUnknownSymbols((s) => s.startsWith("NFO:"))).toBe(true);
    expect(isUnknownSymbol("NFO:NIFTY09NOV2624450CE")).toBe(false);
    expect(forgetUnknownSymbols()).toBe(true);
    expect(isUnknownSymbol("NASDAQ:AAPL")).toBe(false);
    expect(forgetUnknownSymbols()).toBe(false);
  });
});
