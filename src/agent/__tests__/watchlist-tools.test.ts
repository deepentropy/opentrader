import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../data/kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../../data/datafeed", () => ({
  isFullSymbol: (s: string) => s.includes(":"),
  tickerOf: (s: string) => s.slice(s.indexOf(":") + 1),
  toFullSymbol: (s: string) => Promise.resolve(`NASDAQ:${s}`),
  // ZZZZ is not a symbol.
  resolveSymbol: (s: string) => (s.endsWith("ZZZZ") ? Promise.reject(new Error("unknown")) : Promise.resolve({ fullName: s.includes(":") ? s : `NASDAQ:${s}` })),
}));
const rail = vi.hoisted(() => ({ tab: "" }));
vi.mock("../../window/shell/app-dialogs", () => ({ setActiveRailTab: (t: string) => (rail.tab = t) }));

import { createWatchlistTools } from "../watchlist-tools";
import { watchlistStore } from "../../data/watchlist-store";
import { flagOf } from "../../data/symbol-flags";

const tools = createWatchlistTools();
const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args) as Promise<Record<string, unknown>>;

describe("watchlist tools", () => {
  it("creates a list with sections and shows it; unknown symbols are reported", async () => {
    const r = await run("create_watchlist", { name: "Semis", symbols: ["NVDA"], sections: [{ name: "memory", symbols: ["MU", "ZZZZ"] }] });
    expect(r).toMatchObject({ name: "Semis", symbols: ["NASDAQ:NVDA"], sections: [{ name: "MEMORY", symbols: ["NASDAQ:MU"] }], unknownSymbols: ["ZZZZ"] });
    expect(watchlistStore.active()?.name).toBe("Semis");
    expect(rail.tab).toBe("base");
  });

  it("adds to the end of a section, making it when missing, and skips what is there", async () => {
    await run("add_to_watchlist", { name: "semis", symbols: ["AMD", "NVDA"], section: "logic" });
    const r = await run("add_to_watchlist", { symbols: ["INTC"], section: "LOGIC" });
    expect(r.added).toEqual(["NASDAQ:INTC"]);
    const w = await run("get_watchlist", { name: "Semis" });
    expect(w.symbols).toEqual(["NASDAQ:NVDA"]);
    expect(w.sections).toEqual([
      { name: "MEMORY", symbols: ["NASDAQ:MU"] },
      { name: "LOGIC", symbols: ["NASDAQ:AMD", "NASDAQ:INTC"] },
    ]);
  });

  it("removes by ticker or full name, renames, flags", async () => {
    const r = await run("remove_from_watchlist", { name: "Semis", symbols: ["mu", "NASDAQ:AMD", "TSLA"] });
    expect(r).toMatchObject({ removed: ["NASDAQ:MU", "NASDAQ:AMD"], notInList: ["TSLA"] });
    await run("rename_watchlist", { name: "Semis", newName: "Chips" });
    expect(watchlistStore.lists().some((l) => l.name === "Chips")).toBe(true);
    await run("flag_symbols", { symbols: ["NVDA"], color: "red" });
    expect(flagOf("NASDAQ:NVDA")).toBe("red");
    await expect(run("flag_symbols", { symbols: ["NVDA"], color: "gold" })).rejects.toThrow(/color/);
  });

  it("deletes a list but not a colour list", async () => {
    await expect(run("delete_watchlist", { name: "Red list" })).rejects.toThrow(/cannot be deleted/);
    expect(await run("delete_watchlist", { name: "Chips" })).toEqual({ deleted: "Chips" });
    await expect(run("get_watchlist", { name: "Chips" })).rejects.toThrow(/No watchlist named/);
  });
});
