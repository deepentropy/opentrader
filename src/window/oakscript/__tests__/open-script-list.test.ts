import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
  onExternalChangePrefix: () => () => undefined,
}));

import { createScript, deleteScript, listScriptEntries, saveCompiledMeta } from "../../../data/oakscript-store";
import { openScriptRows, readOpenScriptSort, writeOpenScriptSort } from "../open-script-list";
import type { OakScriptEntry } from "../../../data/oakscript-store";

const e = (id: string, name: string, updatedAt: number): OakScriptEntry => ({ id, name, updatedAt, strategy: false });
const entries = [e("a", "Breadth", 300), e("b", "alpha 10", 100), e("c", "Alpha 9", 200), e("d", "Zig", 400)];
const ids = (rows: OakScriptEntry[]) => rows.map((r) => r.id);

describe("Open script list", () => {
  it("sorts by name or date modified, favourites first", () => {
    const none = () => false;
    expect(ids(openScriptRows(entries, "date-desc", "", none))).toEqual(["d", "a", "c", "b"]);
    expect(ids(openScriptRows(entries, "date-asc", "", none))).toEqual(["b", "c", "a", "d"]);
    // Any case, numbers by value.
    expect(ids(openScriptRows(entries, "name-asc", "", none))).toEqual(["c", "b", "a", "d"]);
    expect(ids(openScriptRows(entries, "name-desc", "", none))).toEqual(["d", "a", "b", "c"]);
    const fav = (x: OakScriptEntry) => x.id === "b" || x.id === "a";
    expect(ids(openScriptRows(entries, "date-desc", "", fav))).toEqual(["a", "b", "d", "c"]);
  });

  it("filters by name, any case", () => {
    expect(ids(openScriptRows(entries, "name-asc", "  ALP ", () => false))).toEqual(["c", "b"]);
    expect(openScriptRows(entries, "name-asc", "nothing", () => false)).toEqual([]);
  });

  it("keeps the chosen order, newest first by default", () => {
    expect(readOpenScriptSort()).toBe("date-desc");
    writeOpenScriptSort("name-desc");
    expect(readOpenScriptSort()).toBe("name-desc");
    writeOpenScriptSort("date-desc");
  });

  it("lists every stored script with its change time and kind", () => {
    const one = createScript("Open list one");
    const two = createScript("Open list two");
    saveCompiledMeta(two.id, { strategy: {} } as never);
    const listed = listScriptEntries().filter((x) => x.id === one.id || x.id === two.id);
    expect(listed.map((x) => [x.name, x.strategy, x.updatedAt > 0])).toEqual([
      ["Open list one", false, true],
      ["Open list two", true, true],
    ]);
    deleteScript(one.id);
    deleteScript(two.id);
    expect(listScriptEntries().some((x) => x.id === one.id)).toBe(false);
  });
});
