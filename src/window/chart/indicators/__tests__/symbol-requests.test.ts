import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ asked: [] as string[], stopped: 0, refused: new Set<string>() }));

vi.mock("../../../../data/datafeed", () => ({
  getBars: vi.fn(async (symbol: string) => {
    feed.asked.push(symbol);
    if (feed.refused.has(symbol)) throw new Error("no such symbol");
    return { bars: [100, 200].map((t) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })) };
  }),
  getBarsBefore: vi.fn(async () => []),
  getEvents: vi.fn(async () => []),
  isIntradayResolution: (r: string) => /^\d+$/.test(r),
  isSecondResolution: (r: string) => /S$/.test(r),
  isSupportedResolution: () => true,
  setLiveSymbol: vi.fn(async () => {}),
  subscribeBars: vi.fn(async () => () => {
    feed.stopped++;
  }),
}));
vi.mock("../script-chart", () => ({ scriptChartContext: () => ({}), symbolDetails: () => undefined }));
vi.mock("../../../../data/oakscript-store", () => ({
  loadScript: () => ({ id: "S1", name: "Test", source: "", meta: null }),
  saveCompiledMeta: () => undefined,
}));
// The engine runs a script reading `<tickerid>_OI`: an error when the symbol has no bars.
vi.mock("../../../oakscript/engine", () => {
  class OakEngineError extends Error {
    constructor(readonly detail: { message: string; missing?: { symbol: string; timeframe: string }[] }) {
      super(detail.message);
    }
  }
  return {
    OakEngineError,
    getOakEngine: () => ({
      generation: 1,
      compile: async () => ({ title: "Test", overlay: true, plotConfig: [] }),
      update: async (_run: string, _id: string, _bars: unknown, _inputs: unknown, chart: { tickerid: string }, symbols?: { bars: Record<string, unknown[]> }) => {
        const symbol = `${chart.tickerid}_OI`;
        const oi = symbols?.bars[`${symbol}|`];
        if (!oi) throw new OakEngineError({ message: "missing", missing: [{ symbol, timeframe: "" }] });
        if (!oi.length) throw new OakEngineError({ message: `No data for ${symbol}` });
        return { result: { plots: { p: oi.map(() => ({ time: 1, value: 1 })) } }, fullRunReason: null };
      },
    }),
  };
});
vi.mock("../../../../data/app-events", () => ({ emitAppEvent: () => undefined }));

import { OtherSymbolBars } from "../other-symbols";
import { callAnswered, enterScope, noRequests, readRequests } from "../symbol-requests";
import { getUserIndicatorEntry } from "../user-scripts";

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  feed.asked = [];
  feed.stopped = 0;
  feed.refused = new Set();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("other symbols a study asked for (#411)", () => {
  it("a script in error asks again on the next symbol, and on the one before when it comes back", async () => {
    feed.refused.add("NASDAQ:AAPL_OI");
    const store = new OtherSymbolBars(() => undefined, "t");
    const entry = getUserIndicatorEntry("user:S1")!;
    let used = new Set<string>();
    const run = async (tickerid: string) => {
      const bars = [{ time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
      let out: unknown;
      for (let i = 0; i < 6; i++) {
        const reads = new Set<string>();
        used = reads;
        const ctx = {
          chartId: "c",
          studyId: "s",
          tickerid,
          timeframe: "5",
          sessionType: "regular",
          bars: (s: string, tf: string) => {
            reads.add(store.key(s, tf, "5"));
            return store.bars(s, tf, "5");
          },
          symbolInfo: () => undefined,
        };
        try {
          out = (entry.calculate as unknown as (b: unknown, i: unknown, c: unknown) => unknown)(bars, {}, ctx);
        } catch (err) {
          out = (err as Error).message;
        }
        await settle();
        store.retain(reads);
      }
      return out;
    };

    expect(await run("NASDAQ:AAPL")).toBe("No data for NASDAQ:AAPL_OI");
    expect(await run("TESTX:FUT")).toMatchObject({ plots: { p: [{}, {}] } });
    expect([...used]).toEqual(["TESTX:FUT_OI|5"]);
    // Refused before: tried again, its data may be there now.
    feed.refused.clear();
    expect(await run("NASDAQ:AAPL")).toMatchObject({ plots: { p: [{}, {}] } });
    expect(feed.asked).toEqual(["NASDAQ:AAPL_OI", "TESTX:FUT_OI", "NASDAQ:AAPL_OI"]);
    store.dispose();
  });

  it("keeps a symbol no study reads for a while, then drops it", async () => {
    const store = new OtherSymbolBars(() => undefined, "t");
    store.bars("AMEX:SPY", "", "5");
    await settle();
    store.retain(new Set());
    vi.advanceTimersByTime(5_000);
    expect(store.bars("AMEX:SPY", "", "5")).toHaveLength(2);
    vi.advanceTimersByTime(20_000);
    expect(feed.stopped).toBe(0);
    store.retain(new Set());
    vi.advanceTimersByTime(20_000);
    expect(feed.stopped).toBe(1);
    expect(feed.asked).toEqual(["AMEX:SPY"]);
    store.dispose();
  });

  it("what a run of another scope reports late stays out of the new one", () => {
    const r = noRequests();
    enterScope(r, "a");
    const late = r.list;
    enterScope(r, "b");
    late.push({ symbol: "X", timeframe: "" });
    enterScope(r, "b");
    expect(r.list).toEqual([]);
  });

  it("asks for all the symbols before waiting for one", () => {
    const asked: string[] = [];
    const list = [
      { symbol: "A", timeframe: "" },
      { symbol: "B", timeframe: "" },
    ];
    const bars = (s: string) => {
      asked.push(s);
      return undefined;
    };
    expect(readRequests(list, bars, undefined)).toBeNull();
    expect(asked).toEqual(["A", "B"]);
  });

  it("a call answers when its data is there", () => {
    expect(callAnswered(() => undefined, [])).toBe(false);
    expect(callAnswered(() => [], [])).toBe(false);
    expect(callAnswered(() => [1], [])).toBe(true);
    expect(callAnswered(() => null, [])).toBe(true);
  });
});
