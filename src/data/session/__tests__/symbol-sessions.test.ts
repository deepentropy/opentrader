import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../../bindings";

const getSymbolSession = vi.hoisted(() => vi.fn());
vi.mock("../../../bindings", () => ({ commands: { getSymbolSession } }));
vi.mock("../../providers", () => ({ defaultExchange: () => "NASDAQ" }));

import { SymbolSessions, cachedSymbolSessions, displayTimeZone, sessionsVersion, symbolSessions } from "../symbol-sessions";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

/** A US stock: regular 09:30-16:00, extended 04:00-20:00, one holiday. */
function usStock(over: Partial<SymbolSession> = {}): SymbolSession {
  return {
    timezone: "America/New_York",
    session: "0930-1600",
    subsessions: [
      { id: "regular", description: "Regular Trading Hours", session: "0930-1600", corrections: "" },
      { id: "extended", description: "Extended Trading Hours", session: "0400-2000", corrections: "" },
      { id: "premarket", description: "Premarket", session: "0400-0930", corrections: "" },
      { id: "postmarket", description: "Postmarket", session: "1600-2000", corrections: "" },
    ],
    holidays: "20261126",
    corrections: "",
    pricescale: 100,
    minmov: 1,
    variableTickSize: "0.0001 1 0.01",
    ...over,
  };
}

describe("SymbolSessions", () => {
  const s = new SymbolSessions(usStock());

  it("reads the regular, extended, pre and post schedules", () => {
    expect(s.timeZone).toBe("America/New_York");
    expect(s.regularSpec).toBe("0930-1600");
    expect(s.extendedSpec).toBe("0400-2000");
    expect(s.hasExtendedHours).toBe(true);
    expect(s.premarket).not.toBeNull();
    expect(s.postmarket).not.toBeNull();
    expect(s.spec("RTH")).toBe(s.regular);
    expect(s.spec("ETH")).toBe(s.extended);
  });

  it("gives the market state through the day (EDT)", () => {
    expect(s.status(utc(2026, 10, 14, 7, 59))).toBe("closed"); // 03:59
    expect(s.status(utc(2026, 10, 14, 8))).toBe("pre"); // 04:00
    expect(s.status(utc(2026, 10, 14, 13, 29))).toBe("pre");
    expect(s.status(utc(2026, 10, 14, 13, 30))).toBe("open");
    expect(s.status(utc(2026, 10, 14, 20))).toBe("post"); // 16:00
    expect(s.status(utc(2026, 10, 14, 23, 59))).toBe("post");
    expect(s.status(utc(2026, 10, 15, 0))).toBe("closed"); // 20:00
    expect(s.status(utc(2026, 10, 17, 15))).toBe("closed"); // Saturday
  });

  it("applies the holidays to every part", () => {
    expect(s.status(utc(2026, 11, 26, 16))).toBe("closed");
    expect(s.status(utc(2026, 11, 26, 10))).toBe("closed");
    expect(s.extended.isTradingDay(Date.UTC(2026, 10, 26) / 86400000)).toBe(false);
  });

  it("tells the extended part of a bar", () => {
    expect(s.extendedPart(utc(2026, 10, 14, 12))).toBe("pre");
    expect(s.extendedPart(utc(2026, 10, 14, 15))).toBeNull();
    expect(s.extendedPart(utc(2026, 10, 14, 21))).toBe("post");
    expect(s.extendedPart(utc(2026, 10, 17, 21))).toBeNull();
  });

  it("reads the tick grid", () => {
    expect(s.mintick).toBeCloseTo(0.01, 12);
    expect(s.minmove).toBe(1);
    expect(s.pricescale).toBe(100);
    expect(s.tickBands).toEqual([
      [1, 0.0001],
      [Infinity, 0.01],
    ]);
    expect(s.tickAt(0.5)).toBe(0.0001);
    expect(s.tickAt(1)).toBe(0.0001); // the bound is inclusive
    expect(s.tickAt(-0.5)).toBe(0.0001);
    expect(s.tickAt(1.01)).toBe(0.01);
  });

  it("formats prices on their band's tick (US stocks)", () => {
    expect(s.formatPrice(0.5)).toBe("0.5000");
    expect(s.formatPrice(1)).toBe("1.0000");
    expect(s.formatPrice(123.456)).toBe("123.46");
    expect(s.formatPrice(0.123456)).toBe("0.1235");
  });

  it("formats on multi-band grids (NSE-like)", () => {
    const nse = new SymbolSessions(usStock({ timezone: "Asia/Kolkata", session: "0915-1530", subsessions: [], holidays: "", pricescale: 10, minmov: 1, variableTickSize: "0.05 1000 0.1 5000 5" }));
    expect(nse.formatPrice(500.1)).toBe("500.10");
    expect(nse.formatPrice(1374.7)).toBe("1374.7");
    expect(nse.formatPrice(25001)).toBe("25000");
    expect(nse.hasExtendedHours).toBe(false);
    expect(nse.extended).toBe(nse.regular);
    expect(nse.premarket).toBeNull();
    expect(nse.status(utc(2026, 10, 14, 5))).toBe("open");
    expect(nse.extendedPart(utc(2026, 10, 14, 5))).toBeNull();
  });

  it("uses minmov / pricescale when there are no bands", () => {
    const fut = new SymbolSessions(usStock({ subsessions: [], pricescale: 4, minmov: 1, variableTickSize: "" }));
    expect(fut.tickBands).toEqual([]);
    expect(fut.tickAt(100)).toBe(0.25);
    expect(fut.formatPrice(100.3)).toBe("100.25");
    expect(fut.formatPrice(5)).toBe("5.00");
  });

  it("has no extended hours when the extended session equals the regular one", () => {
    const x = new SymbolSessions(usStock({ subsessions: [{ id: "extended", description: "", session: "0930-1600", corrections: "" }] }));
    expect(x.hasExtendedHours).toBe(false);
  });
});

describe("symbolSessions cache", () => {
  beforeEach(() => getSymbolSession.mockReset());

  it("resolves once per symbol, shares concurrent requests and bumps the version", async () => {
    getSymbolSession.mockResolvedValue({ status: "ok", data: usStock() });
    const v0 = sessionsVersion();
    expect(cachedSymbolSessions("nyse:ibm")).toBeNull(); // starts the resolve
    const [a, b] = await Promise.all([symbolSessions("NYSE:IBM"), symbolSessions("nyse:ibm")]);
    expect(a).toBe(b);
    expect(getSymbolSession).toHaveBeenCalledTimes(1);
    expect(getSymbolSession).toHaveBeenCalledWith("NYSE:IBM");
    expect(sessionsVersion()).toBe(v0 + 1);
    expect(cachedSymbolSessions("NYSE:IBM")).toBe(a);
    await symbolSessions("NYSE:IBM");
    expect(getSymbolSession).toHaveBeenCalledTimes(1);
  });

  it("names a bare ticker with the default exchange", async () => {
    getSymbolSession.mockResolvedValue({ status: "ok", data: usStock() });
    await symbolSessions("aapl");
    expect(getSymbolSession).toHaveBeenCalledWith("NASDAQ:AAPL");
    expect(cachedSymbolSessions("NASDAQ:AAPL")).not.toBeNull();
  });

  it("rejects when the provider cannot describe the symbol, and retries later", async () => {
    getSymbolSession.mockResolvedValueOnce({ status: "error", error: "unknown symbol" });
    await expect(symbolSessions("NYSE:NOPE")).rejects.toThrow("unknown symbol");
    getSymbolSession.mockResolvedValueOnce({ status: "ok", data: usStock() });
    await expect(symbolSessions("NYSE:NOPE")).resolves.toBeInstanceOf(SymbolSessions);
    expect(getSymbolSession).toHaveBeenCalledTimes(2);
  });

  it("returns null for an empty symbol", () => {
    expect(cachedSymbolSessions("")).toBeNull();
    expect(getSymbolSession).not.toHaveBeenCalled();
  });
});

describe("displayTimeZone", () => {
  it("is the picked zone unless 'Exchange' is picked", () => {
    expect(displayTimeZone("(UTC+2) Paris", "Europe/Paris", "NYSE:IBM")).toBe("Europe/Paris");
    expect(displayTimeZone("Exchange", "UTC", undefined)).toBe("UTC");
  });

  it("is the symbol's exchange zone once resolved, the fallback before", async () => {
    getSymbolSession.mockReset();
    getSymbolSession.mockResolvedValue({ status: "ok", data: usStock({ timezone: "Asia/Kolkata" }) });
    expect(displayTimeZone("Exchange", "UTC", "NSE:INFY")).toBe("UTC");
    await symbolSessions("NSE:INFY");
    expect(displayTimeZone("Exchange", "UTC", "NSE:INFY")).toBe("Asia/Kolkata");
  });
});
