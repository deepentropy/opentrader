import { describe, expect, it, vi } from "vitest";

vi.mock("../datafeed", () => ({ setWatchlistSubscription: () => Promise.resolve() }));

import { liveSymbols, WEB_LIVE_SYMBOLS } from "../subscriptions";

const syms = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `NASDAQ:${prefix}${i}`);

describe("liveSymbols: the set streamed, cut to the web server's limit (#358)", () => {
  it("every contributor's symbols once, upper-cased, sorted", () => {
    const sets = new Map([
      ["watchlist", ["nasdaq:aapl", "NYSE:F"]],
      ["alerts", ["NASDAQ:AAPL"]],
    ]);
    expect(liveSymbols(sets, Infinity)).toEqual(["NASDAQ:AAPL", "NYSE:F"]);
  });

  it("a long list keeps the alerts and the rows on screen, then the list in its order", () => {
    const list = syms(1000, "L");
    const sets = new Map([
      ["watchlist", list],
      ["list-alerts", syms(50, "A")],
      ["watchlist-shown", list.slice(800, 830)],
      ["alerts", ["NYSE:ALERT"]],
      ["details", ["NYSE:DETAIL"]],
    ]);
    const out = liveSymbols(sets, WEB_LIVE_SYMBOLS);
    expect(out).toHaveLength(WEB_LIVE_SYMBOLS);
    expect(out).toContain("NYSE:ALERT");
    expect(out).toContain("NYSE:DETAIL");
    for (const s of list.slice(800, 830)) expect(out).toContain(s);
    // Then the top of the list: 500 - 2 - 30 of its first rows.
    expect(out).toContain(list[0]);
    expect(out).toContain(list[WEB_LIVE_SYMBOLS - 33]);
    expect(out).not.toContain(list[WEB_LIVE_SYMBOLS - 32]);
    expect(out.some((s) => s.startsWith("NASDAQ:A"))).toBe(false);
  });

  it("under the limit nothing is left out", () => {
    const sets = new Map([
      ["watchlist", syms(300, "L")],
      ["list-alerts", syms(100, "A")],
    ]);
    expect(liveSymbols(sets, WEB_LIVE_SYMBOLS)).toHaveLength(400);
  });
});
