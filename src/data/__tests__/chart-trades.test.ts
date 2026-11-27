import { describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../bindings";

// A subscriber's trades made into the forming bar of each interval.
const mocks = vi.hoisted(() => ({ getSymbolSession: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../../bindings", () => ({ commands: { getSymbolSession: mocks.getSymbolSession } }));
vi.mock("../kv", () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined, onExternalChange: () => () => undefined }));

import { bucketPluginTrade, bucketTrade } from "../datafeed";
import type { ChartTrade, PluginTrade } from "../datafeed-live";
import { symbolSessions } from "../session";

const US: SymbolSession = {
  barOrigin: null,
  timezone: "America/New_York",
  session: "0930-1600",
  subsessions: [
    { id: "regular", description: "Regular", session: "0930-1600", corrections: "" },
    { id: "extended", description: "Extended", session: "0400-2000", corrections: "" },
  ],
  holidays: "",
  corrections: "",
  pricescale: 100,
  minmov: 1,
  variableTickSize: "",
  intervals: [],
};
// A data plugin's symbol that serves 5-second and 1-minute bars.
const PLUGIN = "NFO:NIFTY1!";
mocks.getSymbolSession.mockImplementation(async (symbol: string) => ({ status: "ok", data: symbol === PLUGIN ? { ...US, intervals: ["5S", "1"] } : US }));

const SYM = "NASDAQ:AAPL";
// Wed 25/11/2026, New York = UTC-5.
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 25, h, m, s) / 1000;
const trade = (time: number, regular: boolean): ChartTrade => ({ symbol: SYM, time, price: 11, high: 12, low: 10, volume: 300, regular });

describe("bucketTrade", () => {
  it("gives no bar until the symbol's sessions are known", () => {
    expect(bucketTrade("1", trade(at(15, 0), true))).toBeNull();
  });

  it("adds its volume to the minute bars", async () => {
    await symbolSessions(SYM);
    expect(bucketTrade("5", trade(at(15, 3, 7), true))).toEqual({ time: at(15, 0), open: 11, high: 12, low: 10, close: 11, volume: 300, volumeIsIncrement: true });
    expect(bucketTrade("1", trade(at(15, 3, 59), true))?.time).toBe(at(15, 3));
  });

  it("leaves pre- and post-market out of a regular-session chart and of daily bars", async () => {
    await symbolSessions(SYM);
    const pre = trade(at(13, 0), false);
    expect(bucketTrade("5", pre, "RTH")).toBeNull();
    expect(bucketTrade("5", pre, "ETH")?.time).toBe(at(13, 0));
    for (const tf of ["1D", "1W", "1M"]) expect(bucketTrade(tf, pre, "ETH")).toBeNull();
  });

  it("moves the daily, weekly and monthly bars' price, not their volume", async () => {
    await symbolSessions(SYM);
    const t = trade(at(15, 0), true);
    const midnight = Date.UTC(2026, 10, 25, 5) / 1000;
    expect(bucketTrade("1D", t)).toMatchObject({ time: midnight, close: 11, high: 12, volume: 0, volumeIsIncrement: true, dayTime: midnight });
    expect(bucketTrade("1W", t)).toMatchObject({ dayTime: midnight, volume: 0 });
  });

  it("leaves the seconds charts to the one-second bars", async () => {
    await symbolSessions(SYM);
    expect(bucketTrade("5S", trade(at(15, 0), true))).toBeNull();
  });
});

describe("bucketPluginTrade", () => {
  const quote = (time: number): PluginTrade => ({ symbol: PLUGIN, time, price: 11, volume: 40 });

  it("puts a plugin's quote into the forming seconds bar, adding its volume (#421)", async () => {
    await symbolSessions(PLUGIN);
    expect(bucketPluginTrade("5S", quote(at(15, 0, 7)))).toEqual({ time: at(15, 0, 5), open: 11, high: 11, low: 11, close: 11, volume: 40, volumeIsIncrement: true });
    expect(bucketPluginTrade("15S", quote(at(15, 0, 29)))?.time).toBe(at(15, 0, 15));
  });

  it("leaves the minute and daily bars to the plugin's bars, and an interval it can't build", async () => {
    await symbolSessions(PLUGIN);
    for (const tf of ["1", "5", "1D"]) expect(bucketPluginTrade(tf, quote(at(15, 0)))).toBeNull();
    expect(bucketPluginTrade("1S", quote(at(15, 0)))).toBeNull();
  });

  it("leaves pre- and post-market out of a regular-session chart", async () => {
    await symbolSessions(PLUGIN);
    expect(bucketPluginTrade("5S", quote(at(13, 0)), "RTH")).toBeNull();
    expect(bucketPluginTrade("5S", quote(at(13, 0)), "ETH")?.time).toBe(at(13, 0));
  });
});
