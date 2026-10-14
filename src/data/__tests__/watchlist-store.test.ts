import { describe, expect, it, vi } from "vitest";
import type { Row } from "../watchlist";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../datafeed", () => ({
  isFullSymbol: (s: string) => s.includes(":"),
  tickerOf: (s: string) => s.slice(s.indexOf(":") + 1),
  toFullSymbol: (s: string) => Promise.resolve(`NASDAQ:${s}`),
}));

import {
  DELETED_LIST_ID,
  canMoveItems,
  colorListId,
  isDeletedList,
  isSectionId,
  listItems,
  sectionId,
  sectionNameOf,
  shownItems,
  watchlistStore as wl,
} from "../watchlist-store";
import { flagOf } from "../symbol-flags";

const row = (ticker: string): Row => ({ ticker, short: ticker.slice(ticker.indexOf(":") + 1), last: "—", changePercent: "", prePostChange: "" });
const items = () => listItems(wl.active()!);
/** A fresh active list holding `spec`: tickers, and "#NAME" for a section header. */
function fresh(spec: string[]): string {
  const groups: { name: string; rows: Row[] }[] = [];
  const extras: Row[] = [];
  for (const s of spec) {
    if (s.startsWith("#")) groups.push({ name: s.slice(1), rows: [] });
    else (groups.length ? groups[groups.length - 1].rows : extras).push(row(s));
  }
  if (groups.length) return wl.importList("Test", groups, extras);
  // A list with no section (an import would put the rows under "IMPORTED").
  const id = wl.createList("Test");
  wl.addSymbols(extras, null);
  return id;
}
const S = sectionId;

describe("item ids", () => {
  it("section ids carry a ### prefix", () => {
    expect(sectionId("TECH")).toBe("###TECH");
    expect(isSectionId("###TECH")).toBe(true);
    expect(isSectionId("NASDAQ:AAPL")).toBe(false);
    expect(sectionNameOf("###TECH")).toBe("TECH");
    expect(isDeletedList(DELETED_LIST_ID)).toBe(true);
    expect(isDeletedList(undefined)).toBe(false);
    expect(colorListId("red")).toBe("color-red");
  });

  it("listItems / shownItems: ungrouped rows first, then each header and its rows", () => {
    const l = { extras: [row("A")], groups: [{ name: "S1", rows: [row("B"), row("C")] }, { name: "S2", rows: [row("D")] }] };
    expect(listItems(l)).toEqual(["A", S("S1"), "B", "C", S("S2"), "D"]);
    expect(shownItems(l, new Set(["S1"]))).toEqual(["A", S("S1"), S("S2"), "D"]);
    expect(shownItems({ extras: [], groups: [] }, new Set())).toEqual([]);
  });
});

describe("canMoveItems", () => {
  const collapsed = new Set(["S2"]);
  // S2 is collapsed (its rows hidden); S3 is expanded and empty.
  const shown = ["A", S("S1"), "B", "C", S("S2"), S("S3")];

  it("symbols and expanded sections go anywhere", () => {
    expect(canMoveItems(shown, collapsed, ["B"], "A", false)).toBe(true);
    expect(canMoveItems(shown, collapsed, [S("S1")], "C", true)).toBe(true);
  });

  it("a collapsed section lands only on a section boundary", () => {
    expect(canMoveItems(shown, collapsed, [S("S2")], S("S1"), false)).toBe(true);
    expect(canMoveItems(shown, collapsed, [S("S2")], "A", true)).toBe(true); // A is followed by a header
    expect(canMoveItems(shown, collapsed, [S("S2")], "C", true)).toBe(true);
    expect(canMoveItems(shown, collapsed, [S("S2")], "B", false)).toBe(false);
    expect(canMoveItems(shown, collapsed, [S("S2")], "B", true)).toBe(false);
    expect(canMoveItems(shown, collapsed, [S("S2")], S("S3"), true)).toBe(true); // the last item
  });

  it("a collapsed section does not travel with symbols or a section holding rows", () => {
    expect(canMoveItems(shown, collapsed, [S("S2"), "B"], S("S1"), false)).toBe(false);
    expect(canMoveItems(shown, collapsed, [S("S2"), S("S1")], "A", false)).toBe(false);
    expect(canMoveItems(shown, collapsed, [S("S2"), S("S3")], S("S1"), false)).toBe(true); // S3 is empty
  });
});

describe("watchlistStore: lists", () => {
  it("seeds the default list with its sections, and every colour list", () => {
    const seed = wl.lists().find((l) => l.id === "watchlist")!;
    expect(seed.name).toBe("Watchlist");
    expect(seed.groups.map((g) => g.name)).toEqual(["INDEX", "LARGE CAPS"]);
    expect(seed.groups[0].rows.map((r) => r.ticker)).toEqual(["AMEX:SPY", "NASDAQ:QQQ", "AMEX:DIA", "AMEX:IWM"]);
    expect(wl.lists().filter((l) => l.id.startsWith("color-")).map((l) => l.name)).toEqual([
      "Red list",
      "Blue list",
      "Green list",
      "Orange list",
      "Purple list",
      "Cyan list",
      "Pink list",
    ]);
    // Empty colour lists are hidden, except the Red list.
    const shown = wl.shownLists().map((l) => l.id);
    expect(shown).toContain("color-red");
    expect(shown).not.toContain("color-blue");
  });

  it("names new lists uniquely and switches to them", () => {
    const a = wl.createList("Tech");
    const b = wl.createList("Tech");
    expect(a).toBe("tech");
    expect(b).toBe("tech-2");
    expect(wl.lists().find((l) => l.id === b)!.name).toBe("Tech 2");
    expect(wl.activeId()).toBe(b);
    expect(wl.createList("  !!  ")).toBe("list");
  });

  it("copies the active list or any list", () => {
    fresh(["A", "#S1", "B"]);
    wl.setSectionsCollapsed(["S1"], true);
    const copy = wl.copyActive();
    expect(wl.activeId()).toBe(copy);
    expect(wl.active()!.name).toMatch(/^Test.* copy$/);
    expect(items()).toEqual(["A", S("S1"), "B"]);
    expect(wl.active()!.collapsed).toEqual(["S1"]);
    const other = wl.copyList("watchlist", "Mine")!;
    expect(wl.activeId()).toBe(copy);
    expect(wl.lists().find((l) => l.id === other)!.groups).toHaveLength(2);
    expect(wl.copyList("nope")).toBeUndefined();
  });

  it("deletes lists, except colour lists and Deleted symbols; the first list takes over", () => {
    const id = wl.createList("Doomed");
    wl.setAlert(id, 5);
    wl.deleteList(id);
    expect(wl.lists().some((l) => l.id === id)).toBe(false);
    expect(wl.activeId()).toBe(wl.lists()[0].id);
    expect(wl.alertFor(id)).toBeUndefined();
    wl.deleteList("color-red");
    expect(wl.lists().some((l) => l.id === "color-red")).toBe(true);
  });

  it("renames (trimmed, empty ignored) and toggles favourites", () => {
    const id = wl.createList("Old");
    wl.renameList(id, "  New  ");
    expect(wl.active()!.name).toBe("New");
    wl.renameList(id, "   ");
    expect(wl.active()!.name).toBe("New");
    wl.renameActive("Newer");
    expect(wl.active()!.name).toBe("Newer");
    wl.toggleFavorite(id);
    expect(wl.active()!.favorite).toBe(true);
    wl.toggleFavorite(id);
    expect(wl.active()!.favorite).toBe(false);
  });

  it("imports a flat list as one IMPORTED section, dedupes section names", () => {
    wl.importList("Flat", [], [row("A"), row("B")]);
    expect(items()).toEqual([S("IMPORTED"), "A", "B"]);
    wl.importList("Dup", [{ name: "X", rows: [] }, { name: "X", rows: [row("A")] }]);
    expect(items()).toEqual([S("X"), S("X 2"), "A"]);
    wl.importList("", []);
    expect(wl.active()!.name).toMatch(/^Imported list/);
  });

  it("ignores switching to an unknown list", () => {
    const before = wl.activeId();
    wl.setActive("nope");
    expect(wl.activeId()).toBe(before);
  });

  it("list alerts", () => {
    wl.setAlert("x", 3);
    expect(wl.alertFor("x")).toBe(3);
    wl.clearAlert("x");
    expect(wl.alertFor("x")).toBeUndefined();
  });
});

describe("watchlistStore: sections", () => {
  it("adds SECTION 1, 2, … at the end", () => {
    fresh(["A", "B"]);
    expect(wl.addSection(null)).toBe("SECTION 1");
    expect(wl.addSection(null)).toBe("SECTION 2");
    expect(items()).toEqual(["A", "B", S("SECTION 1"), S("SECTION 2")]);
  });

  it("a section added before a row takes that row and the rows under it", () => {
    fresh(["A", "B", "#S1", "C", "D"]);
    expect(wl.addSection("B")).toBe("SECTION 1");
    expect(items()).toEqual(["A", S("SECTION 1"), "B", S("S1"), "C", "D"]);
    wl.addSection("D");
    expect(items()).toEqual(["A", S("SECTION 1"), "B", S("S1"), "C", S("SECTION 2"), "D"]);
  });

  it("a section added before a header is an empty section in front of it", () => {
    fresh(["A", "#S1", "B"]);
    wl.addSection(S("S1"));
    expect(items()).toEqual(["A", S("SECTION 1"), S("S1"), "B"]);
  });

  it("renames sections: upper-cased, unique, collapsed state kept", () => {
    fresh(["#S1", "A", "#S2", "B"]);
    wl.setSectionsCollapsed(["S1"], true);
    expect(wl.renameSection("S1", "  tech ")).toBe("TECH");
    expect(wl.active()!.collapsed).toEqual(["TECH"]);
    expect(wl.renameSection("S2", "tech")).toBe("TECH 2");
    expect(wl.renameSection("TECH", "   ")).toBe("TECH");
    expect(wl.renameSection("NOPE", "X")).toBe("NOPE");
    expect(items()).toEqual([S("TECH"), "A", S("TECH 2"), "B"]);
  });

  it("collapses and expands sections; a removed section leaves the collapsed ones", () => {
    fresh(["#S1", "A", "#S2", "B"]);
    wl.setSectionsCollapsed(["S1", "S2"], true);
    expect(wl.active()!.collapsed).toEqual(["S1", "S2"]);
    wl.setSectionsCollapsed(["S1"], false);
    expect(wl.active()!.collapsed).toEqual(["S2"]);
    wl.removeItems([S("S2")]);
    expect(wl.active()!.collapsed).toEqual([]);
  });

  it("a collapsed section opens when rows are added to it", () => {
    fresh(["#S1", "A"]);
    wl.setSectionsCollapsed(["S1"], true);
    wl.addSymbols([row("B")], null);
    expect(wl.active()!.collapsed).toEqual([]);
  });
});

describe("watchlistStore: symbols", () => {
  it("appends to the last section, or to the ungrouped rows of a list with none", () => {
    fresh(["A"]);
    expect(wl.addSymbols([row("B")], null)).toEqual(["B"]);
    expect(items()).toEqual(["A", "B"]);
    fresh(["A", "#S1", "B", "#S2"]);
    wl.addSymbols([row("C")], null);
    expect(items()).toEqual(["A", S("S1"), "B", S("S2"), "C"]);
  });

  it("skips rows already in the list (full or short name) and duplicates in the batch", () => {
    fresh(["AAPL", "#S1", "NASDAQ:MSFT"]);
    expect(wl.addSymbols([row("NASDAQ:AAPL"), row("NASDAQ:MSFT"), row("X:T"), row("X:T")], null)).toEqual(["X:T"]);
    expect(wl.addSymbols([row("X:T")], null)).toEqual([]);
  });

  it("inserts at a section's top, after a row, or after an ungrouped row", () => {
    fresh(["A", "#S1", "B", "C"]);
    wl.addSymbols([row("X")], { section: "S1" });
    expect(items()).toEqual(["A", S("S1"), "X", "B", "C"]);
    wl.addSymbols([row("Y")], { section: "S1", after: "B" });
    expect(items()).toEqual(["A", S("S1"), "X", "B", "Y", "C"]);
    wl.addSymbols([row("Z")], { section: null, after: "A" });
    expect(items()).toEqual(["A", "Z", S("S1"), "X", "B", "Y", "C"]);
    // A missing anchor falls back to the end of the list.
    wl.addSymbols([row("W")], { section: "NOPE", after: "Q" });
    expect(items()[items().length - 1]).toBe("W");
  });

  it("removed symbols go to Deleted symbols (newest last, no duplicates, no flags)", () => {
    fresh(["X:A1", "X:A2", "#S1", "X:A3"]);
    wl.removeSymbol("X:A1");
    expect(items()).toEqual(["X:A2", S("S1"), "X:A3"]);
    wl.removeItems(["X:A3"]);
    wl.clearActive();
    expect(items()).toEqual([]);
    const del = wl.lists().find((l) => l.id === DELETED_LIST_ID)!;
    expect(del.name).toBe("Deleted symbols");
    const tickers = del.extras.map((r) => r.ticker);
    expect(tickers.slice(-3)).toEqual(["X:A1", "X:A3", "X:A2"]);
    expect(new Set(tickers).size).toBe(tickers.length);
    // It cannot be removed or renamed.
    wl.deleteList(DELETED_LIST_ID);
    wl.renameList(DELETED_LIST_ID, "Mine");
    expect(wl.lists().find((l) => l.id === DELETED_LIST_ID)!.name).toBe("Deleted symbols");
  });

  it("Deleted symbols keeps the 100 most recent", () => {
    fresh(Array.from({ length: 120 }, (_, i) => `Y:${i}`));
    wl.clearActive();
    const del = wl.lists().find((l) => l.id === DELETED_LIST_ID)!;
    expect(del.extras).toHaveLength(100);
    expect(del.extras[del.extras.length - 1].ticker).toBe("Y:119");
  });

  it("a removed header leaves its rows to the section above", () => {
    fresh(["A", "#S1", "B", "#S2", "C"]);
    wl.removeItems([S("S2")]);
    expect(items()).toEqual(["A", S("S1"), "B", "C"]);
    wl.removeItems([S("S1"), "A"]);
    expect(items()).toEqual(["B", "C"]);
  });
});

describe("watchlistStore: moving items", () => {
  it("moves rows before / after a target", () => {
    fresh(["A", "B", "C", "D"]);
    wl.moveItems(["A"], "C", true, new Set());
    expect(items()).toEqual(["B", "C", "A", "D"]);
    wl.moveItems(["D", "B"], "C", false, new Set());
    expect(items()).toEqual(["B", "D", "C", "A"]); // in their order on screen
  });

  it("a moved header changes the rows' sections", () => {
    fresh(["A", "B", "#S1", "C"]);
    wl.moveItems([S("S1")], "A", true, new Set());
    expect(items()).toEqual(["A", S("S1"), "B", "C"]);
    expect(wl.active()!.groups[0].rows.map((r) => r.ticker)).toEqual(["B", "C"]);
    expect(wl.active()!.extras.map((r) => r.ticker)).toEqual(["A"]);
  });

  it("a collapsed section moves with its rows", () => {
    fresh(["#S1", "A", "#S2", "B", "C"]);
    wl.moveItems([S("S2")], S("S1"), false, new Set(["S2"]));
    expect(items()).toEqual([S("S2"), "B", "C", S("S1"), "A"]);
  });

  it("ignores a move onto a picked or unknown target", () => {
    fresh(["A", "B"]);
    wl.moveItems(["A"], "A", true, new Set());
    wl.moveItems(["A"], "Z", true, new Set());
    wl.moveItems(["Z"], "A", true, new Set());
    expect(items()).toEqual(["A", "B"]);
  });
});

describe("watchlistStore: sorting", () => {
  const byTickerDesc = (rows: Row[]) => [...rows].sort((a, b) => b.ticker.localeCompare(a.ticker));

  it("sorts each section once and restores the list's own order", () => {
    fresh(["B", "A", "#S1", "D", "F", "E"]);
    wl.applySort("symbol-desc", byTickerDesc);
    expect(wl.active()!.sort).toBe("symbol-desc");
    expect(items()).toEqual(["B", "A", S("S1"), "F", "E", "D"]);
    // A second sort keeps the order from before the first one.
    wl.applySort("symbol-asc", (rows) => [...rows].sort((a, b) => a.ticker.localeCompare(b.ticker)));
    wl.resetSort();
    expect(wl.active()!.sort).toBe("default");
    expect(items()).toEqual(["B", "A", S("S1"), "D", "F", "E"]);
  });

  it("a change of the content ends the sort; the new order stays", () => {
    fresh(["A", "C", "B"]);
    wl.applySort("symbol-desc", byTickerDesc);
    wl.addSymbols([row("D")], null);
    expect(wl.active()!.sort).toBe("default");
    wl.resetSort();
    expect(items()).toEqual(["C", "B", "A", "D"]);
  });

  it("rows added after the sort keep their place after the known ones on reset", () => {
    fresh(["#S1", "B", "A"]);
    wl.applySort("symbol-desc", byTickerDesc);
    wl.setSectionsCollapsed(["S1"], true); // keeps the sort
    expect(wl.active()!.sort).toBe("symbol-desc");
    wl.resetSort();
    expect(items()).toEqual([S("S1"), "B", "A"]);
  });
});

describe("watchlistStore: other lists", () => {
  it("addRowTo / listHas / removeRowFrom", () => {
    const target = wl.createList("Target");
    fresh(["A"]);
    expect(wl.addRowTo(target, row("NASDAQ:AAPL"))).toBe(true);
    expect(wl.addRowTo(target, row("NASDAQ:AAPL"))).toBe(false);
    expect(wl.addRowTo("nope", row("X"))).toBe(false);
    expect(wl.listHas(target, "NASDAQ:AAPL")).toBe(true);
    expect(wl.listHas(target, "NYSE:AAPL")).toBe(false);
    expect(wl.listHas("nope", "NASDAQ:AAPL")).toBe(false);
    wl.removeRowFrom(target, "NASDAQ:AAPL");
    expect(wl.listHas(target, "NASDAQ:AAPL")).toBe(false);
  });

  it("listHas matches a row stored under the short name, and section ids", () => {
    const id = fresh(["AAPL", "#TECH"]);
    expect(wl.listHas(id, "NASDAQ:AAPL")).toBe(true);
    expect(wl.listHas(id, S("TECH"))).toBe(true);
    expect(wl.listHas(id, S("NOPE"))).toBe(false);
  });

  it("addSectionTo / removeSectionFrom", () => {
    const id = fresh(["A", "#S1", "B", "#S2", "C"]);
    expect(wl.addSectionTo(id, "S3")).toBe(true);
    expect(wl.addSectionTo(id, "S3")).toBe(false);
    expect(wl.addSectionTo(DELETED_LIST_ID, "S3")).toBe(false);
    expect(items()).toEqual(["A", S("S1"), "B", S("S2"), "C", S("S3")]);
    wl.removeSectionFrom(id, "S1");
    expect(items()).toEqual(["A", "B", S("S2"), "C", S("S3")]);
    wl.removeSectionFrom(id, "S2");
    expect(items()).toEqual(["A", "B", "C", S("S3")]);
  });

  it("createListWith: strings are section headers, the active list stays", () => {
    const active = wl.activeId();
    const name = wl.createListWith([row("A"), "S1", row("B"), "S1", row("C")], "Picked");
    expect(wl.activeId()).toBe(active);
    const l = wl.lists().find((x) => x.name === name)!;
    expect(listItems(l)).toEqual(["A", S("S1"), "B", "C"]);
    const one = wl.createListWith(row("Z"));
    expect(listItems(wl.lists().find((x) => x.name === one)!)).toEqual(["Z"]);
  });

  it("adding to a colour list flags the symbol, removing unflags it", () => {
    expect(wl.addRowTo("color-green", row("NYSE:GRN"))).toBe(true);
    expect(flagOf("NYSE:GRN")).toBe("green");
    wl.removeRowFrom("color-green", "NYSE:GRN");
    expect(flagOf("NYSE:GRN")).toBeNull();
  });

  // The autosave, recently-used and flags -> colour-list syncs are createEffect()s: under node, solid-js resolves
  // to its server build where effects never run, so they are not covered here.
  it("adding to a colour list flags the symbol in the last colour order kept by symbol-flags", () => {
    wl.addRowTo("color-pink", row("NYSE:PNK"));
    expect(kv.store.get("ot:symbol-flag-last-color")).toBe("pink");
  });
});
