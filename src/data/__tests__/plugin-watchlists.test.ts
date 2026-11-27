import { describe, expect, it, vi } from "vitest";
import type { PluginWatchlist } from "../../bindings";

vi.mock("../kv", () => ({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  onExternalChange: () => () => undefined,
}));
vi.mock("../datafeed", () => ({
  isFullSymbol: (s: string) => s.includes(":"),
  tickerOf: (s: string) => s.slice(s.indexOf(":") + 1),
  toFullSymbol: (s: string) => Promise.resolve(`NSE:${s}`),
}));
vi.mock("../../bindings", () => ({ commands: {}, events: {} }));

import { isLockedList, listItems, watchlistStore as wl } from "../watchlist-store";
import { openPluginList, syncPluginLists } from "../plugin-watchlists";

const nifty = (symbols: string[], banks: string[]): PluginWatchlist => ({
  id: "nifty",
  name: "NIFTY 50",
  symbols,
  sections: [{ name: "BANKS", symbols: banks }],
});

describe("data plugins' watchlists (#381)", () => {
  it("opens a plugin's list as a read-only list", () => {
    openPluginList("algo", nifty(["NSE:RELIANCE"], ["NSE:HDFCBANK"]));
    const l = wl.active()!;
    expect(l.name).toBe("NIFTY 50");
    expect(l.source).toEqual({ plugin: "algo", list: "nifty" });
    expect(listItems(l)).toEqual(["NSE:RELIANCE", "###BANKS", "NSE:HDFCBANK"]);
    expect(isLockedList(l.id)).toBe(true);

    // No change by hand: add, remove, clear, rename, sections, moves.
    wl.addSymbols([{ ticker: "NSE:TCS", short: "TCS", last: "", changePercent: "", prePostChange: "" }], null);
    wl.removeSymbol("NSE:RELIANCE");
    wl.removeItems(["NSE:HDFCBANK"]);
    wl.clearActive();
    wl.renameActive("Mine");
    wl.renameList(l.id, "Mine");
    wl.addSection(null);
    wl.renameSection("BANKS", "LENDERS");
    wl.moveItems(["NSE:RELIANCE"], "NSE:HDFCBANK", true, new Set());
    expect(wl.addRowTo(l.id, { ticker: "NSE:TCS", short: "TCS", last: "", changePercent: "", prePostChange: "" })).toBe(false);
    wl.removeRowFrom(l.id, "NSE:RELIANCE");
    expect(wl.active()!.name).toBe("NIFTY 50");
    expect(listItems(wl.active()!)).toEqual(["NSE:RELIANCE", "###BANKS", "NSE:HDFCBANK"]);
    // Nothing removed reached "Deleted symbols".
    expect(wl.lists().some((x) => x.id === "deleted_symbols")).toBe(false);

    // Opening it again goes to the same list.
    const before = wl.lists().length;
    openPluginList("algo", nifty(["NSE:RELIANCE"], ["NSE:HDFCBANK"]));
    expect(wl.lists().length).toBe(before);
    expect(wl.activeId()).toBe(l.id);
  });

  it("follows what the plugin sends, and drops a list it no longer sends", () => {
    const id = wl.pluginList({ plugin: "algo", list: "nifty" })!.id;
    syncPluginLists([{ plugin: "algo", pluginName: "Algo", lists: [nifty(["NSE:TCS"], ["NSE:SBIN", "NSE:HDFCBANK"])] }]);
    expect(listItems(wl.lists().find((x) => x.id === id)!)).toEqual(["NSE:TCS", "###BANKS", "NSE:SBIN", "NSE:HDFCBANK"]);

    // Another plugin's lists, or none from a plugin turned off: untouched.
    syncPluginLists([{ plugin: "other", pluginName: "Other", lists: [] }]);
    syncPluginLists([]);
    expect(wl.lists().some((x) => x.id === id)).toBe(true);

    // A set without it (#423: a plugin waiting for its login sends none): kept as it was, with the user's favourite,
    // marked, and brought up to date in place when sent again.
    wl.toggleFavorite(id);
    syncPluginLists([{ plugin: "algo", pluginName: "Algo", lists: [] }]);
    let l = wl.lists().find((x) => x.id === id)!;
    expect(l.unsent).toBe(true);
    expect(l.favorite).toBe(true);
    expect(listItems(l)).toEqual(["NSE:TCS", "###BANKS", "NSE:SBIN", "NSE:HDFCBANK"]);
    syncPluginLists([{ plugin: "algo", pluginName: "Algo", lists: [nifty(["NSE:TCS"], ["NSE:SBIN", "NSE:HDFCBANK"])] }]);
    l = wl.lists().find((x) => x.id === id)!;
    expect(l.unsent).toBeUndefined();
    expect(l.favorite).toBe(true);

    // The plugin removed: its lists go.
    wl.deletePluginLists("algo");
    expect(wl.lists().some((x) => x.id === id)).toBe(false);
  });

  it("a copy is the user's own list", () => {
    openPluginList("algo", nifty(["NSE:RELIANCE"], []));
    const copy = wl.copyActive("NIFTY mine");
    expect(wl.lists().find((x) => x.id === copy)!.source).toBeUndefined();
    expect(isLockedList(copy)).toBe(false);
    wl.removeSymbol("NSE:RELIANCE");
    expect(listItems(wl.active()!)).toEqual(["###BANKS"]);
  });
});
