import { describe, expect, it, vi } from "vitest";

// In-memory kv, seeded before the module reads it at import.
const store = vi.hoisted(() => {
  const m = new Map<string, string>();
  const old = Array.from({ length: 12 }, (_, i) => `NASDAQ:S${i}`);
  m.set("ot:recent-symbols", JSON.stringify([...old.slice(0, 3), 42, ...old.slice(3)]));
  m.set("ot:recent-symbols:search", "{not json");
  return m;
});
vi.mock("../kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  onExternalChange: () => () => undefined,
}));

import { recentSymbols, recordRecentSymbol } from "../recent-symbols";

describe("recent symbols", () => {
  it("loads the saved list: strings only, ten compared symbols at most", () => {
    const list = recentSymbols("compare");
    expect(list).toHaveLength(10);
    expect(list[0]).toBe("NASDAQ:S0");
    expect(list.every((s) => typeof s === "string")).toBe(true);
  });

  it("a malformed save reads as an empty list", () => {
    expect(recentSymbols("search")).toEqual([]);
  });

  it("moves a symbol to the top, upper-cased, once", () => {
    recordRecentSymbol("search", "nasdaq:aapl");
    recordRecentSymbol("search", "NYSE:IBM");
    recordRecentSymbol("search", "NASDAQ:AAPL");
    expect(recentSymbols("search")).toEqual(["NASDAQ:AAPL", "NYSE:IBM"]);
    expect(JSON.parse(store.get("ot:recent-symbols:search")!)).toEqual(["NASDAQ:AAPL", "NYSE:IBM"]);
  });

  it("caps each list (compare 10, search 50) and keeps the lists apart", () => {
    recordRecentSymbol("compare", "NYSE:NEW");
    const compare = recentSymbols("compare");
    expect(compare).toHaveLength(10);
    expect(compare[0]).toBe("NYSE:NEW");
    expect(compare).not.toContain("NASDAQ:S9");
    for (let i = 0; i < 60; i++) recordRecentSymbol("search", `X:T${i}`);
    expect(recentSymbols("search")).toHaveLength(50);
    expect(recentSymbols("search")[0]).toBe("X:T59");
    expect(recentSymbols("compare")).not.toContain("X:T59");
  });
});
