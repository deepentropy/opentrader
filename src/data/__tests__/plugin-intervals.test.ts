import { describe, expect, it, vi } from "vitest";
import type { Candle, SymbolSession } from "../../bindings";

// A data plugin's symbol (#318): its session reply carries the intervals the plugin serves.
const mocks = vi.hoisted(() => ({
  getSymbolSession: vi.fn(),
  getMinuteHistory: vi.fn(async () => ({ status: "ok", data: { bars: [] as Candle[], partial: false } })),
  getAggregatesBefore: vi.fn(async () => ({ status: "ok", data: [] as Candle[] })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../../bindings", () => ({ commands: { getSymbolSession: mocks.getSymbolSession, getMinuteHistory: mocks.getMinuteHistory, getAggregatesBefore: mocks.getAggregatesBefore } }));
vi.mock("../kv", () => ({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  onExternalChange: () => () => undefined,
}));

import { bucketLiveTick, getBars, getBarsBefore, symbolServesResolution, unsupportedIntervalMessage } from "../datafeed";
import type { ChartAggregate } from "../datafeed-live";
import { symbolSessions } from "../session";

function session(intervals: string[], timezone = "Etc/UTC", hours = "24x7"): SymbolSession {
  return {
    timezone,
    session: hours,
    subsessions: [{ id: "regular", description: "Regular Trading Hours", session: hours, corrections: "" }],
    holidays: "",
    corrections: "",
    pricescale: 100000,
    minmov: 1,
    variableTickSize: "",
    intervals,
  };
}

const PLUGIN = "TESTX:EURUSD";
const OWN = "NASDAQ:AAPL";
// Sessions that open at 09:30 New York (#332): one plugin serves hours only, the other minutes too.
const HOURLY = "TESTX:HOURLY";
const FINE = "TESTX:FINE";
mocks.getSymbolSession.mockImplementation(async (symbol: string) => ({
  status: "ok",
  data:
    symbol === HOURLY || symbol === FINE
      ? session(symbol === HOURLY ? ["60", "1D"] : ["1", "60", "1D"], "America/New_York", "0930-1600")
      : session(symbol === PLUGIN ? ["2", "15", "1D"] : symbol === "TESTX:MINUTES" ? ["5"] : []),
}));

describe("a data plugin's symbol: the intervals it serves or the app builds from them", () => {
  it("keeps every interval until the symbol's session is known", () => {
    expect(symbolServesResolution("TESTX:LATER", "1S")).toBe(true);
  });

  it("serves the plugin's sizes, the minute sizes built from them, and days, weeks, months from its days", async () => {
    await symbolSessions(PLUGIN);
    expect(["2", "4", "15", "30", "60", "240", "1D", "1W", "1M"].filter((id) => !symbolServesResolution(PLUGIN, id))).toEqual([]);
    expect(["1", "5", "1S", "5S"].filter((id) => symbolServesResolution(PLUGIN, id))).toEqual([]);
  });

  it("leaves the provider's symbols to the provider's intervals", async () => {
    await symbolSessions(OWN);
    expect(["1S", "1", "5", "1D"].every((id) => symbolServesResolution(OWN, id))).toBe(true);
  });

  it("says which intervals are not supported: those under the finest served one", async () => {
    await symbolSessions("TESTX:MINUTES");
    expect(unsupportedIntervalMessage(PLUGIN)).toBe("Intervals less than 2 are not supported for this symbol. Please change the interval to any available one.");
    expect(unsupportedIntervalMessage("TESTX:MINUTES")).toMatch(/^Intervals less than 5 /);
    expect(symbolServesResolution("TESTX:MINUTES", "1D")).toBe(false);
    expect(unsupportedIntervalMessage("ECONOMICS:UNRATE")).toMatch(/^Intervals less than D /);
  });

  it("asks the plugin a size it serves, and asks nothing on an interval it can't build", async () => {
    mocks.getMinuteHistory.mockClear();
    await getBars(PLUGIN, "4");
    await getBars(PLUGIN, "30");
    expect(mocks.getMinuteHistory.mock.calls.map((c) => (c as unknown[])[2])).toEqual([2, 15]);
    mocks.getMinuteHistory.mockClear();
    expect(await getBars(PLUGIN, "5")).toEqual({ bars: [], daily: null, aggregate: null });
    expect(await getBarsBefore(PLUGIN, "5", 1_700_000_000)).toEqual([]);
    expect(mocks.getMinuteHistory).not.toHaveBeenCalled();
  });

  it("takes no live bar on an interval the plugin can't build", async () => {
    await symbolSessions("TESTX:MINUTES");
    const tick = { symbol: "TESTX:MINUTES", time: 1_700_000_100, open: 1, high: 1, low: 1, close: 1, volume: 1 } as ChartAggregate;
    expect(bucketLiveTick("7", tick)).toBeNull();
    expect(bucketLiveTick("10", tick)?.time).toBe(1_699_999_800);
  });
});

describe("a data plugin whose bar sizes don't fit its session open (#332)", () => {
  // Wednesday 11/11/2026 09:00 New York, and the plugin's hour bars from 08:00 to 16:00 (on the clock).
  const NINE = 1_794_405_600;
  const hour = (h: number) => NINE + (h - 9) * 3600;
  const bar = (h: number) => ({ time: hour(h), open: h, high: h + 0.5, low: h - 0.5, close: h + 0.25, volume: 10 });
  const at = (h: number, m = 0) => hour(h) + m * 60;
  const reply = { status: "ok", data: { bars: [8, 9, 10, 11, 12, 13, 14, 15, 16].map(bar), partial: false } };

  it("serves the hour and the sizes built from it, not those under it", async () => {
    await symbolSessions(HOURLY);
    expect(["60", "120", "240", "1D"].filter((id) => !symbolServesResolution(HOURLY, id))).toEqual([]);
    expect(["30", "45", "90"].filter((id) => symbolServesResolution(HOURLY, id))).toEqual([]);
  });

  it("shows the plugin's own hour bars, the one the open falls in stamped at the open", async () => {
    mocks.getMinuteHistory.mockClear();
    mocks.getMinuteHistory.mockResolvedValueOnce(reply);
    const { bars } = await getBars(HOURLY, "60", "RTH");
    expect(mocks.getMinuteHistory.mock.calls.map((c) => (c as unknown[])[2])).toEqual([60]);
    expect(bars.map((b) => b.time)).toEqual([at(9, 30), at(10), at(11), at(12), at(13), at(14), at(15)]);
    expect(bars[0]).toMatchObject({ open: 9, close: 9.25 });
  });

  it("builds 2 and 4 hours from those bars, on their grid", async () => {
    mocks.getMinuteHistory.mockResolvedValueOnce(reply);
    const two = (await getBars(HOURLY, "120", "RTH")).bars;
    expect(two.map((b) => b.time)).toEqual([at(9, 30), at(11), at(13), at(15)]);
    expect(two[0]).toMatchObject({ open: 9, high: 10.5, low: 8.5, close: 10.25, volume: 20 });
    mocks.getAggregatesBefore.mockResolvedValueOnce({ status: "ok", data: reply.data.bars });
    expect((await getBarsBefore(HOURLY, "240", at(16), "RTH")).map((b) => b.time)).toEqual([at(9, 30), at(13)]);
    expect(mocks.getAggregatesBefore.mock.calls.map((c) => (c as unknown[])[2])).toEqual([60]);
  });

  it("puts live minutes in the same bars", async () => {
    const tick = (h: number, m: number) => ({ symbol: HOURLY, time: at(h, m), open: 1, high: 1, low: 1, close: 1, volume: 1 }) as ChartAggregate;
    expect(bucketLiveTick("60", tick(9, 45), "RTH")?.time).toBe(at(9, 30));
    expect(bucketLiveTick("60", tick(10, 15), "RTH")?.time).toBe(at(10));
    expect(bucketLiveTick("120", tick(12, 59), "RTH")?.time).toBe(at(11));
    expect(bucketLiveTick("60", tick(9, 15), "RTH")).toBeNull();
  });

  it("still builds hours from the open when the plugin serves a size that fits it", async () => {
    await symbolSessions(FINE);
    mocks.getMinuteHistory.mockClear();
    const minutes = Array.from({ length: 120 }, (_, i) => ({ time: at(9, 30) + i * 60, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    mocks.getMinuteHistory.mockResolvedValueOnce({ status: "ok", data: { bars: minutes, partial: false } });
    const { bars } = await getBars(FINE, "60", "RTH");
    expect(mocks.getMinuteHistory.mock.calls.map((c) => (c as unknown[])[2])).toEqual([1]);
    expect(bars.map((b) => b.time)).toEqual([at(9, 30), at(10, 30)]);
  });
});
