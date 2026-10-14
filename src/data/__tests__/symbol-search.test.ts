import { describe, expect, it, vi } from "vitest";
import type { SymbolSearchResult } from "../../bindings";

// The live provider adapter, without the module that asks the backend which one is active.
vi.mock("../providers", async () => {
  const m = await import("../providers/massive");
  return { searchResultToRow: m.searchResultToRow, typeFilters: () => m.typeFilters, defaultExchange: () => m.defaultExchange };
});

import { SYMBOLS, filterSymbols, liveResultsToRows } from "../symbol-search";

const res = (ticker: string, over: Partial<SymbolSearchResult> = {}): SymbolSearchResult => ({
  ticker,
  name: `${ticker} Inc.`,
  market: "stocks",
  locale: "us",
  primaryExchange: "XNAS",
  type: "CS",
  ...over,
});

describe("filterSymbols", () => {
  it("no query: recent rows first, then the catalogue order, no highlight", () => {
    const rows = filterSymbols("all", "");
    expect(rows).toHaveLength(SYMBOLS.length);
    const firstOther = rows.findIndex((r) => !r.recent);
    expect(rows.slice(0, firstOther).every((r) => r.recent)).toBe(true);
    expect(rows.slice(firstOther).some((r) => r.recent)).toBe(false);
    expect(rows.every((r) => r.titleHighlight === null && r.descriptionHighlight === null)).toBe(true);
  });

  it("filters by tab", () => {
    expect(filterSymbols("funds", "").every((r) => r.category === "funds")).toBe(true);
    expect(filterSymbols("stocks", "").length).toBeGreaterThan(0);
    expect(filterSymbols("options", "zzz")).toEqual([]);
  });

  it("matches ticker or description with highlight ranges, exact ticker first", () => {
    const rows = filterSymbols("all", "intc");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.ticker === "INTC")).toBe(true);
    expect(rows[0].titleHighlight).toEqual([0, 4]);
    const apple = filterSymbols("all", "apple")[0];
    expect(apple.ticker).toBe("AAPL");
    expect(apple.titleHighlight).toBeNull();
    expect(apple.descriptionHighlight).toEqual([0, 5]);
  });

  it("ranks exact, then ticker prefix, then ticker substring, then description", () => {
    const rows = filterSymbols("all", "a");
    const rank = (r: (typeof rows)[number]) => (r.ticker.toUpperCase() === "A" ? 0 : r.titleHighlight?.[0] === 0 ? 1 : r.titleHighlight ? 2 : 3);
    const ranks = rows.map(rank);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });
});

describe("liveResultsToRows", () => {
  it("ranks by match quality then listing quality, stable within a rank", () => {
    const rows = liveResultsToRows(
      [
        res("AAPLX", { primaryExchange: "OTCM" }),
        res("XAAPL"),
        res("AAPL", { primaryExchange: "OTCM" }),
        res("AAPLE", { type: "ETF", primaryExchange: "ARCX" }),
        res("AAPLW"),
        res("ZZZ", { name: "Fund of AAPL" }),
        res("AAPL"),
      ],
      "all",
      "aapl",
    );
    expect(rows.map((r) => r.symbolName)).toEqual(["NASDAQ:AAPL", "OTC:AAPL", "NASDAQ:AAPLW", "AMEX:AAPLE", "OTC:AAPLX", "NASDAQ:XAAPL", "NASDAQ:ZZZ"]);
    expect(rows[0].titleHighlight).toEqual([0, 4]);
    expect(rows[5].titleHighlight).toEqual([1, 5]);
    expect(rows[6].titleHighlight).toBeNull();
    expect(rows[6].descriptionHighlight).toEqual([8, 12]);
  });

  it("filters by tab and caps the list at 50", () => {
    const many = Array.from({ length: 80 }, (_, i) => res(`A${i}`));
    expect(liveResultsToRows(many, "all", "a")).toHaveLength(50);
    expect(liveResultsToRows([res("SPY", { type: "ETF" }), res("SPYG")], "funds", "spy").map((r) => r.ticker)).toEqual(["SPY"]);
    expect(liveResultsToRows([], "all", "x")).toEqual([]);
  });
});
