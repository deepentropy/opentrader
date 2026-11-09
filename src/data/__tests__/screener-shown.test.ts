import { describe, expect, it, vi } from "vitest";

// A user of an earlier version: the ETF Screener left for the Script Screener.
const store = vi.hoisted(() => new Map<string, string>([["ot:screener:type:v1", "etf"], ["ot:screener:kind:v1", "script"]]));
vi.mock("../kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  onExternalChange: () => () => undefined,
}));

import { screenerStore } from "../screener-store";

describe("the screener shown", () => {
  it("is one setting, taken over from the two old keys once", () => {
    expect(store.get("ot:screener:shown:v1")).toBe("script");
    expect(store.has("ot:screener:type:v1")).toBe(false);
    expect(store.has("ot:screener:kind:v1")).toBe(false);
    expect(screenerStore.kind()).toBe("script");
  });

  it("goes back to the Stock or ETF screener the Script Screener was opened from", () => {
    // The setting holds only the screener shown: after a restart on the Script Screener, back to Stock.
    screenerStore.setKind("stock");
    expect(store.get("ot:screener:shown:v1")).toBe("stock");
    screenerStore.setType("etf");
    expect(store.get("ot:screener:shown:v1")).toBe("etf");
    screenerStore.setKind("script");
    expect(store.get("ot:screener:shown:v1")).toBe("script");
    expect(screenerStore.type()).toBe("etf");
    screenerStore.setKind("stock");
    expect(store.get("ot:screener:shown:v1")).toBe("etf");
  });
});
