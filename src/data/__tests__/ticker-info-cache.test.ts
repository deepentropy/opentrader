import { beforeEach, describe, expect, it, vi } from "vitest";

const getTickerInfo = vi.fn();
vi.mock("../../bindings", () => ({ commands: { getTickerInfo: (s: string) => getTickerInfo(s) } }));

import { forgetTickerInfo, getTickerInfo as ask, tickerInfoEpoch } from "../datafeed-rest";
import { affects } from "../plugin-events";
import { forgetUnknownSymbols, isUnknownSymbol, noteSymbolError } from "../unknown-symbols";

const notFound = { status: "error", error: "NSE:RELIANCE: unknown symbol (NOT_FOUND)" };
const row = { status: "ok", data: { ticker: "NSE:RELIANCE", name: "Reliance", type: "stock" } };

describe("ticker info kept (#371)", () => {
  beforeEach(() => {
    getTickerInfo.mockReset();
    forgetTickerInfo();
  });

  it("asks again for a symbol not found once the plugins change", async () => {
    getTickerInfo.mockResolvedValueOnce(notFound).mockResolvedValueOnce(row);
    await expect(ask("NSE:RELIANCE")).rejects.toMatch(/NOT_FOUND/);
    await expect(ask("NSE:RELIANCE")).rejects.toMatch(/NOT_FOUND/);
    expect(getTickerInfo).toHaveBeenCalledTimes(1);
    forgetTickerInfo();
    await expect(ask("NSE:RELIANCE")).resolves.toMatchObject({ type: "stock" });
    expect(getTickerInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps a request still waiting, and tells the askers", async () => {
    let answer!: (v: unknown) => void;
    getTickerInfo.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const first = ask("NSE:TCS");
    forgetTickerInfo();
    expect(ask("NSE:TCS")).toBe(first);
    answer(row);
    await first;

    // What the asking effects track.
    const epoch = tickerInfoEpoch();
    forgetTickerInfo();
    expect(tickerInfoEpoch()).toBe(epoch + 1);
  });
});

describe("a plugin reloads its symbols' info (#400)", () => {
  beforeEach(() => {
    getTickerInfo.mockReset();
    forgetTickerInfo();
  });

  const ok = (ticker: string) => ({ status: "ok", data: { ticker, name: ticker, type: "stock" } });

  it("keeps an answer for an hour without asking again", async () => {
    vi.useFakeTimers();
    try {
      getTickerInfo.mockResolvedValue(ok("NSE:INFY"));
      await ask("NSE:INFY");
      vi.advanceTimersByTime(59 * 60_000);
      await ask("NSE:INFY");
      expect(getTickerInfo).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets only the symbols of the plugin's exchanges and tells the askers", async () => {
    getTickerInfo.mockImplementation(async (s: string) => ok(s));
    for (const s of ["NSE:INFY", "NFO:NIFTY26NOVFUT", "MCX:GOLD", "NASDAQ:AAPL"]) await ask(s);
    const epoch = tickerInfoEpoch();
    forgetTickerInfo(affects({ exchanges: ["NSE", "NFO"], symbols: null }));
    expect(tickerInfoEpoch()).toBe(epoch + 1);
    for (const s of ["NSE:INFY", "NFO:NIFTY26NOVFUT", "MCX:GOLD", "NASDAQ:AAPL"]) await ask(s);
    expect(getTickerInfo.mock.calls.slice(4).map(([s]) => s)).toEqual(["NSE:INFY", "NFO:NIFTY26NOVFUT"]);
  });

  it("forgets only the symbols it names", async () => {
    getTickerInfo.mockImplementation(async (s: string) => ok(s));
    await ask("NSE:INFY");
    await ask("NSE:TCS");
    forgetTickerInfo(affects({ exchanges: ["NSE"], symbols: ["nse:tcs"] }));
    await ask("NSE:INFY");
    await ask("NSE:TCS");
    expect(getTickerInfo.mock.calls.map(([s]) => s)).toEqual(["NSE:INFY", "NSE:TCS", "NSE:TCS"]);
  });

  it("asks again for its symbols marked unknown, not for the others", () => {
    forgetUnknownSymbols();
    for (const s of ["NFO:OLDFUT", "MCX:OLDFUT"]) noteSymbolError(s, `${s}: unknown symbol (NOT_FOUND)`);
    forgetUnknownSymbols(affects({ exchanges: ["NFO"], symbols: null }));
    expect(isUnknownSymbol("NFO:OLDFUT")).toBe(false);
    expect(isUnknownSymbol("MCX:OLDFUT")).toBe(true);
  });
});
