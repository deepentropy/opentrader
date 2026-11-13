import { describe, expect, it, vi } from "vitest";
import type { SymbolSession } from "../../bindings";

// A data plugin's symbol (#318): its session reply carries the intervals the plugin serves.
const mocks = vi.hoisted(() => ({
  getSymbolSession: vi.fn(),
  getMinuteHistory: vi.fn(async () => ({ status: "ok", data: { bars: [], partial: false } })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../../bindings", () => ({ commands: { getSymbolSession: mocks.getSymbolSession, getMinuteHistory: mocks.getMinuteHistory } }));
vi.mock("../kv", () => ({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  onExternalChange: () => () => undefined,
}));

import { bucketLiveTick, getBars, getBarsBefore, symbolServesResolution, unsupportedIntervalMessage } from "../datafeed";
import type { ChartAggregate } from "../datafeed-live";
import { symbolSessions } from "../session";

function session(intervals: string[]): SymbolSession {
  return {
    timezone: "Etc/UTC",
    session: "24x7",
    subsessions: [{ id: "regular", description: "Regular Trading Hours", session: "24x7", corrections: "" }],
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
mocks.getSymbolSession.mockImplementation(async (symbol: string) => ({
  status: "ok",
  data: session(symbol === PLUGIN ? ["2", "15", "1D"] : symbol === "TESTX:MINUTES" ? ["5"] : []),
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
