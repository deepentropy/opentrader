import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>(), subs: new Map<string, () => void>() }));
vi.mock("../kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  onExternalChange: (k: string, cb: () => void) => {
    kv.subs.set(k, cb);
    return () => kv.subs.delete(k);
  },
}));

import { FLAG_COLORS, allFlags, clearAllFlags, flagOf, lastFlagColor, needsMigration, seedFlags, setFlag } from "../symbol-flags";

const saved = () => JSON.parse(kv.store.get("ot:symbol-flags") ?? "null");

describe("symbol flags", () => {
  it("has seven colours, red first; red is the first 'last colour'", () => {
    expect(FLAG_COLORS).toEqual(["red", "blue", "green", "orange", "purple", "cyan", "pink"]);
    expect(lastFlagColor()).toBe("red");
  });

  it("needs the one-time migration when nothing was saved", () => {
    expect(needsMigration()).toBe(true);
  });

  it("seeds from the watchlist rows, first colour wins", () => {
    seedFlags([
      ["NASDAQ:AAPL", "blue"],
      ["NASDAQ:AAPL", "red"],
      ["NYSE:IBM", "green"],
    ]);
    expect(flagOf("NASDAQ:AAPL")).toBe("blue");
    expect(flagOf("NYSE:IBM")).toBe("green");
    expect(flagOf("NASDAQ:MSFT")).toBeNull();
    expect(saved()).toEqual({ "NASDAQ:AAPL": "blue", "NYSE:IBM": "green" });
  });

  it("flags and unflags a symbol; a colour becomes the last used", () => {
    setFlag("NASDAQ:MSFT", "purple");
    expect(flagOf("NASDAQ:MSFT")).toBe("purple");
    expect(lastFlagColor()).toBe("purple");
    expect(kv.store.get("ot:symbol-flag-last-color")).toBe("purple");
    setFlag("NASDAQ:MSFT", null);
    expect(flagOf("NASDAQ:MSFT")).toBeNull();
    expect(lastFlagColor()).toBe("purple");
    expect(saved()).not.toHaveProperty("NASDAQ:MSFT");
  });

  it("re-reads the store on an external change, dropping unknown colours", () => {
    kv.store.set("ot:symbol-flags", JSON.stringify({ "NYSE:T": "cyan", "NYSE:X": "magenta", "NYSE:Y": 3 }));
    kv.subs.get("ot:symbol-flags")!();
    expect({ ...allFlags() }).toEqual({ "NYSE:T": "cyan" });
    kv.store.set("ot:symbol-flags", "not json");
    kv.subs.get("ot:symbol-flags")!();
    expect({ ...allFlags() }).toEqual({});
  });

  it("clears every flag", () => {
    setFlag("A:B", "red");
    setFlag("C:D", "pink");
    clearAllFlags();
    expect({ ...allFlags() }).toEqual({});
    expect(saved()).toEqual({});
  });
});
